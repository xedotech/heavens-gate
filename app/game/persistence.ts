import { MORROW_SPEC, WEAPONS, WEAPON_ORDER } from './combat';
import { mergeGamepadBinds } from './input';
import { mergeKeybinds } from './keybinds';
import { UPGRADE_IDS } from './upgrades';
import { DEFAULT_SETTINGS, MISSIONS, type GameSettings, type SaveState, type WeaponId } from './types';

export const SAVE_KEY = 'heavens-gate-save-v1';
export const SAVE_BACKUP_KEY = 'heavens-gate-save-v1-backup';
export const SETTINGS_KEY = 'heavens-gate-settings-v1';
const ECHO_IDS = new Set(['echo-mercy', 'echo-truth', 'echo-name']);
export const SIGIL_IDS = new Set([
  'sigil-spire-plaza', 'sigil-south-gate', 'sigil-chapel', 'sigil-docks',
  'sigil-gardens', 'sigil-north-ridge', 'sigil-east-verge', 'sigil-west-hollow',
]);
const FINAL_MISSION = MISSIONS.length - 1;

export interface StorageAccess {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Accessing window.localStorage itself can throw, before getItem is called.
export type StorageProvider = () => StorageAccess;
export type ReadStatus = 'loaded' | 'repaired' | 'recovered' | 'empty' | 'invalid' | 'unsupported' | 'unavailable';
export interface StorageRead<T> { value: T | null; status: ReadStatus }
export type WriteResult = { status: 'saved'; backupAvailable?: boolean } | { status: 'unavailable' | 'unsupported' | 'invalid' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, fallback: number, min: number, max: number, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.floor(bounded) : bounded;
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && options.includes(value as T) ? value as T : fallback;
}

export function normalizeSettings(value: unknown): GameSettings {
  const source = record(value) ? value : {};
  return {
    quality: choice(source.quality, ['low', 'medium', 'high', 'ultra'], DEFAULT_SETTINGS.quality),
    volume: finite(source.volume, DEFAULT_SETTINGS.volume, 0, 1),
    sensitivity: finite(source.sensitivity, DEFAULT_SETTINGS.sensitivity, 0.2, 1.4),
    fov: finite(source.fov, DEFAULT_SETTINGS.fov, 48, 78),
    hudScale: finite(source.hudScale, DEFAULT_SETTINGS.hudScale, 0.8, 1.3),
    subtitles: typeof source.subtitles === 'boolean' ? source.subtitles : DEFAULT_SETTINGS.subtitles,
    subtitleSize: choice(source.subtitleSize, ['standard', 'large'], DEFAULT_SETTINGS.subtitleSize),
    aimAssist: typeof source.aimAssist === 'boolean' ? source.aimAssist : DEFAULT_SETTINGS.aimAssist,
    aimToggle: typeof source.aimToggle === 'boolean' ? source.aimToggle : DEFAULT_SETTINGS.aimToggle,
    rotateMinimap: typeof source.rotateMinimap === 'boolean' ? source.rotateMinimap : DEFAULT_SETTINGS.rotateMinimap,
    reducedMotion: typeof source.reducedMotion === 'boolean' ? source.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    highContrast: typeof source.highContrast === 'boolean' ? source.highContrast : DEFAULT_SETTINGS.highContrast,
    difficulty: choice(source.difficulty, ['story', 'normal', 'ascendant'], DEFAULT_SETTINGS.difficulty),
    characterSkin: choice(source.characterSkin, ['seraph', 'relic', 'nocturne', 'ash', 'meridian', 'voidborn'], DEFAULT_SETTINGS.characterSkin),
    keybinds: mergeKeybinds(source.keybinds),
    gamepadBinds: mergeGamepadBinds(source.gamepadBinds),
  };
}

// Scene-beat flags stay strictly optional: absent stays absent, and keys this
// build doesn't know are dropped rather than carried forward blindly.
function normalizeNarrative(value: Record<string, unknown>): SaveState['narrative'] | undefined {
  const narrative: NonNullable<SaveState['narrative']> = {};
  if (typeof value.senaDelivered === 'boolean') narrative.senaDelivered = value.senaDelivered;
  if (typeof value.senaAsked === 'boolean') narrative.senaAsked = value.senaAsked;
  if (typeof value.cordonSeen === 'boolean') narrative.cordonSeen = value.cordonSeen;
  if (typeof value.voxHeard === 'boolean') narrative.voxHeard = value.voxHeard;
  if (typeof value.exitReleased === 'boolean') narrative.exitReleased = value.exitReleased;
  if (typeof value.aftermathHeard === 'boolean') narrative.aftermathHeard = value.aftermathHeard;
  if (typeof value.seraphHeard === 'boolean') narrative.seraphHeard = value.seraphHeard;
  if (typeof value.chapelWitnessed === 'boolean') narrative.chapelWitnessed = value.chapelWitnessed;
  if (typeof value.relicSeen === 'boolean') narrative.relicSeen = value.relicSeen;
  if (typeof value.undergateTouched === 'boolean') narrative.undergateTouched = value.undergateTouched;
  return Object.keys(narrative).length ? narrative : undefined;
}

function normalizeWeaponAmmo(value: Record<string, unknown>): SaveState['weaponAmmo'] {
  const pools: NonNullable<SaveState['weaponAmmo']> = {};
  WEAPON_ORDER.forEach((id) => {
    const entry = value[id];
    if (!record(entry)) return;
    const spec = WEAPONS[id];
    pools[id] = {
      ammo: finite(entry.ammo, spec.magazineSize, 0, spec.magazineSize, true),
      reserve: finite(entry.reserve, spec.startingReserve, 0, Number.MAX_SAFE_INTEGER, true),
    };
  });
  return pools;
}

/** Preserve v1 progress while repairing resource fields; never guess an unknown version. */
export function normalizeSave(value: unknown): SaveState | null {
  if (!record(value) || value.version !== 1 || !Number.isInteger(value.missionIndex)) return null;
  const index = value.missionIndex as number;
  if (index < 0 || index > FINAL_MISSION) return null;
  const ending = index === FINAL_MISSION && (value.ending === 'open' || value.ending === 'seal') ? value.ending : undefined;
  // Older builds could drop the ending on a free-roam re-save. Return to the
  // decision, without inventing the player's choice or resetting the campaign.
  const missionIndex = index === FINAL_MISSION && !ending ? FINAL_MISSION - 1 : index;
  const weaponId = choice(value.weaponId, WEAPON_ORDER, 'morrow') as WeaponId;
  const magazine = WEAPONS[weaponId]?.magazineSize ?? MORROW_SPEC.magazineSize;
  return {
    version: 1,
    missionIndex,
    health: finite(value.health, 100, 1, 130, true),
    armor: finite(value.armor, 50, 0, 90, true),
    ...(value.shards !== undefined ? { shards: finite(value.shards, 0, 0, Number.MAX_SAFE_INTEGER, true) } : {}),
    ...(value.upgrades !== undefined ? {
      upgrades: Array.isArray(value.upgrades)
        ? [...new Set(value.upgrades.filter((id): id is string => typeof id === 'string' && UPGRADE_IDS.has(id)))]
        : [],
    } : {}),
    ammo: finite(value.ammo, magazine, 0, magazine, true),
    reserveAmmo: finite(value.reserveAmmo, 126, 0, Number.MAX_SAFE_INTEGER, true),
    ...(value.weaponId !== undefined ? { weaponId } : {}),
    ...(record(value.weaponAmmo) ? { weaponAmmo: normalizeWeaponAmmo(value.weaponAmmo) } : {}),
    resonance: finite(value.resonance, 100, 0, 100, true),
    defeatedWardens: finite(value.defeatedWardens, 0, 0, 5, true),
    echoesActivated: Array.isArray(value.echoesActivated)
      ? [...new Set(value.echoesActivated.filter((id): id is string => typeof id === 'string' && ECHO_IDS.has(id)))]
      : [],
    ...(value.sigilsCollected !== undefined ? {
      sigilsCollected: Array.isArray(value.sigilsCollected)
        ? [...new Set(value.sigilsCollected.filter((id): id is string => typeof id === 'string' && SIGIL_IDS.has(id)))]
        : [],
    } : {}),
    ...(value.replays !== undefined ? { replays: finite(value.replays, 0, 0, 9, true) } : {}),
    elapsed: finite(value.elapsed, 0, 0, Number.MAX_SAFE_INTEGER / 1000),
    ...(ending ? { ending } : {}),
    ...(record(value.narrative) && normalizeNarrative(value.narrative) ? { narrative: normalizeNarrative(value.narrative) } : {}),
    updatedAt: finite(value.updatedAt, 0, 0, 8.64e15, true),
  };
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && right.every((value, index) => equalValue(left[index], value));
  if (record(left) && record(right)) return Object.keys(left).length === Object.keys(right).length && Object.entries(right).every(([key, value]) => equalValue(left[key], value));
  return false;
}

function repaired(source: unknown, normalized: object) {
  if (!record(source)) return true;
  return Object.entries(normalized).some(([key, value]) => !equalValue(source[key], value));
}

function decodeSave(raw: string | null): StorageRead<SaveState> {
  if (raw === null) return { value: null, status: 'empty' };
  try {
    const source: unknown = JSON.parse(raw);
    if (record(source) && typeof source.version === 'number' && source.version > 1) {
      return { value: null, status: 'unsupported' };
    }
    const value = normalizeSave(source);
    return value ? { value, status: repaired(source, value) ? 'repaired' : 'loaded' } : { value: null, status: 'invalid' };
  } catch {
    return { value: null, status: 'invalid' };
  }
}

export function readSave(provider: StorageProvider): StorageRead<SaveState> {
  try {
    const storage = provider();
    const primary = decodeSave(storage.getItem(SAVE_KEY));
    if (primary.value || primary.status === 'unsupported') return primary;
    const backup = decodeSave(storage.getItem(SAVE_BACKUP_KEY));
    if (backup.status === 'unsupported') return backup;
    if (backup.value) return { value: backup.value, status: 'recovered' };
    return { value: null, status: primary.status === 'empty' && backup.status === 'empty' ? 'empty' : 'invalid' };
  } catch {
    return { value: null, status: 'unavailable' };
  }
}

export function readSettings(provider: StorageProvider): StorageRead<GameSettings> {
  try {
    const raw = provider().getItem(SETTINGS_KEY);
    if (raw === null) return { value: normalizeSettings(null), status: 'empty' };
    const source: unknown = JSON.parse(raw);
    const value = normalizeSettings(source);
    return { value, status: repaired(source, value) ? 'repaired' : 'loaded' };
  } catch (error) {
    return { value: normalizeSettings(null), status: error instanceof SyntaxError ? 'invalid' : 'unavailable' };
  }
}

export function writeSave(provider: StorageProvider, candidate: SaveState): WriteResult {
  const save = normalizeSave(candidate);
  if (!save) return { status: 'invalid' };
  try {
    const storage = provider();
    const previous = decodeSave(storage.getItem(SAVE_KEY));
    const backup = decodeSave(storage.getItem(SAVE_BACKUP_KEY));
    // Automatic saves must never downgrade a checkpoint from a newer build.
    if (previous.status === 'unsupported' || backup.status === 'unsupported') return { status: 'unsupported' };
    let backupAvailable = Boolean(backup.value);
    try {
      if (previous.value || !backup.value) {
        storage.setItem(SAVE_BACKUP_KEY, JSON.stringify(previous.value ?? save));
        backupAvailable = true;
      }
    } catch {
      // The primary setItem is atomic. A full quota must not erase the last
      // primary checkpoint, nor prevent a smaller primary write from succeeding.
    }
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return { status: 'saved', backupAvailable };
  } catch {
    return { status: 'unavailable' };
  }
}

export function writeSettings(provider: StorageProvider, settings: GameSettings): WriteResult {
  try {
    provider().setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return { status: 'saved' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Untouched boot fallbacks must not overwrite preferences recovered later. */
export function retrySettings(provider: StorageProvider, current: GameSettings, hasSessionEdits: boolean) {
  if (!hasSessionEdits) return readSettings(provider);
  const result = writeSettings(provider, current);
  return { value: current, status: result.status };
}

export function eraseSaves(provider: StorageProvider): boolean {
  try {
    const storage = provider();
    storage.removeItem(SAVE_BACKUP_KEY);
    storage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function createCheckpoint(candidate: SaveState, previous: SaveState | null): SaveState | null {
  return normalizeSave({
    ...candidate,
    health: Math.max(35, candidate.health),
    ending: candidate.missionIndex === FINAL_MISSION
      ? candidate.ending ?? (previous?.missionIndex === FINAL_MISSION ? previous.ending : undefined)
      : undefined,
  });
}

export function saveReadNotice(status: ReadStatus): string | null {
  switch (status) {
    case 'recovered': return 'Recovered the backup checkpoint. Progress after that checkpoint may be missing.';
    case 'repaired': return 'Repaired unsupported checkpoint values. If an older save lost its ending, the final decision is available again.';
    case 'invalid': return 'The checkpoint could not be read. You can begin a new campaign; the stored data has not been erased.';
    case 'unsupported': return 'This checkpoint belongs to a newer save format. This build will not overwrite it; new progress is session-only.';
    case 'unavailable': return 'Browser storage is unavailable. You can play, but progress is session-only until saving succeeds.';
    default: return null;
  }
}

export function saveWriteNotice(result: WriteResult): string | null {
  if (result.status === 'saved') return result.backupAvailable === false ? 'Checkpoint saved, but a backup copy could not be stored.' : null;
  if (result.status === 'unsupported') return saveReadNotice('unsupported');
  return 'Checkpoint not saved to this browser. This session keeps your progress; retry before closing the game.';
}
