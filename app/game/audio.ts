import { clamp } from './mechanics';
import { spatialGunshotMix, type SoundPosition } from './spatial-audio';

type Wave = OscillatorType;

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private interiorSend: GainNode | null = null;
  private veilBed: { source: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  private ambientBus: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private ambientNodes: AudioNode[] = [];
  private ambientSources: AudioScheduledSourceNode[] = [];
  private engineOscillator: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private citySources: AudioScheduledSourceNode[] = [];
  private cityNodes: AudioNode[] = [];
  private cityTimer: ReturnType<typeof setInterval> | null = null;
  private scoreTimer: ReturnType<typeof setInterval> | null = null;
  private scoreStep = 0;
  private intensity = 0;
  private volume = 0.72;
  private muted = false;

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.ambientBus = this.context.createGain();
      this.effectsBus = this.context.createGain();
      this.engineBus = this.context.createGain();

      this.ambientBus.gain.value = 0.42;
      this.effectsBus.gain.value = 0.82;
      this.engineBus.gain.value = 0;
      this.master.gain.value = this.muted ? 0 : this.volume;

      this.masterFilter = this.context.createBiquadFilter();
      this.masterFilter.type = 'lowpass';
      this.masterFilter.frequency.value = 19000;
      this.ambientBus.connect(this.master);
      this.effectsBus.connect(this.master);
      this.engineBus.connect(this.master);
      this.master.connect(this.masterFilter);
      this.masterFilter.connect(this.context.destination);

      // Interior slapback: effects feed a short feedback delay through a
      // lowpass — a stone-room tail for the chapel. Gain stays at 0 outside.
      if (typeof this.context.createDelay === 'function') {
      const echoDelay = this.context.createDelay(0.4);
      echoDelay.delayTime.value = 0.085;
      const echoFilter = this.context.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.value = 2400;
      const echoFeedback = this.context.createGain();
      echoFeedback.gain.value = 0.34;
      this.interiorSend = this.context.createGain();
      this.interiorSend.gain.value = 0;
      this.effectsBus.connect(this.interiorSend);
      this.interiorSend.connect(echoDelay);
      echoDelay.connect(echoFilter);
      echoFilter.connect(echoFeedback);
      echoFeedback.connect(echoDelay);
      echoFilter.connect(this.master);
      }

      this.startAmbient();
    }
    if (this.context.state !== 'running') await this.context.resume();
  }

  // 0 = open street, 1 = fully enclosed — ramps the slapback send and dips
  // the city bed so interiors sound like interiors.
  setInterior(amount: number) {
    if (!this.context || !this.interiorSend || !this.ambientBus) return;
    const level = clamp(amount, 0, 1);
    const now = this.context.currentTime;
    this.interiorSend.gain.setTargetAtTime(level * 0.5, now, 0.25);
    this.ambientBus.gain.setTargetAtTime(0.42 * (1 - level * 0.72), now, 0.35);
  }

  setVolume(volume: number) {
    this.volume = clamp(volume, 0, 1);
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.025);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.setVolume(this.volume);
  }

  isMuted() {
    return this.muted;
  }

  private createNoiseBuffer(seconds = 2) {
    if (!this.context) return null;
    const length = Math.floor(this.context.sampleRate * seconds);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.985 + white * 0.015;
      data[i] = previous;
    }
    return buffer;
  }

  private startAmbient() {
    if (!this.context || !this.ambientBus) return;
    const now = this.context.currentTime;

    [43.65, 65.41, 98].forEach((frequency, index) => {
      const oscillator = this.context!.createOscillator();
      const gain = this.context!.createGain();
      const filter = this.context!.createBiquadFilter();
      oscillator.type = index === 0 ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index * 4 - 4;
      gain.gain.value = index === 0 ? 0.11 : 0.035;
      filter.type = 'lowpass';
      filter.frequency.value = 440 + index * 160;
      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambientBus!);
      oscillator.start(now);
      this.ambientSources.push(oscillator);
      this.ambientNodes.push(gain, filter);
    });

    const buffer = this.createNoiseBuffer(3);
    if (buffer) {
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = 'bandpass';
      filter.frequency.value = 180;
      filter.Q.value = 0.5;
      gain.gain.value = 0.025;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambientBus);
      source.start(now);
      this.ambientSources.push(source);
      this.ambientNodes.push(filter, gain);
    }

    this.scoreTimer = setInterval(() => this.scorePulse(), 1850);
  }

  private scorePulse() {
    if (!this.context || this.context.state !== 'running') return;
    const calm = [110, 146.83, 164.81, 220];
    const danger = [110, 123.47, 146.83, 196];
    const notes = this.intensity > 0.45 ? danger : calm;
    const note = notes[this.scoreStep % notes.length];
    this.scoreStep += 1;
    this.tone(note, this.intensity > 0.45 ? 0.18 : 0.55, 'triangle', 0.025 + this.intensity * 0.025, 0, this.ambientBus);
    if (this.intensity > 0.25 && this.scoreStep % 2 === 0) {
      this.noise(0.08, 0.018 + this.intensity * 0.025, 480, this.ambientBus);
    }
    // Combat stem: a four-on-the-floor sub-kick subdivides each bar once the
    // city is on you, with hat ticks slipping between beats at max intensity.
    if (this.intensity > 0.55) {
      const kickLevel = 0.05 + (this.intensity - 0.55) * 0.09;
      for (let beat = 0; beat < 4; beat += 1) {
        this.tone(52, 0.11, 'sine', kickLevel, beat * 0.46, this.ambientBus, 34);
      }
      if (this.intensity > 0.78) {
        for (let tick = 0; tick < 4; tick += 1) {
          this.noise(0.03, 0.02, 6800, this.ambientBus);
          this.tone(7000, 0.025, 'square', 0.008, tick * 0.46 + 0.23, this.ambientBus);
        }
      }
    }
    // Calm stem: a high airy shimmer when nothing hunts you — the city breathing.
    if (this.intensity < 0.18 && this.scoreStep % 2 === 0) {
      this.tone(note * 4, 1.4, 'sine', 0.008, 0.1, this.ambientBus);
      this.tone(note * 4 * 1.5, 1.2, 'sine', 0.005, 0.55, this.ambientBus);
    }
  }

  setIntensity(intensity: number) {
    this.intensity = clamp(intensity, 0, 1);
    if (!this.ambientBus || !this.context) return;
    this.ambientBus.gain.setTargetAtTime(0.38 + this.intensity * 0.18, this.context.currentTime, 0.8);
  }

  private tone(
    frequency: number,
    duration: number,
    wave: Wave,
    volume: number,
    delay = 0,
    destination: AudioNode | null = this.effectsBus,
    endFrequency?: number,
  ) {
    if (!this.context || !destination) return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(Math.max(1, frequency), start);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    return oscillator;
  }

  private noise(duration: number, volume: number, frequency: number, destination: AudioNode | null = this.effectsBus) {
    if (!this.context || !destination) return;
    const buffer = this.createNoiseBuffer(Math.max(duration, 0.15));
    if (!buffer) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start();
    source.stop(this.context.currentTime + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
    return source;
  }

  enemyShot(source: SoundPosition, listener: SoundPosition, yaw: number, occluded: boolean) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    if (mix.gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan;
    gain.gain.value = mix.gain;
    filter.type = 'lowpass';
    filter.frequency.value = mix.cutoff;
    filter.connect(pan);
    pan.connect(gain);
    gain.connect(this.effectsBus);
    const voices = [this.noise(0.06, 0.16, 2400, filter),
      this.noise(0.14, 0.12, 800, filter),
      this.tone(76, 0.18, 'triangle', 0.06, 0, filter, 38),
      this.tone(54, 0.22, 'sine', 0.05, 0, filter, 26)].filter((voice) => voice !== undefined);
    let remaining = voices.length;
    const cleanup = () => { filter.disconnect(); pan.disconnect(); gain.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
  }

  // Ambient pedestrian chatter — short filtered murmurs spatialized like
  // enemy shots so a conversation reads from the direction it happens in.
  pedestrianBlip(source: SoundPosition, listener: SoundPosition, yaw: number, occluded = false) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    const gain = Math.min(mix.gain * 0.5, 0.03);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan * 0.7;
    master.gain.value = gain;
    filter.type = 'bandpass';
    filter.frequency.value = Math.min(320 + Math.random() * 320, mix.cutoff);
    filter.Q.value = 2.2;
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    const syllables = 2 + Math.floor(Math.random() * 3);
    const voices: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < syllables; i += 1) {
      const pitch = 140 + Math.random() * 160;
      const voice = this.tone(pitch, 0.07 + Math.random() * 0.05, 'sawtooth', 0.16, i * (0.11 + Math.random() * 0.06), filter, pitch * 0.9);
      if (voice) voices.push(voice);
    }
    let remaining = voices.length;
    const cleanup = () => { filter.disconnect(); pan.disconnect(); master.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
  }

  // Supersonic snap of a round passing close by — a short bright crack
  // spatialized to the bullet's closest-approach point. The audio cue that
  // sells incoming fire you never saw.
  bulletWhiz(point: SoundPosition, listener: SoundPosition, yaw: number) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(point, listener, yaw, false);
    const gain = Math.min(mix.gain * 0.85, 0.06);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    pan.pan.value = mix.pan;
    master.gain.value = gain;
    pan.connect(master);
    master.connect(this.effectsBus);
    const jitter = 0.92 + Math.random() * 0.18;
    const voices = [this.noise(0.035, 0.5, 4200 * jitter, pan),
      this.noise(0.08, 0.26, 5600 * jitter, pan)].filter((voice) => voice !== undefined);
    let remaining = voices.length;
    const cleanup = () => { pan.disconnect(); master.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
  }

  ui(confirm = false) {
    this.tone(confirm ? 660 : 440, 0.09, 'sine', 0.045, 0, this.effectsBus, confirm ? 880 : 520);
  }

  // Traffic horn — the classic two-tone square blare, spatialized like
  // pedestrian chatter. Sometimes a double-tap when the driver is angry.
  honk(source: SoundPosition, listener: SoundPosition, yaw: number, occluded = false) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    const gain = Math.min(mix.gain * 0.9, 0.055);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan * 0.8;
    master.gain.value = gain;
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(1600, mix.cutoff);
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    const base = 340 + Math.random() * 60;
    const blasts = Math.random() < 0.35 ? 2 : 1;
    const voices: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < blasts; i += 1) {
      const at = i * 0.42;
      const length = i === blasts - 1 ? 0.3 : 0.16;
      const low = this.tone(base, length, 'square', 0.11, at, filter);
      const high = this.tone(base * 1.26, length, 'square', 0.08, at, filter);
      if (low) voices.push(low);
      if (high) voices.push(high);
    }
    let remaining = voices.length;
    const cleanup = () => { filter.disconnect(); pan.disconnect(); master.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
  }

  // Low-health heartbeat — a lub-dub pair of deep sine thumps routed through
  // the ambient bus so it sits under the mix like a pulse, not an effect.
  heartbeat(intensity = 0.5) {
    if (!this.context) return;
    const level = clamp(intensity, 0, 1);
    this.tone(58, 0.16, 'sine', 0.09 + level * 0.13, 0, this.ambientBus, 40);
    this.tone(50, 0.13, 'sine', 0.06 + level * 0.09, 0.24, this.ambientBus, 36);
  }

  shoot(voice: 'morrow' | 'psalm' | 'vesper' = 'morrow') {
    const jitter = 0.94 + Math.random() * 0.12;
    if (voice === 'psalm') {
      this.noise(0.05, 0.16, 3400 * jitter);
      this.noise(0.14, 0.11, 950 * jitter);
      this.tone(210 * jitter, 0.1, 'square', 0.05, 0, this.effectsBus, 72);
      this.tone(64 * jitter, 0.17, 'sine', 0.09, 0, this.effectsBus, 30);
      this.noise(0.34, 0.026, 420);
      return;
    }
    if (voice === 'vesper') {
      this.noise(0.07, 0.3, 1500 * jitter);
      this.noise(0.3, 0.22, 640 * jitter);
      this.tone(52 * jitter, 0.34, 'sine', 0.16, 0, this.effectsBus, 24);
      this.tone(96 * jitter, 0.12, 'sawtooth', 0.06, 0.01, this.effectsBus, 40);
      this.noise(0.52, 0.034, 300);
      return;
    }
    this.noise(0.045, 0.2, 2600 * jitter);
    this.noise(0.12, 0.13, 1300 * jitter);
    this.tone(110 * jitter, 0.11, 'square', 0.06, 0, this.effectsBus, 48);
    this.tone(58 * jitter, 0.18, 'sine', 0.1, 0, this.effectsBus, 28);
    this.noise(0.3, 0.02, 480);
  }

  swap() {
    this.tone(240, 0.05, 'square', 0.028);
    this.tone(170, 0.07, 'square', 0.036, 0.055, this.effectsBus, 120);
  }

  empty() {
    this.tone(920, 0.035, 'square', 0.035);
  }

  reload() {
    this.tone(290, 0.05, 'square', 0.028);
    this.tone(440, 0.07, 'square', 0.035, 0.34);
  }

  hit(critical = false) {
    this.tone(critical ? 1240 : 780, 0.06, 'sine', critical ? 0.08 : 0.05);
    this.noise(0.05, critical ? 0.05 : 0.028, critical ? 2400 : 1600);
    if (critical) this.tone(340, 0.12, 'triangle', 0.045, 0.015, this.effectsBus, 220);
  }

  footstep(run = false, surface: 'street' | 'stone' | 'veil' = 'street') {
    const jitter = 0.9 + Math.random() * 0.2;
    if (surface === 'stone') {
      // Interior flagstones — a hard click and a bright scuff that the
      // chapel slapback then smears into the room.
      this.noise(0.022, run ? 0.02 : 0.011, 2100 * jitter);
      this.tone(210 * jitter, 0.035, 'triangle', run ? 0.014 : 0.008, 0, this.effectsBus, 140);
      this.tone(96 * jitter, 0.05, 'sine', run ? 0.02 : 0.011, 0, this.effectsBus, 58);
      return;
    }
    if (surface === 'veil') {
      // The Veil swallows impact — a soft low thud, no scuff.
      this.noise(0.07, run ? 0.016 : 0.009, 220 * jitter);
      this.tone(64 * jitter, 0.08, 'sine', run ? 0.018 : 0.01, 0, this.effectsBus, 42);
      return;
    }
    this.noise(0.05, run ? 0.03 : 0.018, 150 * jitter);
    this.noise(0.028, run ? 0.014 : 0.008, 950 * jitter);
    this.tone(88 * jitter, 0.045, 'sine', run ? 0.02 : 0.011, 0, this.effectsBus, 55);
  }

  playerDamage() {
    this.noise(0.16, 0.11, 320);
    this.tone(72, 0.24, 'sawtooth', 0.035, 0, this.effectsBus, 42);
  }

  gate() {
    [110, 164.81, 220, 329.63].forEach((note, index) => {
      this.tone(note, 1.8 - index * 0.12, 'sine', 0.055, index * 0.08, this.effectsBus, note * 2);
    });
  }

  pulse() {
    this.tone(65, 0.65, 'sine', 0.12, 0, this.effectsBus, 520);
    this.noise(0.28, 0.09, 920);
  }

  setVeilBed(active: boolean) {
    if (!this.context || !this.ambientBus) return;
    const now = this.context.currentTime;
    if (this.masterFilter) {
      this.masterFilter.frequency.setTargetAtTime(active ? 900 : 19000, now, 0.28);
    }
    if (active && !this.veilBed) {
      const source = this.context.createBufferSource();
      source.buffer = this.createNoiseBuffer(3.5);
      source.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 520;
      filter.Q.value = 1.5;
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.setTargetAtTime(0.055, now, 0.6);
      const lfo = this.context.createOscillator();
      lfo.frequency.value = 0.14;
      const lfoGain = this.context.createGain();
      lfoGain.gain.value = 260;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambientBus);
      source.start();
      lfo.start();
      this.veilBed = { source, gain, lfo, lfoGain };
    } else if (!active && this.veilBed) {
      const bed = this.veilBed;
      this.veilBed = null;
      bed.gain.gain.setTargetAtTime(0, now, 0.4);
      setTimeout(() => {
        try { bed.source.stop(); bed.lfo.stop(); } catch { /* already stopped */ }
        bed.source.disconnect();
        bed.lfo.disconnect();
        bed.lfoGain.disconnect();
        bed.gain.disconnect();
      }, 1600);
    }
  }

  whisperBlip() {
    // Two detuned descending tones + hiss — a voice that almost forms words.
    const base = 340 + Math.random() * 260;
    this.tone(base, 0.5, 'sine', 0.028, 0, this.ambientBus, base * 0.62);
    this.tone(base * 1.007, 0.55, 'sine', 0.024, 0.04, this.ambientBus, base * 0.58);
    this.noise(0.4, 0.02, 1600);
  }

  meleeSwing() {
    this.noise(0.14, 0.09, 1400);
    this.tone(180, 0.1, 'triangle', 0.04, 0.02, this.effectsBus, 90);
  }

  meleeHit() {
    this.noise(0.1, 0.2, 700);
    this.tone(85, 0.22, 'sine', 0.2, 0, this.effectsBus, 40);
    this.tone(300, 0.08, 'square', 0.05, 0.01, this.effectsBus, 140);
  }

  chargeThrow() {
    const jitter = 0.95 + Math.random() * 0.1;
    this.tone(620 * jitter, 0.18, 'sine', 0.06, 0, this.effectsBus, 940 * jitter);
    this.noise(0.12, 0.05, 2200);
  }

  crash(intensity = 1) {
    const amount = clamp(intensity, 0.2, 1);
    // Metal crunch + low thud + glass scatter.
    this.noise(0.22, 0.2 * amount, 900);
    this.tone(68, 0.3, 'sine', 0.16 * amount, 0, this.effectsBus, 30);
    this.noise(0.45, 0.06 * amount, 3200);
    this.tone(240, 0.12, 'square', 0.05 * amount, 0.02, this.effectsBus, 110);
  }

  tireScreech(gripLoss = 0.5) {
    // High bandpass noise wail — short, so it can be re-triggered while held.
    const jitter = 0.94 + Math.random() * 0.12;
    this.noise(0.16, 0.045 * clamp(gripLoss, 0.2, 1), 2600 * jitter);
    this.tone(1180 * jitter, 0.14, 'sawtooth', 0.012 * gripLoss, 0, this.effectsBus, 980 * jitter);
  }

  explosion() {
    this.noise(0.75, 0.24, 110);
    this.tone(55, 0.8, 'sine', 0.14, 0, this.effectsBus, 24);
  }

  thunder(intensity = 1) {
    const amount = clamp(intensity, 0.2, 1);
    this.noise(2.2 * amount, 0.045 * amount, 95);
    this.noise(0.6, 0.028 * amount, 280);
    this.tone(38, 2.0 * amount, 'sine', 0.1 * amount, 0.05, this.effectsBus, 24);
  }

  setRainBed(active: boolean) {
    if (!this.context || !this.ambientBus) return;
    if (active && !this.rainSource) {
      const buffer = this.createNoiseBuffer(4);
      if (!buffer) return;
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = 'highpass';
      filter.frequency.value = 750;
      gain.gain.value = 0.0001;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambientBus);
      source.start();
      this.rainSource = source;
      this.rainGain = gain;
      this.ambientNodes.push(filter, gain);
      this.ambientSources.push(source);
    }
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(active ? 0.016 : 0.0001, this.context.currentTime, 1.1);
    }
  }

  // The "city is alive" bed: layered noise for traffic rumble and wind, plus a
  // scheduler that fires distant honks and crowd murmurs on loose intervals.
  setCityBed(active: boolean) {
    if (!this.context || !this.ambientBus) return;
    if (active && !this.citySources.length) {
      const now = this.context.currentTime;
      const rumbleBuffer = this.createNoiseBuffer(4);
      if (rumbleBuffer) {
        const source = this.context.createBufferSource();
        const filter = this.context.createBiquadFilter();
        const gain = this.context.createGain();
        source.buffer = rumbleBuffer;
        source.loop = true;
        filter.type = 'lowpass';
        filter.frequency.value = 130;
        gain.gain.value = 0.055;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.ambientBus);
        source.start(now);
        this.citySources.push(source);
        this.cityNodes.push(filter, gain);
      }
      const windBuffer = this.createNoiseBuffer(3);
      if (windBuffer) {
        const source = this.context.createBufferSource();
        const filter = this.context.createBiquadFilter();
        const gain = this.context.createGain();
        source.buffer = windBuffer;
        source.loop = true;
        filter.type = 'bandpass';
        filter.frequency.value = 820;
        filter.Q.value = 0.35;
        gain.gain.value = 0.014;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.ambientBus);
        source.start(now);
        this.citySources.push(source);
        this.cityNodes.push(filter, gain);
      }
      if (!this.cityTimer) this.cityTimer = setInterval(() => this.cityEvent(), 900);
      return;
    }
    if (!active) {
      this.citySources.forEach((source) => {
        try { source.stop(); } catch { /* Already stopped. */ }
        source.disconnect();
      });
      this.cityNodes.forEach((node) => node.disconnect());
      this.citySources = [];
      this.cityNodes = [];
      if (this.cityTimer) clearInterval(this.cityTimer);
      this.cityTimer = null;
    }
  }

  private cityEvent() {
    if (!this.context || this.context.state !== 'running' || !this.ambientBus) return;
    const roll = Math.random();
    if (roll < 0.42) {
      // Distant two-tone horn, heavily low-passed so it reads as far away.
      const root = 260 + Math.random() * 120;
      const delay = Math.random() * 0.6;
      this.tone(root, 0.16, 'square', 0.012, delay, this.ambientBus, root * 0.92);
      if (Math.random() > 0.5) this.tone(root * 0.81, 0.14, 'square', 0.01, delay + 0.18, this.ambientBus, root * 0.74);
    } else if (roll < 0.72) {
      // Crowd murmur swell — short bandpassed noise wobble.
      this.noise(0.7 + Math.random() * 0.8, 0.008 + Math.random() * 0.01, 300 + Math.random() * 500, this.ambientBus);
    } else if (roll < 0.86) {
      // Skateboard/drone flyover — a filtered tone gliding upward.
      const root = 180 + Math.random() * 160;
      this.tone(root, 1.4, 'sine', 0.006, Math.random() * 0.4, this.ambientBus, root * 2.2);
    }
    // else: silence — gaps are part of the illusion.
  }

  setEngine(speed: number, active: boolean) {
    if (!this.context || !this.engineBus) return;
    if (active && !this.engineOscillator) {
      this.engineOscillator = this.context.createOscillator();
      this.engineFilter = this.context.createBiquadFilter();
      this.engineOscillator.type = 'sawtooth';
      this.engineFilter.type = 'lowpass';
      this.engineOscillator.connect(this.engineFilter);
      this.engineFilter.connect(this.engineBus);
      this.engineOscillator.start();
    }
    const now = this.context.currentTime;
    const normalized = clamp(Math.abs(speed) / 44, 0, 1);
    this.engineBus.gain.setTargetAtTime(active ? 0.028 + normalized * 0.07 : 0, now, 0.08);
    this.engineOscillator?.frequency.setTargetAtTime(58 + normalized * 94, now, 0.04);
    this.engineFilter?.frequency.setTargetAtTime(220 + normalized * 1300, now, 0.05);
  }

  testMix() {
    this.ui(true);
    this.tone(220, 0.42, 'triangle', 0.04, 0.12, this.effectsBus, 440);
    this.noise(0.11, 0.025, 900);
  }

  dispose() {
    if (this.scoreTimer) clearInterval(this.scoreTimer);
    this.scoreTimer = null;
    this.setCityBed(false);
    if (this.veilBed) {
      const bed = this.veilBed;
      this.veilBed = null;
      try { bed.source.stop(); bed.lfo.stop(); } catch { /* Already stopped. */ }
      bed.source.disconnect();
      bed.lfo.disconnect();
      bed.lfoGain.disconnect();
      bed.gain.disconnect();
    }
    this.ambientSources.forEach((source) => {
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
    });
    this.ambientNodes.forEach((node) => node.disconnect());
    if (this.engineOscillator) {
      try { this.engineOscillator.stop(); } catch { /* Already stopped. */ }
      this.engineOscillator.disconnect();
    }
    this.engineFilter?.disconnect();
    this.ambientBus?.disconnect();
    this.effectsBus?.disconnect();
    this.engineBus?.disconnect();
    this.master?.disconnect();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.ambientBus = null;
    this.effectsBus = null;
    this.engineBus = null;
    this.rainSource = null;
    this.rainGain = null;
    this.engineOscillator = null;
    this.engineFilter = null;
    this.ambientSources = [];
    this.ambientNodes = [];
    this.scoreStep = 0;
    this.intensity = 0;
  }
}
