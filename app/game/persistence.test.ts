import { describe, expect, it } from 'vitest';
import {
  createCheckpoint, eraseSaves, normalizeSave, normalizeSettings, readSave, readSettings,
  SAVE_BACKUP_KEY, SAVE_KEY, SETTINGS_KEY, writeSave, writeSettings, retrySettings, type StorageAccess,
} from './persistence';
import { DEFAULT_SETTINGS, MISSIONS, type SaveState } from './types';

function checkpoint(patch: Partial<SaveState> = {}): SaveState {
  return {
    version: 1, missionIndex: 0, health: 87, armor: 24, ammo: 11, reserveAmmo: 102,
    resonance: 71, defeatedWardens: 0, echoesActivated: [], elapsed: 80.5,
    updatedAt: 1788480000000, ...patch,
  };
}

class TestStorage implements StorageAccess {
  values = new Map<string, string>();
  blockedWrites = new Set<string>();
  blockedReads = false;
  blockedRemovals = false;
  writes: string[] = [];
  getItem(key: string) {
    if (this.blockedReads) throw new Error('Storage blocked');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.blockedWrites.has(key)) throw new Error('Quota exceeded');
    this.writes.push(key);
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.blockedRemovals) throw new Error('Storage blocked');
    this.values.delete(key);
  }
}

describe('persisted settings validation', () => {
  it('recovers untouched preferences after temporarily unavailable boot storage', () => {
    const storage = new TestStorage();
    const customized = normalizeSettings({ highContrast: true, volume: 0.23, keybinds: { inspect: 'o' } });
    storage.values.set(SETTINGS_KEY, JSON.stringify(customized));
    storage.blockedReads = true;
    const boot = readSettings(() => storage);
    expect(boot.status).toBe('unavailable');
    storage.blockedReads = false;
    expect(retrySettings(() => storage, boot.value!, false)).toEqual({ value: customized, status: 'loaded' });
    expect(storage.writes).toEqual([]);
  });

  it('persists intentional session edits when retrying and preserves them if still blocked', () => {
    const storage = new TestStorage();
    const edited = normalizeSettings({ highContrast: true, reducedMotion: true });
    storage.blockedWrites.add(SETTINGS_KEY);
    expect(retrySettings(() => storage, edited, true)).toEqual({ value: edited, status: 'unavailable' });
    storage.blockedWrites.clear();
    expect(retrySettings(() => storage, edited, true)).toEqual({ value: edited, status: 'saved' });
    expect(readSettings(() => storage).value).toEqual(edited);
  });

  it('migrates older settings with independent defaults and ignores unknown properties', () => {
    const normalized = normalizeSettings({ quality: 'low', volume: 0.3, unknown: true });
    expect(normalized).toEqual({ ...DEFAULT_SETTINGS, quality: 'low', volume: 0.3 });
    expect(normalized.keybinds).not.toBe(DEFAULT_SETTINGS.keybinds);
  });

  it('validates every enum, boolean and numeric range without coercing strings', () => {
    const normalized = normalizeSettings({
      quality: 'ultra', characterSkin: '__proto__', difficulty: null, volume: -4,
      sensitivity: Infinity, hudScale: 8, subtitles: 'false', reducedMotion: true, highContrast: 1,
    });
    expect(normalized).toMatchObject({
      quality: 'high', characterSkin: 'seraph', difficulty: 'normal', volume: 0,
      sensitivity: DEFAULT_SETTINGS.sensitivity, hudScale: 1.3, subtitles: true,
      reducedMotion: true, highContrast: false,
    });
    expect(normalizeSettings({ volume: '0.1', hudScale: NaN })).toMatchObject({ volume: 0.72, hudScale: 1 });
  });

  it.each([null, [], 'text', 12, false])('handles non-record settings: %j', (value) => {
    expect(normalizeSettings(value)).toEqual(DEFAULT_SETTINGS);
  });

  it('recovers malformed JSON and blocked storage without throwing', () => {
    const storage = new TestStorage();
    storage.values.set(SETTINGS_KEY, '{broken');
    expect(readSettings(() => storage)).toEqual({ value: DEFAULT_SETTINGS, status: 'invalid' });
    expect(readSettings(() => { throw new Error('SecurityError'); })).toEqual({ value: DEFAULT_SETTINGS, status: 'unavailable' });
    storage.blockedWrites.add(SETTINGS_KEY);
    expect(writeSettings(() => storage, DEFAULT_SETTINGS)).toEqual({ status: 'unavailable' });
  });
});

