import { clamp } from './mechanics';
import { acquireAssetStream, assetEntryIsSafe, fetchVerifiedBytes, releaseAssetStream, type VerifiedAssetEntry } from './props';
import { spatialGunshotMix, type SoundPosition } from './spatial-audio';

type Wave = OscillatorType;

// One live city-bed graph: a level-scaled master gain feeding the ambient
// bus, the looped layer sources, and the three self-rescheduling timers that
// keep wind and distant events non-repeating. Captured by teardown so a bed
// fading out can die without disturbing its replacement.
type CityBed = {
  master: GainNode;
  windFilter: BiquadFilterNode | null;
  windGain: GainNode | null;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  gustTimer: ReturnType<typeof setTimeout> | null;
  thumpTimer: ReturnType<typeof setTimeout> | null;
  hornTimer: ReturnType<typeof setTimeout> | null;
};

// Recorded foley families → manifest clip ids. Every family keeps its synth
// fallback while clips are pending or failed verification.
const SAMPLE_FAMILIES: Record<string, string[]> = {
  'footstep-street': ['footstep-concrete-000', 'footstep-concrete-001', 'footstep-concrete-002', 'footstep-concrete-003', 'footstep-concrete-004'],
  'footstep-stone': ['hard-footstep1', 'hard-footstep2', 'hard-footstep3', 'hard-footstep4', 'heel-reverb2', 'heel-reverb4'],
  'impact-metal': ['impactmetal-light-000', 'impactmetal-light-001', 'impactmetal-light-002', 'impactmetal-light-003', 'impactmetal-light-004'],
  'impact-generic': ['impactgeneric-light-000', 'impactgeneric-light-001', 'impactgeneric-light-002', 'impactgeneric-light-003', 'impactgeneric-light-004'],
  'impact-soft': ['impactsoft-medium-000', 'impactsoft-medium-001', 'impactsoft-medium-002', 'impactsoft-medium-003', 'impactsoft-medium-004'],
  'impact-punch': ['impactpunch-medium-000', 'impactpunch-medium-001', 'impactpunch-medium-002', 'impactpunch-medium-003', 'impactpunch-medium-004'],
  'impact-glass': ['impactglass-light-000', 'impactglass-light-001', 'impactglass-light-002'],
  cloth: ['320138--owlstorm--blanket-movement-2', '320142--owlstorm--blanket-movement-4', '320144--owlstorm--blanket-movement-6'],
  rain: ['3'],
};

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private interiorSend: GainNode | null = null;
  private streetSend: GainNode | null = null;
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
  private rainIsClip = false;
  private samples = new Map<string, AudioBuffer[]>();
  private samplesLoading = false;
  private cityBed: CityBed | null = null;
  private cityBedWanted = false;
  private cityBedLevel = 0.5;
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

      // Street slap: the same effects feed a longer, brighter delay — the
      // report bouncing down the canyon of facades. Always on outdoors,
      // faded out as the interior tail takes over.
      const streetDelay = this.context.createDelay(0.6);
      streetDelay.delayTime.value = 0.19;
      const streetFilter = this.context.createBiquadFilter();
      streetFilter.type = 'bandpass';
      streetFilter.frequency.value = 1500;
      streetFilter.Q.value = 0.6;
      const streetFeedback = this.context.createGain();
      streetFeedback.gain.value = 0.24;
      this.streetSend = this.context.createGain();
      this.streetSend.gain.value = 0.3;
      this.effectsBus.connect(this.streetSend);
      this.streetSend.connect(streetDelay);
      streetDelay.connect(streetFilter);
      streetFilter.connect(streetFeedback);
      streetFeedback.connect(streetDelay);
      streetFilter.connect(this.master);
      }

      this.startAmbient();
      if (this.cityBedWanted) this.buildCityBed();
      void this.loadSamples();
    }
    if (this.context.state !== 'running') await this.context.resume();
  }

  // Fetch + verify + decode every clip after the first user gesture. Failures
  // leave families absent — the synth layers underneath keep working.
  private async loadSamples() {
    const context = this.context;
    if (!context || typeof context.decodeAudioData !== 'function' || this.samplesLoading || this.samples.size) return;
    this.samplesLoading = true;
    try {
      await acquireAssetStream();
      let manifest: { clips?: VerifiedAssetEntry[] };
      try {
        const manifestResponse = await fetch('/assets/audio/manifest.json', { cache: 'no-store' });
        if (!manifestResponse.ok) return;
        manifest = (await manifestResponse.json()) as { clips?: VerifiedAssetEntry[] };
      } finally {
        releaseAssetStream();
      }
      for (const [family, ids] of Object.entries(SAMPLE_FAMILIES)) {
        const buffers: AudioBuffer[] = [];
        for (const id of ids) {
          const clip = manifest.clips?.find((candidate) => candidate.id === id);
          if (!assetEntryIsSafe(clip)) continue;
          try {
            const bytes = await fetchVerifiedBytes('/assets/audio/', clip);
            if (this.context !== context) return; // context was rebuilt mid-load
            buffers.push(await context.decodeAudioData(bytes));
          } catch { /* a bad clip only loses its variant */ }
        }
        if (buffers.length) this.samples.set(family, buffers);
      }
      // Upgrade the running rain bed to the recorded loop if it started early.
      if (this.rainSource && !this.rainIsClip && this.samples.has('rain')) this.setRainBed(true);
    } catch {
      // No foley — synthesized cues still carry the mix.
    } finally {
      this.samplesLoading = false;
    }
  }

  // Random variant through the effects bus with ±8% rate jitter. Returns
  // false while the family is empty so callers can fall back to synth.
  private playSample(family: string, gain: number, rate = 1) {
    if (!this.context || !this.effectsBus) return false;
    const variants = this.samples.get(family);
    if (!variants?.length) return false;
    const source = this.context.createBufferSource();
    const amp = this.context.createGain();
    source.buffer = variants[Math.floor(Math.random() * variants.length)];
    if (source.playbackRate) source.playbackRate.value = rate * (0.92 + Math.random() * 0.16);
    amp.gain.value = gain;
    source.connect(amp);
    amp.connect(this.effectsBus);
    source.start();
    source.onended = () => { source.disconnect(); amp.disconnect(); };
    return true;
  }

  // 0 = open street, 1 = fully enclosed — ramps the slapback send and dips
  // the city bed so interiors sound like interiors.
  setInterior(amount: number) {
    if (!this.context || !this.interiorSend || !this.ambientBus) return;
    const level = clamp(amount, 0, 1);
    const now = this.context.currentTime;
    this.interiorSend.gain.setTargetAtTime(level * 0.5, now, 0.25);
    this.streetSend?.gain.setTargetAtTime(0.3 * (1 - level), now, 0.3);
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

  private noise(duration: number, volume: number, frequency: number, destination: AudioNode | null = this.effectsBus, delay = 0) {
    if (!this.context || !destination) return;
    const buffer = this.createNoiseBuffer(Math.max(duration, 0.15));
    if (!buffer) return;
    const start = this.context.currentTime + delay;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(start);
    source.stop(start + duration);
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

  // A pellet striking world geometry — a material-matched crack spatialized
  // like enemy gunfire. Silent while foley samples are pending or absent.
  surfaceImpact(source: SoundPosition, listener: SoundPosition, yaw: number, occluded: boolean, material: 'glass' | 'metal' | 'generic' = 'generic') {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    const level = Math.min(mix.gain * 0.85, 0.075);
    if (level < 0.002) return;
    const family = material === 'glass' ? 'impact-glass' : material === 'metal' ? 'impact-metal' : 'impact-generic';
    const variants = this.samples.get(family);
    if (!variants?.length) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan;
    master.gain.value = level;
    filter.type = 'lowpass';
    filter.frequency.value = mix.cutoff;
    const clip = this.context.createBufferSource();
    clip.buffer = variants[Math.floor(Math.random() * variants.length)];
    if (clip.playbackRate) clip.playbackRate.value = 0.9 + Math.random() * 0.2;
    clip.connect(filter);
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    clip.start();
    clip.onended = () => { clip.disconnect(); filter.disconnect(); pan.disconnect(); master.disconnect(); };
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

  // Cordon detection tell — a short rising chirp that climbs as a posted
  // patrol's attention hardens. Caller rate-limits; intensity 0..1.
  detectionTell(intensity = 0.5) {
    const level = clamp(intensity, 0, 1);
    this.tone(560 + level * 360, 0.13, 'sine', 0.02 + level * 0.022, 0, this.effectsBus, 940 + level * 560);
    this.tone(1180 + level * 700, 0.06, 'triangle', 0.008 + level * 0.012, 0.06, this.effectsBus, 1520 + level * 720);
  }

  // Exit-release klaxon — a two-tone alarm off the release panel, high-low
  // square blasts through a bandpass so it reads as infrastructure waking.
  klaxon(source: SoundPosition, listener: SoundPosition, yaw: number, occluded = false) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    const gain = Math.min(mix.gain * 1.1, 0.09);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan;
    master.gain.value = gain;
    filter.type = 'bandpass';
    filter.frequency.value = Math.min(1500, mix.cutoff);
    filter.Q.value = 1.1;
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    const voices: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < 2; i += 1) {
      const high = this.tone(920, 0.22, 'square', 0.5, i * 0.62, filter);
      const low = this.tone(614, 0.24, 'square', 0.44, i * 0.62 + 0.29, filter);
      if (high) voices.push(high);
      if (low) voices.push(low);
    }
    let remaining = voices.length;
    const cleanup = () => { filter.disconnect(); pan.disconnect(); master.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
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

  // Warden radio bark — a squelch click then two low mutter syllables, the
  // sound of a squad sharing your position. Spatialized like chatter.
  radioBark(source: SoundPosition, listener: SoundPosition, yaw: number, occluded = false) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, occluded);
    const gain = Math.min(mix.gain * 0.7, 0.04);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan * 0.75;
    master.gain.value = gain;
    filter.type = 'bandpass';
    filter.frequency.value = Math.min(520, mix.cutoff);
    filter.Q.value = 2.6;
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    const voices: AudioScheduledSourceNode[] = [];
    const squelch = this.noise(0.03, 0.4, 2400, filter);
    if (squelch) voices.push(squelch);
    const syllables = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < syllables; i += 1) {
      const pitch = 96 + Math.random() * 50;
      const voice = this.tone(pitch, 0.06 + Math.random() * 0.04, 'sawtooth', 0.14, 0.04 + i * (0.09 + Math.random() * 0.05), filter, pitch * 0.86);
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

  // Low-health heartbeat — a lub-dub pair of deep sine thumps routed through
  // the ambient bus so it sits under the mix like a pulse, not an effect.
  heartbeat(intensity = 0.5) {
    if (!this.context) return;
    const level = clamp(intensity, 0, 1);
    this.tone(58, 0.16, 'sine', 0.09 + level * 0.13, 0, this.ambientBus, 40);
    this.tone(50, 0.13, 'sine', 0.06 + level * 0.09, 0.24, this.ambientBus, 36);
  }

  shoot(voice: 'morrow' | 'psalm' | 'vesper' = 'morrow', muffled = false) {
    const jitter = 0.94 + Math.random() * 0.12;
    // Shroud baffles: the crack and the street-carry tail collapse into a
    // cough — the mechanical action stays because metal still cycles.
    const damp = muffled ? 0.42 : 1;
    if (voice === 'psalm') {
      this.noise(0.05, 0.16 * damp, 3400 * jitter);
      this.noise(0.14, 0.11 * damp, 950 * jitter);
      this.tone(210 * jitter, 0.1, 'square', 0.05 * damp, 0, this.effectsBus, 72);
      this.tone(64 * jitter, 0.17, 'sine', 0.09 * damp, 0, this.effectsBus, 30);
      if (!muffled) this.noise(0.34, 0.026, 420);
      // Capacitor recharge — a falling whine as the coils drink again.
      this.tone(2600 * jitter, 0.1, 'sine', 0.018, 0.07, this.effectsBus, 820);
      return;
    }
    if (voice === 'vesper') {
      this.noise(0.07, 0.3 * damp, 1500 * jitter);
      this.noise(0.3, 0.22 * damp, 640 * jitter);
      this.tone(52 * jitter, 0.34, 'sine', 0.16 * damp, 0, this.effectsBus, 24);
      this.tone(96 * jitter, 0.12, 'sawtooth', 0.06 * damp, 0.01, this.effectsBus, 40);
      if (!muffled) this.noise(0.52, 0.034, 300);
      // The pump — fore clack then the return, the slowest mechanical tell.
      this.noise(0.018, 0.045, 1900 * jitter, this.effectsBus, 0.27);
      this.noise(0.022, 0.04, 1300 * jitter, this.effectsBus, 0.37);
      return;
    }
    this.noise(0.045, 0.2 * damp, 2600 * jitter);
    this.noise(0.12, 0.13 * damp, 1300 * jitter);
    this.tone(110 * jitter, 0.11, 'square', 0.06 * damp, 0, this.effectsBus, 48);
    this.tone(58 * jitter, 0.18, 'sine', 0.1 * damp, 0, this.effectsBus, 28);
    if (!muffled) this.noise(0.3, 0.02, 480);
    // Slide racks back — the bright metal clack ~90ms after the report.
    this.noise(0.016, 0.04, 5200 * jitter, this.effectsBus, 0.09);
    this.tone(2350 * jitter, 0.02, 'square', 0.014, 0.09, this.effectsBus, 1600);
  }

  swap() {
    // Cloth rustle under the holster click — also fires on the inspect draw.
    this.playSample('cloth', 0.4);
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
    // Recorded foley first — synth layers stay as the pending/failed fallback.
    if (surface === 'street' && this.playSample('footstep-street', run ? 0.5 : 0.3, run ? 1.06 : 0.98)) return;
    if (surface === 'stone' && this.playSample('footstep-stone', run ? 0.5 : 0.3, run ? 1.05 : 0.95)) return;
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

  // The toll under Saint Orison — a low sine stack struck by a noise mallet,
  // always occluded-lowpassed so it reads as sounding through the street.
  bell(source: SoundPosition, listener: SoundPosition, yaw: number) {
    if (!this.context || !this.effectsBus) return;
    const mix = spatialGunshotMix(source, listener, yaw, true);
    const gain = Math.min(mix.gain * 1.5, 0.24);
    if (gain < 0.002) return;
    const pan = this.context.createStereoPanner();
    const master = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    pan.pan.value = mix.pan;
    master.gain.value = gain;
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(1200, mix.cutoff);
    filter.connect(pan);
    pan.connect(master);
    master.connect(this.effectsBus);
    const voices: AudioScheduledSourceNode[] = [];
    const strike = this.noise(0.5, 0.5, 210, filter);
    if (strike) voices.push(strike);
    [55, 82.41, 110, 164.81].forEach((note, index) => {
      const voice = this.tone(note, 3.6 - index * 0.55, 'sine', 0.4 - index * 0.09, index * 0.04, filter, note * 0.982);
      if (voice) voices.push(voice);
    });
    let remaining = voices.length;
    const cleanup = () => { filter.disconnect(); pan.disconnect(); master.disconnect(); };
    if (!remaining) cleanup();
    voices.forEach((voice) => voice.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining === 0) cleanup();
    }, { once: true }));
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
    // Foley punch under the synth thud — the two layers share the hit.
    this.playSample('impact-punch', 0.5);
    this.noise(0.1, 0.2, 700);
    this.tone(85, 0.22, 'sine', 0.2, 0, this.effectsBus, 40);
    this.tone(300, 0.08, 'square', 0.05, 0.01, this.effectsBus, 140);
  }

  chargeThrow() {
    const jitter = 0.95 + Math.random() * 0.1;
    this.tone(620 * jitter, 0.18, 'sine', 0.06, 0, this.effectsBus, 940 * jitter);
    this.noise(0.12, 0.05, 2200);
  }

  casingTink() {
    // Brass hitting pavement — a high ring with a tiny bounce.
    const pitch = 4200 + Math.random() * 1600;
    this.tone(pitch, 0.07, 'triangle', 0.028, 0, this.effectsBus, pitch * 0.62);
    this.tone(pitch * 1.18, 0.05, 'triangle', 0.016, 0.045, this.effectsBus, pitch * 0.7);
    this.noise(0.025, 0.012, 8200);
  }

  crash(intensity = 1) {
    const amount = clamp(intensity, 0.2, 1);
    // Metal crunch + low thud + glass scatter.
    this.playSample('impact-metal', 0.55 * amount);
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
    const clip = active ? this.samples.get('rain')?.[0] : null;
    // The recorded loop may have landed after the synth bed started — swap
    // beds so "prefer the clip" holds even mid-shower.
    if (active && this.rainSource && Boolean(clip) !== this.rainIsClip) {
      try { this.rainSource.stop(); } catch { /* already stopped */ }
      this.rainSource.disconnect();
      this.rainSource = null;
    }
    if (active && !this.rainSource) {
      const buffer = clip ?? this.createNoiseBuffer(4);
      if (!buffer) return;
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = clip ? 'lowpass' : 'highpass';
      filter.frequency.value = clip ? 5600 : 750;
      gain.gain.value = 0.0001;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambientBus);
      source.start();
      this.rainSource = source;
      this.rainGain = gain;
      this.rainIsClip = Boolean(clip);
      this.ambientNodes.push(filter, gain);
      this.ambientSources.push(source);
    }
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(active ? (this.rainIsClip ? 0.045 : 0.016) : 0.0001, this.context.currentTime, 1.1);
    }
  }

  // The ambient city bed — the layer that keeps the world alive when nothing
  // is happening. startCityBed/stopCityBed own the lifecycle, setCityBedLevel
  // is the intensity fader the engine maps calm/combat/veil states onto:
  // 0 = silent, ~0.5 = baseline street, 1 = heightened aftermath. All three
  // are safe before the AudioContext unlocks — intent is stored and the graph
  // is built (or rebuilt) inside unlock().
  startCityBed() {
    this.cityBedWanted = true;
    this.buildCityBed();
  }

  setCityBedLevel(level: number) {
    this.cityBedLevel = clamp(level, 0, 1);
    const bed = this.cityBed;
    if (!bed || !this.context) return;
    // ~1s to converge — a fader move, never a click.
    bed.master.gain.setTargetAtTime(this.cityBedTarget(), this.context.currentTime, 0.35);
  }

  stopCityBed() {
    this.cityBedWanted = false;
    const bed = this.cityBed;
    if (!bed || !this.context) return;
    this.cityBed = null;
    // Fade under the noise floor before teardown so stopping mid-gust never
    // clicks; the captured bed dies even if a new one starts meanwhile.
    bed.master.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.4);
    setTimeout(() => this.tearDownCityBed(bed), 1600);
  }

  // Legacy on/off surface — kept for callers wired against the old API.
  setCityBed(active: boolean) {
    if (active) this.startCityBed();
    else this.stopCityBed();
  }

  private cityBedTarget() {
    // Full bed ≈ 0.06 into the ambient bus — well under the score layer, so
    // speech and music sit ~24dB above it.
    return this.cityBedLevel * 0.06;
  }

  private buildCityBed() {
    if (!this.context || !this.ambientBus || this.cityBed || !this.cityBedWanted) return;
    const context = this.context;
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.setTargetAtTime(this.cityBedTarget(), now, 0.9);
    master.connect(this.ambientBus);
    const bed: CityBed = {
      master,
      windFilter: null,
      windGain: null,
      sources: [],
      nodes: [master],
      gustTimer: null,
      thumpTimer: null,
      hornTimer: null,
    };
    this.cityBed = bed;

    // Rain wash — pink-leaning looped noise through a soft lowpass. 3.ogg is
    // already claimed by setRainBed, so the bed synthesizes its own, quieter.
    const rainBuffer = this.createNoiseBuffer(5);
    if (rainBuffer) {
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = rainBuffer;
      source.loop = true;
      filter.type = 'lowpass';
      filter.frequency.value = 1150;
      filter.Q.value = 0.4;
      gain.gain.value = 0.4;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(now);
      bed.sources.push(source);
      bed.nodes.push(filter, gain);
    }

    // Wind — a band wandering 300-700Hz under two detuned LFOs (7s/9s-ish
    // beating), plus a slow random-walk retune every 7-15s so the gust
    // pattern never audibly repeats.
    const windBuffer = this.createNoiseBuffer(4);
    if (windBuffer) {
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = windBuffer;
      source.loop = true;
      filter.type = 'bandpass';
      filter.frequency.value = 480;
      filter.Q.value = 0.7;
      gain.gain.value = 0.26;
      const lfo = context.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = context.createGain();
      lfoGain.gain.value = 170;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      const gustLfo = context.createOscillator();
      gustLfo.frequency.value = 0.11;
      const gustDepth = context.createGain();
      gustDepth.gain.value = 0.09;
      gustLfo.connect(gustDepth);
      gustDepth.connect(gain.gain);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(now);
      lfo.start(now);
      gustLfo.start(now);
      bed.sources.push(source, lfo, gustLfo);
      bed.nodes.push(filter, gain, lfoGain, gustDepth);
      bed.windFilter = filter;
      bed.windGain = gain;
    }

    // Sparse-event schedulers. Every timer checks the bed is still current,
    // so a fading predecessor can never fire into the replacement mix.
    const gust = () => {
      if (this.cityBed !== bed) return;
      if (this.context && this.context.state === 'running' && bed.windFilter && bed.windGain) {
        const at = this.context.currentTime;
        bed.windFilter.frequency.setTargetAtTime(300 + Math.random() * 400, at, 2.2);
        bed.windGain.gain.setTargetAtTime(0.18 + Math.random() * (0.16 + this.cityBedLevel * 0.22), at, 2.8);
      }
      bed.gustTimer = setTimeout(gust, 7000 + Math.random() * 8000);
    };
    const thump = () => {
      if (this.cityBed !== bed) return;
      this.cityBedThump(bed);
      bed.thumpTimer = setTimeout(thump, this.cityBedSpacing(20, 40));
    };
    const horn = () => {
      if (this.cityBed !== bed) return;
      this.cityBedHorn(bed);
      bed.hornTimer = setTimeout(horn, this.cityBedSpacing(45, 90));
    };
    bed.gustTimer = setTimeout(gust, 5000 + Math.random() * 7000);
    bed.thumpTimer = setTimeout(thump, this.cityBedSpacing(14, 30));
    bed.hornTimer = setTimeout(horn, this.cityBedSpacing(30, 90));
  }

  // Higher levels tighten event spacing: ×1.35 at level 0 down to ×0.65 at 1.
  private cityBedSpacing(minSeconds: number, maxSeconds: number) {
    const span = maxSeconds - minSeconds;
    return (minSeconds + Math.random() * span) * (1.35 - this.cityBedLevel * 0.7) * 1000;
  }

  // A far-off muffled impact — low noise whomp plus a decaying sub-bloom,
  // randomized enough that no two thumps read as a loop.
  private cityBedThump(bed: CityBed) {
    if (!this.context || this.context.state !== 'running' || this.cityBedLevel < 0.02) return;
    const level = 0.7 + this.cityBedLevel * 0.6;
    this.noise(0.5 + Math.random() * 0.7, (0.1 + Math.random() * 0.1) * level, 90 + Math.random() * 80, bed.master);
    this.tone(44 + Math.random() * 22, 0.45 + Math.random() * 0.35, 'sine', (0.14 + Math.random() * 0.12) * level, Math.random() * 0.05, bed.master, 30 + Math.random() * 12);
  }

  // A rare distant horn — two detuned low voices swelling through a heavy
  // lowpass over ~1.5s, like traffic heard through several blocks.
  private cityBedHorn(bed: CityBed) {
    const context = this.context;
    if (!context || context.state !== 'running' || this.cityBedLevel < 0.02) return;
    const now = context.currentTime;
    const level = (0.7 + this.cityBedLevel * 0.6) * (0.09 + Math.random() * 0.06);
    const root = 90 + Math.random() * 50;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
    filter.connect(gain);
    gain.connect(bed.master);
    const low = context.createOscillator();
    low.type = 'sine';
    low.frequency.value = root;
    const high = context.createOscillator();
    high.type = 'triangle';
    high.frequency.value = root * (1.006 + Math.random() * 0.004);
    low.connect(filter);
    high.connect(filter);
    low.start(now);
    high.start(now);
    low.stop(now + 1.55);
    high.stop(now + 1.55);
    let remaining = 2;
    const cleanup = () => { low.disconnect(); high.disconnect(); filter.disconnect(); gain.disconnect(); };
    const done = () => { remaining -= 1; if (remaining === 0) cleanup(); };
    low.addEventListener('ended', done, { once: true });
    high.addEventListener('ended', done, { once: true });
  }

  private tearDownCityBed(bed: CityBed) {
    if (bed.gustTimer) clearTimeout(bed.gustTimer);
    if (bed.thumpTimer) clearTimeout(bed.thumpTimer);
    if (bed.hornTimer) clearTimeout(bed.hornTimer);
    bed.gustTimer = null;
    bed.thumpTimer = null;
    bed.hornTimer = null;
    bed.sources.forEach((source) => {
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
    });
    bed.nodes.forEach((node) => node.disconnect());
    bed.sources = [];
    bed.nodes = [];
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
    this.cityBedWanted = false;
    if (this.cityBed) {
      const bed = this.cityBed;
      this.cityBed = null;
      this.tearDownCityBed(bed);
    }
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
    this.rainIsClip = false;
    this.samples.clear();
    this.samplesLoading = false;
    this.engineOscillator = null;
    this.engineFilter = null;
    this.ambientSources = [];
    this.ambientNodes = [];
    this.scoreStep = 0;
    this.intensity = 0;
  }
}
