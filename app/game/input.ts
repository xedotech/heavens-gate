import { normalizeKeyBinding } from './keybinds';
import { DEFAULT_KEYBINDS, type GamepadBinds, type KeybindAction, type Keybinds } from './types';

interface KeyboardInput {
  key: string;
  code?: string;
  repeat?: boolean;
}

export interface GamepadSnapshot {
  index: number;
  id: string;
  mapping: string;
  connected?: boolean;
  axes: readonly number[];
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
}

export interface GamepadAxes {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  aim: number;
  shoot: number;
}

export const GAMEPAD_ACTION_BUTTONS: Partial<Record<KeybindAction, number>> = {
  jump: 0,
  dodge: 1,
  reload: 2,
  interact: 3,
  veil: 4,
  pulse: 5,
  inspect: 8,
  sprint: 10,
  crouch: 11,
  weaponSwap: 13,
  melee: 12,
  throwCharge: 14,
  shoulderSwap: 15,
};

/** Standard-layout gamepad button labels for the remap UI. */
export const GAMEPAD_BUTTON_LABELS: Record<number, string> = {
  0: 'A / Cross', 1: 'B / Circle', 2: 'X / Square', 3: 'Y / Triangle',
  4: 'LB / L1', 5: 'RB / R1', 6: 'LT / L2', 7: 'RT / R2',
  8: 'Back / Share', 9: 'Start / Options', 10: 'L3', 11: 'R3',
  12: 'D-up', 13: 'D-down', 14: 'D-left', 15: 'D-right', 16: 'Home',
};

/** Validate stored pad overrides: known actions, standard button indices only. */
export function mergeGamepadBinds(value: unknown): GamepadBinds {
  if (!value || typeof value !== 'object') return {};
  const binds: GamepadBinds = {};
  Object.entries(value as Record<string, unknown>).forEach(([action, button]) => {
    if (!(action in GAMEPAD_ACTION_BUTTONS)) return;
    if (typeof button === 'number' && Number.isInteger(button) && button >= 0 && button <= 16) {
      binds[action as KeybindAction] = button;
    }
  });
  return binds;
}

/** Resolve the button index for an action, honoring per-player overrides. */
export function gamepadButtonFor(action: KeybindAction, pad?: GamepadBinds) {
  return pad?.[action] ?? GAMEPAD_ACTION_BUTTONS[action];
}

const neutralAxes = (): GamepadAxes => ({ moveX: 0, moveY: 0, lookX: 0, lookY: 0, aim: 0, shoot: 0 });
const finiteClamped = (value: number | undefined, minimum: number, maximum: number) => (
  Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value!)) : 0
);

function readStick(x: number | undefined, y: number | undefined) {
  const horizontal = finiteClamped(x, -1, 1);
  const vertical = finiteClamped(y, -1, 1);
  const length = Math.hypot(horizontal, vertical);
  if (length <= 0.14) return { x: 0, y: 0 };
  const magnitude = (Math.min(1, length) - 0.14) / 0.86;
  return { x: horizontal / length * magnitude, y: vertical / length * magnitude };
}

export function gamepadLookDelta(axes: Pick<GamepadAxes, 'lookX' | 'lookY'>, sensitivity: number, deltaSeconds: number) {
  const speed = finiteClamped(sensitivity, 0, 10) * 2.1 * finiteClamped(deltaSeconds, 0, 0.05);
  // Response curve: soft around center for fine aim, fast at the rim for
  // turnarounds — linear sticks read twitchy at every deflection.
  const curve = (v: number) => {
    const c = finiteClamped(v, -1, 1);
    return c * (0.3 + 0.7 * c * c);
  };
  return { yaw: -curve(axes.lookX) * speed, pitch: -curve(axes.lookY) * speed };
}

/* ------------------------------------------------------------------------ */
/* Touch input — analog stick response curve and smoothed look-drag.         */
/* ------------------------------------------------------------------------ */

/** Inner deadzone of the touch move stick, as a fraction of its radius. */
export const TOUCH_STICK_DEADZONE = 0.12;

