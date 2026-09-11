import { DEFAULT_KEYBINDS, type KeybindAction, type Keybinds } from './types';

export function normalizeKeyBinding(value: string) {
  if (value === ' ') return ' ';
  const binding = value.trim().toLowerCase();
  if (binding === 'space' || binding === 'spacebar') return ' ';
  if (binding === 'ctrl') return 'control';
  if (binding === 'esc') return 'escape';
  return binding;
}

export function isValidKeyBinding(binding: string) {
  if (binding === ' ') return true;
  if ([...binding].length === 1) return !/\s|\p{C}/u.test(binding);
  return /^(alt|control|shift|enter|backspace|delete|insert|home|end|pageup|pagedown|arrowup|arrowdown|arrowleft|arrowright|f(?:[1-9]|1[0-2]))$/.test(binding);
}

export function assignKeybind(bindings: Keybinds, action: KeybindAction, value: string): Keybinds {
  const binding = normalizeKeyBinding(value);
  if (!isValidKeyBinding(binding)) return bindings;
  const previous = bindings[action];
  const conflict = (Object.keys(bindings) as KeybindAction[]).find((candidate) => (
    candidate !== action && bindings[candidate] === binding
  ));
  return {
    ...bindings,
    [action]: binding,
    ...(conflict ? { [conflict]: previous } : {}),
  };
}

export function mergeKeybinds(value: unknown): Keybinds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_KEYBINDS };
  const candidate = value as Partial<Keybinds>;
  const actions = Object.keys(DEFAULT_KEYBINDS) as KeybindAction[];
  const merged: Partial<Keybinds> = {};
  const used = new Set<string>();
  // Claim valid saved bindings first, so a partial remap does not also leave
  // the same key assigned to an action with that default.
  actions.forEach((action) => {
    if (typeof candidate[action] !== 'string') return;
    const binding = normalizeKeyBinding(candidate[action]);
    if (isValidKeyBinding(binding) && !used.has(binding)) {
      merged[action] = binding;
      used.add(binding);
    }
  });
  actions.forEach((action) => {
    if (merged[action]) return;
    const preferred = DEFAULT_KEYBINDS[action];
    if (!used.has(preferred)) {
      merged[action] = preferred;
      used.add(preferred);
    }
  });
  actions.forEach((action) => {
    if (merged[action]) return;
    // At most one key is claimed per action, so the default pool always has
    // enough free keys to make every remaining action reachable.
    const replacement = actions.map((entry) => DEFAULT_KEYBINDS[entry]).find((binding) => !used.has(binding))!;
    merged[action] = replacement;
    used.add(replacement);
  });
  return merged as Keybinds;
}