describe('checkpoint validation and repair', () => {
  it('round-trips all mission checkpoints and both endings', () => {
    for (let missionIndex = 0; missionIndex < MISSIONS.length - 1; missionIndex += 1) {
      const save = checkpoint({ missionIndex });
      expect(normalizeSave(save)).toEqual(save);
    }
    for (const ending of ['open', 'seal'] as const) {
      const save = checkpoint({ missionIndex: 7, ending });
      expect(normalizeSave(save)).toEqual(save);
    }
  });

  it.each([-1, 8, 0.5, NaN, Infinity, '2', null])('rejects invalid mission index %j', (missionIndex) => {
    expect(normalizeSave({ ...checkpoint(), missionIndex })).toBeNull();
  });

  it('rejects unknown save versions and non-records', () => {
    for (const value of [null, [], 'save', { ...checkpoint(), version: 0 }, { ...checkpoint(), version: 2 }]) {
      expect(normalizeSave(value)).toBeNull();
    }
  });

  it('repairs invalid resources without losing the mission or valid echoes', () => {
    const save = normalizeSave({
      ...checkpoint({ missionIndex: 4 }), health: NaN, armor: 800, ammo: -1,
      reserveAmmo: Infinity, resonance: 'empty', defeatedWardens: 500,
      elapsed: -10, updatedAt: 'yesterday', echoesActivated: ['echo-truth', 'echo-truth', {}, 'unknown', 'echo-name'],
    });
    expect(save).toMatchObject({ missionIndex: 4, health: 100, armor: 90, ammo: 0, reserveAmmo: 126,
      resonance: 100, defeatedWardens: 5, elapsed: 0, updatedAt: 0, echoesActivated: ['echo-truth', 'echo-name'] });
    expect(normalizeSave({ version: 1, missionIndex: 3 })).toMatchObject({ missionIndex: 3, health: 100 });
  });

  it('repairs the historical lost-ending bug by reopening only the last choice', () => {
    expect(normalizeSave(checkpoint({ missionIndex: 7 }))).toMatchObject({ missionIndex: 6, elapsed: 80.5 });
    expect(normalizeSave(checkpoint({ missionIndex: 7, ending: 'bad' as 'open' }))).toMatchObject({ missionIndex: 6 });
    expect(normalizeSave(checkpoint({ missionIndex: 2, ending: 'open' }))).not.toHaveProperty('ending');
  });

  it('preserves the chosen ending across repeated epilogue checkpoints but not a new campaign', () => {
    for (const ending of ['open', 'seal'] as const) {
      const prior = checkpoint({ missionIndex: 7, ending });
      const next = createCheckpoint(checkpoint({ missionIndex: 7, health: 10 }), prior);
      expect(next).toMatchObject({ missionIndex: 7, ending, health: 35 });
      expect(createCheckpoint(checkpoint({ missionIndex: 7 }), next)).toMatchObject({ ending, missionIndex: 7 });
      expect(createCheckpoint(checkpoint(), prior)).not.toHaveProperty('ending');
    }
  });
});

