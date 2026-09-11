import { expect, it } from 'vitest';
import { HeavensGateEngine } from './engine';
import { FrameTimeSampler } from './performance';

it('reports actual render resolution and runtime context beside frame timings', () => {
  const sampler = new FrameTimeSampler(3);
  [16, 17, 180].forEach((ms) => sampler.record(ms));
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    frameTimeSampler: sampler, fps: 42, dynamicPixelRatio: 0.85,
    settings: { quality: 'high' }, mode: 'playing', paused: false,
    renderer: {
      domElement: { clientWidth: 1920, clientHeight: 1080, width: 1632, height: 918 },
      info: { render: { calls: 250, triangles: 500000 }, memory: { geometries: 100, textures: 40 } },
    },
  }) as HeavensGateEngine;
  expect(engine.getPerformanceSnapshot()).toMatchObject({
    samples: 3, medianMs: 17, p95Ms: 180, maxMs: 180,
    fps: 42, pixelRatio: 0.85, quality: 'high', mode: 'playing', paused: false,
    viewportWidth: 1920, viewportHeight: 1080, renderWidth: 1632, renderHeight: 918,
    drawCalls: 250, triangles: 500000, geometries: 100, textures: 40,
  });
});
