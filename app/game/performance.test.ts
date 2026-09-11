import { describe, expect, it } from 'vitest';
import { FrameTimeSampler } from './performance';

describe('frame-time sampler', () => {
  it('summarizes an empty and populated window', () => {
    const sampler = new FrameTimeSampler(5);
    expect(sampler.summary()).toEqual({ samples: 0, medianMs: 0, p95Ms: 0, maxMs: 0 });
    [10, 12, 14, 18, 40].forEach((value) => sampler.record(value));
    expect(sampler.summary()).toEqual({ samples: 5, medianMs: 14, p95Ms: 40, maxMs: 40 });
  });

  it('ignores invalid observations rather than inventing zero-time frames', () => {
    const sampler = new FrameTimeSampler(3);
    sampler.record(Number.NaN);
    sampler.record(-4);
    sampler.record(20);
    sampler.record(30);
    expect(sampler.summary()).toEqual({ samples: 2, medianMs: 25, p95Ms: 30, maxMs: 30 });
  });

  it('uses nearest-rank p95 and the midpoint median for an even window', () => {
    const sampler = new FrameTimeSampler(100);
    for (let ms = 1; ms <= 100; ms++) sampler.record(ms);
    expect(sampler.summary()).toEqual({ samples: 100, medianMs: 50.5, p95Ms: 95, maxMs: 100 });
  });

  it('drops evicted spikes while preserving current stalls', () => {
    const sampler = new FrameTimeSampler(3);
    [250, 16, 17, 18].forEach((ms) => sampler.record(ms));
    expect(sampler.summary()).toEqual({ samples: 3, medianMs: 17, p95Ms: 18, maxMs: 18 });
    sampler.record(180);
    expect(sampler.summary().maxMs).toBe(180);
    expect(sampler.summary().p95Ms).toBe(180);
  });
});
