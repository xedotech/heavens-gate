import { describe, expect, it } from 'vitest';
import { assignKeybind, isValidKeyBinding, mergeKeybinds, normalizeKeyBinding } from './keybinds';
import { DEFAULT_KEYBINDS } from './types';

describe('keyboard bindings', () => {
  it('normalizes common browser key labels', () => {
    expect(normalizeKeyBinding(' Space ')).toBe(' ');
    expect(normalizeKeyBinding(' ')).toBe(' ');
    expect(normalizeKeyBinding('Spacebar')).toBe(' ');
    expect(normalizeKeyBinding('CTRL')).toBe('control');
    expect(normalizeKeyBinding('Esc')).toBe('escape');
  });

  it('swaps a conflicting action without dropping reachability', () => {
    const next = assignKeybind(DEFAULT_KEYBINDS, 'moveForward', 's');
    expect(next.moveForward).toBe('s');
    expect(next.moveBackward).toBe('w');
    expect(Object.values(next)).toHaveLength(new Set(Object.values(next)).size);
  });

  it('rejects reserved keys and repairs partial stored settings', () => {
    expect(assignKeybind(DEFAULT_KEYBINDS, 'jump', 'Escape')).toEqual(DEFAULT_KEYBINDS);
    expect(mergeKeybinds({ moveForward: 'Z', jump: 'tab', inspect: 4 })).toMatchObject({
      moveForward: 'z',
      jump: ' ',
      inspect: 'p',
    });
  });

  it('binds a physical Space key without losing the displaced action', () => {
    const next = assignKeybind(DEFAULT_KEYBINDS, 'reload', ' ');
    expect(next.reload).toBe(' ');
    expect(next.jump).toBe('r');
    expect(DEFAULT_KEYBINDS.jump).toBe(' ');
    expect(mergeKeybinds(next)).toEqual(next);
  });

  it('repairs duplicate saved keys while preserving a partial remap', () => {
    const next = mergeKeybinds({ moveForward: 's', moveBackward: 's', reload: 'Z', veil: 'z' });
    expect(next.moveForward).toBe('s');
    expect(next.reload).toBe('z');
    expect(new Set(Object.values(next)).size).toBe(Object.keys(DEFAULT_KEYBINDS).length);
    expect(next.moveBackward).not.toBe('s');
    expect(next.veil).not.toBe('z');
  });

  it('keeps unique keys for heavily conflicting or corrupt settings', () => {
    for (const key of [...Object.values(DEFAULT_KEYBINDS), 'z', 'Unidentified', '', '\t', 'a'.repeat(100)]) {
      const source = Object.fromEntries(Object.keys(DEFAULT_KEYBINDS).map((action) => [action, key]));
      const next = mergeKeybinds(source);
      expect(new Set(Object.values(next)).size).toBe(Object.keys(DEFAULT_KEYBINDS).length);
      expect(Object.values(next).every(isValidKeyBinding)).toBe(true);
      expect(mergeKeybinds(next)).toEqual(next);
    }
    expect(mergeKeybinds([])).toEqual(DEFAULT_KEYBINDS);
    expect(mergeKeybinds(null)).toEqual(DEFAULT_KEYBINDS);
  });

  it('ignores reserved, composition-only, and unknown labels', () => {
    for (const key of ['Escape', 'Tab', 'Dead', 'Unidentified', 'Process', 'Meta', '   ', '\n', 'made-up-key']) {
      expect(assignKeybind(DEFAULT_KEYBINDS, 'jump', key)).toEqual(DEFAULT_KEYBINDS);
    }
    expect(assignKeybind(DEFAULT_KEYBINDS, 'jump', 'ArrowUp').jump).toBe('arrowup');
    expect(assignKeybind(DEFAULT_KEYBINDS, 'jump', 'é').jump).toBe('é');
  });
});
