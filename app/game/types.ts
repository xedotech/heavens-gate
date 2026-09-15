import type { Vector3 } from 'three';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type Difficulty = 'story' | 'normal' | 'ascendant';
export type CharacterSkin = 'seraph' | 'relic' | 'nocturne' | 'ash' | 'meridian' | 'voidborn';
export type WeaponId = 'morrow' | 'psalm' | 'vesper';
export type KeybindAction =
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'crouch'
  | 'dodge'
  | 'jump'
  | 'reload'
  | 'veil'
  | 'pulse'
  | 'weaponSwap'
  | 'melee'
  | 'throwCharge'
  | 'shoulderSwap'
  | 'interact'
  | 'inspect';

export interface Keybinds {
  moveForward: string;
  moveBackward: string;
  moveLeft: string;
  moveRight: string;
  sprint: string;
  crouch: string;
  dodge: string;
  jump: string;
  reload: string;
  veil: string;
  pulse: string;
  weaponSwap: string;
  melee: string;
  throwCharge: string;
  shoulderSwap: string;
  interact: string;
  inspect: string;
}
export type ScreenState =
  | 'title'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'settings'
  | 'codex'
  | 'gameover'
  | 'choice'
  | 'ending'
  | 'credits';

export type GamepadBinds = Partial<Record<KeybindAction, number>>;

export interface GameSettings {
  quality: Quality;
  volume: number;
  sensitivity: number;
  fov: number;
  hudScale: number;
  subtitles: boolean;
  subtitleSize: 'standard' | 'large';
  aimAssist: boolean;
  /** When on, clicking aim toggles ADS instead of holding it. */
  aimToggle: boolean;
  rotateMinimap: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  difficulty: Difficulty;
  characterSkin: CharacterSkin;
  keybinds: Keybinds;
  /** Gamepad button-index overrides; absent actions use the default map. */
  gamepadBinds: GamepadBinds;
}

export interface SaveState {
  version: 1;
  missionIndex: number;
  health: number;
  armor: number;
  shards?: number;
  upgrades?: string[];
  ammo: number;
  reserveAmmo: number;
  weaponId?: WeaponId;
  weaponAmmo?: Partial<Record<WeaponId, { ammo: number; reserve: number }>>;
  resonance: number;
  defeatedWardens: number;
  echoesActivated: string[];
  sigilsCollected?: string[];
  replays?: number;
  elapsed: number;
  ending?: 'open' | 'seal';
  /** Scene-beat flags — additive and optional so older saves load unchanged. */
  narrative?: {
    senaDelivered?: boolean;
    senaAsked?: boolean;
  };
  updatedAt: number;
}

export interface HUDState {
  health: number;
  armor: number;
  stamina: number;
  stance: 'standing' | 'crouched' | 'sliding' | 'dodging' | 'cover';
  ammo: number;
  reserveAmmo: number;
  weapon: string;
  resonance: number;
  shards: number;
  upgrades: string[];
  heat: number;
  heatTier: number;
  vehicleSpeed: number;
  inVehicle: boolean;
  veilActive: boolean;
  veilCooldown: number;
  pulseCooldown: number;
  objectiveTitle: string;
  objectiveText: string;
  objectiveProgress: number;
  objectiveDistance: number | null;
  district: string;
  timeLabel: string;
  fps: number;
  aiming: boolean;
  reticleSpread: number;
  reticleHit: boolean;
  reticleKill: boolean;
  lowHealth: boolean;
  hitDamage: number | null;
  hitDamageSeq: number;
  reloading: boolean;
  damageFlash: number;
  hitStop: boolean;
  damageDirection: number | null;
  bossHealth: number | null;
  cinematic: boolean;
  stats: {
    kills: number;
    shots: number;
    hits: number;
    distanceDriven: number;
    sigils: number;
    sigilsTotal: number;
  };
}

export interface MapPoint {
  x: number;
  z: number;
  kind: 'player' | 'objective' | 'hostile' | 'civilian' | 'vehicle' | 'gate' | 'sigil' | 'echo';
  rotation?: number;
}

