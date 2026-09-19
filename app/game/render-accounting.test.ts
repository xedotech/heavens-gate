import { describe, expect, it, vi } from 'vitest';
import { HeavensGateEngine } from './engine';

function fixture(quality: string, composed = true) {
  const info = {
    autoReset: true,
    render: { calls: 999, triangles: 999 },
    reset() { this.render.calls = 0; this.render.triangles = 0; },
  };
  const submit = (calls: number, triangles: number) => {
    if (info.autoReset) info.reset();
    info.render.calls += calls;
    info.render.triangles += triangles;
  };
  const renderer = { info, render: vi.fn(() => submit(40, 20000)) };
  const composer = { render: vi.fn(() => {
    renderer.render();
    submit(5, 10);
    submit(1, 2);
  }) };
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    renderer, composer: composed ? composer : undefined, settings: { quality },
    scene: {}, camera: {},
  }) as { renderFrame(): void };
  return { engine, info, composer, renderer };
}

describe('whole-frame rendering counters', () => {
  it('includes scene and every post-processing pass without accumulating older frames', () => {
    const { engine, info } = fixture('high');
    engine.renderFrame();
    expect(info.render).toEqual({ calls: 46, triangles: 20012 });
    engine.renderFrame();
    expect(info.render).toEqual({ calls: 46, triangles: 20012 });
  });

  it.each([['low', true], ['high', false]])('counts direct rendering for %s, composer=%s', (quality, composed) => {
    const { engine, info, composer, renderer } = fixture(quality as string, composed as boolean);
    engine.renderFrame();
    expect(info.render).toEqual({ calls: 40, triangles: 20000 });
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(composer.render).not.toHaveBeenCalled();
  });
});
