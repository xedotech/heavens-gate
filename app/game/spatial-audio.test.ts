import { describe, expect, it } from 'vitest';
import { spatialGunshotMix } from './spatial-audio';

const listener = { x: 0, y: 0, z: 0 };
describe('enemy gunshot spatial cues', () => {
  it('places sources on the correct side and rotates with the camera', () => {
    expect(spatialGunshotMix({ x: 10, y: 0, z: 0 }, listener, 0, false).pan).toBe(1);
    expect(spatialGunshotMix({ x: -10, y: 0, z: 0 }, listener, 0, false).pan).toBe(-1);
    expect(spatialGunshotMix({ x: 0, y: 0, z: -10 }, listener, Math.PI / 2, false).pan).toBeCloseTo(1);
  });
  it('centers coincident sounds and attenuates distance including elevation', () => {
    const close = spatialGunshotMix(listener, listener, 0, false);
    const far = spatialGunshotMix({ x: 0, y: 36, z: 0 }, listener, 0, false);
    expect(close).toEqual({ pan: 0, gain: 1, cutoff: 9000 });
    expect(far.gain).toBeCloseTo(0.2);
    expect(spatialGunshotMix({ x: 140, y: 0, z: 0 }, listener, 0, false).gain).toBe(0);
  });
  it('muffles and quiets occluded sources without changing their direction', () => {
    const source = { x: 10, y: 0, z: -10 };
    const clear = spatialGunshotMix(source, listener, 0, false);
    const blocked = spatialGunshotMix(source, listener, 0, true);
    expect(blocked.pan).toBe(clear.pan);
    expect(blocked.gain).toBeCloseTo(clear.gain * 0.35);
    expect(blocked.cutoff).toBeLessThan(clear.cutoff);
  });
});