/**
 * Radial response for the touch move stick. Inside the deadzone the stick
 * reports zero; past it an ease-out cubic ramps to full deflection at the rim,
 * so small pushes answer quickly while the rim still means "full speed".
 * Direction is preserved exactly and the output magnitude never exceeds 1.
 */
export function touchStickResponse(
  deltaX: number,
  deltaY: number,
  radius: number,
  deadzone = TOUCH_STICK_DEADZONE,
) {
  const length = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(length) || !Number.isFinite(radius) || radius <= 0 || length <= 0) {
    return { x: 0, y: 0 };
  }
  const radial = Math.min(length / radius, 1);
  if (radial <= deadzone) return { x: 0, y: 0 };
  const t = (radial - deadzone) / (1 - deadzone);
  const magnitude = 1 - (1 - t) * (1 - t) * (1 - t);
  return { x: (deltaX / length) * magnitude, y: (deltaY / length) * magnitude };
}

/** /s — how hard tracked velocity chases the measured finger velocity. */
export const TOUCH_LOOK_RESPONSE = 15;
/** /s — exponential decay of leftover velocity once deltas stop arriving. */
export const TOUCH_LOOK_DECAY = 10;
/** px/s — a glide slower than this is snapped to zero to end the tail. */
export const TOUCH_LOOK_MIN_SPEED = 1.5;

/**
 * Velocity model for the touch look-drag. Raw pointer deltas are queued via
 * push() as they arrive; advance() runs once per animation frame and returns
 * the smoothed camera delta for that frame.
 *
 * While deltas keep arriving, velocity is low-passed toward the measured
 * finger speed (time constant ≈ 1/TOUCH_LOOK_RESPONSE ≈ 65ms of effective lag)
 * so single jittery or coalesced events cannot spike the camera. Once deltas
 * stop — finger held still or lifted — leftover velocity bleeds off
 * exponentially, which produces the inertial "fling" of a shipped mobile port.
 */
export class TouchLookSmoother {
  private vx = 0;
  private vy = 0;
  private pendingX = 0;
  private pendingY = 0;

  push(deltaX: number, deltaY: number) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.pendingX += deltaX;
    this.pendingY += deltaY;
  }

  reset() {
    this.vx = 0;
    this.vy = 0;
    this.pendingX = 0;
    this.pendingY = 0;
  }

  advance(dtSeconds: number, response = TOUCH_LOOK_RESPONSE, decay = TOUCH_LOOK_DECAY) {
    const dt = Number.isFinite(dtSeconds) ? Math.min(Math.max(dtSeconds, 0.0001), 0.05) : 1 / 60;
    if (this.pendingX !== 0 || this.pendingY !== 0) {
      const track = 1 - Math.exp(-dt * response);
      this.vx += (this.pendingX / dt - this.vx) * track;
      this.vy += (this.pendingY / dt - this.vy) * track;
      this.pendingX = 0;
      this.pendingY = 0;
    } else if (this.vx !== 0 || this.vy !== 0) {
      const damp = Math.exp(-dt * decay);
      this.vx *= damp;
      this.vy *= damp;
      if (Math.hypot(this.vx, this.vy) < TOUCH_LOOK_MIN_SPEED) {
        this.vx = 0;
        this.vy = 0;
      }
    }
    return { dx: this.vx * dt, dy: this.vy * dt };
  }
}

function acceptsLegacyCrouch(bindings: Keybinds) {
  return bindings.crouch === DEFAULT_KEYBINDS.crouch && !Object.values(bindings).includes('control');
}

export function isGameplayBinding(key: string, bindings: Keybinds) {
  const normalized = normalizeKeyBinding(key);
  return Object.values(bindings).includes(normalized) || (normalized === 'control' && acceptsLegacyCrouch(bindings));
}

/** Browser-independent input edges. Menu/focus transitions must call reset(). */
export class GameInputState {
  private readonly keyboardByCode = new Map<string, string>();
  private readonly keyboardPressed = new Set<string>();
  private gamepadId: string | null = null;
  private gamepadHeld = new Set<number>();
  private readonly gamepadPressed = new Set<number>();
  private blockedGamepadButtons = new Set<number>();
  private axes = neutralAxes();

