import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './audio';

class Param {
  value = 0;
  setTargetAtTime = vi.fn((value: number) => { this.value = value; });
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
class Node extends EventTarget {
  gain = new Param(); frequency = new Param(); detune = new Param(); Q = new Param(); pan = new Param();
  connect = vi.fn(); disconnect = vi.fn(); start = vi.fn(); stop = vi.fn();
  onended: (() => void) | null = null;
  finish() { this.onended?.(); this.dispatchEvent(new Event('ended')); }
}
class Context {
  static instances: Context[] = [];
  currentTime = 0; sampleRate = 100; state = 'running'; destination = new Node();
  nodes: Node[] = []; sources: Node[] = [];
  constructor() { Context.instances.push(this); }
  createGain = () => { const n = new Node(); this.nodes.push(n); return n; };
  createBiquadFilter = this.createGain;
  createStereoPanner = this.createGain;
  createOscillator = () => { const n = this.createGain(); this.sources.push(n); return n; };
  createBufferSource = this.createOscillator;
  createBuffer = (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) });
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

beforeEach(() => { vi.useFakeTimers(); Context.instances = []; vi.stubGlobal('AudioContext', Context); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('audio routing lifecycle', () => {
  it('honors mute set before the first user gesture unlock', async () => {
    const audio = new AudioEngine();
    audio.setMuted(true);
    await audio.unlock();
    expect(Context.instances[0].nodes[0].gain.value).toBe(0);
    audio.dispose();
  });

  it('disconnects all transient gunshot nodes after both layers finish', async () => {
    const audio = new AudioEngine();
    await audio.unlock();
    const context = Context.instances[0];
    const nodeStart = context.nodes.length;
    const sourceStart = context.sources.length;
    audio.enemyShot({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, false);
    const sources = context.sources.slice(sourceStart);
    expect(sources).toHaveLength(2);
    sources.forEach((source) => source.finish());
    context.nodes.slice(nodeStart).forEach((node) => expect(node.disconnect).toHaveBeenCalledOnce());
    audio.dispose();
  });

  it('creates the engine oscillator in the new context after disposal', async () => {
    const audio = new AudioEngine();
    await audio.unlock();
    audio.setEngine(20, true);
    audio.dispose();
    await audio.unlock();
    const context = Context.instances[1];
    const sources = context.sources.length;
    audio.setEngine(20, true);
    expect(context.sources.length).toBe(sources + 1);
    audio.dispose();
  });
});