export interface MapSnapshot {
  points: MapPoint[];
  worldSize: number;
}

export interface SubtitleLine {
  id: number;
  speaker: string;
  text: string;
  duration?: number;
}

export interface ToastMessage {
  id: number;
  title: string;
  detail?: string;
  tone?: 'info' | 'success' | 'danger';
}

export interface InteractionPrompt {
  label: string;
  action: string;
}

export interface DialogueChoiceOption {
  /** Key hint shown on the option chip (e.g. "E / Y"). */
  action: string;
  label: string;
  detail?: string;
}

export interface DialogueChoicePrompt {
  prompt: string;
  options: DialogueChoiceOption[];
}

export type MissionKind = 'reach' | 'eliminate' | 'vehicle' | 'drive' | 'echoes' | 'boss' | 'choice' | 'complete';

export interface MissionDefinition {
  id: string;
  act: string;
  title: string;
  summary: string;
  kind: MissionKind;
  target?: [number, number, number];
  radius?: number;
  count?: number;
  briefing: string[];
  completionLine: string;
}

export interface EngineCallbacks {
  onReady: () => void;
  onLoadProgress: (progress: number, label: string) => void;
  onHUD: (hud: HUDState, map: MapSnapshot) => void;
  onSubtitle: (line: SubtitleLine) => void;
  onToast: (toast: ToastMessage) => void;
  onInteraction: (prompt: InteractionPrompt | null) => void;
  onPauseRequested: () => void;
  onGameOver: () => void;
  onChoiceRequested: () => void;
  /** Small in-HUD dialogue picker — null dismisses it. Optional so embedders can ignore it. */
  onDialogueChoice?: (choice: DialogueChoicePrompt | null) => void;
  onCampaignComplete: (ending: 'open' | 'seal') => void;
  onError: (message: string) => void;
  onSave: (save: SaveState) => void;
}

export interface WorldEntity {
  id: string;
  kind: 'enemy' | 'civilian' | 'vehicle' | 'echo' | 'boss' | 'drone';
  position: Vector3;
  health?: number;
  active: boolean;
}

export const DEFAULT_KEYBINDS: Keybinds = {
  moveForward: 'w',
  moveBackward: 's',
  moveLeft: 'a',
  moveRight: 'd',
  sprint: 'shift',
  crouch: 'c',
  dodge: 'alt',
  jump: ' ',
  reload: 'r',
  veil: 'q',
  pulse: 'f',
  weaponSwap: 'x',
  melee: 'v',
  throwCharge: 'g',
  shoulderSwap: 't',
  interact: 'e',
  inspect: 'p',
};

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'high',
  volume: 0.72,
  sensitivity: 0.65,
  fov: 56,
  hudScale: 1,
  subtitles: true,
  subtitleSize: 'standard',
  aimAssist: true,
  aimToggle: false,
  rotateMinimap: false,
  reducedMotion: false,
  highContrast: false,
  difficulty: 'normal',
  characterSkin: 'seraph',
  keybinds: DEFAULT_KEYBINDS,
  gamepadBinds: {},
};

export const INITIAL_HUD: HUDState = {
  health: 100,
  armor: 50,
  stamina: 100,
  stance: 'standing',
  ammo: 18,
  reserveAmmo: 126,
  weapon: 'Morrow / 9mm smart',
  resonance: 100,
  shards: 0,
  upgrades: [],
  heat: 0,
  heatTier: 0,
  vehicleSpeed: 0,
  inVehicle: false,
  veilActive: false,
  veilCooldown: 0,
  pulseCooldown: 0,
  objectiveTitle: 'The Bell Below',
  objectiveText: 'Reach the First Gate',
  objectiveProgress: 0,
  objectiveDistance: null,
  district: 'Crown District',
  timeLabel: '03:17',
  fps: 60,
  aiming: false,
  reticleSpread: 0,
  reticleHit: false,
  reticleKill: false,
  lowHealth: false,
  hitDamage: null,
  hitDamageSeq: 0,
  reloading: false,
  damageFlash: 0,
  hitStop: false,
  damageDirection: null,
  bossHealth: null,
  cinematic: false,
  stats: { kills: 0, shots: 0, hits: 0, distanceDriven: 0, sigils: 0, sigilsTotal: 8 },
};

