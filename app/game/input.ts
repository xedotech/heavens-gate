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
  return { yaw: -finiteClamped(axes.lookX, -1, 1) * speed, pitch: -finiteClamped(axes.lookY, -1, 1) * speed };
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