  get gamepadAxes(): GamepadAxes {
    return this.axes;
  }

  keyDown(event: KeyboardInput) {
    if (event.repeat) return;
    const key = normalizeKeyBinding(event.key);
    const code = event.code || key;
    if (!key || this.keyboardByCode.has(code)) return;
    if (!this.isKeyboardHeld(key)) this.keyboardPressed.add(key);
    this.keyboardByCode.set(code, key);
  }

  keyUp(event: KeyboardInput) {
    // A shifted punctuation key can produce a different event.key on release.
    // Physical codes also keep left/right modifiers independent.
    this.keyboardByCode.delete(event.code || normalizeKeyBinding(event.key));
  }

  sampleGamepad(gamepad: GamepadSnapshot | null | undefined) {
    this.gamepadPressed.clear();
    if (!gamepad || gamepad.connected === false || gamepad.mapping !== 'standard') {
      this.gamepadId = null;
      this.gamepadHeld.clear();
      this.blockedGamepadButtons.clear();
      this.axes = neutralAxes();
      return;
    }
    const id = `${gamepad.index}:${gamepad.id}`;
    const held = new Set<number>();
    gamepad.buttons.forEach((button, index) => {
      const threshold = index === 6 || index === 7 ? 0.1 : 0.5;
      if (button.pressed || finiteClamped(button.value, 0, 1) > threshold) held.add(index);
    });
    // A newly connected device or a resumed session must release held buttons
    // before they can fire an action (or a trigger can aim/shoot).
    if (id !== this.gamepadId) this.blockedGamepadButtons = new Set(held);
    this.blockedGamepadButtons.forEach((index) => {
      if (!held.has(index)) this.blockedGamepadButtons.delete(index);
    });
    held.forEach((index) => {
      if (!this.gamepadHeld.has(index) && !this.blockedGamepadButtons.has(index)) this.gamepadPressed.add(index);
    });
    this.gamepadHeld = held;
    this.gamepadId = id;
    const move = readStick(gamepad.axes[0], gamepad.axes[1]);
    const look = readStick(gamepad.axes[2], gamepad.axes[3]);
    this.axes = {
      moveX: move.x,
      moveY: move.y,
      lookX: look.x,
      lookY: look.y,
      aim: this.blockedGamepadButtons.has(6) ? 0 : finiteClamped(gamepad.buttons[6]?.value, 0, 1),
      shoot: this.blockedGamepadButtons.has(7) ? 0 : finiteClamped(gamepad.buttons[7]?.value, 0, 1),
    };
  }

  isHeld(action: KeybindAction, bindings: Keybinds, pad?: GamepadBinds) {
    const button = gamepadButtonFor(action, pad);
    return this.isKeyboardHeld(bindings[action])
      || (action === 'crouch' && acceptsLegacyCrouch(bindings) && this.isKeyboardHeld('control'))
      || (button !== undefined && this.gamepadHeld.has(button) && !this.blockedGamepadButtons.has(button));
  }

  wasPressed(action: KeybindAction, bindings: Keybinds, pad?: GamepadBinds) {
    const button = gamepadButtonFor(action, pad);
    return this.keyboardPressed.has(bindings[action])
      || (action === 'crouch' && acceptsLegacyCrouch(bindings) && this.keyboardPressed.has('control'))
      || (button !== undefined && this.gamepadPressed.has(button));
  }

  wasPausePressed() {
    return this.gamepadPressed.has(9);
  }

  finishFrame() {
    this.keyboardPressed.clear();
    this.gamepadPressed.clear();
  }

  reset() {
    this.keyboardByCode.clear();
    this.keyboardPressed.clear();
    this.gamepadId = null;
    this.gamepadHeld.clear();
    this.gamepadPressed.clear();
    this.blockedGamepadButtons.clear();
    this.axes = neutralAxes();
  }

  private isKeyboardHeld(key: string) {
    for (const held of this.keyboardByCode.values()) {
      if (held === key) return true;
    }
    return false;
  }
}