export const MISSIONS: MissionDefinition[] = [
  {
    id: 'bell-below',
    act: 'Act I · The Descent',
    title: 'The Bell Below',
    summary: 'Cross Crown District and answer the gate beneath Saint Orison Station.',
    kind: 'reach',
    target: [0, 0, -54],
    radius: 10,
    briefing: [
      'Nia: Aurel, every dead frequency in the city just spoke your name.',
      'Aurel: Then let us hear what the dead want.',
    ],
    completionLine: 'The gate recognizes you. The Wardens do too.',
  },
  {
    id: 'no-saints',
    act: 'Act I · The Descent',
    title: 'No Saints in Crown',
    summary: 'Break the Warden cordon and recover the city key from their captain.',
    kind: 'eliminate',
    count: 5,
    briefing: [
      'Warden Vox: Step away from the aperture. This city has one heaven and you are not invited.',
      'Nia: Five signatures. Make the lie expensive.',
    ],
    completionLine: 'City key acquired. Every locked road is now an invitation.',
  },
  {
    id: 'borrowed-wings',
    act: 'Act II · Borrowed Heaven',
    title: 'Borrowed Wings',
    summary: 'Take a Seraph interceptor before the Choir closes the district.',
    kind: 'vehicle',
    target: [26, 0, -32],
    radius: 8,
    briefing: [
      'Nia: Gold chassis, black windows. The Choir calls it a Seraph.',
      'Aurel: Tonight it learns a new hymn.',
    ],
    completionLine: 'Seraph online. The city opens at two hundred kilometers per hour.',
  },
  {
    id: 'long-ascension',
    act: 'Act II · Borrowed Heaven',
    title: 'The Long Ascension',
    summary: 'Drive the stolen interceptor through the Meridian Gate.',
    kind: 'drive',
    target: [92, 0, 76],
    radius: 13,
    briefing: [
      'Nia: Meridian is ninety seconds from permanent lockdown.',
      'Aurel: Then we arrive in eighty-nine.',
    ],
    completionLine: 'Meridian breached. The city has begun remembering the future.',
  },
  {
    id: 'city-remembers',
    act: 'Act III · Memory War',
    title: 'A City That Remembers',
    summary: 'Enter the Veil and awaken three memory echoes hidden across Old Spine.',
    kind: 'echoes',
    count: 3,
    briefing: [
      'The Archivist: You think memory records the world. Here, memory writes it.',
      'Nia: Shift into the Veil. Find what the Choir erased.',
    ],
    completionLine: 'Three witnesses restored. The Archon can no longer hide behind history.',
  },
  {
    id: 'false-archon',
    act: 'Finale · Open Sky',
    title: 'The False Archon',
    summary: 'Return to Crown and defeat the machine wearing heaven’s voice.',
    kind: 'boss',
    target: [0, 0, -54],
    radius: 18,
    briefing: [
      'Archon: Mercy is a door I closed for your protection.',
      'Aurel: You built a cage and taught it to sing.',
    ],
    completionLine: 'The Archon falls. One decision remains.',
  },
  {
    id: 'last-door',
    act: 'Finale · Open Sky',
    title: 'The Last Door',
    summary: 'Open the gates and free every stored soul, or seal them to protect the living city.',
    kind: 'choice',
    briefing: [
      'Nia: Open it and the dead return—but Aethel may never be the same.',
      'The Archivist: Seal it and the living survive by keeping heaven imprisoned.',
    ],
    completionLine: 'The city accepts your verdict.',
  },
  {
    id: 'afterlight',
    act: 'Epilogue',
    title: 'Afterlight',
    summary: 'The story is complete. Aethel remains open for free roam.',
    kind: 'complete',
    briefing: [],
    completionLine: 'Every city is a gate. Every choice is a key.',
  },
];
