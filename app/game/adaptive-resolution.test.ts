import { describe, expect, it, vi } from 'vitest';
import { HeavensGateEngine } from './engine';

function fixture() {
  const resize = vi.fn();
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    fpsTimer: 0, fpsFrames: 0, slowFrameWindows: 0, fastFrameWindows: 0,
    dynamicPixelRatio: 1, targetPixelRatio: () => 1.3,
    renderer: { setPixelRatio: vi.fn() }, composer: { setPixelRatio: resize },
    resize: () => { throw new Error('Resolution-only adaptation must not repeat viewport resize'); },
  }) as { updatePerformance(delta: number): void; fpsFrames: number; dynamicPixelRatio: number };
  const window = (fps: number) => {
    engine.fpsFrames = fps - 1;
    engine.updatePerformance(1);
  };
  return { engine, resize, window };
}

describe('adaptive resolution stability', () => {
  it('does not interpret hidden-tab throttling as graphics overload', () => {
    const { engine, resize, window } = fixture();
    vi.stubGlobal('document', { hidden: true });
    try {
      for (let i = 0; i < 10; i++) window(1);
      expect(engine.dynamicPixelRatio).toBe(1);
      expect(resize).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not resize on alternating slow and fast windows', () => {
    const { resize, window } = fixture();
    for (let i = 0; i < 20; i++) window(i % 2 ? 60 : 30);
    expect(resize).not.toHaveBeenCalled();
  });
  it('reduces sustained overload and requires sustained headroom to recover', () => {
    const { engine, resize, window } = fixture();
    window(30); window(30);
    expect(engine.dynamicPixelRatio).toBeCloseTo(0.88);
    for (let i = 0; i < 7; i++) window(60);
    expect(resize).toHaveBeenCalledTimes(1);
    window(60);
    expect(engine.dynamicPixelRatio).toBeCloseTo(0.96);
    expect(resize).toHaveBeenCalledTimes(2);
  });
});