describe('safe checkpoint storage', () => {
  it('distinguishes a first launch from corrupt and unavailable storage', () => {
    const storage = new TestStorage();
    expect(readSave(() => storage)).toEqual({ value: null, status: 'empty' });
    storage.values.set(SAVE_KEY, 'null');
    expect(readSave(() => storage)).toEqual({ value: null, status: 'invalid' });
    storage.blockedReads = true;
    expect(readSave(() => storage)).toEqual({ value: null, status: 'unavailable' });
    expect(readSave(() => { throw new Error('SecurityError'); })).toEqual({ value: null, status: 'unavailable' });
  });

  it('writes an initial backup and keeps the previous good checkpoint on subsequent writes', () => {
    const storage = new TestStorage();
    const first = checkpoint();
    const next = checkpoint({ missionIndex: 1, updatedAt: first.updatedAt + 1000 });
    expect(writeSave(() => storage, first)).toEqual({ status: 'saved', backupAvailable: true });
    expect(JSON.parse(storage.getItem(SAVE_BACKUP_KEY)!)).toEqual(first);
    expect(writeSave(() => storage, next)).toEqual({ status: 'saved', backupAvailable: true });
    expect(readSave(() => storage)).toEqual({ status: 'loaded', value: next });
    expect(JSON.parse(storage.getItem(SAVE_BACKUP_KEY)!)).toEqual(first);
  });

  it('recovers a corrupt or missing primary from backup without mutation', () => {
    const storage = new TestStorage();
    const save = checkpoint({ missionIndex: 4, echoesActivated: ['echo-mercy'] });
    storage.values.set(SAVE_BACKUP_KEY, JSON.stringify(save));
    for (const primary of [null, '{broken', JSON.stringify({ version: 1, missionIndex: 999 })]) {
      if (primary === null) storage.values.delete(SAVE_KEY);
      else storage.values.set(SAVE_KEY, primary);
      expect(readSave(() => storage)).toEqual({ status: 'recovered', value: save });
      expect(storage.writes).toHaveLength(0);
    }
  });

  it('does not replace a good backup with corrupt primary data', () => {
    const storage = new TestStorage();
    const backup = checkpoint({ missionIndex: 2 });
    storage.values.set(SAVE_KEY, '{broken');
    storage.values.set(SAVE_BACKUP_KEY, JSON.stringify(backup));
    expect(writeSave(() => storage, checkpoint({ missionIndex: 3 })).status).toBe('saved');
    expect(JSON.parse(storage.getItem(SAVE_BACKUP_KEY)!)).toEqual(backup);
  });

  it('protects checkpoints from newer versions, including backup files', () => {
    const storage = new TestStorage();
    const future = JSON.stringify({ version: 2, missionIndex: 1 });
    storage.values.set(SAVE_KEY, future);
    storage.values.set(SAVE_BACKUP_KEY, JSON.stringify(checkpoint()));
    expect(readSave(() => storage)).toEqual({ status: 'unsupported', value: null });
    expect(writeSave(() => storage, checkpoint())).toEqual({ status: 'unsupported' });
    expect(storage.getItem(SAVE_KEY)).toBe(future);
    expect(storage.writes).toHaveLength(0);
    storage.values.set(SAVE_KEY, JSON.stringify(checkpoint()));
    storage.values.set(SAVE_BACKUP_KEY, future);
    expect(writeSave(() => storage, checkpoint())).toEqual({ status: 'unsupported' });
  });

  it('keeps the primary intact when quota is exceeded, and permits a later retry', () => {
    const storage = new TestStorage();
    const first = checkpoint();
    const second = checkpoint({ missionIndex: 2 });
    writeSave(() => storage, first);
    storage.blockedWrites.add(SAVE_KEY);
    expect(writeSave(() => storage, second)).toEqual({ status: 'unavailable' });
    expect(readSave(() => storage).value).toEqual(first);
    storage.blockedWrites.clear();
    expect(writeSave(() => storage, second).status).toBe('saved');
    expect(readSave(() => storage).value).toEqual(second);
  });

  it('reports backup failure without blocking an atomic primary write', () => {
    const storage = new TestStorage();
    storage.blockedWrites.add(SAVE_BACKUP_KEY);
    expect(writeSave(() => storage, checkpoint())).toEqual({ status: 'saved', backupAvailable: false });
    expect(readSave(() => storage).value).toEqual(checkpoint());
  });

  it('does not write an invalid save or throw when the storage getter is blocked', () => {
    const storage = new TestStorage();
    expect(writeSave(() => storage, checkpoint({ missionIndex: NaN }))).toEqual({ status: 'invalid' });
    expect(storage.writes).toHaveLength(0);
    expect(writeSave(() => { throw new Error('SecurityError'); }, checkpoint())).toEqual({ status: 'unavailable' });
  });

  it('erases only this game checkpoint and backup, preserving settings and other apps', () => {
    const storage = new TestStorage();
    writeSave(() => storage, checkpoint());
    storage.values.set(SETTINGS_KEY, 'settings');
    storage.values.set('other-app', 'unchanged');
    expect(eraseSaves(() => storage)).toBe(true);
    expect(readSave(() => storage).status).toBe('empty');
    expect(storage.getItem(SETTINGS_KEY)).toBe('settings');
    expect(storage.getItem('other-app')).toBe('unchanged');
    storage.blockedRemovals = true;
    expect(eraseSaves(() => storage)).toBe(false);
  });
});
