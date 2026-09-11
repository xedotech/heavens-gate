import { describe, expect, it } from 'vitest';
import { GAMEPAD_ACTION_BUTTONS, GameInputState, gamepadLookDelta, isGameplayBinding, type GamepadSnapshot } from './input';
import { assignKeybind } from './keybinds';
import { DEFAULT_KEYBINDS, type KeybindAction } from './types';

function pad(held: number[] = [], overrides: Partial<GamepadSnapshot> = {}): GamepadSnapshot {
  return {
    index: 0,
    id: 'test-standard-pad',
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: held.includes(index), value: held.includes(index) ? 1 : 0 })),
    ...overrides,
  };
}

describe('keyboard input edges', () => {
  it('holds a key but only fires a one-shot once until release', () => {
    const input = new GameInputState();
    input.keyDown({ key: 'r', code: 'KeyR' });
    expect(input.isHeld('reload', DEFAULT_KEYBINDS)).toBe(true);
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(true);
    input.finishFrame();
    input.keyDown({ key: 'r', code: 'KeyR', repeat: true });
    input.keyDown({ key: 'r', code: 'KeyR' });
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(false);
    expect(input.isHeld('reload', DEFAULT_KEYBINDS)).toBe(true);
    input.keyUp({ key: 'r', code: 'KeyR' });
    input.keyDown({ key: 'r', code: 'KeyR' });
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(true);
  });

  it('keeps a quick tap for one frame even when keyup arrives before simulation', () => {
    const input = new GameInputState();
    input.keyDown({ key: ' ', code: 'Space' });
    input.keyUp({ key: ' ', code: 'Space' });
    expect(input.isHeld('jump', DEFAULT_KEYBINDS)).toBe(false);
    expect(input.wasPressed('jump', DEFAULT_KEYBINDS)).toBe(true);
    input.finishFrame();
    expect(input.wasPressed('jump', DEFAULT_KEYBINDS)).toBe(false);
  });

  it('releases the original binding when modifiers change the released key label', () => {
    const input = new GameInputState();
    const bindings = assignKeybind(DEFAULT_KEYBINDS, 'reload', '?');
    input.keyDown({ key: '?', code: 'Slash' });
    expect(input.isHeld('reload', bindings)).toBe(true);
    input.keyUp({ key: '/', code: 'Slash' });
    expect(input.isHeld('reload', bindings)).toBe(false);
  });

  it('does not release a shared modifier until both physical keys are up', () => {
    const input = new GameInputState();
    input.keyDown({ key: 'Shift', code: 'ShiftLeft' });
    input.finishFrame();
    input.keyDown({ key: 'Shift', code: 'ShiftRight' });
    expect(input.wasPressed('sprint', DEFAULT_KEYBINDS)).toBe(false);
    input.keyUp({ key: 'Shift', code: 'ShiftLeft' });
    expect(input.isHeld('sprint', DEFAULT_KEYBINDS)).toBe(true);
    input.keyUp({ key: 'Shift', code: 'ShiftRight' });
    expect(input.isHeld('sprint', DEFAULT_KEYBINDS)).toBe(false);
  });

  it('clears pending and held input on reset without rearming from OS repeat', () => {
    const input = new GameInputState();
    input.keyDown({ key: 'w', code: 'KeyW' });
    input.keyDown({ key: 'f', code: 'KeyF' });
    input.reset();
    input.keyDown({ key: 'w', code: 'KeyW', repeat: true });
    expect(input.isHeld('moveForward', DEFAULT_KEYBINDS)).toBe(false);
    expect(input.wasPressed('pulse', DEFAULT_KEYBINDS)).toBe(false);
    input.keyUp({ key: 'w', code: 'KeyW' });
    input.keyDown({ key: 'w', code: 'KeyW' });
    expect(input.isHeld('moveForward', DEFAULT_KEYBINDS)).toBe(true);
  });

  it('resolves keyboard actions through the remapped binding', () => {
    const input = new GameInputState();
    const bindings = assignKeybind(DEFAULT_KEYBINDS, 'pulse', 'z');
    input.keyDown({ key: 'f', code: 'KeyF' });
    expect(input.wasPressed('pulse', bindings)).toBe(false);
    input.keyDown({ key: 'z', code: 'KeyZ' });
    expect(input.wasPressed('pulse', bindings)).toBe(true);
  });

  it('retains unassigned default Ctrl crouch but never collides with a remapped action', () => {
    const input = new GameInputState();
    input.keyDown({ key: 'Control', code: 'ControlLeft' });
    expect(input.wasPressed('crouch', DEFAULT_KEYBINDS)).toBe(true);
    expect(isGameplayBinding('Control', DEFAULT_KEYBINDS)).toBe(true);
    const remapped = assignKeybind(DEFAULT_KEYBINDS, 'reload', 'Control');
    expect(input.wasPressed('reload', remapped)).toBe(true);
    expect(input.wasPressed('crouch', remapped)).toBe(false);
    const crouchMoved = assignKeybind(DEFAULT_KEYBINDS, 'crouch', 'z');
    expect(input.wasPressed('crouch', crouchMoved)).toBe(false);
    expect(isGameplayBinding('Control', crouchMoved)).toBe(false);
    expect(isGameplayBinding('Tab', DEFAULT_KEYBINDS)).toBe(false);
  });
});

