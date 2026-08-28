import { clamp } from './mechanics';

type Wave = OscillatorType;

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private ambientNodes: AudioNode[] = [];
  private ambientSources: AudioScheduledSourceNode[] = [];
  private engineOscillator: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
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
      this.master.gain.value = this.volume;

      this.ambientBus.connect(this.master);
      this.effectsBus.connect(this.master);
      this.engineBus.connect(this.master);
      this.master.connect(this.context.destination);
      this.startAmbient();
    }
    if (this.context.state !== 'running') await this.context.resume();
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
  }

  ui(confirm = false) {
    this.tone(confirm ? 660 : 440, 0.09, 'sine', 0.045, 0, this.effectsBus, confirm ? 880 : 520);
  }

  shoot() {
    this.noise(0.11, 0.19, 1800);
    this.tone(92, 0.13, 'square', 0.07, 0, this.effectsBus, 45);
  }

  empty() {
    this.tone(920, 0.035, 'square', 0.035);
  }

  reload() {
    this.tone(290, 0.05, 'square', 0.028);
    this.tone(440, 0.07, 'square', 0.035, 0.34);
  }

  hit(critical = false) {
    this.tone(critical ? 1200 : 760, 0.07, 'sine', critical ? 0.075 : 0.045);
  }

  footstep(run = false) {
    this.noise(0.045, run ? 0.025 : 0.016, 130);
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

  explosion() {
    this.noise(0.75, 0.24, 110);
    this.tone(55, 0.8, 'sine', 0.14, 0, this.effectsBus, 24);
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
    this.ambientSources.forEach((source) => {
      try { source.stop(); } catch { /* Already stopped. */ }
    });
    this.ambientNodes.forEach((node) => node.disconnect());
    if (this.engineOscillator) {
      try { this.engineOscillator.stop(); } catch { /* Already stopped. */ }
    }
    void this.context?.close();
    this.context = null;
  }
}