describe('standard gamepad input', () => {
  it.each(Object.entries(GAMEPAD_ACTION_BUTTONS))('keeps %s working after its keyboard binding changes', (name, button) => {
    const action = name as KeybindAction;
    const input = new GameInputState();
    const bindings = assignKeybind(DEFAULT_KEYBINDS, action, 'z');
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([button]));
    expect(input.wasPressed(action, bindings)).toBe(true);
    expect(input.isHeld(action, bindings)).toBe(true);
    input.finishFrame();
    input.sampleGamepad(pad([button]));
    expect(input.wasPressed(action, bindings)).toBe(false);
    expect(input.isHeld(action, bindings)).toBe(true);
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([button]));
    expect(input.wasPressed(action, bindings)).toBe(true);
  });

  it('samples L3 sprint and held A for the vehicle handbrake', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([0, 10]));
    input.finishFrame();
    expect(input.isHeld('sprint', DEFAULT_KEYBINDS)).toBe(true);
    expect(input.isHeld('jump', DEFAULT_KEYBINDS)).toBe(true);
    expect(input.wasPressed('jump', DEFAULT_KEYBINDS)).toBe(false);
  });

  it('emits exactly one pause edge while the menu button remains down', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([9]));
    expect(input.wasPausePressed()).toBe(true);
    input.finishFrame();
    input.sampleGamepad(pad([9]));
    expect(input.wasPausePressed()).toBe(false);
  });

  it('requires held actions and triggers to release after pause/reset', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([2, 6, 7, 9]));
    input.reset();
    input.sampleGamepad(pad([2, 6, 7, 9]));
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(false);
    expect(input.wasPausePressed()).toBe(false);
    expect(input.gamepadAxes.aim).toBe(0);
    expect(input.gamepadAxes.shoot).toBe(0);
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([2, 6, 7, 9]));
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(true);
    expect(input.gamepadAxes.aim).toBe(1);
    expect(input.gamepadAxes.shoot).toBe(1);
  });

  it('clears disconnected state and does not replay a held button on reconnect', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([2, 7, 10], { axes: [1, 1, 1, 1] }));
    input.sampleGamepad(null);
    expect(input.isHeld('sprint', DEFAULT_KEYBINDS)).toBe(false);
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(false);
    expect(Object.values(input.gamepadAxes).every((value) => value === 0)).toBe(true);
    input.sampleGamepad(pad([2]));
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(false);
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([2]));
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(true);
  });

  it('treats a different controller as a fresh connection and ignores unmapped devices', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad());
    input.sampleGamepad(pad([2], { index: 1, id: 'second-pad' }));
    expect(input.wasPressed('reload', DEFAULT_KEYBINDS)).toBe(false);
    input.sampleGamepad(pad([2, 7], { mapping: '', axes: [1, 1, 1, 1] }));
    expect(input.isHeld('reload', DEFAULT_KEYBINDS)).toBe(false);
    expect(Object.values(input.gamepadAxes).every((value) => value === 0)).toBe(true);
  });

  it('filters stick drift, normalizes diagonals, and keeps partial analog magnitude', () => {
    const input = new GameInputState();
    input.sampleGamepad(pad([], { axes: [0.05, -0.05, 0.1, 0] }));
    expect(input.gamepadAxes.moveX).toBe(0);
    expect(input.gamepadAxes.lookX).toBe(0);
    input.sampleGamepad(pad([], { axes: [1, 1, 0.5, 0] }));
    expect(Math.hypot(input.gamepadAxes.moveX, input.gamepadAxes.moveY)).toBeCloseTo(1);
    expect(input.gamepadAxes.lookX).toBeGreaterThan(0);
    expect(input.gamepadAxes.lookX).toBeLessThan(0.5);
    input.sampleGamepad(pad([], { axes: [Number.NaN, Infinity, -8, 0] }));
    expect(input.gamepadAxes.moveX).toBe(0);
    expect(input.gamepadAxes.moveY).toBe(0);
    expect(input.gamepadAxes.lookX).toBe(-1);
  });

  it('rotates equally over one second at 30, 60, and 144 frames per second', () => {
    for (const frameRate of [30, 60, 144]) {
      let yaw = 0;
      let pitch = 0;
      for (let frame = 0; frame < frameRate; frame += 1) {
        const change = gamepadLookDelta({ lookX: 1, lookY: 0.5 }, 0.65, 1 / frameRate);
        yaw += change.yaw;
        pitch += change.pitch;
      }
      expect(yaw).toBeCloseTo(-0.65 * 2.1);
      expect(pitch).toBeCloseTo(-0.65 * 2.1 * 0.5);
    }
  });
});
