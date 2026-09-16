import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import {
  createNpcAiState,
  npcAccuracyScale,
  npcAimBloom,
  recordNpcShotFired,
  stepNpcAi,
  type NpcAiState,
  type SquadRadioSignal,
} from './ai';
import { AudioEngine } from './audio';
import { GameInputState, gamepadLookDelta, isGameplayBinding } from './input';
import { normalizeKeyBinding } from './keybinds';
import { HERO_CHARACTER_SCALE, HeroCharacter, loadHeroCharacter } from './character';
import {
  MORROW_SPEC,
  WEAPONS,
  WEAPON_ORDER,
  addShotRecoil,
  deterministicShotOffset,
  effectiveHitChance,
  recoverShotRecoil,
  shotIntervalSeconds,
  shotSpreadRadians,
  transferReload,
  weaponDamage,
  type WeaponSpec,
} from './combat';
import {
  clamp,
  cordonConeDetect,
  damp,
  difficultyDamage,
  distance2D,
  formatTime,
  heatTier,
  objectiveProgress,
  seeded,
} from './mechanics';
import {
  MOVEMENT_SPEC,
  canStartDodge,
  canStartSlide,
  movementSpeed,
  slideSpeed,
  smoothHeading,
  resolvePlanarCollision,
  sweepPlanarCollision,
  updateStamina,
} from './movement';
import { FrameTimeSampler } from './performance';
import { createCheckpoint, normalizeSave } from './persistence';
import { UPGRADES, marksForActor } from './upgrades';
import { ScannedSurfaceMaterial } from './scanned-materials';
import { createStreetDetail, fetchVerifiedAsset, loadVerifiedProp } from './props';
import { visibleInScene, withoutSubtree } from './scene-lifecycle';
import {
  INITIAL_HUD,
  MISSIONS,
  type CharacterSkin,
  type EngineCallbacks,
  type GameSettings,
  type HUDState,
  type InteractionPrompt,
  type KeybindAction,
  type MapSnapshot,
  type SaveState,
  type SubtitleLine,
  type ToastMessage,
  type WeaponId,
} from './types';

type ActorKind = 'enemy' | 'civilian' | 'drone' | 'boss';

interface Actor {
  id: string;
  kind: ActorKind;
  group: THREE.Group;
  spawn: THREE.Vector3;
  health: number;
  maxHealth: number;
  alive: boolean;
  speed: number;
  cooldown: number;
  wanderAngle: number;
  flee: number;
  materials: THREE.MeshStandardMaterial[];
  rig?: CharacterRig;
  aiState?: NpcAiState;
  damagePulse: number;
  lastDamageAmount: number;
  vignette?: 'wander' | 'idle' | 'talk' | 'lean' | 'run';
  /** Posted actors hold their spot instead of wandering or fleeing. */
  posted?: boolean;
  /** Cordon overwatch stance — true keeps the rifle raised, false low ready. */
  overwatchAim?: boolean;
  /** Facing a posted enemy eases back to while it holds the line. */
  spawnYaw?: number;
  /** Flee heading override — released civilians run the exit lane, not just away. */
  fleeHeading?: number;
  vignetteTimer?: number;
  hitReact?: number;
  hitReactSide?: number;
  lastHitAngle?: number;
  lastHitCritical?: boolean;
  /** Bulwark plate — frontal shots deflect until Pulse or a flank opens it. */
  shielded?: boolean;
  shieldMesh?: THREE.Mesh;
  shieldDownUntil?: number;
  /** Distance to the player this frame — drives animation LOD. */
  lod?: number;
  /** Accumulated delta between throttled animation steps. */
  animBudget?: number;
  /** Stride accumulation for positional footsteps — meters walked since the
   * last boot-fall. */
  stepAccum?: number;
  prevX?: number;
  prevZ?: number;
  /** Rounds left in the current magazine — enemies reload, they don't hose. */
  magAmmo?: number;
  /** Seconds until the reload finishes and the mag refills. */
  reloadTimer?: number;
}

interface CharacterRig {
  arms: THREE.Object3D[];
  legs: THREE.Object3D[];
  head: THREE.Object3D;
  chest: THREE.Object3D;
  phase: number;
  stride: number;
}

interface PlayerSkinMaterials {
  coat: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
}

interface VehicleWheel {
  pivot: THREE.Group;
  front: boolean;
}

interface VehicleSpec {
  name: string;
  top: number;
  boost: number;
  accel: number;
  steer: number;
  damageScale: number;
}

interface Vehicle {
  id: string;
  group: THREE.Group;
  spawn: THREE.Vector3;
  heading: number;
  speed: number;
  occupied: boolean;
  damage: number;
  wrecked: boolean;
  bumpDip: number;
  spec: VehicleSpec;
  smoke?: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  wheels?: VehicleWheel[];
  tailMaterial?: THREE.MeshStandardMaterial;
  beamMaterial?: THREE.MeshBasicMaterial;
  spot?: THREE.SpotLight;
}

interface TrafficCar {
  group: THREE.Group;
  axis: 'x' | 'z';
  lane: number;
  direction: 1 | -1;
  offset: number;
  spawnProgress: number;
  progress: number;
  cruise: number;
  speed: number;
  panic: number;
  damage: number;
  honkTimer: number;
  blockedFor: number;
  wrecked: boolean;
  driverFled?: boolean;
  smoke?: THREE.Group;
  wheels: VehicleWheel[];
  tailMaterial: THREE.MeshStandardMaterial;
}

interface MissionCinematic {
  start: number;
  duration: number;
  focus: THREE.Vector3;
}

interface Corpse {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  life: number;
  total: number;
  tip: number;
  /** Actors that have already spotted this body — no repeat alarms. */
  noticedBy: Set<string>;
  /** Whether the find has been radioed to the squad. */
  reported: boolean;
}

interface DropPickup {
  group: THREE.Group;
  kind: 'ammo' | 'resonance';
  life: number;
}

interface MemoryEcho {
  id: string;
  group: THREE.Group;
  activated: boolean;
}

interface GateObject {
  group: THREE.Group;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  veil: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  shaft?: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
}

interface TimedEffect {
  object: THREE.Object3D;
  life: number;
  total: number;
  mode: 'fade' | 'pulse';
  pooled?: boolean;
}

const WORLD_SIZE = 340;
const PLAYER_RADIUS = 1.05;
const veilTint = new THREE.Color(0x4a3f8a);
const SAVE_VERSION = 1 as const;

const PLAYER_SKINS: Record<CharacterSkin, { coat: number; armor: number; accent: number; skin: number; hair: number }> = {
  seraph: { coat: 0x171b1c, armor: 0x343b3d, accent: 0xc9a75a, skin: 0x8f5f47, hair: 0x171411 },
  relic: { coat: 0x392c25, armor: 0x786044, accent: 0xe2bd6a, skin: 0xb97959, hair: 0x2a1711 },
  nocturne: { coat: 0x101522, armor: 0x293750, accent: 0x91b8d6, skin: 0x6f4538, hair: 0x0e1116 },
  ash: { coat: 0x3c3a37, armor: 0x77736b, accent: 0xd86b50, skin: 0xd0a07b, hair: 0x2f2a27 },
  meridian: { coat: 0x24372e, armor: 0x426150, accent: 0xd5bd72, skin: 0x5b362d, hair: 0x131111 },
  voidborn: { coat: 0x251c32, armor: 0x4f3f68, accent: 0xe2a9ff, skin: 0x9a6651, hair: 0x1c1424 },
};

const DISTRICTS = [
  { name: 'Crown District', test: (x: number, z: number) => Math.abs(x) < 58 && z < 36 },
  { name: 'Old Spine', test: (x: number, z: number) => x < -42 && z >= 12 },
  { name: 'Gilded Docks', test: (x: number, z: number) => x >= 48 && z >= 12 },
  { name: 'Ash Gardens', test: (x: number, z: number) => x < -28 && z < -42 },
  { name: 'Meridian', test: (x: number, z: number) => x >= 32 && z < -24 },
];

const MISSION_SPAWNS: [number, number, number][] = [
  [0, 0, 34],
  [0, 0, -34],
  [16, 0, -28],
  [28, 0, -30],
  [-68, 0, 48],
  [0, 0, -38],
  [0, 0, -44],
  [0, 0, -40],
];

// Beat B/C of the opening script — the parcel exchange with Sena at Saint
// Orison's edge, then the bell that should not be able to ring.
const SENA_DELIVERY_LINES: Array<[string, string]> = [
  ['Sena', 'Set it there. Dry side.'],
  ['Aurel', 'Which side is dry?'],
  ['Sena', 'It was, this morning.'],
  ['Aurel', 'Need a signature.'],
  ['Sena', 'Mine or the name on the order?'],
  ['Aurel', 'Whoever paid for it.'],
  ['Sena', 'She did. Years ago.'],
];
const SENA_REPLY_ASKED = 'My wife. She ordered a spare for everything. I used to complain about the space.';
const SENA_REPLY_SIGNED = 'Thank you.';
const SENA_BELL_LINES: Array<[string, string]> = [
  ['Sena', 'That isn’t possible.'],
  ['Aurel', 'Power’s back?'],
  ['Sena', 'They took the bell down.'],
  ['Nia', 'Every channel. Stay where you are.'],
];
// The lamp she tends — the last one on the approach, outside the mission
// radius so the delivery plays before the gate can complete the operation.
const SENA_LAMP_SPOT = { x: 0, z: -35.6 };

// The cordon beat — a Seraph line materializes across the station approach
// ~12 s after the bell tolls. Posted guards face north (the approach the
// player walks down), rifles overwatching a marked cone each.
const CORDON_POSTS: Array<{ x: number; z: number; yaw: number; aim: boolean }> = [
  { x: -5.2, z: -44.8, yaw: 0.1, aim: true },
  { x: -1.7, z: -45.4, yaw: -0.05, aim: false },
  { x: 1.8, z: -45.2, yaw: 0.06, aim: true },
  { x: 5.3, z: -44.6, yaw: -0.12, aim: false },
];
const CORDON_BARRIERS: Array<{ x: number; y: number; z: number; yaw: number }> = [
  { x: -2.6, y: 0, z: -43.3, yaw: 0.1 },
  { x: 2.7, y: 0, z: -43.1, yaw: -0.08 },
];
// The waterline — the flank Nia reroutes the breadcrumbs to, around the
// cordon's east shoulder and into the clearing edge.
const CORDON_FLANK = { x: 12.5, z: -48 };
const CORDON_CLEARING = { x: 0, z: -54, radius: 6 };
const CORDON_CONE_RANGE = 24;
const CORDON_CONE_HALF_ANGLE = 0.62;
const CORDON_HEAT_RATE = 2.1;
const CORDON_SPAWN_DELAY = 12;

// Beat E's speaker exchange — Vox makes the cordon a civic order before the
// rifles open up. Queued once on the cordon's first commitment.
const CORDON_VOX_LINES: Array<[string, string]> = [
  ['Vox', 'Station personnel, leave through the north exit. Courier, put the receipt on the ground.'],
  ['Aurel', 'It’s paper.'],
  ['Vox', 'Then you won’t mind letting it go.'],
];
// The north-exit release: a lit lever post on the cordon's street side beside
// the east barrier; the hinged door behind it is what holds people in.
const EXIT_RELEASE_POST = { x: 4.35, z: -42.55 };
const EXIT_RELEASE_DOOR = { x: 4.55, z: -43.35, w: 1.8, h: 1.9, yaw: -0.08 };
const EXIT_RELEASE_RANGE = 3.1;
const EXIT_RELEASE_CIVILIANS = 4;
// Beat F — a held breath after the cordon resolves, then the fracture.
const AFTERMATH_QUIET = 6;
const AFTERMATH_LINES: Array<[string, string]> = [
  ['Aurel', 'What did I just carry into that station?'],
  ['Nia', 'A way into the records.'],
  ['Aurel', 'That wasn’t the question.'],
];

// The quiet Seraph — a rifle that stopped being one. He waits slumped at
// the clearing's east edge once the cordon resolves; talking is optional
// but it's the only signpost toward the chapel.
const QUIET_SERAPH_POS = { x: 7.2, z: -49.5, yaw: 2.45 };
const QUIET_SERAPH_LINES: Array<[string, string]> = [
  ['Seraph', 'You’re the courier. I’m done shooting.'],
  ['Aurel', 'That supposed to make us even?'],
  ['Seraph', 'No. It makes me tired.'],
  ['Seraph', 'They held people in the north line. I didn’t stop it.'],
  ['Seraph', 'Ask the chapel what it kept. I’m not your fight anymore.'],
  ['Aurel', 'Then stay down.'],
];
const QUIET_SERAPH_LINES_FREED: Array<[string, string]> = [
  ['Seraph', 'You’re the courier. I’m done shooting.'],
  ['Aurel', 'That supposed to make us even?'],
  ['Seraph', 'No. It makes me tired.'],
  ['Seraph', 'You let them out. Below, that counts.'],
  ['Seraph', 'Ask the chapel what it kept. I’m not your fight anymore.'],
  ['Aurel', 'Then stay down.'],
];
// The chapel witness — what the candles kept. Stands at the altar of Saint
// Orison (-72, 48), translucent, only after the Seraph points the way.
const WITNESS_POS = { x: -75.0, z: 50.6 };
const WITNESS_SPAWN_RANGE = 22;
const WITNESS_TRIGGER_RANGE = 2.6;
const WITNESS_LINES: Array<[string, string]> = [
  ['The Witness', 'Courier.'],
  ['Aurel', 'Another ghost.'],
  ['The Witness', 'She stood where you’re standing. Signed your name before you ever carried it.'],
  ['Aurel', 'Who told her it?'],
  ['The Witness', 'The bell did. It always does.'],
];

// The job board inside Saint Orison Station — repeatable contracts so free
// roam pays. Sweep jobs spawn a Warden patrol at a district point; cache
// jobs are timed runs. Rotation is session-scoped; marks persist.
const CONTRACT_BOARD = { x: 23.6, z: -52.5, range: 3.0 };
interface ContractDef {
  id: string;
  kind: 'sweep' | 'cache';
  title: string;
  brief: string;
  x: number;
  z: number;
  count?: number;
  seconds?: number;
  payout: number;
}
const CONTRACTS: ContractDef[] = [
  { id: 'sweep-docks', kind: 'sweep', title: 'Still the dock toll', brief: 'A Warden tithe-crew is taxing the Meridian piers. End it.', x: 90, z: 76, count: 3, payout: 30 },
  { id: 'cache-verge', kind: 'cache', title: 'The verge run', brief: 'A cache of pre-burn records sits at the east verge. Ninety seconds before the Choir scans it.', x: 140, z: -140, seconds: 90, payout: 35 },
  { id: 'sweep-hollow', kind: 'sweep', title: 'Hollow tithe', brief: 'Four Wardens collect in the West Hollow. The Hollow pays for their absence.', x: -140, z: -60, count: 4, payout: 40 },
  { id: 'cache-ridge', kind: 'cache', title: 'Ridge runner’s errand', brief: 'A runner’s package waits on the north ridge. Eighty seconds.', x: -82, z: 104, seconds: 80, payout: 30 },
  { id: 'sweep-gardens', kind: 'sweep', title: 'What the gardens grew', brief: 'Wardens are burning the Ash Gardens seed-vault. Stop them.', x: -112, z: 72, count: 3, payout: 30 },
];

export class HeavensGateEngine {
  readonly audio = new AudioEngine();

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: EngineCallbacks;
  private settings: GameSettings;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(58, 1, 0.08, 480);
  private lastFrameTime = performance.now();
  private renderTime = 0;
  private frame = 0;
  private initialized = false;
  private disposed = false;
  private mode: 'attract' | 'playing' = 'attract';
  private paused = false;
  private contextLost = false;
  private pointerLocked = false;

  private player = new THREE.Group();
  private playerParts: THREE.Object3D[] = [];
  private playerSkinMaterials: PlayerSkinMaterials | null = null;
  private heroCharacter: HeroCharacter | null = null;
  private heroLoadToken = 0;
  private playerVelocity = new THREE.Vector3();
  private playerHeading = 0;
  private cameraYaw = 0.12;
  private cameraPitch = 0.18;
  private photoMode = false;
  private photoFilterIndex = 0;
  private photoCamPos = new THREE.Vector3();
  private photoFov = 55;
  private bonnetCam = false;
  private readonly inspectionCenter = new THREE.Vector3(0, 2.05, 0);
  private inspectionHeight = 3.7;
  private grounded = true;
  private airTime = 0;
  private crouching = false;
  private stamina: number = MOVEMENT_SPEC.staminaMaximum;
  private slideRemaining = 0;
  private readonly slideDirection = new THREE.Vector3();
  private dodgeRemaining = 0;
  private dodgeCooldown = 0;
  private readonly dodgeDirection = new THREE.Vector3();
  private vaultTimer = 0;
  private vaultFrom = new THREE.Vector3();
  private vaultTo = new THREE.Vector3();
  private vaultPeak = 0;
  private walkPhase = 0;
  private footstepTimer = 0;

  private actors: Actor[] = [];
  private radioSignals: SquadRadioSignal[] = [];
  private vehicles: Vehicle[] = [];
  private currentVehicle: Vehicle | null = null;
  private vehicleEnter: { timer: number; total: number; vehicle: Vehicle; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private tmpUpAxis: THREE.Vector3 | null = null;
  private echoes: MemoryEcho[] = [];
  private gates: GateObject[] = [];
  private phaseMaterials: THREE.MeshStandardMaterial[] = [];
  private collisionBoxes: THREE.Box3[] = [];
  private vaultIgnore: THREE.Box3 | null = null;
  private rayTargets: THREE.Object3D[] = [];
  private scannedGround: ScannedSurfaceMaterial | null = null;
  private scannedSurfaces: ScannedSurfaceMaterial[] = [];
  private chapelStone: THREE.MeshStandardMaterial | null = null;
  private chapelStoneDark: THREE.MeshStandardMaterial | null = null;
  private chapelWood: THREE.MeshStandardMaterial | null = null;
  private propMetal: THREE.MeshStandardMaterial | null = null;
  private propRust: THREE.MeshStandardMaterial | null = null;
  private streetLamps: Array<{ x: number; z: number; armX: number; armZ: number }> = [];
  private lampParts = new Map<number, {
    head?: { mesh: THREE.InstancedMesh; local: number; color: THREE.Color };
    cone?: { mesh: THREE.InstancedMesh; local: number; matrix: THREE.Matrix4 };
    poles: Array<{ mesh: THREE.InstancedMesh; local: number }>;
  }>();
  private deadLamps = new Set<number>();
  private windowPaneHits?: Map<THREE.InstancedMesh, Map<number, THREE.Color>>;
  private readonly windowDeadColor = new THREE.Color(0x11151c);
  private readonly lampDeadColor = new THREE.Color(0x0a0c0e);
  private readonly lampLiveColor = new THREE.Color(1, 1, 1);
  private readonly lampOffScale = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
  private readonly tmpMatrix = new THREE.Matrix4();
  private hydrantSpots: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  private stoveLight: THREE.PointLight | null = null;
  private chapelWindowAnchor: THREE.Vector3 | null = null;
  private effects: TimedEffect[] = [];
  private objectiveMarker: THREE.Group | null = null;
  private dust: THREE.Points | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private sunTarget: THREE.Object3D | null = null;
  private stormLight: THREE.DirectionalLight | null = null;
  private lightningTimer = 9;
  private lightningFlash = 0;
  private reinforcementTimer = 0;
  private reinforcementSeq = 0;
  private killStreak = 0;
  private killStreakUntil = 0;
  private arrivalFlashes?: Array<{ group: THREE.Group; beamMat: THREE.MeshBasicMaterial; ringMat: THREE.MeshBasicMaterial; life: number }>;
  private playerSprinting = false;
  private pointerFallback = false;
  private weaponSway = { yaw: 0, pitch: 0 };
  private weaponKick = 0;
  private weaponInspect = 0;
  private weaponSwayParentScale = new THREE.Vector3(1, 1, 1);
  private tracerPool: THREE.Line[] = [];
  private tracerCursor = 0;
  private flashPool: THREE.Group[] = [];
  private flashCursor = 0;
  private impactPool: THREE.Group[] = [];
  private impactCursor = 0;
  private litter: {
    mesh: THREE.InstancedMesh;
    items: Array<{ x: number; z: number; y: number; vx: number; vz: number; spin: number; phase: number }>;
  } | null = null;
  private litterMatrix = new THREE.Matrix4();
  private litterPosition = new THREE.Vector3();
  private litterQuaternion = new THREE.Quaternion();
  private litterEuler = new THREE.Euler();
  private litterScale = new THREE.Vector3(1, 1, 1);
  private screechTimer = 0;
  private meleeCooldown = 0;
  private chargeCooldown = 0;
  private charges: Array<{ mesh: THREE.Mesh; light: THREE.PointLight; velocity: THREE.Vector3; timer: number; active: boolean }> = [];
  private chargeVelocity = new THREE.Vector3();
  private cameraForward = new THREE.Vector3();
  private tmpToPlayer = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private tmpPlayerDir = new THREE.Vector3();
  private tmpActorFwd = new THREE.Vector3();
  private tmpDestination = new THREE.Vector3();
  private tmpAimTarget = new THREE.Vector3();
  private tmpLosFrom = new THREE.Vector3();
  private tmpLosTo = new THREE.Vector3();
  private tmpActorFwd2 = new THREE.Vector3();
  private radioSeq = 1;
  private tmpMove = new THREE.Vector3();
  private tmpPrevPos = new THREE.Vector3();
  private tmpShotSeg = new THREE.Vector3();
  private tmpColor = new THREE.Color();
  private losDelta = new THREE.Vector3();
  private losRay = new THREE.Ray();
  private losHit = new THREE.Vector3();
  private losBox = new THREE.Box3();
  private camForward = new THREE.Vector3();
  private camRight = new THREE.Vector3();
  private camDesired = new THREE.Vector3();
  private camConstrain = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camLight = new THREE.Vector3();
  private moveForward = new THREE.Vector3();
  private moveRight = new THREE.Vector3();
  private moveDesired = new THREE.Vector3();
  private vehiclePrev = new THREE.Vector3();
  private puddleSpots: Array<{ x: number; z: number }> = [];
  private contactShadows: THREE.InstancedMesh | null = null;
  private contactShadowMatrix = new THREE.Matrix4();
  private contactShadowPosition = new THREE.Vector3();
  private contactShadowQuaternion = new THREE.Quaternion();
  private contactShadowScale = new THREE.Vector3();
  private contactShadowSources: Array<{ object: THREE.Object3D; radius: number; visible: boolean }> = [];
  private decalMesh: THREE.InstancedMesh | null = null;
  private decalCursor = 0;
  private skidMesh: THREE.InstancedMesh | null = null;
  private skidCursor = 0;
  private skidDistance = 0;
  private decalNormal = new THREE.Vector3();
  private decalQuaternion = new THREE.Quaternion();
  private decalZ = new THREE.Vector3(0, 0, 1);
  private decalMatrix = new THREE.Matrix4();
  private prevCameraYaw = 0;
  private prevCameraPitch = 0;
  private inspectionKey: THREE.PointLight | null = null;
  private skyOrb: THREE.Mesh | null = null;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtaoPass: GTAOPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private trafficCars: TrafficCar[] = [];
  private dynamicObstacles: Array<{ x: number; z: number; radius: number }> = [];
  private cinematic: MissionCinematic | null = null;
  private hitStop = 0;
  private shakeTrauma = 0;
  private rain: { mesh: THREE.InstancedMesh; drops: Float32Array; count: number } | null = null;
  private rainSplash: { mesh: THREE.InstancedMesh; ages: Float32Array; spots: Float32Array; count: number } | null = null;
  private cloudLayer: { mesh: THREE.Mesh; texture: THREE.CanvasTexture } | null = null;
  private veilMotes: { mesh: THREE.InstancedMesh; seeds: Float32Array; count: number } | null = null;
  private breadcrumb: { mesh: THREE.InstancedMesh; count: number } | null = null;
  private searchlight: { pivot: THREE.Group; coneMat: THREE.MeshBasicMaterial; lampMat: THREE.MeshBasicMaterial } | null = null;
  private corpses: Corpse[] = [];
  private drops: DropPickup[] = [];
  private envMapTexture: THREE.Texture | null = null;
  private streetEnvTexture: THREE.Texture | null = null;
  private chapelEnvTexture: THREE.Texture | null = null;
  private landDip = 0;
  private hurtKick = 0;
  private damageDirection: number | null = null;
  private damageDirectionTimer = 0;
  private touchMove = { x: 0, y: 0 };
  private touchFire = false;
  private touchAim = false;
  private touchHeld = new Set<KeybindAction>();
  private touchPressed = new Set<KeybindAction>();
  private readonly rainMatrix = new THREE.Matrix4();
  private readonly billboardTextures: THREE.CanvasTexture[] = [];

  private readonly input = new GameInputState();
  private gamepadAxes = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, aim: 0, shoot: 0 };
  private mouseShootHeld = false;
  private mouseAimHeld = false;
  private aimToggled = false;
  private shotCooldown = 0;
  private weaponRecoil = 0;
  private shotIndex = 0;
  private reloading = 0;
  private invulnerability = 0;
  private weaponId: WeaponId = 'morrow';
  private weaponPools: Partial<Record<WeaponId, { ammo: number; reserve: number }>> = {};

  private health = 100;
  private armor = 50;
  private shards = 0;
  private ownedUpgrades = new Set<string>();
  private ammo = 18;
  private reserveAmmo = 126;
  private resonance = 100;
  private heat = 0;
  private lastCombat = 0;
  private veilActive = false;
  private veilHeroStates = new Map<THREE.Material, { opacity: number; emissive: number; emissiveIntensity: number }>();
  private veilTimer = 0;
  private veilCooldown = 0;
  private veilWhisperTimer = 0;
  private chapelZone: THREE.Box3 | null = null;
  private chapelVisited = false;
  private chapelInterior = false;
  private stationZone: THREE.Box3 | null = null;
  private stationInterior = false;
  private interiorActive = false;
  private readonly groundHoles: THREE.Box3[] = [];
  private undergateLight: THREE.PointLight | null = null;
  private undergateVeil: THREE.Mesh | null = null;
  private undergatePos: THREE.Vector3 | null = null;
  private lastUndergateAt = -99;
  private jobBoardGlow: THREE.Mesh | null = null;
  private contractIndex = 0;
  private contractCooldownUntil = 0;
  private activeContract: {
    def: ContractDef;
    spawned: Actor[];
    deadline: number;
    acceptedAt: number;
  } | null = null;
  private lastAltarAt = -99;
  private streetEvent: {
    kind: 'argument' | 'breakdown' | 'preacher' | 'snatch';
    props: THREE.Object3D[];
    actorIds: string[];
    expiresAt: number;
    tailMaterial?: THREE.MeshStandardMaterial;
    chase?: { runner: string; chaser: string };
  } | null = null;
  private nextStreetEventAt = 24;
  private replays = 0;
  private chapelCandles: THREE.PointLight[] = [];
  private memorialZone: THREE.Box3 | null = null;
  private memorialMesh: THREE.Object3D | null = null;
  private memorialVisited = false;
  private sigils: Array<{ id: string; group: THREE.Group; collected: boolean }> = [];
  private sigilsCollected = new Set<string>();
  private statKills = 0;
  private statShots = 0;
  private statHits = 0;
  private statCivilians = 0;
  private statDistanceDriven = 0;
  private peekLean = 0;
  private shoulderSide = 1;
  private shoulderOffset = 0.78;
  private deathCamTimer = 0;
  private lastKiller = 'the city';
  private whizCooldown = 0;
  private casings: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3; spin: number; timer: number; active: boolean; bounced: boolean }> = [];
  private pulseCooldown = 0;
  private reticleHit = 0;
  private reticleKill = 0;
  private heartbeatTimer = 0;
  private hitDamagePool = 0;
  private hitDamageTimer = 0;
  private hitDamageSeq = 0;
  private damageFlash = 0;
  private missionIndex = 0;
  private defeatedWardens = 0;
  private echoesActivated = new Set<string>();
  private boss: Actor | null = null;
  private bossPhase = 0;
  private nextBossVoiceAt = 0;
  private bossHalo: THREE.MeshStandardMaterial | null = null;
  private choiceRequested = false;
  private missionDeadline: number | null = null;
  private gameOverSent = false;
  private elapsed = 0;
  private worldHours = 3.28;
  private lastSave: SaveState | null = null;

  // The Bell Below scene state: `narrative` is the persisted slice; the rest
  // are per-session timers so the bell beat can never double-fire.
  private sena: Actor | null = null;
  private senaLamp: THREE.Vector3 | null = null;
  private narrative: NonNullable<SaveState['narrative']> = {};
  private senaChoiceOpen = false;
  private senaChoiceAt = 0;
  private senaChoiceDeadline = 0;
  private senaTalkingUntil = 0;
  private bellAt: number | null = null;
  private bellFired = false;

  // The cordon beat: spawned actors, their marked cones, and the tracked
  // barrier props (so a reset can strike them). `cordonSeen` lives on the
  // persisted narrative slice; the rest are per-session beat state.
  private cordonPatrol: Actor[] = [];
  private cordonScans: Array<{ actor: Actor; mesh: THREE.Object3D; material: THREE.MeshBasicMaterial }> = [];
  private cordonProps: { meshes: THREE.Object3D[]; boxes: THREE.Box3[] } | null = null;
  private cordonGeneration = 0;
  private cordonAt: number | null = null;
  private cordonAlerted = false;
  private cordonPassed = false;
  private cordonTellCooldown = 0;
  private cordonConeGeometry: THREE.CircleGeometry | null = null;
  private breadcrumbTarget: THREE.Vector3 | null = null;
  // The north-exit release prop plus the once-only cost/aftermath timers —
  // per-session state; the persisted bits are exitReleased/aftermathHeard.
  private exitRelease: {
    group: THREE.Group;
    doorPivot: THREE.Object3D;
    lamp: THREE.MeshStandardMaterial;
    collider: THREE.Box3;
    opening: boolean;
    open: number;
  } | null = null;
  private exitCostAt: number | null = null;
  private aftermathAt: number | null = null;
  private cordonResolved = false;
  // The quiet Seraph is a real actor (killable — his corpse is the
  // consequence); the chapel witness is a translucent echo, not a person.
  private quietSeraph: Actor | null = null;
  private chapelWitness: {
    group: THREE.Group;
    materials: THREE.MeshStandardMaterial[];
    light: THREE.PointLight;
    bornAt: number;
    triggeredAt: number | null;
  } | null = null;

  private hudTimer = 0;
  private fpsTimer = 0;
  private fpsFrames = 0;
  private fps = 60;
  private readonly frameTimeSampler = new FrameTimeSampler(600);
  private dynamicPixelRatio = 1;
  private lastInteraction = '';
  private subtitleId = 0;
  private toastId = 0;
  private timeouts = new Set<ReturnType<typeof setTimeout>>();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.mode !== 'playing' || this.paused || this.contextLost || event.defaultPrevented || event.isComposing) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
    const key = normalizeKeyBinding(event.key);
    if (key === 'escape' && !event.repeat) {
      event.preventDefault();
      this.requestPause();
      return;
    }
    if (isGameplayBinding(key, this.settings.keybinds)) event.preventDefault();
    this.input.keyDown(event);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.input.keyUp(event);
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if ((!this.pointerLocked && !this.pointerFallback) || this.mode !== 'playing' || this.paused || this.contextLost) return;
    if (this.pointerFallback && event.target !== this.canvas) return;
    const sensitivity = this.settings.sensitivity * 0.0022;
    this.cameraYaw -= event.movementX * sensitivity;
    this.cameraPitch = this.photoMode
      ? clamp(this.cameraPitch - event.movementY * sensitivity, -1.45, 1.45)
      : clamp(this.cameraPitch - event.movementY * sensitivity, -0.24, 0.74);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if ((event.button !== 0 && event.button !== 2) || this.mode !== 'playing' || this.paused || this.contextLost || event.target !== this.canvas) return;
    if (!this.pointerLocked && !this.pointerFallback) {
      const lockRequest = this.canvas.requestPointerLock?.();
      if (lockRequest) {
        void lockRequest.catch(() => this.enablePointerFallback());
      } else {
        this.enablePointerFallback();
      }
      // Some embedders (iframes, previews) resolve the request but never lock.
      const timeout = setTimeout(() => {
        this.timeouts.delete(timeout);
        if (!this.pointerLocked) this.enablePointerFallback();
      }, 450);
      this.timeouts.add(timeout);
      return;
    }
    if (!this.pointerLocked && this.pointerFallback) {
      // Retry real lock on each gesture — a transient denial shouldn't disable lock forever.
      const retry = this.canvas.requestPointerLock?.();
      if (retry) void retry.catch(() => {});
    }
    if (event.button === 2) {
      if (this.settings.aimToggle) this.aimToggled = !this.aimToggled;
      else this.mouseAimHeld = true;
      return;
    }
    this.mouseShootHeld = true;
    this.tryShoot();
  };

  private enablePointerFallback() {
    if (this.pointerLocked || this.pointerFallback) return;
    this.pointerFallback = true;
    this.emitToast('Pointer lock unavailable', 'Drag-look fallback active — click the canvas, then move the mouse to aim.', 'info');
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.mouseShootHeld = false;
    if (event.button === 2 && !this.settings.aimToggle) this.mouseAimHeld = false;
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (this.mode !== 'playing' || this.paused || this.contextLost || event.deltaY === 0) return;
    if (this.photoMode) {
      // The wheel is the lens — narrowing FOV is the zoom.
      this.photoFov = clamp(this.photoFov + (event.deltaY > 0 ? 4 : -4), 18, 95);
      return;
    }
    if (!this.pointerLocked && !this.pointerFallback) return;
    this.cycleWeapon(event.deltaY > 0 ? 1 : -1);
  };

  private readonly onPointerLockChange = () => {
    const wasLocked = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (wasLocked && !this.pointerLocked) {
      this.clearInput();
      if (!this.photoMode && this.mode === 'playing' && !this.paused) this.requestPause();
    }
  };

  private readonly onResize = () => this.resize();

  private readonly onBlur = () => {
    this.clearInput();
    if (this.mode === 'playing' && !this.paused) this.requestPause();
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.onBlur();
  };

  private readonly onContextLost = (event: Event) => {
    // Browsers can evict a WebGL context under GPU pressure or when a laptop
    // switches adapters. Prevent the default teardown, suspend simulation
    // mutations, and let Three.js rebuild its state when restoration arrives.
    event.preventDefault();
    this.contextLost = true;
    this.clearInput();
    this.emitToast('Graphics device paused', 'The renderer is recovering; your checkpoint is safe.', 'danger');
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.clearInput();
    this.renderer.resetState();
    this.createComposer();
    this.applyQuality();
    this.lastFrameTime = performance.now();
    this.emitToast('Graphics device restored', 'Rendering resumed without resetting the campaign.', 'success');
  };

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks, settings: GameSettings) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.settings = settings;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: settings.quality !== 'low',
        powerPreference: 'high-performance',
      });
    } catch {
      throw new Error('WebGL could not start. Update your graphics driver or enable hardware acceleration.');
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.resize();
    this.createComposer();
    this.applyQuality();
    // Scanned surfaces bind maps staggered per frame; when the queue drains,
    // compile the touched programs off the critical path instead of letting
    // the next rendered frame pay every compile at once.
    ScannedSurfaceMaterial.onQueueDrained = () => {
      const compile = this.renderer?.compileAsync?.bind(this.renderer);
      if (compile && this.scene && this.camera) void compile(this.scene, this.camera).catch(() => {});
    };
  }

  private createComposer() {
    try {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(
        Math.max(1, size.x),
        Math.max(1, size.y),
        { type: THREE.HalfFloatType, samples: this.highTier() ? (this.settings.quality === 'ultra' ? 4 : 2) : 0 },
      );
      this.composer?.dispose();
      const composer = new EffectComposer(this.renderer, target);
      this.renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(this.renderPass);
      // Ground-truth AO on high quality — it multiplies AO over the RenderPass
      // beauty (it does not draw the scene itself). This is the pass that
      // grounds actors, cars, and facades into the street.
      this.gtaoPass = new GTAOPass(this.scene, this.camera, size.x, size.y);
      this.gtaoPass.updateGtaoMaterial({ radius: 0.45, distanceExponent: 2.4, thickness: 1.2, scale: 1.4 });
      this.gtaoPass.enabled = false;
      composer.addPass(this.gtaoPass);
      this.bloomPass = new UnrealBloomPass(size, 0.6, 0.5, 0.82);
      composer.addPass(this.bloomPass);
      composer.addPass(new OutputPass());
      composer.addPass(new SMAAPass());
      this.composer = composer;
      this.composer.setPixelRatio(this.dynamicPixelRatio);
      this.composer.setSize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
    } catch {
      this.composer = null;
      this.bloomPass = null;
    }
  }

  async initialize() {
    try {
      this.callbacks.onLoadProgress(0.08, 'Opening the sky');
      this.createAtmosphere();
      await this.nextFrame();
      this.callbacks.onLoadProgress(0.25, 'Raising Aethel');
      this.createCity();
      await this.nextFrame();
      this.callbacks.onLoadProgress(0.52, 'Teaching the streets');
      this.createPlayer();
      this.callbacks.onLoadProgress(0.58, 'Giving Aurel a face');
      await this.swapHeroCharacter(this.settings.characterSkin, true);
      this.createVehicles();
      this.createTraffic();
      this.createRain();
      this.createRainSplashes();
      this.createSkidMarks();
      this.createCloudLayer();
      this.createVeilMotes();
      this.createBreadcrumb();
      this.createActors();
      await this.nextFrame();
      this.callbacks.onLoadProgress(0.76, 'Tuning the gates');
      this.createGatesAndEchoes();
      this.createObjectiveMarker();
      this.createChapel();
      this.createMemorial();
      this.createStation();
      this.createSigils();
      this.createContactShadows();
      await this.nextFrame();
      this.callbacks.onLoadProgress(1, 'The city remembers');
      this.initialized = true;
      this.callbacks.onReady();
      this.lastFrameTime = performance.now();
      this.animate();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The world failed to initialize.';
      this.callbacks.onError(message);
    }
  }

  private nextFrame() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Resolves once the world has finished booting — derived-asset loads wait
  // here so they never race the hero character on the boot critical path.
  private whenReady() {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.disposed || this.initialized) resolve();
        else window.setTimeout(check, 300);
      };
      check();
    });
  }

  private createAtmosphere() {
    this.scene.background = new THREE.Color(0x091016);
    this.scene.fog = new THREE.FogExp2(0x101920, 0.0054);

    const hemisphere = new THREE.HemisphereLight(0xc6dcf0, 0x24180f, 2.45);
    this.scene.add(hemisphere);

    const ambientBounce = new THREE.AmbientLight(0x6c8497, 0.46);
    this.scene.add(ambientBounce);

    this.sun = new THREE.DirectionalLight(0xffd98a, 3.8);
    this.sun.position.set(-84, 116, 58);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -64;
    this.sun.shadow.camera.right = 64;
    this.sun.shadow.camera.top = 64;
    this.sun.shadow.camera.bottom = -64;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.scene.add(this.sun);
    // The shadow frustum follows the player — a fixed 172 m window meant
    // half the city never cast a shadow. Snapping to a 4 m grid keeps
    // texel shimmer inaudible while the window slides.
    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;

    const rim = new THREE.DirectionalLight(0x7fa6c8, 2.1);
    rim.position.set(70, 34, -90);
    this.scene.add(rim);

    this.stormLight = new THREE.DirectionalLight(0xbfd4ff, 0);
    this.stormLight.position.set(-30, 120, -60);
    this.scene.add(this.stormLight);

    this.inspectionKey = new THREE.PointLight(0xffdec7, 0, 8, 2);
    this.inspectionKey.name = 'Aurel camera-side key light';
    this.scene.add(this.inspectionKey);

    const orbMaterial = new THREE.MeshBasicMaterial({ color: 0xd8c37b, fog: false });
    this.skyOrb = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16), orbMaterial);
    this.skyOrb.position.set(-110, 74, -150);
    this.scene.add(this.skyOrb);

    const starsGeometry = new THREE.BufferGeometry();
    const count = this.settings.quality === 'low' ? 700 : 1600;
    const starPositions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 140 + seeded(i, 1) * 180;
      const angle = seeded(i, 2) * Math.PI * 2;
      starPositions[i * 3] = Math.cos(angle) * radius;
      starPositions[i * 3 + 1] = 36 + seeded(i, 3) * 150;
      starPositions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({ color: 0xe4d6aa, size: 0.42, sizeAttenuation: true, fog: false }),
    );
    this.scene.add(stars);

    const dustGeometry = new THREE.BufferGeometry();
    const dustPositions = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i += 1) {
      dustPositions[i * 3] = (seeded(i, 7) - 0.5) * WORLD_SIZE;
      dustPositions[i * 3 + 1] = 0.5 + seeded(i, 8) * 34;
      dustPositions[i * 3 + 2] = (seeded(i, 9) - 0.5) * WORLD_SIZE;
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    this.dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({ color: 0xb49b64, size: 0.12, transparent: true, opacity: 0.38 }),
    );
    this.scene.add(this.dust);
    this.createEnvironmentMap();
  }

  private createEnvironmentMap() {
    try {
      const env = new THREE.Scene();
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 128;
      const context = canvas.getContext('2d');
      if (context) {
        const gradient = context.createLinearGradient(0, 0, 0, 128);
        gradient.addColorStop(0, '#060b12');
        gradient.addColorStop(0.45, '#12202c');
        gradient.addColorStop(0.72, '#4a351d');
        gradient.addColorStop(0.86, '#1a1209');
        gradient.addColorStop(1, '#0a0705');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 4, 128);
      }
      const dome = new THREE.CanvasTexture(canvas);
      dome.mapping = THREE.EquirectangularReflectionMapping;
      dome.colorSpace = THREE.SRGBColorSpace;
      env.background = dome;

      const glowPalette = [0xd8a94e, 0x7fb4d8, 0xc25a40, 0x9fd6a0];
      for (let i = 0; i < 8; i += 1) {
        const color = new THREE.Color(glowPalette[i % glowPalette.length]).multiplyScalar(2.6);
        const card = new THREE.Mesh(
          new THREE.PlaneGeometry(14 + seeded(i, 40) * 22, 5 + seeded(i, 41) * 9),
          new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
        );
        const angle = (i / 8) * Math.PI * 2 + seeded(i, 42) * 0.4;
        card.position.set(Math.cos(angle) * 40, 4 + seeded(i, 43) * 16, Math.sin(angle) * 40);
        card.lookAt(0, 6, 0);
        env.add(card);
      }
      const underglow = new THREE.Mesh(
        new THREE.CircleGeometry(46, 32),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x54401e).multiplyScalar(1.6) }),
      );
      underglow.rotation.x = -Math.PI / 2;
      underglow.position.y = -2;
      env.add(underglow);

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envMapTexture = pmrem.fromScene(env, 0.08).texture;
      this.scene.environment = this.envMapTexture;
      this.scene.environmentIntensity = 0.5;
      pmrem.dispose();
      dome.dispose();
      env.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    } catch {
      // IBL is a visual enhancement; the light rig already carries the scene.
    }
    // Real sky lands when the HDRIs verify + PMREM — the procedural dome above
    // stays as the boot-time fallback and the failure path.
    void this.loadHdriEnvironments();
  }

  private async loadHdriEnvironments() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    try {
      const load = async (file: string) => {
        const { bytes } = await fetchVerifiedAsset('/assets/environment/hdri/manifest.json', 'files', file, '/assets/environment/hdri/');
        // Blob URL keeps RGBE parsing inside the loader (correct flipY/type).
        const url = URL.createObjectURL(new Blob([bytes]));
        try {
          const hdr = await new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(url);
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          const texture = pmrem.fromEquirectangular(hdr).texture;
          hdr.dispose();
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      const [street, chapel] = await Promise.all([
        load('cobblestone_street_night_1k.hdr'),
        load('abandoned_church_1k.hdr'),
      ]);
      if (this.disposed) {
        street.dispose();
        chapel.dispose();
        return;
      }
      this.streetEnvTexture = street;
      this.chapelEnvTexture = chapel;
      this.envMapTexture?.dispose();
      this.envMapTexture = null;
      this.scene.environment = this.chapelInterior ? chapel : street;
      this.scene.environmentIntensity = this.chapelInterior ? 0.85 : 0.6;
    } catch {
      // Missing/unverifiable HDRIs keep the procedural dome — no visual hole.
    } finally {
      pmrem.dispose();
    }
  }

  private createCity() {
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const surfaceFallback = (label: string) => () => {
      this.emitToast(`${label} detail unavailable`, 'The last working material is retained. You can keep playing.', 'info');
    };
    this.scannedGround = new ScannedSurfaceMaterial('/assets/environment/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Ground'));
    // Photo-scanned asphalt on the roads; albedo kept dark for the wet-noir look.
    const scannedRoad = new ScannedSurfaceMaterial('/assets/environment/asphalt-02/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Road'), {
      repeat: [WORLD_SIZE / 2, 4.2],
      apply: { metalnessMap: false },
      tint: 0x585c60,
      metalness: 0.5,
      aoIntensity: 0.5,
      fallback: { color: 0x10171a, roughness: 0.19, metalness: 0.55, envMapIntensity: 1.5 },
    });
    // Three facade buckets — same silhouette and window canvas, but each gets
    // its own scanned surface so the towers stop reading as one material.
    const facadeMap = this.createFacadeTexture(false);
    const facadeRoughness = this.createFacadeTexture(true);
    const buildingMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: facadeMap,
      roughnessMap: facadeRoughness,
      roughness: 0.47,
      metalness: 0.42,
      emissive: 0x0d1111,
      emissiveIntensity: 0.28,
    });
    const buildingMaterialWarm = new THREE.MeshStandardMaterial({
      color: 0xf2ece4,
      map: facadeMap,
      roughnessMap: facadeRoughness,
      roughness: 0.52,
      metalness: 0.34,
      emissive: 0x0d1111,
      emissiveIntensity: 0.28,
    });
    const buildingMaterialCool = new THREE.MeshStandardMaterial({
      color: 0xdfe4e8,
      map: facadeMap,
      roughnessMap: facadeRoughness,
      roughness: 0.68,
      metalness: 0.16,
      emissive: 0x0d1111,
      emissiveIntensity: 0.28,
    });
    this.phaseMaterials.push(buildingMaterial, buildingMaterialWarm, buildingMaterialCool);
    // Concrete-wall relief on the tower facades — normal only; the procedural
    // canvas albedo already carries the lit-window grid.
    const scannedFacade = new ScannedSurfaceMaterial('/assets/environment/concrete-wall-008/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Facade'), {
      repeat: [3, 3],
      apply: { albedo: false, arm: false },
      normalScale: 1.1,
      onApplied: (material) => {
        buildingMaterial.normalMap = material.normalMap;
        buildingMaterial.normalScale.setScalar(1.1);
        buildingMaterial.needsUpdate = true;
      },
    });
    const chippedFacade = new ScannedSurfaceMaterial('/assets/environment/chipped-concrete/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Facade'), {
      repeat: [3, 3],
      apply: { albedo: false, arm: false },
      normalScale: 1.0,
      onApplied: (material) => {
        buildingMaterialWarm.normalMap = material.normalMap;
        buildingMaterialWarm.normalScale.setScalar(1.0);
        buildingMaterialWarm.needsUpdate = true;
      },
    });
    const plasterFacade = new ScannedSurfaceMaterial('/assets/environment/blue-plaster-weathered/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Facade'), {
      repeat: [3, 3],
      apply: { albedo: false, arm: false },
      normalScale: 0.9,
      onApplied: (material) => {
        buildingMaterialCool.normalMap = material.normalMap;
        buildingMaterialCool.normalScale.setScalar(0.9);
        buildingMaterialCool.needsUpdate = true;
      },
    });
    // The cool bucket also gets a real brick albedo — the only facade group
    // whose windows live purely on the instanced overlay, so a scanned map
    // can't misalign them.
    const brickFacade = new ScannedSurfaceMaterial('/assets/environment/brick-wall-001/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Facade'), {
      repeat: [3, 3],
      apply: { normal: false, arm: false },
      onApplied: (material) => {
        buildingMaterialCool.map = material.map;
        buildingMaterialCool.needsUpdate = true;
      },
    });
    const chapelFloor = new ScannedSurfaceMaterial('/assets/environment/stone-tiles-02/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Stone'), {
      repeat: [8, 7],
      tint: 0x6a6763,
      aoIntensity: 0.8,
      fallback: { color: 0x232120, roughness: 0.94 },
    });
    const chapelBrick = new ScannedSurfaceMaterial('/assets/environment/church-bricks-03/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Brick'), {
      repeat: [5, 3],
      tint: 0x8a8178,
      aoIntensity: 0.8,
      fallback: { color: 0x2e2c2a, roughness: 0.9, metalness: 0.05 },
    });
    const pewWood = new ScannedSurfaceMaterial('/assets/environment/wood-planks/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Wood'), {
      repeat: [1.4, 1.4],
      tint: 0x6b523a,
      aoIntensity: 0.7,
      fallback: { color: 0x3d2f22, roughness: 0.82 },
    });
    // Paved plaza + chapel court — real scanned floors over the ground plane.
    const plazaConcrete = new ScannedSurfaceMaterial('/assets/environment/concrete-floor-02/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Plaza'), {
      repeat: [14, 14],
      apply: { metalnessMap: false },
      tint: 0x8b8d8f,
      metalness: 0.05,
      aoIntensity: 0.7,
      fallback: { color: 0x232629, roughness: 0.82 },
    });
    const chapelCobble = new ScannedSurfaceMaterial('/assets/environment/cobblestone-floor-001/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Cobble'), {
      repeat: [12, 12],
      apply: { metalnessMap: false },
      tint: 0x77787c,
      aoIntensity: 0.8,
      fallback: { color: 0x242524, roughness: 0.9 },
    });
    const propMetalLoader = new ScannedSurfaceMaterial('/assets/environment/metal-plate/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Metal'), {
      repeat: [1.6, 1.6],
      tint: 0x8a9198,
      aoIntensity: 0.55,
      fallback: { color: 0x39424a, roughness: 0.46, metalness: 0.5 },
    });
    const propRustLoader = new ScannedSurfaceMaterial('/assets/environment/rusty-metal-02/manifest.json', WORLD_SIZE, anisotropy, surfaceFallback('Rust'), {
      repeat: [1.8, 1.8],
      apply: { metalnessMap: false },
      tint: 0x8a6a52,
      metalness: 0.35,
      aoIntensity: 0.6,
      fallback: { color: 0x4c3a2c, roughness: 0.7, metalness: 0.34 },
    });
    this.propMetal = propMetalLoader.material;
    this.propRust = propRustLoader.material;
    this.chapelWood = pewWood.material;
    this.chapelStoneDark = chapelFloor.material;
    this.chapelStone = chapelBrick.material;
    this.scannedSurfaces = [
      this.scannedGround, scannedRoad, scannedFacade, chippedFacade, plasterFacade, brickFacade,
      chapelFloor, chapelBrick, pewWood, plazaConcrete, chapelCobble, propMetalLoader, propRustLoader,
    ];
    // Textures stream in after boot — the fetches stay off the hero's
    // critical path, and the painted fallbacks carry the first seconds.
    void this.whenReady().then(() => {
      if (!this.disposed) this.scannedSurfaces.forEach((surface) => surface.setQuality(this.settings.quality));
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), this.scannedGround.material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData.blocksShot = true;
    this.scene.add(ground);
    this.rayTargets.push(ground);

    // Paved plazas — real scanned floors in the two route clearings.
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(14, 48), plazaConcrete.material);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.02, -54);
    plaza.receiveShadow = true;
    plaza.userData.blocksShot = true;
    this.scene.add(plaza);
    this.rayTargets.push(plaza);
    const chapelCourt = new THREE.Mesh(new THREE.CircleGeometry(12, 48), chapelCobble.material);
    chapelCourt.rotation.x = -Math.PI / 2;
    chapelCourt.position.set(-72, 0.02, 48);
    chapelCourt.receiveShadow = true;
    chapelCourt.userData.blocksShot = true;
    this.scene.add(chapelCourt);
    this.rayTargets.push(chapelCourt);

    // Perpetual-storm noir: roads read as wet asphalt — low roughness and a
    // raised env response so neon and headlights smear across the surface.
    const roadMaterial = scannedRoad.material;
    const laneMaterial = new THREE.MeshBasicMaterial({ color: 0x927b46, transparent: true, opacity: 0.5 });
    for (let line = -150; line <= 150; line += 30) {
      const roadX = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, 8.4), roadMaterial);
      roadX.rotation.x = -Math.PI / 2;
      roadX.position.set(0, 0.018, line);
      roadX.receiveShadow = true;
      this.scene.add(roadX);
      // Same 340x8.4 UV span, spun in-plane — the asphalt grain runs along the street.
      const roadZGeometry = new THREE.PlaneGeometry(WORLD_SIZE, 8.4);
      roadZGeometry.rotateX(-Math.PI / 2);
      roadZGeometry.rotateY(Math.PI / 2);
      const roadZ = new THREE.Mesh(roadZGeometry, roadMaterial);
      roadZ.position.set(line, 0.019, 0);
      roadZ.receiveShadow = true;
      this.scene.add(roadZ);

      const laneX = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, 0.08), laneMaterial);
      laneX.rotation.x = -Math.PI / 2;
      laneX.position.set(0, 0.03, line);
      this.scene.add(laneX);
      const laneZ = new THREE.Mesh(new THREE.PlaneGeometry(0.08, WORLD_SIZE), laneMaterial);
      laneZ.rotation.x = -Math.PI / 2;
      laneZ.position.set(line, 0.031, 0);
      this.scene.add(laneZ);
    }

    const buildingData: Array<{
      position: THREE.Vector3;
      scale: THREE.Vector3;
      color: THREE.Color;
    }> = [];
    const clearings: Array<[number, number, number]> = [
      [0, -54, 24],
      [90, 76, 18],
      [-72, 48, 10],
      [-112, 72, 10],
      [-82, 104, 10],
      [0, 34, 10],
    ];

    let index = 0;
    for (let gridX = -5; gridX <= 4; gridX += 1) {
      for (let gridZ = -5; gridZ <= 4; gridZ += 1) {
        const centerX = gridX * 30 + 15;
        const centerZ = gridZ * 30 + 15;
        for (let lot = 0; lot < 3; lot += 1) {
          index += 1;
          const offsetAngle = (lot / 3) * Math.PI * 2 + seeded(index, 11) * 0.7;
          const radius = 5.6 + seeded(index, 12) * 2.8;
          const x = centerX + Math.cos(offsetAngle) * radius;
          const z = centerZ + Math.sin(offsetAngle) * radius;
          if (clearings.some(([cx, cz, cr]) => distance2D(x, z, cx, cz) < cr)) continue;
          const width = 6.4 + seeded(index, 13) * 5;
          const depth = 6.4 + seeded(index, 14) * 5;
          const coreBoost = Math.max(0, 1 - Math.hypot(x, z) / 190);
          const height = 7 + seeded(index, 15) * 28 + coreBoost * 22;
          const baseColor = this.districtColor(x, z);
          baseColor.offsetHSL((seeded(index, 16) - 0.5) * 0.025, 0, (seeded(index, 17) - 0.5) * 0.07);
          buildingData.push({
            position: new THREE.Vector3(x, height / 2, z),
            scale: new THREE.Vector3(width, height, depth),
            color: baseColor,
          });
          this.collisionBoxes.push(
            new THREE.Box3(
              new THREE.Vector3(x - width / 2, 0, z - depth / 2),
              new THREE.Vector3(x + width / 2, height, z + depth / 2),
            ),
          );
        }
      }
    }

    // Partition first so each bucket keeps its own contiguous subarray — the
    // split is seeded, not positional, so districts still interleave.
    const buildingBuckets: typeof buildingData[] = [[], [], []];
    buildingData.forEach((building, buildingIndex) => {
      const pick = seeded(buildingIndex, 77);
      buildingBuckets[pick < 0.5 ? 0 : pick < 0.82 ? 1 : 2].push(building);
    });
    const facadeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const matrix = new THREE.Matrix4();
    [buildingMaterial, buildingMaterialWarm, buildingMaterialCool].forEach((material, bucketIndex) => {
      const group = buildingBuckets[bucketIndex];
      if (!group.length) return;
      const placements = group.map((building) => {
        matrix.compose(building.position, new THREE.Quaternion(), building.scale);
        return { matrix: matrix.clone(), color: building.color };
      });
      // Chunked so whole blocks of towers frustum-cull instead of drawing
      // the entire skyline every frame; each chunk is its own ray target.
      this.addInstancedChunks(facadeGeometry, material, placements).forEach((mesh) => {
        mesh.castShadow = this.highTier();
        mesh.receiveShadow = true;
        mesh.userData.blocksShot = true;
        this.rayTargets.push(mesh);
      });
    });

    // Setback crowns — the skyline's second silhouette. Tall towers grow a
    // stepped upper tier (the tallest a second, slimmer one), slightly darker
    // like real roof massing. Same bucket → same facade material as the
    // tower it sits on.
    const crownBuckets: Array<Array<{ matrix: THREE.Matrix4; color: THREE.Color }>> = [[], [], []];
    const crownMatrix = new THREE.Matrix4();
    const crownQuat = new THREE.Quaternion();
    buildingData.forEach((building, buildingIndex) => {
      if (building.scale.y < 16 || seeded(buildingIndex, 90) < 0.42) return;
      const pick = seeded(buildingIndex, 77);
      const bucket = pick < 0.5 ? 0 : pick < 0.82 ? 1 : 2;
      const tiers = building.scale.y > 30 && seeded(buildingIndex, 91) > 0.45 ? 2 : 1;
      const crownColor = building.color.clone().multiplyScalar(0.82);
      let topY = building.scale.y;
      for (let tier = 0; tier < tiers; tier += 1) {
        const shrink = tier === 0 ? 0.62 : 0.4;
        const tierHeight = 3.2 + seeded(buildingIndex + tier * 97, 92) * 4.6;
        crownMatrix.compose(
          new THREE.Vector3(building.position.x, topY + tierHeight / 2, building.position.z),
          crownQuat,
          new THREE.Vector3(building.scale.x * shrink, tierHeight, building.scale.z * shrink),
        );
        crownBuckets[bucket].push({ matrix: crownMatrix.clone(), color: crownColor });
        topY += tierHeight;
      }
    });
    const bucketMaterials = [buildingMaterial, buildingMaterialWarm, buildingMaterialCool];
    crownBuckets.forEach((placements, bucketIndex) => {
      if (!placements.length) return;
      this.addInstancedChunks(facadeGeometry, bucketMaterials[bucketIndex], placements).forEach((mesh) => {
        mesh.castShadow = this.highTier();
        mesh.receiveShadow = true;
        mesh.userData.blocksShot = true;
        this.rayTargets.push(mesh);
      });
    });
    this.createBuildingDetails(buildingData);
    this.createStreetMarkings();

    const windowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const windowGeometry = new THREE.BoxGeometry(0.66, 0.34, 0.1);
    const windowCount = this.settings.quality === 'low' ? 240 : this.settings.quality === 'medium' ? 620 : this.settings.quality === 'ultra' ? 1400 : 1080;
    const windowColor = new THREE.Color();
    const faceQuaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
    const windowPlacements: Array<{ matrix: THREE.Matrix4; color: THREE.Color }> = [];
    for (let i = 0; i < windowCount; i += 1) {
      const building = buildingData[Math.floor(seeded(i, 31) * buildingData.length)];
      const face = Math.floor(seeded(i, 32) * 4);
      const along = (seeded(i, 33) - 0.5) * 0.78;
      const y = 1.6 + seeded(i, 34) * Math.max(1.4, building.scale.y - 2.4);
      const x = face < 2
        ? building.position.x + (face === 0 ? 1 : -1) * (building.scale.x * 0.5 + 0.06)
        : building.position.x + along * building.scale.x;
      const z = face < 2
        ? building.position.z + along * building.scale.z
        : building.position.z + (face === 2 ? 1 : -1) * (building.scale.z * 0.5 + 0.06);
      faceQuaternion.setFromAxisAngle(upAxis, face === 0 ? Math.PI / 2 : face === 1 ? -Math.PI / 2 : face === 2 ? 0 : Math.PI);
      matrix.compose(new THREE.Vector3(x, y, z), faceQuaternion, new THREE.Vector3(1, 1, 1));
      const pick = seeded(i, 35);
      if (pick < 0.56) windowColor.setRGB(1.15, 0.82, 0.42).multiplyScalar(0.45 + seeded(i, 36) * 0.65);
      else if (pick < 0.78) windowColor.setRGB(0.48, 0.95, 1.18).multiplyScalar(0.5 + seeded(i, 36) * 0.6);
      else if (pick < 0.9) windowColor.setRGB(2.6, 1.9, 0.85);
      else windowColor.setRGB(2.1, 0.65, 1.5);
      if (seeded(i, 38) < 0.16) windowColor.multiplyScalar(0.1);
      windowPlacements.push({ matrix: matrix.clone(), color: windowColor.clone() });
    }
    const windowMeshes = this.addInstancedChunks(windowGeometry, windowMaterial, windowPlacements);
    // Panes sit 6cm proud of the facade — a shot at a lit window hits glass
    // first, cracks it, and the pane stays dark until the world resets.
    windowMeshes.forEach((mesh) => {
      mesh.userData.windowPane = true;
      mesh.userData.surfaceKind = 'glass';
      this.rayTargets.push(mesh);
    });
    this.createNeonStrips(buildingData);
    this.createStreetlamps();
    this.createBillboards(buildingData);
    this.createStreetDecals(buildingData);
    this.createRooftopProps(buildingData);
    this.createSearchlight(buildingData);
    this.createStreetProps();
    this.createRouteProps(buildingData);
    this.createArtDecals(buildingData);
    this.createLitter();

    this.createLandmark(new THREE.Vector3(0, 0, -54), 0xd1ad61, 'Crown Basilica');
    this.createLandmark(new THREE.Vector3(90, 0, 76), 0x7fa7b0, 'Meridian Needle');
    this.createLandmark(new THREE.Vector3(-94, 0, 78), 0x8e8264, 'The Archive');
  }

  // Procedural facade texture: vertical panel seams, horizontal floor bands,
  // and per-panel value/roughness variation. Generated once on a canvas —
  // keeps flat-color towers from reading as untextured blocks up close.
  private createFacadeTexture(roughness: boolean) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = roughness ? '#8a8a8a' : '#b9bcbd';
    ctx.fillRect(0, 0, 256, 256);
    const rand = (i: number, salt: number) => seeded(i, salt + (roughness ? 500 : 0));
    for (let panel = 0; panel < 8; panel += 1) {
      for (let floor = 0; floor < 8; floor += 1) {
        const v = Math.floor((roughness ? 100 : 168) + rand(panel * 8 + floor, 501) * (roughness ? 90 : 32));
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(panel * 32 + 1, floor * 32 + 1, 30, 30);
      }
    }
    ctx.fillStyle = roughness ? '#4a4a4a' : '#7f8385';
    for (let s = 0; s <= 256; s += 32) {
      ctx.fillRect(s, 0, 2, 256);
      ctx.fillRect(0, s, 256, 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 3);
    if (!roughness) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createBuildingDetails(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const crowns: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }> = [];
    const parapets: Array<{ position: THREE.Vector3; scale: THREE.Vector3 }> = [];
    buildingData.forEach((building, index) => {
      parapets.push({
        position: new THREE.Vector3(building.position.x, building.scale.y + 0.16, building.position.z),
        scale: new THREE.Vector3(building.scale.x * 1.04, 0.42, building.scale.z * 1.04),
      });
      if (building.scale.y > 26 && seeded(index, 95) > 0.4) {
        const crownHeight = Math.min(10, building.scale.y * (0.2 + seeded(index, 96) * 0.14));
        const crownColor = building.color.clone().offsetHSL(0, 0, -0.035);
        crowns.push({
          position: new THREE.Vector3(building.position.x, building.scale.y + crownHeight * 0.5 - 0.3, building.position.z),
          scale: new THREE.Vector3(building.scale.x * 0.7, crownHeight, building.scale.z * 0.7),
          color: crownColor,
        });
        if (seeded(index, 97) > 0.62) {
          const spireHeight = 2.5 + seeded(index, 98) * 4;
          crowns.push({
            position: new THREE.Vector3(building.position.x, building.scale.y + crownHeight + spireHeight * 0.5 - 0.5, building.position.z),
            scale: new THREE.Vector3(building.scale.x * 0.4, spireHeight, building.scale.z * 0.4),
            color: crownColor.clone().offsetHSL(0, 0, -0.03),
          });
        }
      }
    });
    const crownMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0.5, emissive: 0x0c1012, emissiveIntensity: 0.3 });
    this.phaseMaterials.push(crownMaterial);
    const parapetMaterial = new THREE.MeshStandardMaterial({ color: 0x14181b, roughness: 0.58, metalness: 0.4 });
    const matrix = new THREE.Matrix4();
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const crownPlacements = crowns.map((crown) => {
      matrix.compose(crown.position, new THREE.Quaternion(), crown.scale);
      return { matrix: matrix.clone(), color: crown.color };
    });
    const parapetPlacements = parapets.map((parapet) => {
      matrix.compose(parapet.position, new THREE.Quaternion(), parapet.scale);
      return { matrix: matrix.clone() };
    });
    [
      ...this.addInstancedChunks(boxGeo, crownMaterial, crownPlacements),
      ...this.addInstancedChunks(boxGeo, parapetMaterial, parapetPlacements),
    ].forEach((mesh) => {
      mesh.castShadow = this.highTier();
      mesh.receiveShadow = true;
      mesh.userData.blocksShot = true;
      this.rayTargets.push(mesh);
    });

    // Edge-lit corner strips — the skyscraper "edge lighting" that sells silhouette at night.
    const strips: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }> = [];
    buildingData.forEach((building, index) => {
      if (building.scale.y < 18 || seeded(index, 110) < 0.52) return;
      const tint = this.districtColor(building.position.x, building.position.z).lerp(new THREE.Color(0xffffff), 0.3);
      const stripHeight = building.scale.y * 0.94;
      const halfX = building.scale.x * 0.5 + 0.06;
      const halfZ = building.scale.z * 0.5 + 0.06;
      const corners = seeded(index, 111) > 0.5
        ? [[halfX, halfZ], [-halfX, -halfZ]]
        : [[halfX, -halfZ], [-halfX, halfZ]];
      corners.forEach(([cx, cz]) => {
        strips.push({
          position: new THREE.Vector3(building.position.x + cx, stripHeight * 0.5, building.position.z + cz),
          scale: new THREE.Vector3(0.16, stripHeight, 0.16),
          color: tint,
        });
      });
    });
    const stripMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false });
    const stripPlacements = strips.map((strip) => {
      matrix.compose(strip.position, new THREE.Quaternion(), strip.scale);
      return { matrix: matrix.clone(), color: strip.color };
    });
    this.addInstancedChunks(new THREE.BoxGeometry(1, 1, 1), stripMaterial, stripPlacements);

    // Baked contact-AO skirts — soften every wall-to-ground seam so towers sit
    // in the world instead of floating on it.
    const aoCanvas = document.createElement('canvas');
    aoCanvas.width = 128;
    aoCanvas.height = 128;
    const aoCtx = aoCanvas.getContext('2d');
    if (aoCtx) {
      const gradient = aoCtx.createRadialGradient(64, 64, 30, 64, 64, 64);
      gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
      gradient.addColorStop(0.62, 'rgba(0,0,0,0.22)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      aoCtx.fillStyle = gradient;
      aoCtx.fillRect(0, 0, 128, 128);
      const aoTexture = new THREE.CanvasTexture(aoCanvas);
      const aoMaterial = new THREE.MeshBasicMaterial({ map: aoTexture, transparent: true, depthWrite: false });
      const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      const aoPlacements = buildingData.map((building) => {
        matrix.compose(
          new THREE.Vector3(building.position.x, 0.025, building.position.z),
          flat,
          new THREE.Vector3(building.scale.x * 1.35, building.scale.z * 1.35, 1),
        );
        return { matrix: matrix.clone() };
      });
      this.addInstancedChunks(new THREE.PlaneGeometry(1, 1), aoMaterial, aoPlacements);
    }
  }

  private createStreetMarkings() {
    const curbPieces: Array<{ position: THREE.Vector3; yaw: number }> = [];
    for (let line = -150; line <= 150; line += 30) {
      for (let t = -146; t <= 146; t += 7.5) {
        const mod = ((t % 30) + 30) % 30;
        if (mod < 7.4 || mod > 22.6) continue;
        for (const side of [-5.15, 5.15]) {
          const index = (line + 400) * 100 + Math.round(t * 10) + (side > 0 ? 7 : 3);
          if (seeded(index, 100) < 0.06) continue;
          if (!this.collides(line + side, t, 2.2)) curbPieces.push({ position: new THREE.Vector3(line + side, 0.07, t), yaw: 0 });
          if (!this.collides(t, line + side, 2.2)) curbPieces.push({ position: new THREE.Vector3(t, 0.07, line + side), yaw: Math.PI / 2 });
        }
      }
    }
    const curbMaterial = new THREE.MeshStandardMaterial({ color: 0x232b2e, roughness: 0.72, metalness: 0.18 });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
    const curbPlacements = curbPieces.map((piece) => {
      // Curbs get real collider tops: at 0.14 they never block the capsule,
      // but grounding and foot IK both read them — stepping onto a curb is a
      // plant, not a clip.
      const halfLong = 3.6;
      const halfShort = 0.5;
      const alongZ = Math.abs(Math.sin(piece.yaw)) < 0.5;
      this.collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(piece.position.x - (alongZ ? halfShort : halfLong), 0, piece.position.z - (alongZ ? halfLong : halfShort)),
        new THREE.Vector3(piece.position.x + (alongZ ? halfShort : halfLong), 0.14, piece.position.z + (alongZ ? halfLong : halfShort)),
      ));
      quaternion.setFromAxisAngle(upAxis, piece.yaw);
      matrix.compose(piece.position, quaternion, new THREE.Vector3(1, 1, 1));
      return { matrix: matrix.clone() };
    });
    const curbMeshes = this.addInstancedChunks(new THREE.BoxGeometry(1, 0.14, 7.2), curbMaterial, curbPlacements);
    curbMeshes.forEach((mesh) => { mesh.receiveShadow = true; });

    const stripes: Array<{ x: number; z: number; yaw: number }> = [];
    for (let lx = -150; lx <= 150; lx += 30) {
      for (let lz = -150; lz <= 150; lz += 30) {
        for (const offset of [-6.2, 6.2]) {
          stripes.push({ x: lx + offset, z: lz, yaw: Math.PI / 2 });
          stripes.push({ x: lx, z: lz + offset, yaw: 0 });
        }
      }
    }
    const stripeMaterial = new THREE.MeshBasicMaterial({ color: 0x9aa4a8, transparent: true, opacity: 0.34 });
    const stripePlacements = stripes.map((stripe) => {
      quaternion.setFromAxisAngle(upAxis, stripe.yaw);
      matrix.compose(new THREE.Vector3(stripe.x, 0.042, stripe.z), quaternion, new THREE.Vector3(1, 1, 1));
      return { matrix: matrix.clone() };
    });
    this.addInstancedChunks(new THREE.BoxGeometry(0.5, 0.02, 7.4), stripeMaterial, stripePlacements);
    this.createPuddles();
  }

  // Standing water — the perpetual storm leaves sheets of it along the curb
  // lines and in the low road seams. Near-zero roughness mirrors catch the
  // neon and lamp cones as long streaks; without it the wet asphalt reads
  // uniformly satin instead of rained-on.
  private createPuddles() {
    if (!this.scene || this.settings.quality === 'low') return;
    const material = new THREE.MeshStandardMaterial({
      color: 0x05090c,
      roughness: 0.04,
      metalness: 0.92,
      envMapIntensity: 2.4,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const yawQuat = new THREE.Quaternion();
    const final = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
    const matrix = new THREE.Matrix4();
    const count = this.settings.quality === 'ultra' ? 130 : 88;
    const placements: Array<{ matrix: THREE.Matrix4 }> = [];
    for (let i = 0; i < count; i += 1) {
      // Bias toward curb lines: road grid at multiples of 30, puddles hug
      // the ±4.2..5.2 band where the camber would shed water.
      const road = Math.floor(seeded(i, 160) * 11 - 5) * 30;
      const along = (seeded(i, 161) - 0.5) * 288;
      const curbBand = (3.4 + seeded(i, 162) * 1.9) * (seeded(i, 163) > 0.5 ? 1 : -1);
      const horizontal = seeded(i, 164) > 0.5;
      const x = horizontal ? along : road + curbBand;
      const z = horizontal ? road + curbBand : along;
      if (this.collides(x, z, 0.3)) continue;
      (this.puddleSpots ??= []).push({ x, z });
      const yaw = horizontal ? 0 : Math.PI / 2;
      yawQuat.setFromAxisAngle(upAxis, yaw + (seeded(i, 165) - 0.5) * 0.5);
      final.copy(yawQuat).multiply(flat);
      matrix.compose(
        new THREE.Vector3(x, 0.028, z),
        final,
        new THREE.Vector3(1.1 + seeded(i, 166) * 2.6, 0.62 + seeded(i, 167) * 1.4, 1),
      );
      placements.push({ matrix: matrix.clone() });
    }
    const puddleMeshes = this.addInstancedChunks(new THREE.CircleGeometry(0.5, 18), material, placements);
    puddleMeshes.forEach((mesh) => { mesh.renderOrder = 1; });
  }

  private districtColor(x: number, z: number) {
    if (x < -42 && z > 12) return new THREE.Color(0x625e5a);
    if (x > 48 && z > 12) return new THREE.Color(0x4c6a74);
    if (x < -28 && z < -42) return new THREE.Color(0x586c5a);
    if (x > 32 && z < -24) return new THREE.Color(0x6a5e50);
    return new THREE.Color(0x5a6a70);
  }

  private districtNeonColor(x: number, z: number) {
    if (x < -42 && z > 12) return new THREE.Color(0.55, 2.05, 1.7);
    if (x > 48 && z > 12) return new THREE.Color(0.5, 1.25, 2.5);
    if (x < -28 && z < -42) return new THREE.Color(2.5, 1.0, 0.42);
    if (x > 32 && z < -24) return new THREE.Color(2.2, 0.62, 2.1);
    return new THREE.Color(2.35, 1.8, 0.72);
  }

  private createNeonStrips(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const horizontal: Array<{ position: THREE.Vector3; yaw: number; length: number; color: THREE.Color }> = [];
    const vertical: Array<{ position: THREE.Vector3; height: number; color: THREE.Color }> = [];
    buildingData.forEach((building, buildingIndex) => {
      if (seeded(buildingIndex, 41) > 0.58) return;
      const face = Math.floor(seeded(buildingIndex, 42) * 4);
      const outward = new THREE.Vector3(face === 0 ? 1 : face === 1 ? -1 : 0, 0, face === 2 ? 1 : face === 3 ? -1 : 0);
      const surface = face < 2 ? building.scale.x * 0.5 + 0.1 : building.scale.z * 0.5 + 0.1;
      const faceLength = (face < 2 ? building.scale.z : building.scale.x) * 0.82;
      const color = this.districtNeonColor(building.position.x, building.position.z);
      const base = building.position.clone().addScaledVector(outward, surface);
      if (seeded(buildingIndex, 43) > 0.45) {
        base.y = 2.4 + seeded(buildingIndex, 44) * Math.max(1.5, building.scale.y - 3.2);
        horizontal.push({ position: base, yaw: face < 2 ? Math.PI / 2 : 0, length: faceLength, color });
      } else {
        base.y = building.scale.y * 0.5;
        base.addScaledVector(outward, 0.02);
        const lateral = (seeded(buildingIndex, 45) - 0.5) * 0.5;
        base.x += face >= 2 ? lateral * building.scale.x : 0;
        base.z += face < 2 ? lateral * building.scale.z : 0;
        vertical.push({ position: base, height: building.scale.y * (0.32 + seeded(buildingIndex, 46) * 0.42), color });
      }
    });
    const neonMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
    const hPlacements = horizontal.map((strip) => {
      quaternion.setFromAxisAngle(upAxis, strip.yaw);
      matrix.compose(strip.position, quaternion, new THREE.Vector3(strip.length, 1, 1));
      return { matrix: matrix.clone(), color: strip.color };
    });
    const vPlacements = vertical.map((strip) => {
      matrix.compose(strip.position, new THREE.Quaternion(), new THREE.Vector3(1, strip.height, 1));
      return { matrix: matrix.clone(), color: strip.color };
    });
    this.addInstancedChunks(new THREE.BoxGeometry(1, 0.12, 0.12), neonMaterial, hPlacements);
    this.addInstancedChunks(new THREE.BoxGeometry(0.12, 1, 0.12), neonMaterial, vPlacements);
  }

  private createStreetlamps() {
    const positions: Array<{ x: number; z: number; armX: number; armZ: number }> = [];
    for (let line = -120; line <= 120; line += 60) {
      for (let t = -132; t <= 132; t += 30) {
        const side = Math.round(t / 30) % 2 === 0 ? 5.6 : -5.6;
        positions.push({ x: line + side, z: t, armX: side > 0 ? -0.6 : 0.6, armZ: 0 });
        positions.push({ x: t, z: line - side, armX: 0, armZ: side > 0 ? 0.6 : -0.6 });
      }
    }
    const lamps = positions.filter((lamp) => !this.collides(lamp.x, lamp.z, 0.5));
    this.streetLamps = lamps;
    const headMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const coneMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.35, 1.06, 0.52),
      transparent: true,
      opacity: 0.055,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Poles come from the GLB in createRouteProps — these are just the glow:
    // a small emissive lantern head + the additive light cone under it.
    const matrix = new THREE.Matrix4();
    const headColor = new THREE.Color();
    const headPlacements = lamps.map((lamp, index) => {
      matrix.makeTranslation(lamp.x, 4.7, lamp.z);
      headColor.setRGB(1.9, 1.5, 0.72).multiplyScalar(0.85 + seeded(index, 52) * 0.3);
      return { matrix: matrix.clone(), color: headColor.clone() };
    });
    const conePlacements = lamps.map((lamp) => {
      matrix.makeTranslation(lamp.x, 2.6, lamp.z);
      return { matrix: matrix.clone() };
    });
    const headMeshes = this.addInstancedChunks(new THREE.BoxGeometry(0.34, 0.3, 0.34), headMaterial, headPlacements);
    const coneMeshes = this.addInstancedChunks(new THREE.ConeGeometry(1.5, 4.7, 10, 1, true), coneMaterial, conePlacements);
    coneMeshes.forEach((mesh) => { mesh.renderOrder = 5; });
    // Shootable lamps: index each head/cone instance back to its streetLamps
    // entry so a bullet (or a blast) can kill the light. Heads are ray targets;
    // cones are not — a transparent glow shouldn't eat bullets mid-street.
    headMeshes.forEach((mesh) => {
      mesh.userData.lampGlow = true;
      mesh.userData.surfaceKind = 'glass';
      this.rayTargets.push(mesh);
      (mesh.userData.instanceIds as number[]).forEach((id, local) => {
        const part = this.lampParts.get(id) ?? { poles: [] };
        const color = new THREE.Color();
        mesh.getColorAt(local, color);
        part.head = { mesh, local, color };
        this.lampParts.set(id, part);
      });
    });
    const coneMatrix = new THREE.Matrix4();
    coneMeshes.forEach((mesh) => {
      (mesh.userData.instanceIds as number[]).forEach((id, local) => {
        const part = this.lampParts.get(id) ?? { poles: [] };
        mesh.getMatrixAt(local, coneMatrix);
        part.cone = { mesh, local, matrix: coneMatrix.clone() };
        this.lampParts.set(id, part);
      });
    });
  }

  // A shot lantern: head goes dark, light cone collapses, sparks + glass.
  private killLamp(index: number, point: THREE.Vector3) {
    const dead = (this.deadLamps ??= new Set());
    if (dead.has(index)) return;
    const part = this.lampParts?.get(index);
    if (!part) return;
    dead.add(index);
    if (part.head) {
      part.head.mesh.setColorAt(part.head.local, this.lampDeadColor);
      if (part.head.mesh.instanceColor) part.head.mesh.instanceColor.needsUpdate = true;
    }
    if (part.cone) {
      this.tmpMatrix.copy(part.cone.matrix).multiply(this.lampOffScale);
      part.cone.mesh.setMatrixAt(part.cone.local, this.tmpMatrix);
      part.cone.mesh.instanceMatrix.needsUpdate = true;
    }
    part.poles.forEach(({ mesh, local }) => {
      mesh.setColorAt(local, this.lampDeadColor);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    this.createImpact(point, false);
    this.audio.surfaceImpact?.(point, this.camera.position, this.cameraYaw, false, 'glass');
  }

  private relightLamps() {
    if (!this.deadLamps?.size) return;
    this.deadLamps.forEach((index) => {
      const part = this.lampParts?.get(index);
      if (!part) return;
      if (part.head) {
        part.head.mesh.setColorAt(part.head.local, part.head.color);
        if (part.head.mesh.instanceColor) part.head.mesh.instanceColor.needsUpdate = true;
      }
      if (part.cone) {
        part.cone.mesh.setMatrixAt(part.cone.local, part.cone.matrix);
        part.cone.mesh.instanceMatrix.needsUpdate = true;
      }
      part.poles.forEach(({ mesh, local }) => {
        mesh.setColorAt(local, this.lampLiveColor);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
    });
    this.deadLamps.clear();
  }

  // Poles the photogrammetry lamp replaces — only built if the GLB can't load.
  private buildFallbackLampPoles() {
    if (!this.streetLamps.length) return;
    const dark = new THREE.MeshStandardMaterial({ color: 0x14181a, roughness: 0.5, metalness: 0.6 });
    const matrix = new THREE.Matrix4();
    const polePlacements = this.streetLamps.map((lamp) => {
      matrix.makeTranslation(lamp.x, 2.5, lamp.z);
      return { matrix: matrix.clone() };
    });
    const poleMeshes = this.addInstancedChunks(new THREE.CylinderGeometry(0.07, 0.11, 5.0, 6), dark, polePlacements);
    poleMeshes.forEach((mesh) => {
      mesh.userData.lampPole = true;
      this.rayTargets.push(mesh);
      (mesh.userData.instanceIds as number[]).forEach((id, local) => {
        const part = this.lampParts.get(id) ?? { poles: [] };
        part.poles.push({ mesh, local });
        this.lampParts.set(id, part);
      });
    });
  }

  private billboardTexture(title: string, subtitle: string, accent: string, background: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 288;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = background;
    context.fillRect(0, 0, 512, 288);
    context.fillStyle = 'rgba(255,255,255,0.045)';
    for (let y = 0; y < 288; y += 4) context.fillRect(0, y, 512, 1);
    context.strokeStyle = accent;
    context.lineWidth = 6;
    context.strokeRect(10, 10, 492, 268);
    context.fillStyle = accent;
    context.font = '700 62px Georgia, serif';
    context.fillText(title, 30, 130);
    context.font = '400 28px Georgia, serif';
    context.fillStyle = 'rgba(255,255,255,0.78)';
    context.fillText(subtitle, 32, 182);
    for (let i = 0; i < 5; i += 1) context.fillRect(30 + i * 26, 226, 16, 10);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.billboardTextures.push(texture);
    return texture;
  }

  private createBillboards(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const textures = [
      this.billboardTexture('CHOIR', 'ONE HEAVEN / ONE OWNER', '#e8c96f', '#101418'),
      this.billboardTexture('AETHEL', 'MEMORY IS CURRENCY', '#7fd4e8', '#0d1418'),
      this.billboardTexture('SERAPH', 'ASCENSION MOTORWORKS', '#d88ce8', '#120e16'),
    ];
    const tall = buildingData
      .filter((building) => building.scale.y > 26)
      .sort((a, b) => b.scale.y - a.scale.y)
      .slice(0, this.settings.quality === 'low' ? 6 : 14);
    tall.forEach((building, index) => {
      const texture = textures[index % textures.length];
      if (!texture) return;
      const material = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.45, 1.45, 1.45) });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 4.16), material);
      const roadX = Math.round(building.position.x / 30) * 30;
      const roadZ = Math.round(building.position.z / 30) * 30;
      const faceX = Math.abs(roadX - building.position.x) < Math.abs(roadZ - building.position.z);
      if (faceX) {
        const side = roadX < building.position.x ? -1 : 1;
        board.position.set(
          building.position.x + side * (building.scale.x * 0.5 + 0.12),
          building.scale.y * (0.52 + seeded(index, 61) * 0.18),
          building.position.z,
        );
        board.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        const side = roadZ < building.position.z ? -1 : 1;
        board.position.set(
          building.position.x,
          building.scale.y * (0.52 + seeded(index, 61) * 0.18),
          building.position.z + side * (building.scale.z * 0.5 + 0.12),
        );
        board.rotation.y = side > 0 ? 0 : Math.PI;
      }
      this.scene.add(board);
    });
  }

  // Street-level wall life: pasted posters, stencil sigils, spray tags —
  // instanced quads flush against building faces so the whole pass costs
  // three draw calls. The mark of a lived-in city.
  private createStreetDecals(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const variants = [
      this.streetDecalTexture('poster'),
      this.streetDecalTexture('sigil'),
      this.streetDecalTexture('tag'),
    ].filter((texture): texture is THREE.CanvasTexture => Boolean(texture));
    if (!variants.length) return;
    const perVariant = this.settings.quality === 'low' ? 10 : 22;
    const dummy = new THREE.Object3D();
    variants.forEach((texture, variantIndex) => {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const placements: Array<{ matrix: THREE.Matrix4 }> = [];
      for (let i = 0; i < perVariant; i += 1) {
        const salt = 150 + variantIndex * 7;
        const building = buildingData[Math.floor(seeded(i, salt) * buildingData.length)];
        const roadX = Math.round(building.position.x / 30) * 30;
        const roadZ = Math.round(building.position.z / 30) * 30;
        const faceX = Math.abs(roadX - building.position.x) < Math.abs(roadZ - building.position.z);
        const width = variantIndex === 0 ? 1.05 : variantIndex === 1 ? 1.35 : 1.8;
        const height = variantIndex === 0 ? 1.5 : variantIndex === 1 ? 1.35 : 1.1;
        const y = variantIndex === 0 ? 1.6 + seeded(i, salt + 1) * 1.1 : 1.15 + seeded(i, salt + 1) * 1.5;
        const lateral = (seeded(i, salt + 2) - 0.5) * Math.max(0, (faceX ? building.scale.z : building.scale.x) - 2.4);
        if (faceX) {
          const side = roadX < building.position.x ? -1 : 1;
          dummy.position.set(
            building.position.x + side * (building.scale.x * 0.5 + 0.05),
            y,
            building.position.z + lateral,
          );
          dummy.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
        } else {
          const side = roadZ < building.position.z ? -1 : 1;
          dummy.position.set(
            building.position.x + lateral,
            y,
            building.position.z + side * (building.scale.z * 0.5 + 0.05),
          );
          dummy.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
        }
        const scale = 0.75 + seeded(i, salt + 3) * 0.6;
        dummy.scale.set(width * scale, height * scale, 1);
        dummy.updateMatrix();
        placements.push({ matrix: dummy.matrix.clone() });
      }
      const decalMeshes = this.addInstancedChunks(new THREE.PlaneGeometry(1, 1), material, placements);
      decalMeshes.forEach((mesh) => { mesh.renderOrder = 1; });
    });
  }

  private streetDecalTexture(kind: 'poster' | 'sigil' | 'tag') {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, 128, 128);
    if (kind === 'poster') {
      // Weathered paper notice: torn edges, bold header mark, print lines.
      ctx.fillStyle = 'rgba(226,216,196,0.92)';
      ctx.beginPath();
      ctx.moveTo(14, 8);
      ctx.lineTo(114, 12);
      ctx.lineTo(118, 116);
      ctx.lineTo(20, 120);
      ctx.lineTo(10, 60);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30,28,26,0.85)';
      ctx.fillRect(24, 22, 80, 26);
      ctx.fillStyle = 'rgba(226,216,196,0.95)';
      ctx.font = 'bold 18px serif';
      ctx.fillText('ASCEND', 30, 41);
      ctx.fillStyle = 'rgba(30,28,26,0.7)';
      for (let line = 0; line < 5; line += 1) ctx.fillRect(24, 56 + line * 12, 70 + (line % 2) * 14, 4);
      ctx.fillStyle = 'rgba(140,60,50,0.6)';
      ctx.beginPath();
      ctx.arc(92, 96, 12, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'sigil') {
      // The game's mark sprayed as a stencil — an eye inside a broken ring.
      ctx.strokeStyle = 'rgba(196,168,110,0.85)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(64, 64, 40, 0.5, Math.PI * 2 - 0.5);
      ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse(64, 64, 26, 13, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(196,168,110,0.9)';
      ctx.beginPath();
      ctx.arc(64, 64, 8, 0, Math.PI * 2);
      ctx.fill();
      // Overspray ghosting.
      ctx.fillStyle = 'rgba(196,168,110,0.12)';
      for (let i = 0; i < 40; i += 1) {
        ctx.fillRect(30 + Math.random() * 68, 30 + Math.random() * 68, 2, 2);
      }
    } else {
      // Spray tag — a fast scrawl with drips.
      ctx.strokeStyle = 'rgba(126,196,216,0.8)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(16, 84);
      ctx.bezierCurveTo(34, 34, 52, 96, 70, 48);
      ctx.bezierCurveTo(80, 26, 96, 74, 114, 42);
      ctx.stroke();
      ctx.lineWidth = 3;
      for (let i = 0; i < 5; i += 1) {
        const x = 26 + i * 18;
        ctx.beginPath();
        ctx.moveTo(x, 80);
        ctx.lineTo(x + 2, 96 + Math.random() * 18);
        ctx.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.billboardTextures.push(texture);
    return texture;
  }

  // Heat cordon: at high heat the tallest tower wakes a sweeping
  // searchlight — the wanted-level made visible on the skyline.
  private createSearchlight(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    if (!buildingData.length) return;
    const tallest = buildingData.reduce((best, building) => (building.scale.y > best.scale.y ? building : best));
    const pivot = new THREE.Group();
    pivot.position.set(tallest.position.x, tallest.scale.y + 2.2, tallest.position.z);
    const beamLength = tallest.scale.y * 1.35;
    const tilt = new THREE.Group();
    tilt.rotation.x = 0.46;
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffeec2,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 5.2, beamLength, 12, 1, true),
      coneMat,
    );
    beam.position.y = -beamLength / 2;
    tilt.add(beam);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), lampMat);
    pivot.add(tilt);
    pivot.add(lamp);
    const group = new THREE.Group();
    group.add(pivot);
    this.scene.add(group);
    this.searchlight = { pivot, coneMat, lampMat };
  }

  private createRooftopProps(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const antennas: Array<{ position: THREE.Vector3; height: number }> = [];
    const beacons: THREE.Vector3[] = [];
    const units: Array<{ position: THREE.Vector3; yaw: number; scale: number }> = [];
    const tanks: Array<{ position: THREE.Vector3; radius: number; height: number }> = [];
    buildingData.forEach((building, index) => {
      const roofY = building.scale.y;
      if (building.scale.y > 15 && seeded(index, 70) > 0.55) {
        const height = 2.4 + seeded(index, 73) * 3.4;
        const top = new THREE.Vector3(
          building.position.x + (seeded(index, 71) - 0.5) * building.scale.x * 0.5,
          roofY + height,
          building.position.z + (seeded(index, 72) - 0.5) * building.scale.z * 0.5,
        );
        antennas.push({ position: top.clone().setY(roofY + height * 0.5), height });
        if (seeded(index, 82) > 0.4) beacons.push(top.clone().setY(roofY + height + 0.12));
      }
      if (seeded(index, 74) > 0.42) {
        const count = 1 + Math.floor(seeded(index, 75) * 3);
        for (let k = 0; k < count; k += 1) {
          units.push({
            position: new THREE.Vector3(
              building.position.x + (seeded(index * 7 + k, 76) - 0.5) * building.scale.x * 0.66,
              roofY + 0.34,
              building.position.z + (seeded(index * 7 + k, 77) - 0.5) * building.scale.z * 0.66,
            ),
            yaw: seeded(index * 7 + k, 78) * Math.PI,
            scale: 0.8 + seeded(index * 7 + k, 83) * 0.6,
          });
        }
      }
      if (building.scale.y > 22 && seeded(index, 79) > 0.76) {
        tanks.push({
          position: new THREE.Vector3(building.position.x, roofY + 1.1, building.position.z),
          radius: 0.85 + seeded(index, 80) * 0.5,
          height: 1.8 + seeded(index, 81) * 0.9,
        });
      }
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1e20, roughness: 0.52, metalness: 0.62 });
    const metal = this.propMetal ?? new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.46, metalness: 0.5 });
    const rust = this.propRust ?? new THREE.MeshStandardMaterial({ color: 0x4c3a2c, roughness: 0.7, metalness: 0.34 });
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 0.3) });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);

    const antennaPlacements = antennas.map((antenna) => {
      matrix.compose(antenna.position, new THREE.Quaternion(), new THREE.Vector3(1, antenna.height, 1));
      return { matrix: matrix.clone() };
    });
    const beaconPlacements = beacons.map((position) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      return { matrix: matrix.clone() };
    });
    const unitPlacements = units.map((unit) => {
      quaternion.setFromAxisAngle(upAxis, unit.yaw);
      matrix.compose(unit.position, quaternion, new THREE.Vector3(unit.scale, 1, unit.scale));
      return { matrix: matrix.clone() };
    });
    const tankPlacements = tanks.map((tank) => {
      matrix.compose(tank.position, new THREE.Quaternion(), new THREE.Vector3(tank.radius, tank.height, tank.radius));
      return { matrix: matrix.clone() };
    });
    this.addInstancedChunks(new THREE.CylinderGeometry(0.03, 0.07, 1, 5), dark, antennaPlacements);
    this.addInstancedChunks(new THREE.SphereGeometry(0.09, 6, 5), beaconMaterial, beaconPlacements);
    this.addInstancedChunks(new THREE.BoxGeometry(1.5, 0.68, 1.05), metal, unitPlacements);
    this.addInstancedChunks(new THREE.CylinderGeometry(1, 1, 1, 10), rust, tankPlacements);
  }

  private createStreetProps() {
    const bollards: THREE.Vector3[] = [];
    const planters: Array<{ position: THREE.Vector3; yaw: number }> = [];
    const kiosks: Array<{ position: THREE.Vector3; yaw: number }> = [];
    for (let line = -120; line <= 120; line += 60) {
      for (let t = -132; t <= 132; t += 22) {
        const index = (line + 200) * 40 + (t + 200);
        if (seeded(index, 90) > 0.52) {
          const side = seeded(index, 91) > 0.5 ? 5.4 : -5.4;
          const x = line + side;
          const z = t;
          // Every fourth curb spot grows a real hydrant instead of a bollard.
          if (!this.collides(x, z, 0.4)) {
            if (seeded(index, 97) > 0.62) {
              (this.hydrantSpots ??= []).push({ x, y: 0, z, yaw: seeded(index, 98) * Math.PI * 2 });
            } else {
              bollards.push(new THREE.Vector3(x, 0.32, z));
            }
          }
        }
        if (seeded(index, 92) > 0.78) {
          const side = seeded(index, 93) > 0.5 ? 6.4 : -6.4;
          const x = t;
          const z = line - side;
          if (!this.collides(x, z, 1)) planters.push({ position: new THREE.Vector3(x, 0.26, z), yaw: seeded(index, 94) > 0.5 ? 0 : Math.PI / 2 });
        }
        if (seeded(index, 95) > 0.9) {
          const side = seeded(index, 96) > 0.5 ? 6.8 : -6.8;
          const x = t;
          const z = line + side;
          if (!this.collides(x, z, 1.2)) kiosks.push({ position: new THREE.Vector3(x, 1.1, z), yaw: side > 0 ? Math.PI : 0 });
        }
      }
    }
    const bollardMaterial = this.propRust ?? new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.42, metalness: 0.68 });
    const planterMaterial = new THREE.MeshStandardMaterial({ color: 0x22312a, roughness: 0.8, metalness: 0.08 });
    const kioskBody = this.propMetal ?? new THREE.MeshStandardMaterial({ color: 0x1d2326, roughness: 0.44, metalness: 0.55 });
    const kioskScreen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.7, 2.1) });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);

    const bollardPlacements = bollards.map((position) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      return { matrix: matrix.clone() };
    });
    const planterPlacements = planters.map((planter) => {
      quaternion.setFromAxisAngle(upAxis, planter.yaw);
      matrix.compose(planter.position, quaternion, new THREE.Vector3(1, 1, 1));
      return { matrix: matrix.clone() };
    });
    const kioskPlacements = kiosks.map((kiosk) => {
      quaternion.setFromAxisAngle(upAxis, kiosk.yaw);
      matrix.compose(kiosk.position, quaternion, new THREE.Vector3(1, 1, 1));
      return { matrix: matrix.clone() };
    });
    const screenPlacements = kiosks.map((kiosk) => {
      quaternion.setFromAxisAngle(upAxis, kiosk.yaw);
      const screenPos = kiosk.position.clone();
      screenPos.y += 0.1;
      screenPos.x += Math.sin(kiosk.yaw) * 0.27;
      screenPos.z += Math.cos(kiosk.yaw) * 0.27;
      matrix.compose(screenPos, quaternion, new THREE.Vector3(1, 1, 1));
      return { matrix: matrix.clone() };
    });
    this.addInstancedChunks(new THREE.CylinderGeometry(0.09, 0.11, 0.64, 6), bollardMaterial, bollardPlacements);
    this.addInstancedChunks(new THREE.BoxGeometry(1.9, 0.52, 0.62), planterMaterial, planterPlacements);
    this.addInstancedChunks(new THREE.BoxGeometry(1.1, 2.2, 0.5), kioskBody, kioskPlacements);
    this.addInstancedChunks(new THREE.PlaneGeometry(0.86, 1.4), kioskScreen, screenPlacements);
  }

  private createLitter() {
    // Wind-blown paper scraps — the ambient-motion detail that keeps streets
    // from reading as sterile (GTA's classic "illusion of life" trick).
    const count = 44;
    const material = new THREE.MeshBasicMaterial({ color: 0x8d9391, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 0.22), material, count);
    const items: Array<{ x: number; z: number; y: number; vx: number; vz: number; spin: number; phase: number }> = [];
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i += 1) {
      const road = Math.floor(seeded(i, 140) * 9 - 4) * 30;
      const along = (seeded(i, 141) - 0.5) * 280;
      const horizontal = seeded(i, 142) > 0.5;
      items.push({
        x: horizontal ? along : road + (seeded(i, 143) - 0.5) * 9,
        z: horizontal ? road + (seeded(i, 144) - 0.5) * 9 : along,
        y: 0.045,
        vx: 0,
        vz: 0,
        spin: 0,
        phase: seeded(i, 145) * Math.PI * 2,
      });
      matrix.makeTranslation(items[i].x, items[i].y, items[i].z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this.litter = { mesh, items };
  }

  // One verified GLB scattered as instanced draws — a single InstancedMesh
  // per source primitive, one matrix per placement. Fire-and-forget: a
  // failed verify or load just isn't there. Resolves true when it landed.
  // Map-wide instanced fields render every vertex every frame — a single
  // InstancedMesh can never frustum-cull. Binning placements into ~85 m
  // cells gives each chunk its own bounding sphere, so whole districts
  // drop out of the draw the moment they leave the frustum.
  private addInstancedChunks(
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    placements: Array<{ matrix: THREE.Matrix4; color?: THREE.Color }>,
    cellSize = 85,
  ): THREE.InstancedMesh[] {
    if (!this.scene) return [];
    const cells = new Map<string, Array<{ matrix: THREE.Matrix4; color?: THREE.Color; id: number }>>();
    placements.forEach((placement, id) => {
      const e = placement.matrix.elements;
      const key = `${Math.floor(e[12] / cellSize)}:${Math.floor(e[14] / cellSize)}`;
      const entry = { matrix: placement.matrix, color: placement.color, id };
      const list = cells.get(key);
      if (list) list.push(entry);
      else cells.set(key, [entry]);
    });
    const meshes: THREE.InstancedMesh[] = [];
    cells.forEach((list) => {
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length));
      list.forEach((placement, index) => {
        mesh.setMatrixAt(index, placement.matrix);
        if (placement.color) mesh.setColorAt(index, placement.color);
      });
      // Global placement index per local instance — lets raycast hits map an
      // instanceId back to the source spot (shootable lamps, tracked props).
      mesh.userData.instanceIds = list.map((entry) => entry.id);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.scene!.add(mesh);
      meshes.push(mesh);
    });
    return meshes;
  }

  private async instancedProp(
    id: string,
    placements: Array<{ x: number; y: number; z: number; yaw: number; scale?: number }>,
    options: {
      targetHeight?: number;
      mount?: 'ground' | 'pivot';
      surface?: 'metal' | 'generic';
      nodeFilter?: (name: string) => boolean;
      collider?: { w: number; d: number; h: number } | 'none';
      emissiveGlass?: number;
      /** Collects the spawned meshes + collider boxes so a beat can strike them. */
      track?: { meshes: THREE.Object3D[]; boxes: THREE.Box3[] };
    } = {},
  ): Promise<boolean> {
    if (!placements.length) return false;
    try {
      await this.whenReady();
      if (this.disposed) return false;
      const prop = await loadVerifiedProp(id);
      if (this.disposed) {
        prop.traverse((node) => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
        return false;
      }
      prop.updateMatrixWorld(true);
      const sources: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; local: THREE.Matrix4; glass: boolean }> = [];
      prop.traverse((node) => {
        if (node instanceof THREE.Mesh && (!options.nodeFilter || options.nodeFilter(node.name))) {
          const material = node.material as THREE.Material | THREE.Material[];
          const names = (Array.isArray(material) ? material : [material]).map((entry) => entry?.name ?? '').join(' ');
          sources.push({ geometry: node.geometry, material, local: node.matrixWorld.clone(), glass: /glass/i.test(names) });
        }
      });
      if (!sources.length) return false;
      // Prop-space bounds → uniform scale so heightMeters lands on
      // targetHeight, then ground-mount: footprint centre + base on the spot.
      const bounds = new THREE.Box3();
      const piece = new THREE.Box3();
      sources.forEach(({ geometry, local }) => {
        geometry.computeBoundingBox();
        if (geometry.boundingBox) {
          piece.copy(geometry.boundingBox).applyMatrix4(local);
          bounds.union(piece);
        }
      });
      const heightMeters = Math.max(bounds.max.y - bounds.min.y, 0.001);
      const desiredHeight = options.targetHeight ?? (prop.userData.heightMeters as number | undefined) ?? heightMeters;
      const baseScale = desiredHeight / heightMeters;
      const center = bounds.getCenter(new THREE.Vector3());
      const align = options.mount === 'pivot'
        ? new THREE.Matrix4()
        : new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const upAxis = new THREE.Vector3(0, 1, 0);
      const scaleVector = new THREE.Vector3();
      const position = new THREE.Vector3();
      const castShadow = this.highTier();
      sources.forEach(({ geometry, material, local, glass }) => {
        const chunkPlacements = placements.map((spot) => {
          quaternion.setFromAxisAngle(upAxis, spot.yaw);
          scaleVector.setScalar(baseScale * (spot.scale ?? 1));
          position.set(spot.x, spot.y, spot.z);
          matrix.compose(position, quaternion, scaleVector);
          matrix.multiply(align);
          matrix.multiply(local);
          return { matrix: matrix.clone() };
        });
        let litMaterial: THREE.Material | THREE.Material[] = material;
        if (glass && options.emissiveGlass && !Array.isArray(material)) {
          // The GLB glass IS the lantern — light it, not just the cone.
          const lit = (material as THREE.MeshStandardMaterial).clone();
          lit.emissive = new THREE.Color(options.emissiveGlass);
          lit.emissiveIntensity = 1.6;
          litMaterial = lit;
        }
        const chunks = this.addInstancedChunks(geometry, litMaterial, chunkPlacements);
        chunks.forEach((mesh) => {
          mesh.castShadow = castShadow;
          mesh.receiveShadow = true;
          mesh.userData.blocksShot = true;
          mesh.userData.surfaceKind = glass ? 'glass' : options.surface ?? 'generic';
          this.rayTargets.push(mesh);
          options.track?.meshes.push(mesh);
        });
      });
      if (options.collider && options.collider !== 'none') {
        const { w, d, h } = options.collider;
        placements.forEach((spot) => {
          // Yaw-rotated footprint → conservative axis-aligned box.
          const c = Math.abs(Math.cos(spot.yaw));
          const s = Math.abs(Math.sin(spot.yaw));
          const hx = (w / 2) * c + (d / 2) * s;
          const hz = (w / 2) * s + (d / 2) * c;
          const box = new THREE.Box3(
            new THREE.Vector3(spot.x - hx, spot.y, spot.z - hz),
            new THREE.Vector3(spot.x + hx, spot.y + h, spot.z + hz),
          );
          this.collisionBoxes.push(box);
          options.track?.boxes.push(box);
        });
      }
      return true;
    } catch {
      // The street is complete without the prop — verification keeps it honest.
      return false;
    }
  }

  // Derived-asset street dressing along the main route: verified GLB props
  // layered over the procedural furniture. Placements are seeded and the
  // `spots` registry keeps props off each other; `reserved` covers the
  // landmark/sigil/door spaces that have no collision box to collide with.
  private createRouteProps(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    type Spot = { x: number; y: number; z: number; yaw: number };
    const spots: Array<{ x: number; z: number; r: number }> = [];
    const reserved: Array<[number, number, number]> = [
      [-69, 55.5, 2.8],   // memorial obelisk
      [-69, 52.5, 2.2],   // chapel sigil
      [-65.5, 48, 3.2],   // chapel door approach
      [0, 34, 2.4],       // spire sigil
      [0, -54, 2.6],      // gate sigil
    ];
    const blocked = (x: number, z: number, r: number) =>
      this.collides(x, z, r)
      || (x > -79.5 && x < -64.5 && z > 41.5 && z < 54.5) // chapel walls land later — keep its footprint clear
      || spots.some((spot) => Math.hypot(spot.x - x, spot.z - z) < spot.r + r)
      || reserved.some(([rx, rz, rr]) => Math.hypot(rx - x, rz - z) < rr + r);
    const take = (x: number, z: number, r: number) => { spots.push({ x, z, r }); };
    // Face-mounted props are supposed to touch a wall — skip the collider
    // check (the building box would always win) but still respect props/spots.
    const blockedWall = (x: number, z: number, r: number) =>
      spots.some((spot) => Math.hypot(spot.x - x, spot.z - z) < spot.r + r)
      || reserved.some(([rx, rz, rr]) => Math.hypot(rx - x, rz - z) < rr + r);
    // A wall-face spot: position proud of the building, yaw facing the road.
    const faceSpot = (building: (typeof buildingData)[number], outset: number, y: number): Spot => {
      const roadX = Math.round(building.position.x / 30) * 30;
      const roadZ = Math.round(building.position.z / 30) * 30;
      const faceX = Math.abs(roadX - building.position.x) < Math.abs(roadZ - building.position.z);
      if (faceX) {
        const side = roadX < building.position.x ? -1 : 1;
        return { x: building.position.x + side * (building.scale.x * 0.5 + outset), y, z: building.position.z, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2 };
      }
      const side = roadZ < building.position.z ? -1 : 1;
      return { x: building.position.x, y, z: building.position.z + side * (building.scale.z * 0.5 + outset), yaw: side > 0 ? 0 : Math.PI };
    };

    // Street lamps — the GLB lantern replaces every procedural pole site.
    const lampPoleMeshes: THREE.Object3D[] = [];
    void this.instancedProp('street_lamp_01',
      (this.streetLamps ?? []).map((lamp, index) => ({ x: lamp.x, y: 0, z: lamp.z, yaw: seeded(index, 210) * Math.PI * 2 })),
      { targetHeight: 5.2, surface: 'metal', emissiveGlass: 0xffc87a, collider: { w: 0.34, d: 0.34, h: 5.2 }, track: { meshes: lampPoleMeshes, boxes: [] } },
    ).then((placed) => {
      if (this.disposed) return;
      if (!placed) { this.buildFallbackLampPoles(); return; }
      // Register each pole chunk under the shootable-lamp lookup — a round to
      // the lantern kills its glow, and the pole itself darkens with it.
      lampPoleMeshes.forEach((mesh) => {
        mesh.userData.lampPole = true;
        ((mesh.userData.instanceIds as number[] | undefined) ?? []).forEach((id, local) => {
          const part = this.lampParts.get(id) ?? { poles: [] };
          part.poles.push({ mesh: mesh as THREE.InstancedMesh, local });
          this.lampParts.set(id, part);
        });
      });
    });

    // Painted benches on sidewalks + a pair inside Bell Below.
    const benches: Spot[] = [];
    for (let i = 0; i < 60 && benches.length < 8; i += 1) {
      const line = (Math.floor(seeded(i, 211) * 11) - 5) * 30;
      const side = seeded(i, 212) > 0.5 ? 6.3 : -6.3;
      const along = (seeded(i, 213) - 0.5) * 260;
      if (seeded(i, 214) > 0.5) {
        const x = line + side;
        if (!blocked(x, along, 1.0)) { benches.push({ x, y: 0, z: along, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2 }); take(x, along, 1.0); }
      } else {
        const z = line + side;
        if (!blocked(along, z, 1.0)) { benches.push({ x: along, y: 0, z, yaw: side > 0 ? Math.PI : 0 }); take(along, z, 1.0); }
      }
    }
    // The fixed pair sits in the memorial garden, turned toward the obelisk.
    [{ x: -72.6, z: 60.6, yaw: 2.3 }, { x: -63.8, z: 55.2, yaw: 2.4 }].forEach((bench) => {
      if (!blocked(bench.x, bench.z, 1.0)) { benches.push({ ...bench, y: 0 }); take(bench.x, bench.z, 1.0); }
    });
    // Sena's bench beside the lamp she tends on the Saint Orison approach.
    if (!blocked(-2.6, -32.2, 1.0)) { benches.push({ x: -2.6, y: 0, z: -32.2, yaw: -2.0 }); take(-2.6, -32.2, 1.0); }
    void this.instancedProp('painted_wooden_bench', benches, { targetHeight: 0.95, collider: { w: 1.9, d: 0.7, h: 0.95 } });

    // Manhole covers flush with the asphalt — visible, never blocking.
    const manholes: Spot[] = [];
    for (let i = 0; i < 40 && manholes.length < 14; i += 1) {
      const line = (Math.floor(seeded(i, 221) * 11) - 5) * 30;
      const t = (seeded(i, 222) - 0.5) * 280;
      const horizontal = seeded(i, 223) > 0.5;
      const x = horizontal ? line : t;
      const z = horizontal ? t : line;
      if (!blocked(x, z, 0.5)) { manholes.push({ x, y: 0.035, z, yaw: seeded(i, 224) * Math.PI * 2 }); take(x, z, 0.5); }
    }
    void this.instancedProp('water_manhole_cover', manholes, { targetHeight: 0.05, surface: 'metal', collider: 'none' });

    // Hydrants — the curb spots createStreetProps split off from bollards.
    void this.instancedProp('fire_hydrant', this.hydrantSpots ?? [], {
      targetHeight: 0.8,
      surface: 'metal',
      nodeFilter: (name) => name.includes('_aged'),
      collider: { w: 0.34, d: 0.34, h: 0.8 },
    });

    // Concrete barriers — a staggered cordon on the Bell Below approach
    // plus a loose ring inside the clearing itself.
    const barriers: Spot[] = [];
    [
      { x: -9, z: -37, yaw: 0.06 }, { x: -4.4, z: -40, yaw: -0.05 }, { x: 4.4, z: -39, yaw: 0.08 },
      { x: 9, z: -37.5, yaw: -0.04 }, { x: -6.6, z: -45, yaw: 0.1 }, { x: 6.6, z: -44, yaw: -0.08 },
    ].forEach((spot) => {
      if (!blocked(spot.x, spot.z, 1.0)) { barriers.push({ ...spot, y: 0 }); take(spot.x, spot.z, 1.0); }
    });
    for (let i = 0; i < 16 && barriers.length < 10; i += 1) {
      const angle = seeded(i, 232) * Math.PI * 2;
      const x = Math.cos(angle) * 13;
      const z = -54 + Math.sin(angle) * 13;
      if (!blocked(x, z, 1.0)) { barriers.push({ x, y: 0, z, yaw: -angle + Math.PI / 2 }); take(x, z, 1.0); }
    }
    void this.instancedProp('concrete_road_barrier', barriers, { targetHeight: 1.1, collider: { w: 2.4, d: 0.6, h: 1.1 } });

    // A second barrier style on the dockside / industrial streets.
    const dockBarriers: Spot[] = [];
    for (let i = 0; i < 30 && dockBarriers.length < 6; i += 1) {
      const line = [60, 90, 120][Math.floor(seeded(i, 233) * 3)];
      const along = 40 + seeded(i, 234) * 60;
      const horizontal = seeded(i, 235) > 0.5;
      const x = horizontal ? along : line + (seeded(i, 236) > 0.5 ? 3.4 : -3.4);
      const z = horizontal ? line + (seeded(i, 236) > 0.5 ? 3.4 : -3.4) : along;
      if (!blocked(x, z, 1.0)) {
        dockBarriers.push({ x, y: 0, z, yaw: (horizontal ? 0 : Math.PI / 2) + (seeded(i, 237) - 0.5) * 0.3 });
        take(x, z, 1.0);
      }
    }
    void this.instancedProp('concrete_road_barrier_02', dockBarriers, { targetHeight: 1.0, collider: { w: 2.0, d: 0.6, h: 1.0 } });

    // Memorial statue + mossy stones around the garden clearing.
    void this.instancedProp('gothic_statue', [
      { x: -70.9, y: 0, z: 58.9, yaw: Math.PI * 0.9 },
    ], { targetHeight: 1.9, collider: { w: 1.0, d: 1.0, h: 1.9 } });
    const rocks: Spot[] = [];
    [{ x: -66.3, z: 59.0, yaw: 1.1 }, { x: -74.9, z: 58.2, yaw: 2.4 }, { x: -80.4, z: 55.8, yaw: 0.4 }].forEach((spot) => {
      if (!blocked(spot.x, spot.z, 1.6)) { rocks.push({ ...spot, y: 0 }); take(spot.x, spot.z, 1.6); }
    });
    void this.instancedProp('rock_moss_set_01', rocks, { targetHeight: 0.9, collider: { w: 1.9, d: 1.4, h: 0.9 } });
    const boulders: Spot[] = [];
    [{ x: -64.9, z: 57.9, yaw: 0.2 }, { x: -76.8, z: 61.3, yaw: 1.8 }, { x: -80.6, z: 47.6, yaw: 2.9 }].forEach((spot) => {
      if (!blocked(spot.x, spot.z, 1.0)) { boulders.push({ ...spot, y: 0 }); take(spot.x, spot.z, 1.0); }
    });
    void this.instancedProp('boulder_01', boulders, { targetHeight: 0.85, collider: { w: 0.9, d: 0.9, h: 0.85 } });

    // Roller shutters on street-facing walls — service entrances, mostly shut.
    const shutters: Spot[] = [];
    for (let i = 0; i < 30 && shutters.length < 8; i += 1) {
      const building = buildingData[Math.floor(seeded(i, 241) * buildingData.length)];
      const spot = faceSpot(building, 0.08, 0);
      if (!blockedWall(spot.x, spot.z, 1.6)) { shutters.push(spot); take(spot.x, spot.z, 1.6); }
    }
    void this.instancedProp('rollershutter_door', shutters, { targetHeight: 2.4, surface: 'metal', collider: { w: 3.0, d: 0.34, h: 2.4 } });

    // Industrial wall lamps along the route corridor — sconce-height, a few
    // carrying real point lights inside the scene's light budget.
    const routeLength = Math.hypot(-72, 102);
    const routeDistance = (x: number, z: number) => {
      const t = clamp(((x - 0) * -72 + (z + 54) * 102) / (routeLength * routeLength), 0, 1);
      return Math.hypot(x - t * -72, z - (-54 + t * 102));
    };
    const corridor = buildingData.filter((building) => routeDistance(building.position.x, building.position.z) < 34);
    const wallLamps: Spot[] = [];
    for (let i = 0; i < 40 && wallLamps.length < 12 && corridor.length; i += 1) {
      const building = corridor[Math.floor(seeded(i, 251) * corridor.length)];
      const spot = faceSpot(building, 0.12, 3.0 + seeded(i, 252) * 1.4);
      if (!blockedWall(spot.x, spot.z, 0.6)) { wallLamps.push(spot); take(spot.x, spot.z, 0.6); }
    }
    let lampBudget = 13;
    this.scene.traverse((node) => { if (node instanceof THREE.PointLight) lampBudget -= 1; });
    lampBudget = Math.max(0, lampBudget - 1); // one stays reserved for the stove
    wallLamps.forEach((spot, index) => {
      if (index >= lampBudget) return;
      const light = new THREE.PointLight(0xffb464, 2.4, 10, 1.8);
      light.position.set(spot.x + Math.sin(spot.yaw) * 0.42, spot.y + 0.05, spot.z + Math.cos(spot.yaw) * 0.42);
      this.scene.add(light);
    });
    void this.instancedProp('industrial_wall_lamp', wallLamps, {
      targetHeight: 0.55, mount: 'pivot', surface: 'metal', emissiveGlass: 0xffb464, collider: 'none',
    });

    // Utility pipe runs against industrial facades at street level.
    const pipeWall = buildingData.filter((building) => building.position.x > 32 && building.position.z < -24 && building.scale.y > 18);
    const pipes: Spot[] = [];
    for (let i = 0; i < 24 && pipes.length < 6 && pipeWall.length; i += 1) {
      const building = pipeWall[Math.floor(seeded(i, 261) * pipeWall.length)];
      const spot = faceSpot(building, 0.55, 0);
      if (!blockedWall(spot.x, spot.z, 1.1)) { pipes.push(spot); take(spot.x, spot.z, 1.1); }
    }
    void this.instancedProp('modular_industrial_pipes_01', pipes, { targetHeight: 2.8, surface: 'metal', collider: { w: 0.8, d: 0.8, h: 2.4 } });

    // Barrel + stove clusters in the outer clearings, one route stove lit.
    const clusterCenters: Array<[number, number, number]> = [
      [90, 76, 18], [-112, 72, 10], [-82, 104, 10], [0, 34, 10], [-69, 63, 0],
    ];
    const barrels: Spot[] = [];
    const stoves: Spot[] = [];
    clusterCenters.forEach(([cx, cz, cr], clusterIndex) => {
      const angle = seeded(clusterIndex, 270) * Math.PI * 2;
      const bx = cx + Math.cos(angle) * cr * 0.6;
      const bz = cz + Math.sin(angle) * cr * 0.6;
      const count = 2 + (seeded(clusterIndex, 271) > 0.5 ? 1 : 0);
      for (let j = 0; j < count; j += 1) {
        const x = bx + (seeded(clusterIndex * 7 + j, 272) - 0.5) * 1.9;
        const z = bz + (seeded(clusterIndex * 7 + j, 273) - 0.5) * 1.9;
        if (blocked(x, z, 0.6)) continue;
        (j === 0 ? stoves : barrels).push({ x, y: 0, z, yaw: seeded(clusterIndex * 7 + j, 274) * Math.PI * 2 });
        take(x, z, 0.6);
      }
    });
    stoves.push({ x: -64.4, y: 0, z: 43.6, yaw: 0.7 });
    take(-64.4, 43.6, 0.6);
    void this.instancedProp('Barrel_01', barrels, { targetHeight: 0.9, surface: 'metal', collider: { w: 0.62, d: 0.62, h: 0.9 } });
    void this.instancedProp('barrel_stove', stoves, { targetHeight: 0.95, surface: 'metal', collider: { w: 0.58, d: 0.58, h: 0.95 } });
    const stove = new THREE.PointLight(0xff7a30, 2.4, 8, 1.8);
    stove.position.set(-64.4, 0.9, 43.6);
    this.scene.add(stove);
    this.stoveLight = stove;

    // Chain-link panels edging the clearings — thin colliders, angled inward.
    const fences: Spot[] = [];
    const fenceRims: Array<[number, number, number]> = [[90, 76, 18], [-112, 72, 10], [-82, 104, 10], [0, -54, 24], [0, 34, 10]];
    for (let i = 0; i < 26 && fences.length < 8; i += 1) {
      const [fx, fz, fr] = fenceRims[Math.floor(seeded(i, 280) * fenceRims.length)];
      const angle = seeded(i, 281) * Math.PI * 2;
      const x = fx + Math.cos(angle) * (fr - 1.4);
      const z = fz + Math.sin(angle) * (fr - 1.4);
      if (blocked(x, z, 3.2)) continue;
      fences.push({ x, y: 0, z, yaw: Math.atan2(fx - x, fz - z) });
      take(x, z, 3.2);
    }
    void this.instancedProp('modular_chainlink_fence', fences, { targetHeight: 2.1, surface: 'metal', collider: { w: 6.2, d: 1.6, h: 2.1 } });

    // Street-detail layer — AC units, drainpipes, junction boxes, awnings,
    // sign brackets, sidewalk clutter, slack cables. One instanced set per
    // layer; only newsboxes carry colliders.
    const detail = createStreetDetail({
      buildings: buildingData,
      lamps: this.streetLamps,
      blocked,
      blockedWall,
      claim: take,
      density: this.settings.quality === 'low' ? 0.45 : this.settings.quality === 'medium' ? 0.75 : 1,
    }, { metal: this.propMetal, rust: this.propRust });
    detail.meshes.forEach((mesh) => this.scene.add(mesh));
    detail.colliders.forEach((box) => this.collisionBoxes.push(box));
  }

  // Generated art: the chapel's memory window + memory-office posters on
  // facades. Both verify against the art manifest — a bad hash skips silently.
  private createArtDecals(buildingData: Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>) {
    const loadArt = (name: string) =>
      this.whenReady()
        .then(() => fetchVerifiedAsset('/assets/art/manifest.json', 'art', name, '/assets/art/'))
        .then(({ bytes }) => {
          if (this.disposed) return null;
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
          return new THREE.TextureLoader().loadAsync(url).finally(() => URL.revokeObjectURL(url));
        });
    void loadArt('chapel-memory-window')
      .then((texture) => { if (texture && !this.disposed) this.applyChapelWindow(texture); })
      .catch(() => { /* the warm glass panel stays the window */ });
    void loadArt('memory-office-poster')
      .then((texture) => {
        if (!texture || this.disposed) return;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const material = new THREE.MeshBasicMaterial({ map: texture, polygonOffset: true, polygonOffsetFactor: -2 });
        const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, 11);
        mesh.renderOrder = 1;
        const dummy = new THREE.Object3D();
        // Same wall placement math as the procedural posters (variant 0).
        for (let i = 0; i < 10; i += 1) {
          const salt = 171;
          const building = buildingData[Math.floor(seeded(i, salt) * buildingData.length)];
          const roadX = Math.round(building.position.x / 30) * 30;
          const roadZ = Math.round(building.position.z / 30) * 30;
          const faceX = Math.abs(roadX - building.position.x) < Math.abs(roadZ - building.position.z);
          const y = 1.6 + seeded(i, salt + 1) * 1.1;
          const lateral = (seeded(i, salt + 2) - 0.5) * Math.max(0, (faceX ? building.scale.z : building.scale.x) - 2.4);
          if (faceX) {
            const side = roadX < building.position.x ? -1 : 1;
            dummy.position.set(building.position.x + side * (building.scale.x * 0.5 + 0.052), y, building.position.z + lateral);
            dummy.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
          } else {
            const side = roadZ < building.position.z ? -1 : 1;
            dummy.position.set(building.position.x + lateral, y, building.position.z + side * (building.scale.z * 0.5 + 0.052));
            dummy.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
          }
          const scale = 0.75 + seeded(i, salt + 3) * 0.6;
          dummy.scale.set(1.05 * scale, 1.5 * scale, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        // One fixed poster on the facade nearest Sena's lamp — the notice she
        // keeps glancing at while she works the approach.
        if (buildingData.length) {
          let host = buildingData[0];
          buildingData.forEach((building) => {
            if (Math.hypot(building.position.x - SENA_LAMP_SPOT.x, building.position.z - SENA_LAMP_SPOT.z)
              < Math.hypot(host.position.x - SENA_LAMP_SPOT.x, host.position.z - SENA_LAMP_SPOT.z)) host = building;
          });
          const towardX = SENA_LAMP_SPOT.x - host.position.x;
          const towardZ = SENA_LAMP_SPOT.z - host.position.z;
          if (Math.abs(towardX) > Math.abs(towardZ)) {
            const side = Math.sign(towardX) || 1;
            dummy.position.set(host.position.x + side * (host.scale.x * 0.5 + 0.052), 1.9, host.position.z);
            dummy.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
          } else {
            const side = Math.sign(towardZ) || 1;
            dummy.position.set(host.position.x, 1.9, host.position.z + side * (host.scale.z * 0.5 + 0.052));
            dummy.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
          }
          dummy.scale.set(1.15, 1.65, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(10, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
      })
      .catch(() => { /* procedural posters already cover the walls */ });
  }

  // The verified chapel window art lands over the warm center panel — a hair
  // proud of the wall face so the original glass reads as its backglow.
  private applyChapelWindow(texture: THREE.Texture) {
    if (!this.chapelWindowAnchor) return;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      emissive: 0xffffff,
      emissiveIntensity: 1.15,
      roughness: 0.25,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.4), material);
    panel.position.copy(this.chapelWindowAnchor);
    panel.rotation.y = Math.PI / 2;
    this.scene.add(panel);
  }

  private updateLitter(delta: number, time: number) {
    if (!this.litter) return;
    const { mesh, items } = this.litter;
    const gust = 0.55 + Math.sin(time * 0.31) * 0.45 + Math.sin(time * 1.7) * 0.18;
    const windX = Math.sin(time * 0.13) * gust;
    const windZ = Math.cos(time * 0.09) * gust * 0.8;
    const quaternion = this.litterQuaternion;
    const scale = this.litterScale;
    items.forEach((item, index) => {
      // Traffic slipstream: passing cars shove litter aside and lift it.
      this.trafficCars?.forEach((car) => {
        if (car.wrecked || Math.abs(car.speed) < 2) return;
        const dx = item.x - car.group.position.x;
        const dz = item.z - car.group.position.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < 7.3) {
          const dist = Math.max(0.4, Math.sqrt(distSq));
          const push = (Math.abs(car.speed) * 0.16) / dist;
          item.vx += (dx / dist) * push + (car.axis === 'x' ? car.direction * push * 0.6 : 0);
          item.vz += (dz / dist) * push + (car.axis === 'z' ? car.direction * push * 0.6 : 0);
          item.y = Math.min(0.5, item.y + push * 0.09);
        }
      });
      item.vx += (windX - item.vx) * delta * 0.7;
      item.vz += (windZ - item.vz) * delta * 0.7;
      item.x += item.vx * delta;
      item.z += item.vz * delta;
      const speed = Math.hypot(item.vx, item.vz);
      item.spin = damp(item.spin, clamp(speed * 1.6, 0, 3.4), 4, delta);
      item.y = Math.max(0.045, item.y - delta * 0.22);
      if (item.x < -160 || item.x > 160 || item.z < -160 || item.z > 160) {
        const road = Math.floor(seeded(index, Math.floor(time) + 146) * 9 - 4) * 30;
        const along = (seeded(index, Math.floor(time) + 147) - 0.5) * 280;
        const horizontal = seeded(index, Math.floor(time) + 148) > 0.5;
        item.x = horizontal ? along : road;
        item.z = horizontal ? road : along;
        item.vx = 0;
        item.vz = 0;
      }
      quaternion.setFromEuler(this.litterEuler.set(
        -Math.PI / 2 + Math.sin(time * item.spin + item.phase) * clamp(speed, 0, 1) * 0.9,
        item.phase + time * item.spin * 0.4,
        Math.sin(time * item.spin * 0.7 + item.phase) * 0.4,
      ));
      this.litterMatrix.compose(this.litterPosition.set(item.x, item.y + Math.sin(time * item.spin + item.phase) * 0.05 * clamp(speed, 0, 1), item.z), quaternion, scale);
      mesh.setMatrixAt(index, this.litterMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  private createContactShadows() {
    // Soft radial blob shadows — the cheapest credible AO: anchors actors,
    // vehicles, and the player to the ground instead of floating.
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
    gradient.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.contactShadowSources = [
      { object: this.player, radius: 1.15, visible: true },
      ...this.actors.map((actor) => ({
        object: actor.group,
        radius: actor.kind === 'drone' ? 0.85 : actor.kind === 'boss' ? 2.4 : 1.05,
        visible: true,
      })),
      ...this.vehicles.map((vehicle) => ({ object: vehicle.group, radius: 3.4, visible: true })),
      ...this.trafficCars.map((car) => ({ object: car.group, radius: 3.4, visible: true })),
    ];
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, this.contactShadowSources.length);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.contactShadows = mesh;
    this.contactShadowQuaternion.setFromEuler(this.litterEuler.set(-Math.PI / 2, 0, 0));
  }

  private footstepSurface(): 'street' | 'stone' | 'veil' | 'puddle' {
    if (this.veilActive) return 'veil';
    if (this.chapelInterior || this.stationInterior) return 'stone';
    if (this.player.position.y < 0.4) {
      for (const spot of this.puddleSpots ?? []) {
        const dx = spot.x - this.player.position.x;
        const dz = spot.z - this.player.position.z;
        if (dx * dx + dz * dz < 3.2) return 'puddle';
      }
    }
    return 'street';
  }

  private updateContactShadows() {
    if (!this.contactShadows) return;
    this.contactShadowSources.forEach((source, index) => {
      const grounded = source.object.position.y;
      const shrink = clamp(1 - grounded * 0.22, 0.35, 1);
      this.contactShadowPosition.set(source.object.position.x, 0.035, source.object.position.z);
      this.contactShadowScale.set(source.radius * shrink, source.radius * shrink, 1);
      this.contactShadowMatrix.compose(this.contactShadowPosition, this.contactShadowQuaternion, this.contactShadowScale);
      if (!source.object.visible) this.contactShadowMatrix.makeScale(0, 0, 0);
      this.contactShadows!.setMatrixAt(index, this.contactShadowMatrix);
    });
    this.contactShadows.instanceMatrix.needsUpdate = true;
  }

  private createLandmark(position: THREE.Vector3, color: number, label: string) {
    const group = new THREE.Group();
    group.position.copy(position);
    group.userData.label = label;
    const material = new THREE.MeshStandardMaterial({ color: 0x272a29, roughness: 0.38, metalness: 0.52 });
    const accent = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.55,
      roughness: 0.24,
      metalness: 0.68,
    });
    this.phaseMaterials.push(material, accent);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 2.4, 8), material);
    base.position.y = 1.2;
    base.castShadow = true;
    group.add(base);
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.82, 13, 8), material);
      column.position.set(Math.cos(angle) * 6.1, 7.7, Math.sin(angle) * 6.1);
      column.castShadow = true;
      group.add(column);
    }
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3.2, 16, 8), material);
    spire.position.y = 18;
    spire.castShadow = true;
    group.add(spire);
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(1.2, 0), accent);
    beacon.position.y = 27;
    group.add(beacon);
    this.scene.add(group);
  }

  private createPlayer() {
    this.player.name = 'Aurel';
    const selected = PLAYER_SKINS[this.settings.characterSkin];
    const coatMaterial = new THREE.MeshStandardMaterial({ color: selected.coat, roughness: 0.78, metalness: 0.12 });
    const armorMaterial = new THREE.MeshStandardMaterial({ color: selected.armor, roughness: 0.32, metalness: 0.66 });
    const goldMaterial = new THREE.MeshStandardMaterial({ color: selected.accent, emissive: selected.accent, emissiveIntensity: 0.22, metalness: 0.78, roughness: 0.24 });
    const skinMaterial = new THREE.MeshStandardMaterial({ color: selected.skin, roughness: 0.86, metalness: 0, envMapIntensity: 0.35 });
    const hairMaterial = new THREE.MeshStandardMaterial({ color: selected.hair, roughness: 0.92, metalness: 0 });
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xe9e1d4, roughness: 0.42 });
    const iris = new THREE.MeshStandardMaterial({ color: 0x6f8e8f, roughness: 0.25, metalness: 0.08 });
    this.playerSkinMaterials = { coat: coatMaterial, armor: armorMaterial, accent: goldMaterial, skin: skinMaterial, hair: hairMaterial };

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.02, 8, 14), coatMaterial);
    torso.scale.set(1.06, 1, 0.7);
    torso.position.y = 1.68;
    torso.castShadow = true;
    this.player.add(torso);
    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.24, 6, 12), coatMaterial);
    pelvis.scale.set(1, 0.72, 0.72);
    pelvis.position.y = 1.02;
    this.player.add(pelvis);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.66, 0.22, 2, 2, 1), armorMaterial);
    chest.position.set(0, 1.91, -0.39);
    chest.rotation.x = -0.12;
    this.player.add(chest);
    const sternum = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 1), goldMaterial);
    sternum.position.set(0, 1.92, -0.53);
    sternum.scale.set(0.72, 1.15, 0.28);
    this.player.add(sternum);
    for (const side of [-1, 1]) {
      const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.78, 0.07), goldMaterial);
      lapel.position.set(side * 0.24, 1.72, -0.48);
      lapel.rotation.z = side * 0.16;
      this.player.add(lapel);
    }

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.21, 0.28, 12), skinMaterial);
    neck.position.y = 2.45;
    this.player.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.37, 24, 18), skinMaterial);
    head.scale.set(0.88, 1.08, 0.92);
    head.position.y = 2.78;
    head.castShadow = true;
    head.name = 'head';
    this.player.add(head);
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), skinMaterial);
    jaw.scale.set(0.88, 0.72, 0.86);
    jaw.position.set(0, 2.64, -0.035);
    jaw.name = 'head';
    this.player.add(jaw);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.17, 10), skinMaterial);
    nose.position.set(0, 2.79, -0.35);
    nose.rotation.x = -Math.PI / 2;
    nose.name = 'head';
    this.player.add(nose);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), skinMaterial);
      ear.scale.set(0.55, 1, 0.62);
      ear.position.set(side * 0.335, 2.78, 0);
      ear.name = 'head';
      this.player.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), eyeWhite);
      eye.scale.set(1.22, 0.62, 0.38);
      eye.position.set(side * 0.12, 2.84, -0.34);
      eye.name = 'head';
      this.player.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), iris);
      pupil.scale.z = 0.3;
      pupil.position.set(side * 0.12, 2.84, -0.375);
      pupil.name = 'head';
      this.player.add(pupil);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.024, 0.026), hairMaterial);
      brow.position.set(side * 0.12, 2.94, -0.347);
      brow.rotation.z = side * -0.07;
      brow.name = 'head';
      this.player.add(brow);
    }
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.385, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), hairMaterial);
    hairCap.scale.set(0.9, 0.72, 0.94);
    hairCap.position.y = 2.91;
    hairCap.name = 'head';
    this.player.add(hairCap);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 6, 24), goldMaterial);
    halo.position.set(0, 3.12, 0);
    halo.rotation.x = Math.PI / 2;
    this.player.add(halo);

    for (const side of [-1, 1]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(side * 0.24, 0.97, 0);
      legPivot.userData.side = side;
      legPivot.userData.limb = 'leg';
      const upperLeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.48, 6, 10), coatMaterial);
      upperLeg.position.y = -0.32;
      upperLeg.castShadow = true;
      legPivot.add(upperLeg);
      const boot = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.46, 6, 10), armorMaterial);
      boot.position.set(0, -0.84, -0.05);
      boot.rotation.x = -0.035;
      boot.castShadow = true;
      legPivot.add(boot);
      this.player.add(legPivot);
      this.playerParts.push(legPivot);

      const armPivot = new THREE.Group();
      armPivot.position.set(side * 0.57, 2.08, -0.02);
      armPivot.rotation.z = side * 0.12;
      armPivot.userData.side = side;
      armPivot.userData.limb = 'arm';
      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.38, 6, 10), coatMaterial);
      upperArm.position.y = -0.27;
      armPivot.add(upperArm);
      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.35, 6, 10), armorMaterial);
      forearm.position.set(0, -0.7, -0.035);
      armPivot.add(forearm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 9), skinMaterial);
      hand.scale.set(0.82, 1.05, 0.62);
      hand.position.y = -1.03;
      armPivot.add(hand);
      this.player.add(armPivot);
      this.playerParts.push(armPivot);

      const coatTail = new THREE.Mesh(new THREE.BoxGeometry(0.44, 1.08, 0.08), coatMaterial);
      coatTail.position.set(side * 0.24, 1.1, 0.35);
      coatTail.rotation.x = 0.12;
      coatTail.rotation.z = side * -0.05;
      this.player.add(coatTail);
    }

    const weaponMount = new THREE.Group();
    weaponMount.name = 'Weapon mount';
    weaponMount.position.set(0.48, 1.7, -0.62);
    weaponMount.rotation.x = -0.08;
    this.buildWeaponModels(weaponMount, { coat: coatMaterial, armor: armorMaterial, gold: goldMaterial });
    this.player.add(weaponMount);
    this.player.userData.weapon = weaponMount;
    this.applyWeaponVisibility();
    this.player.children.forEach((child) => {
      child.userData.proceduralFallback = child !== weaponMount;
    });
    this.player.position.set(0, 0, 34);
    this.scene.add(this.player);
  }

  private async swapHeroCharacter(skin: CharacterSkin, initialLoad = false) {
    const token = ++this.heroLoadToken;
    try {
      const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const character = await loadHeroCharacter(skin, anisotropy, (progress) => {
        if (initialLoad) this.callbacks.onLoadProgress(0.58 + progress * 0.14, 'Resolving skin, cloth, and memory');
      });
      if (this.disposed || token !== this.heroLoadToken) {
        character.dispose();
        return;
      }
      if (this.heroCharacter) {
        const weapon = this.player.userData.weapon as THREE.Object3D | undefined;
        if (weapon) this.restoreFallbackWeaponTransform(weapon);
        this.player.remove(this.heroCharacter.object);
        this.heroCharacter.dispose();
      }
      this.player.children.forEach((child) => {
        if (child.userData.proceduralFallback) child.visible = false;
      });
      this.heroCharacter = character;
      character.object.scale.setScalar(HERO_CHARACTER_SCALE);
      this.player.add(character.object);
      // Feet plant on whatever the player is actually standing on — the same
      // collider-top sampler the grounding code uses.
      character.setFootIKSampler((x, z) => this.groundHeightAt(x, z, this.player.position.y));
      character.object.updateMatrixWorld(true);
      this.updateInspectionFraming(character.object);
      const weapon = this.player.userData.weapon as THREE.Object3D | undefined;
      if (weapon && !character.attachHeldObject(weapon)) this.restoreFallbackWeaponTransform(weapon);
      if (weapon) {
        delete weapon.userData.restRotation;
        delete weapon.userData.restPosition;
      }
      this.emitToast('Character streaming complete', `${character.boneCount} bones · ${character.morphCount} facial/body shapes`, 'success');
      // A skin arriving mid-veil still gets the ghost-sheen.
      if (this.veilActive) {
        this.veilHeroStates.clear();
        this.applyVeilToHero(true);
      }
    } catch (error) {
      if (token !== this.heroLoadToken || this.disposed) return;
      this.player.children.forEach((child) => {
        if (child.userData.proceduralFallback) child.visible = true;
      });
      const detail = error instanceof Error ? error.message : 'The character asset could not be decoded.';
      console.warn('Using procedural character fallback:', detail);
      if (!initialLoad) this.emitToast('Character fallback active', 'The rigged skin could not be loaded; gameplay remains available.', 'danger');
    }
  }

  private restoreFallbackWeaponTransform(weapon: THREE.Object3D) {
    this.player.add(weapon);
    weapon.position.set(0.48, 1.7, -0.62);
    weapon.rotation.set(-0.08, 0, 0);
    weapon.scale.setScalar(1);
    delete weapon.userData.restRotation;
    delete weapon.userData.restPosition;
    weapon.updateMatrixWorld(true);
  }

  private buildWeaponModels(mount: THREE.Group, materials: { coat: THREE.Material; armor: THREE.Material; gold: THREE.Material }) {
    const { coat, armor, gold } = materials;
    const cyanAccent = new THREE.MeshStandardMaterial({ color: 0x9fd6ff, emissive: 0x4fb6e8, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.5 });
    const emberAccent = new THREE.MeshStandardMaterial({ color: 0xffa35c, emissive: 0xe86a28, emissiveIntensity: 1.7, roughness: 0.3, metalness: 0.5 });

    const morrow = new THREE.Group();
    morrow.name = 'weapon-morrow';
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.52), armor);
    slide.position.z = -0.18;
    slide.castShadow = true;
    morrow.add(slide);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.5, 12), coat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -0.24);
    barrel.castShadow = true;
    morrow.add(barrel);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.32, 0.17), coat);
    grip.position.set(0, -0.19, 0.015);
    grip.rotation.x = -0.22;
    grip.castShadow = true;
    morrow.add(grip);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.035, 12), armor);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.z = -0.455;
    morrow.add(muzzle);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.035, 0.24), gold);
    sight.position.set(0, 0.098, -0.19);
    morrow.add(sight);
    morrow.userData.muzzle = new THREE.Vector3(0, 0.01, -0.5);
    // Pistol two-hand wrap: the left palm presses the right grip's side.
    morrow.userData.foregrip = new THREE.Vector3(-0.1, -0.16, 0.04);
    mount.add(morrow);

    const psalm = new THREE.Group();
    psalm.name = 'weapon-psalm';
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.19, 0.86), armor);
    receiver.position.z = -0.24;
    receiver.castShadow = true;
    psalm.add(receiver);
    const railBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 12), coat);
    railBarrel.rotation.x = Math.PI / 2;
    railBarrel.position.set(0, 0.03, -0.66);
    railBarrel.castShadow = true;
    psalm.add(railBarrel);
    const psalmMuzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 12), cyanAccent);
    psalmMuzzle.rotation.x = Math.PI / 2;
    psalmMuzzle.position.set(0, 0.03, -1.02);
    psalm.add(psalmMuzzle);
    const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.34, 0.19), coat);
    magazine.position.set(0, -0.24, -0.12);
    magazine.rotation.x = 0.24;
    magazine.castShadow = true;
    psalm.add(magazine);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.22, 0.34), coat);
    stock.position.set(0, -0.03, 0.32);
    stock.rotation.x = 0.1;
    psalm.add(stock);
    const coilStrip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.5), cyanAccent);
    coilStrip.position.set(0.078, 0.02, -0.4);
    psalm.add(coilStrip);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.4), gold);
    rail.position.set(0, 0.12, -0.36);
    psalm.add(rail);
    psalm.userData.muzzle = new THREE.Vector3(0, 0.03, -1.06);
    // Support hand rides the rail just ahead of the receiver.
    psalm.userData.foregrip = new THREE.Vector3(0, -0.07, -0.46);
    mount.add(psalm);

    const vesper = new THREE.Group();
    vesper.name = 'weapon-vesper';
    const receiverWide = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.22, 0.68), coat);
    receiverWide.position.z = -0.16;
    receiverWide.castShadow = true;
    vesper.add(receiverWide);
    for (const side of [-1, 1]) {
      const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.62, 12), armor);
      bore.rotation.x = Math.PI / 2;
      bore.position.set(side * 0.055, 0.04, -0.5);
      bore.castShadow = true;
      vesper.add(bore);
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.14, 8), emberAccent);
      shell.rotation.z = Math.PI / 2;
      shell.position.set(side * 0.14, -0.02, 0.02);
      vesper.add(shell);
    }
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.12, 0.3), armor);
    pump.position.set(0, -0.13, -0.44);
    pump.castShadow = true;
    vesper.add(pump);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.2), emberAccent);
    vent.position.set(0, 0.14, -0.3);
    vesper.add(vent);
    const vesperGrip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.3, 0.16), coat);
    vesperGrip.position.set(0, -0.22, 0.14);
    vesperGrip.rotation.x = -0.26;
    vesper.add(vesperGrip);
    vesper.userData.muzzle = new THREE.Vector3(0, 0.04, -0.83);
    // The pump *is* the foregrip — the left hand sits right on it.
    vesper.userData.foregrip = new THREE.Vector3(0, -0.11, -0.44);
    mount.add(vesper);
  }

  private applyWeaponVisibility() {
    const mount = this.player?.userData?.weapon as THREE.Group | undefined;
    if (!mount) return;
    const activeName = `weapon-${this.weaponId ?? 'morrow'}`;
    mount.children.forEach((child) => {
      child.visible = child.name === activeName;
    });
  }

  private activeWeaponSpec(): WeaponSpec {
    return WEAPONS[this.weaponId] ?? MORROW_SPEC;
  }

  private cycleWeapon(direction = 1) {
    if (this.currentVehicle || this.paused) return;
    const index = WEAPON_ORDER.indexOf(this.weaponId);
    const next = WEAPON_ORDER[(index + direction + WEAPON_ORDER.length) % WEAPON_ORDER.length];
    if (next === this.weaponId) return;
    this.weaponPools[this.weaponId] = { ammo: this.ammo, reserve: this.reserveAmmo };
    this.weaponId = next;
    const spec = WEAPONS[next];
    const pool = this.weaponPools[next];
    this.ammo = pool?.ammo ?? spec.magazineSize;
    this.reserveAmmo = pool?.reserve ?? spec.startingReserve;
    this.reloading = 0;
    this.weaponRecoil = 0;
    this.shotCooldown = Math.max(this.shotCooldown, spec.swapSeconds);
    this.weaponInspect = 0.85;
    this.applyWeaponVisibility();
    this.heroCharacter?.playOnce('reload', 0.07);
    this.audio.swap();
    this.emitToast(spec.name, spec.hudLabel, 'info');
  }

  private updateInspectionFraming(object: THREE.Object3D) {
    this.player.updateWorldMatrix(true, false);
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    // Convert the world-space bounds back into the player root. Subtracting a
    // cached world position is subtly wrong when the imported glTF scene has
    // its own root transform (and was the source of camera targets drifting
    // tens of metres away from Aurel in inspection mode).
    const center = bounds.getCenter(new THREE.Vector3())
      .applyMatrix4(new THREE.Matrix4().copy(this.player.matrixWorld).invert());
    const size = bounds.getSize(new THREE.Vector3());
    // The imported scene can carry a baked lateral offset from its authoring
    // collection. Inspection should orbit the gameplay capsule, not that
    // authoring origin, so retain the measured vertical center only.
    this.inspectionCenter.set(0, clamp(center.y, 1.45, 2.55), 0);
    this.inspectionHeight = Math.max(2.8, size.y);
  }

  private applyPlayerSkin(skin: CharacterSkin) {
    if (!this.playerSkinMaterials) return;
    const palette = PLAYER_SKINS[skin];
    this.playerSkinMaterials.coat.color.setHex(palette.coat);
    this.playerSkinMaterials.armor.color.setHex(palette.armor);
    this.playerSkinMaterials.accent.color.setHex(palette.accent);
    this.playerSkinMaterials.accent.emissive.setHex(palette.accent);
    this.playerSkinMaterials.skin.color.setHex(palette.skin);
    this.playerSkinMaterials.hair.color.setHex(palette.hair);
  }

  private buildCarBody(color: number, archetype = 'seraph') {
    const group = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 0.76 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x090d0f, roughness: 0.24, metalness: 0.7 });
    const headlightMaterial = new THREE.MeshStandardMaterial({ color: 0xe5c774, emissive: 0xe5a932, emissiveIntensity: 2.2 });
    const tailMaterial = new THREE.MeshStandardMaterial({ color: 0x5a1018, emissive: 0xd92632, emissiveIntensity: 0.9 });
    // Archetype silhouettes: morrow is tall and slab-sided, choir is low and long.
    const hauler = archetype === 'morrow';
    const interceptor = archetype === 'choir';
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.7, hauler ? 1.05 : 0.72, interceptor ? 7.9 : 7.1), bodyMaterial);
    body.position.y = hauler ? 0.95 : 0.82;
    body.castShadow = true;
    group.add(body);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(3.25, hauler ? 0.62 : 0.42, 2.3), bodyMaterial);
    hood.position.set(0, hauler ? 1.55 : 1.25, interceptor ? -2.6 : -2.15);
    hood.rotation.x = interceptor ? -0.14 : -0.08;
    group.add(hood);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.8, hauler ? 1.35 : interceptor ? 0.7 : 0.92, hauler ? 3.1 : 2.55), dark);
    cabin.position.set(0, hauler ? 2.1 : interceptor ? 1.32 : 1.47, 0.55);
    group.add(cabin);
    const wheels: VehicleWheel[] = [];
    for (const side of [-1, 1]) {
      for (const front of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * 1.86, 0.58, front * 2.2);
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.38, 14), dark);
        wheel.rotation.z = Math.PI / 2;
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4, 8), bodyMaterial);
        hub.rotation.z = Math.PI / 2;
        pivot.add(wheel, hub);
        group.add(pivot);
        wheels.push({ pivot, front: front === -1 });
      }
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.12), headlightMaterial);
      headlight.position.set(side * 1.12, 0.92, -3.58);
      group.add(headlight);
      const taillight = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.1), tailMaterial);
      taillight.position.set(side * 1.12, 0.98, 3.58);
      group.add(taillight);
    }
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.5, 1.2, 0.72),
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.9, 9, 12, 1, true), beamMaterial);
    beam.rotation.x = Math.PI / 2;
    beam.position.set(0, 0.95, -8.05);
    group.add(beam);
    return { group, bodyMaterial, tailMaterial, beamMaterial, wheels };
  }

  private createVehicle(id: string, x: number, z: number, heading: number, color: number) {
    const { group, bodyMaterial, tailMaterial, beamMaterial, wheels } = this.buildCarBody(color, id.split('-')[0]);
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    group.userData.vehicleId = id;
    const spotTarget = new THREE.Object3D();
    spotTarget.position.set(0, 0.2, -19);
    const spot = new THREE.SpotLight(0xffe2b0, 0, 48, 0.42, 0.5, 1.1);
    spot.position.set(0, 1.15, -3.3);
    spot.target = spotTarget;
    group.add(spot, spotTarget);
    this.scene.add(group);
    const vehicle: Vehicle = {
      id,
      group,
      spawn: group.position.clone(),
      heading,
      speed: 0,
      occupied: false,
      damage: 0,
      wrecked: false,
      bumpDip: 0,
      spec: this.vehicleSpecFor(id),
      bodyMaterial,
      wheels,
      tailMaterial,
      beamMaterial,
      spot,
    };
    this.vehicles.push(vehicle);
    return vehicle;
  }

  private createTraffic() {
    const routes: Array<{ axis: 'x' | 'z'; lane: number; direction: 1 | -1 }> = [
      { axis: 'x', lane: -30, direction: 1 },
      { axis: 'x', lane: 60, direction: -1 },
      { axis: 'x', lane: 120, direction: 1 },
      { axis: 'z', lane: -60, direction: 1 },
      { axis: 'z', lane: 30, direction: -1 },
    ];
    const colors = [0x4a3b32, 0x33434e, 0x50392f, 0x3c4a38, 0x443c50];
    routes.forEach((route, index) => {
      const { group, tailMaterial, wheels } = this.buildCarBody(colors[index % colors.length]);
      const progress = (seeded(index, 80) - 0.5) * 260;
      const lateral = route.axis === 'x' ? route.direction * 2.1 : -route.direction * 2.1;
      if (route.axis === 'x') {
        group.position.set(progress, 0, route.lane + lateral);
        group.rotation.y = route.direction > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        group.position.set(route.lane + lateral, 0, progress);
        group.rotation.y = route.direction > 0 ? Math.PI : 0;
      }
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.userData.trafficId = index;
          this.rayTargets.push(child);
        }
      });
      this.scene.add(group);
      this.trafficCars.push({
        group,
        axis: route.axis,
        lane: route.lane,
        direction: route.direction,
        offset: lateral,
        spawnProgress: progress,
        progress,
        cruise: 8.4 + seeded(index, 81) * 3.2,
        speed: 0,
        panic: 0,
        damage: 0,
        honkTimer: seeded(index, 95) * 5,
        blockedFor: 0,
        wrecked: false,
        wheels,
        tailMaterial,
      });
    });
  }

  private updateTraffic(delta: number) {
    const playerPosition = this.currentVehicle?.group.position ?? this.player?.position ?? new THREE.Vector3();
    this.trafficCars?.forEach((car) => {
      const position = car.group.position;
      const ahead = car.axis === 'x'
        ? (playerPosition.x - position.x) * car.direction
        : (playerPosition.z - position.z) * car.direction;
      const lateral = car.axis === 'x'
        ? Math.abs(playerPosition.z - position.z)
        : Math.abs(playerPosition.x - position.x);
      const blocked = !car.wrecked && ahead > 0.5 && ahead < 10 && lateral < 3.4;
      car.panic = Math.max(0, car.panic - delta);
      car.honkTimer -= delta;
      // A driver held up by the player honks after a beat — rarely twice.
      if (blocked && car.speed < 2.5) {
        car.blockedFor += delta;
        if (car.blockedFor > 0.85 && car.honkTimer <= 0) {
          car.honkTimer = 3.5 + seeded(Math.floor(this.elapsed * 10) + Math.round(car.lane * 7), 96) * 4.5;
          car.blockedFor = 0;
          const occluded = this.firstWorldObstruction(
            this.tmpMove.copy(position).setY(1.4),
            this.tmpActorFwd.copy(playerPosition).setY(1.6),
          ) !== null;
          this.audio.honk?.(position, playerPosition, this.cameraYaw, occluded);
        }
      } else {
        car.blockedFor = Math.max(0, car.blockedFor - delta * 2);
      }
      // Intersection yield: while approaching a crossing, give way to
      // cross-traffic already inside the intersection box.
      const crossings = car.axis === 'x' ? [-60, 30] : [-30, 60, 120];
      let yielding = false;
      for (const cross of crossings) {
        const dist = (cross - car.progress) * car.direction;
        if (dist > 1 && dist < 16) {
          const conflict = this.trafficCars?.some((other) =>
            other !== car && !other.wrecked && other.axis !== car.axis
            && Math.abs(other.progress - car.lane) < 11
            && Math.abs(other.lane - cross) < 11,
          );
          if (conflict) { yielding = true; break; }
        }
      }
      // Car-following: hold distance behind a car ahead on the same lane.
      const tailgating = this.trafficCars?.some((other) => {
        if (other === car || other.axis !== car.axis || Math.abs(other.lane - car.lane) > 2) return false;
        const gap = (other.progress - car.progress) * car.direction;
        return gap > 0.5 && gap < 13;
      }) ?? false;
      const target = car.wrecked || blocked || yielding || tailgating ? 0 : car.cruise * (car.panic > 0 ? 1.8 : 1);
      car.speed = damp(car.speed, target, blocked || yielding || tailgating || car.wrecked ? 9 : 2.1, delta);
      car.progress += car.speed * car.direction * delta;
      if (car.progress > 150) car.progress -= 300;
      else if (car.progress < -150) car.progress += 300;
      if (car.axis === 'x') position.set(car.progress, 0, car.lane + car.offset);
      else position.set(car.lane + car.offset, 0, car.progress);
      // LOD: beyond ~110 m the car still moves along its route but skips
      // wheel spin, smoke pulsing, and tail-light damping.
      const farAway = position.distanceToSquared(playerPosition) > 12100;
      if (!farAway) {
        car.wheels.forEach((wheel) => {
          wheel.pivot.rotation.x += (car.speed * delta) / 0.52;
        });
        if (car.wrecked && car.smoke) {
          const pulse = 0.55 + Math.sin(this.elapsed * 3.1 + car.lane) * 0.2;
          car.smoke.children.forEach((child, index) => {
            const mesh = child as THREE.Mesh;
            (mesh.material as THREE.MeshBasicMaterial).opacity = pulse * (0.16 - index * 0.045);
            mesh.position.y = 1.15 + index * 0.55 + Math.sin(this.elapsed * 1.4 + index * 2.2) * 0.08;
          });
        }
        const braking = car.wrecked || blocked || yielding || tailgating || car.speed < target * 0.55;
        car.tailMaterial.emissiveIntensity = damp(
          car.tailMaterial.emissiveIntensity,
          car.wrecked ? 0.06 : braking ? 3.4 : 0.95,
          9,
          delta,
        );
      }
    });
    this.dynamicObstacles = this.trafficCars?.map((car) => ({
      x: car.group.position.x,
      z: car.group.position.z,
      radius: 2.55,
    })) ?? [];
  }

  private updateReinforcements(delta: number) {
    if (typeof this.reinforcementTimer !== 'number') this.reinforcementTimer = 0;
    this.reinforcementTimer -= delta;
    if (this.reinforcementTimer > 0 || this.heatTierValue() < 3 || this.currentVehicle) return;
    const live = this.actors.filter((actor) => actor.alive && actor.id.startsWith('reinforce-')).length;
    if (live >= 4) {
      this.reinforcementTimer = 6;
      return;
    }
    const playerPosition = this.player.position;
    const stamp = Math.floor(this.elapsed * 10);
    const angle = seeded(stamp, 400) * Math.PI * 2;
    const distance = 30 + seeded(stamp, 401) * 22;
    const x = playerPosition.x + Math.cos(angle) * distance;
    const z = playerPosition.z + Math.sin(angle) * distance;
    if (Math.abs(x) > WORLD_SIZE / 2 - 10 || Math.abs(z) > WORLD_SIZE / 2 - 10 || this.collides(x, z, 0.7)) {
      this.reinforcementTimer = 1.5;
      return;
    }
    this.reinforcementSeq += 1;
    // Choir units transmit in — a column of light and a ground ring mark the
    // arrival so the dispatch reads at range instead of popping into frame.
    this.spawnArrival(x, z);
    // At sustained heat the Choir stops sending hunters and sends a wall:
    // every fourth dispatch at tier 4+ is a Bulwark, not a hunter.
    const bulwark = this.heatTierValue() >= 4 && this.reinforcementSeq % 4 === 0;
    if (bulwark) {
      this.createBulwark(`reinforce-${this.reinforcementSeq}`, x, z);
      this.emitToast('Bulwark dispatched', 'Plate armor inbound — flank it or Pulse it open', 'danger');
    } else {
      const hunter = this.addActor(`reinforce-${this.reinforcementSeq}`, 'enemy', x, z, 0x2a2f33, 0xe05a3a, 62);
      hunter.speed = 3.95;
      this.emitToast('Choir reinforcement', 'A hunter was dispatched to your position', 'danger');
    }
    this.reinforcementTimer = 14;
  }

  private spawnArrival(x: number, z: number) {
    if (!this.scene) return;
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.85, 9, 12, 1, true), beamMat);
    beam.position.y = 4.5;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 1.05, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    const group = new THREE.Group();
    group.add(beam, ring);
    group.position.set(x, 0, z);
    this.scene.add(group);
    (this.arrivalFlashes ??= []).push({ group, beamMat, ringMat, life: 1.15 });
    this.audio.pulse?.();
  }

  private updateArrivals(delta: number) {
    if (!this.arrivalFlashes?.length) return;
    this.arrivalFlashes = this.arrivalFlashes.filter((flash) => {
      flash.life -= delta;
      const t = clamp(flash.life / 1.15, 0, 1);
      flash.beamMat.opacity = 0.42 * t;
      flash.ringMat.opacity = 0.7 * t;
      const ring = flash.group.children[1];
      ring.scale.setScalar(1 + (1 - t) * 3.2);
      if (flash.life > 0) return true;
      this.scene?.remove(flash.group);
      this.disposeObject(flash.group);
      return false;
    });
  }

  private wreckTrafficCar(car: TrafficCar) {
    car.wrecked = true;
    car.panic = 0;
    car.group.rotation.z = (seeded(car.lane, 330) > 0.5 ? 1 : -1) * 0.045;
    car.group.position.y = -0.06;
    const smoke = new THREE.Group();
    for (let i = 0; i < 3; i += 1) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.5 + i * 0.3, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.14, depthWrite: false }),
      );
      puff.position.set(0, 1.15 + i * 0.55, -0.4);
      puff.scale.y = 1.35;
      smoke.add(puff);
    }
    car.smoke = smoke;
    car.group.add(smoke);
    // The street keeps the scar — a wide scorch under the wreck.
    this.placeDecal(car.group.position, this.tmpMove.set(0, 1, 0), 15);
    // The driver bails — a ghost car reads wrong, so somebody scrambles out
    // the door and bolts for the sidewalk.
    if (!car.driverFled && this.scene && this.actors) {
      car.driverFled = true;
      const side = car.direction > 0 ? 1 : -1;
      const dx = car.axis === 'x' ? 0 : side * 1.9;
      const dz = car.axis === 'x' ? side * 1.9 : 0;
      const px = car.group.position.x + dx;
      const pz = car.group.position.z + dz;
      if (!this.collides(px, pz, 0.4)) {
        const driver = this.addActor(`driver-${car.lane}-${Math.floor(this.elapsed * 10)}`, 'civilian', px, pz,
          [0x4a5560, 0x5d5348, 0x3d4a55, 0x554b5a][car.lane & 3], 0xb8c4d0, 42);
        driver.flee = 14;
        driver.fleeHeading = Math.atan2(dx, dz);
      }
    }
    this.heat = clamp(this.heat + 8, 0, 100);
    this.emitToast('Vehicle disabled', 'Choir response escalating', 'danger');
    this.audio.explosion();
  }

  private createRain() {
    const count = this.settings.quality === 'ultra' ? 1500 : 850;
    const geometry = new THREE.BoxGeometry(0.018, 0.62, 0.018);
    const material = new THREE.MeshBasicMaterial({
      color: 0xa8c2d4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const drops = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      drops[i * 3] = (seeded(i, 200) - 0.5) * 120;
      drops[i * 3 + 1] = seeded(i, 201) * 38;
      drops[i * 3 + 2] = (seeded(i, 202) - 0.5) * 120;
      this.rainMatrix.makeTranslation(drops[i * 3], drops[i * 3 + 1], drops[i * 3 + 2]);
      mesh.setMatrixAt(i, this.rainMatrix);
    }
    mesh.visible = this.settings.quality !== 'low';
    this.scene.add(mesh);
    this.rain = { mesh, drops, count };
  }

  /** Ground-level rain: expanding rings where drops strike the street. */
  private createRainSplashes() {
    const count = 44;
    const geometry = new THREE.RingGeometry(0.11, 0.16, 10);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x9ec2de,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const ages = new Float32Array(count);
    const spots = new Float32Array(count * 2);
    const color = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      ages[i] = seeded(i, 210) * 0.42;
      this.rainMatrix.makeTranslation(0, -10, 0);
      mesh.setMatrixAt(i, this.rainMatrix);
      mesh.setColorAt(i, color.setScalar(0));
    }
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = this.settings.quality !== 'low';
    this.scene.add(mesh);
    this.rainSplash = { mesh, ages, spots, count };
  }

  // A low storm shelf scrolling overhead — cheap sky detail that reads as
  // moving weather instead of a static gradient dome.
  private createCloudLayer() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#000000';
      context.fillRect(0, 0, size, size);
      // Layered soft blobs — cheap fbm; edges wrap because blobs drawn near
      // the border are mirrored.
      for (let i = 0; i < 340; i += 1) {
        const x = seeded(i, 150) * size;
        const y = seeded(i, 151) * size;
        const radius = 18 + seeded(i, 152) * 64;
        const shade = 26 + seeded(i, 153) * 60;
        for (const ox of [-size, 0, size]) {
          for (const oy of [-size, 0, size]) {
            const gradient = context.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, radius);
            gradient.addColorStop(0, `rgba(${shade},${shade + 6},${shade + 12},0.16)`);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            context.fillStyle = gradient;
            context.fillRect(x + ox - radius, y + oy - radius, radius * 2, radius * 2);
          }
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = 165;
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    this.cloudLayer = { mesh, texture };
  }

  // Dust motes suspended in the Veil — the Void sells itself on particles
  // hanging wrong in the air. Visible only while the Veil is open.
  private createVeilMotes() {
    const count = 150;
    const geometry = new THREE.SphereGeometry(0.022, 6, 4);
    const material = new THREE.MeshBasicMaterial({
      color: 0x9a7ad8,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.visible = false;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      seeds[i * 4] = seeded(i, 160) * Math.PI * 2;
      seeds[i * 4 + 1] = 1.5 + seeded(i, 161) * 13;
      seeds[i * 4 + 2] = seeded(i, 162) * Math.PI * 2;
      seeds[i * 4 + 3] = 0.35 + seeded(i, 163) * 1.4;
    }
    this.scene.add(mesh);
    this.veilMotes = { mesh, seeds, count };
  }

  // Dotted guidance line from the player to the active objective.
  private createBreadcrumb() {
    const count = 22;
    const geometry = new THREE.SphereGeometry(0.16, 8, 6);
    const material = new THREE.MeshBasicMaterial({ color: 0xd8b46a, transparent: true, opacity: 0.6, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    this.breadcrumb = { mesh, count };
  }

  private updateVeilMotes(time: number) {
    if (!this.veilMotes) return;
    this.veilMotes.mesh.visible = this.veilActive;
    if (!this.veilActive) return;
    const center = this.player.position;
    const { mesh, seeds, count } = this.veilMotes;
    const m = this.rainMatrix;
    for (let i = 0; i < count; i += 1) {
      const angle = seeds[i * 4] + time * 0.06 * seeds[i * 4 + 3];
      const radius = seeds[i * 4 + 1];
      const bob = seeds[i * 4 + 2];
      m.makeTranslation(
        center.x + Math.cos(angle) * radius,
        0.5 + (Math.sin(bob + time * 0.5) * 0.5 + 0.5) * 3.4,
        center.z + Math.sin(angle) * radius,
      );
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // The cordon sweeps the streets while heat is high; at tier 4 it
  // periodically drifts toward the player before resuming its patrol arc.
  private updateSearchlight(delta: number, time: number) {
    if (!this.searchlight) return;
    const tier = this.heatTierValue();
    const on = tier >= 3;
    const targetCone = on ? 0.16 : 0;
    this.searchlight.coneMat.opacity = damp(this.searchlight.coneMat.opacity, targetCone, 2.5, delta);
    this.searchlight.lampMat.opacity = damp(this.searchlight.lampMat.opacity, on ? 0.9 : 0, 2.5, delta);
    if (this.searchlight.coneMat.opacity < 0.004) return;
    let yaw = time * 0.34 + Math.sin(time * 0.11) * 0.7;
    if (tier >= 4) {
      const toPlayer = Math.atan2(this.player.position.x - this.searchlight.pivot.position.x, this.player.position.z - this.searchlight.pivot.position.z);
      const linger = (Math.sin(time * 0.21) * 0.5 + 0.5) ** 2;
      let diff = toPlayer - yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      yaw += diff * linger * 0.75;
    }
    this.searchlight.pivot.rotation.y = yaw;
  }

  private updateBreadcrumb(time: number) {
    // The cordon beat reroutes the dots to the waterline flank while it is
    // up; otherwise they run to the objective marker as usual.
    const target = this.breadcrumbTarget ?? this.objectiveMarker?.position ?? null;
    if (!this.breadcrumb || !target || (!this.breadcrumbTarget && !this.objectiveMarker?.visible)) {
      if (this.breadcrumb) this.breadcrumb.mesh.visible = false;
      return;
    }
    const from = this.currentVehicle?.group.position ?? this.player.position;
    const distance = distance2D(from.x, from.z, target.x, target.z);
    if (distance < 10 || distance > 260) {
      this.breadcrumb.mesh.visible = false;
      return;
    }
    this.breadcrumb.mesh.visible = true;
    const { mesh, count } = this.breadcrumb;
    const m = this.rainMatrix;
    // A wave of brightness travels along the dots toward the objective.
    const travel = (time * 0.9) % 1;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const x = from.x + (target.x - from.x) * t;
      const z = from.z + (target.z - from.z) * t;
      const y = 0.5 + Math.sin(t * Math.PI) * Math.min(2.2, distance * 0.02);
      const pulse = 1 - Math.abs(t - travel) * 6;
      m.makeTranslation(x, y, z);
      m.scale(this.tmpScale.setScalar(0.6 + Math.max(0, pulse) * 0.8));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private static readonly PHOTO_FILTERS: Array<{ name: string; css: string; hint: string }> = [
    { name: 'Untouched', css: '', hint: 'The city as it is.' },
    { name: 'Noir', css: 'grayscale(1) contrast(1.18) brightness(0.94)', hint: 'Black rain, white muzzle flashes.' },
    { name: 'Ember', css: 'sepia(0.55) saturate(1.35) contrast(1.1)', hint: 'Warm ash over the Old Spine.' },
    { name: 'Veil-light', css: 'hue-rotate(200deg) saturate(1.45) brightness(0.9)', hint: 'The world as the Veil sees it.' },
    { name: 'Chrome', css: 'saturate(0.4) contrast(1.32) brightness(1.06)', hint: 'Cold meridian steel.' },
  ];

  private static readonly VEHICLE_SPECS: Record<string, VehicleSpec> = {
    // Seraph sedan — the baseline: balanced speed and forgiveness.
    seraph: { name: 'Seraph sedan', top: 38, boost: 48, accel: 2.7, steer: 1.42, damageScale: 1 },
    // Morrow hauler — armored workhorse: slower, lumbering, shrugs off hits.
    morrow: { name: 'Morrow hauler', top: 30, boost: 38, accel: 1.8, steer: 1.02, damageScale: 0.6 },
    // Choir interceptor — pursuit frame: fast and twitchy, fragile.
    choir: { name: 'Choir interceptor', top: 45, boost: 58, accel: 3.6, steer: 1.75, damageScale: 1.35 },
  };

  private vehicleSpecFor(id: string): VehicleSpec {
    return HeavensGateEngine.VEHICLE_SPECS[id.split('-')[0]] ?? HeavensGateEngine.VEHICLE_SPECS.seraph;
  }

  private createVehicles() {
    this.createVehicle('seraph-01', 26, -32, Math.PI / 2, 0x9d7b38);
    this.createVehicle('seraph-02', -30, 1, 0, 0x31434c);
    this.createVehicle('morrow-01', 60, 60, -Math.PI / 2, 0x4c3734);
    this.createVehicle('morrow-02', -90, 90, Math.PI, 0x2e3a31);
    this.createVehicle('choir-01', 116, -28, Math.PI / 2, 0x4b4b4a);
    this.createVehicle('seraph-03', -56, -20, Math.PI, 0x35566b);
    this.createVehicle('choir-02', 8, 106, 0, 0x54452e);
  }

  private humanoid(id: string, color: number, visorColor: number) {
    const group = new THREE.Group();
    const variant = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    const isCivilian = id.startsWith('citizen');
    const skinTones = [0x43251f, 0x63382b, 0x85503c, 0xa66d51, 0xc38b68, 0xe0b28e];
    const hairTones = [0x0d0b0a, 0x211611, 0x3a2519, 0x5a3a25, 0x8a6b4b, 0x312d2c];
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: isCivilian ? 0.83 : 0.42, metalness: isCivilian ? 0.05 : 0.5 });
    const skinMaterial = new THREE.MeshStandardMaterial({ color: skinTones[variant % skinTones.length], roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
    const hairMaterial = new THREE.MeshStandardMaterial({ color: hairTones[(variant * 3) % hairTones.length], roughness: 0.94, metalness: 0 });
    const leatherMaterial = new THREE.MeshStandardMaterial({ color: isCivilian ? 0x171819 : 0x101416, roughness: 0.54, metalness: 0.26 });
    const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0xe7dfd1, roughness: 0.38 });
    const irisMaterial = new THREE.MeshStandardMaterial({ color: [0x4d6d72, 0x70553e, 0x33483d, 0x77715c][variant % 4], roughness: 0.22 });
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: visorColor,
      emissive: visorColor,
      emissiveIntensity: isCivilian ? 0.12 : 1.4,
      roughness: 0.25,
      metalness: 0.45,
    });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.76, 7, 12), bodyMaterial);
    torso.scale.set(1 + ((variant % 5) - 2) * 0.025, 1, 0.7);
    torso.position.y = 1.43;
    torso.castShadow = true;
    group.add(torso);
    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.2, 5, 10), bodyMaterial);
    pelvis.scale.set(1, 0.68, 0.74);
    pelvis.position.y = 0.9;
    group.add(pelvis);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.42, 0.12, 2, 2, 1), isCivilian ? bodyMaterial : leatherMaterial);
    chest.position.set(0, 1.55, -0.34);
    chest.rotation.x = -0.08;
    group.add(chest);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.22, 12), isCivilian ? skinMaterial : leatherMaterial);
    neck.position.y = 2.03;
    group.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 15), isCivilian ? skinMaterial : leatherMaterial);
    head.name = 'head';
    head.scale.set(0.88 + (variant % 3) * 0.025, 1.08, 0.92);
    head.position.y = 2.28;
    head.castShadow = true;
    group.add(head);

    if (isCivilian) {
      const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.245, 16, 12), skinMaterial);
      jaw.scale.set(0.88, 0.7, 0.86);
      jaw.position.set(0, 2.16, -0.018);
      jaw.name = 'head';
      group.add(jaw);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.041, 0.13, 8), skinMaterial);
      nose.position.set(0, 2.29, -0.294);
      nose.rotation.x = -Math.PI / 2;
      nose.name = 'head';
      group.add(nose);
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.057, 10, 7), skinMaterial);
        ear.scale.set(0.54, 1, 0.62);
        ear.position.set(side * 0.278, 2.28, 0);
        ear.name = 'head';
        group.add(ear);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.037, 10, 7), eyeMaterial);
        eye.scale.set(1.25, 0.62, 0.34);
        eye.position.set(side * 0.1, 2.33, -0.285);
        eye.name = 'head';
        group.add(eye);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), irisMaterial);
        pupil.scale.z = 0.26;
        pupil.position.set(side * 0.1, 2.33, -0.315);
        pupil.name = 'head';
        group.add(pupil);
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.02), hairMaterial);
        brow.position.set(side * 0.1, 2.41, -0.293);
        brow.rotation.z = side * ((variant % 3) - 1) * 0.035;
        brow.name = 'head';
        group.add(brow);
      }
      const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.325, 18, 12, 0, Math.PI * 2, 0, Math.PI * (0.48 + (variant % 2) * 0.08)), hairMaterial);
      hairCap.scale.set(0.9, 0.73, 0.95);
      hairCap.position.y = 2.39;
      hairCap.name = 'head';
      group.add(hairCap);
      if (variant % 4 === 1) {
        const bun = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 9), hairMaterial);
        bun.position.set(0, 2.58, 0.16);
        bun.name = 'head';
        group.add(bun);
      } else if (variant % 4 === 2) {
        for (const side of [-1, 1]) {
          const braid = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.34, 5, 8), hairMaterial);
          braid.position.set(side * 0.24, 2.15, 0.08);
          braid.rotation.z = side * 0.08;
          braid.name = 'head';
          group.add(braid);
        }
      }
      const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.052, 8, 20), visorMaterial);
      scarf.position.y = 2.02;
      scarf.rotation.x = Math.PI / 2;
      group.add(scarf);
    } else {
      const mask = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.14, 3, 2, 1), leatherMaterial);
      mask.position.set(0, 2.26, -0.26);
      mask.name = 'head';
      group.add(mask);
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.075, 0.035), visorMaterial);
      visor.position.set(0, 2.34, -0.345);
      visor.name = 'head';
      group.add(visor);
      for (const side of [-1, 1]) {
        const temple = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.28), bodyMaterial);
        temple.position.set(side * 0.27, 2.29, -0.01);
        temple.name = 'head';
        group.add(temple);
      }
    }

    const arms: THREE.Object3D[] = [];
    const legs: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(side * 0.19, 0.82, 0);
      const upperLeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.34, 5, 9), bodyMaterial);
      upperLeg.position.y = -0.25;
      legPivot.add(upperLeg);
      const lowerLeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.35, 5, 9), leatherMaterial);
      lowerLeg.position.set(0, -0.66, -0.02);
      legPivot.add(lowerLeg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.38), leatherMaterial);
      shoe.position.set(0, -0.94, -0.09);
      legPivot.add(shoe);
      group.add(legPivot);
      legs.push(legPivot);

      const armPivot = new THREE.Group();
      armPivot.position.set(side * 0.47, 1.73, 0);
      armPivot.rotation.z = side * 0.1;
      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.3, 5, 9), bodyMaterial);
      upperArm.position.y = -0.22;
      armPivot.add(upperArm);
      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.29, 5, 9), isCivilian ? skinMaterial : leatherMaterial);
      forearm.position.set(0, -0.57, -0.015);
      armPivot.add(forearm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 8), isCivilian ? skinMaterial : leatherMaterial);
      hand.scale.set(0.78, 1.08, 0.62);
      hand.position.y = -0.83;
      armPivot.add(hand);
      group.add(armPivot);
      arms.push(armPivot);
    }

    if (isCivilian && variant % 3 === 0) {
      const satchel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.43, 0.16), leatherMaterial);
      satchel.position.set(0.34, 1.15, 0.32);
      satchel.rotation.z = -0.08;
      group.add(satchel);
      const strap = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.025, 6, 22, Math.PI * 1.2), leatherMaterial);
      strap.position.set(0.1, 1.55, 0.05);
      strap.rotation.set(Math.PI / 2, 0, -0.48);
      group.add(strap);
    }

    const scale = 0.94 + (variant % 7) * 0.018;
    group.scale.set(scale * (0.97 + (variant % 3) * 0.02), scale, scale);
    const headRig = new THREE.Group();
    headRig.position.set(0, 2.28, 0);
    group.add(headRig);
    group.updateMatrixWorld(true);
    group.children.filter((child) => child.name === 'head').forEach((child) => headRig.attach(child));
    group.traverse((child) => {
      child.userData.actorId = id;
    });
    const rig: CharacterRig = { arms, legs, head: headRig, chest, phase: seeded(variant, 208) * Math.PI * 2, stride: 0 };
    if (!isCivilian) {
      const rifleMaterial = new THREE.MeshStandardMaterial({ color: 0x171b1e, roughness: 0.36, metalness: 0.72 });
      const rifleGlow = new THREE.MeshStandardMaterial({ color: visorColor, emissive: visorColor, emissiveIntensity: 1.6 });
      const rifle = new THREE.Group();
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.62), rifleMaterial);
      rifle.add(receiver);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.4, 8), rifleMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -0.5);
      rifle.add(barrel);
      const cell = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.14), rifleGlow);
      cell.position.set(0.045, 0.01, -0.1);
      rifle.add(cell);
      rifle.position.set(0, -0.86, -0.16);
      rifle.rotation.x = -0.22;
      arms[1].add(rifle);
      return { group, materials: [bodyMaterial, skinMaterial, hairMaterial, leatherMaterial, visorMaterial, rifleMaterial, rifleGlow], rig };
    }
    return { group, materials: [bodyMaterial, skinMaterial, hairMaterial, leatherMaterial, visorMaterial], rig };
  }

  private addActor(id: string, kind: ActorKind, x: number, z: number, color: number, visor: number, health: number) {
    const { group, materials, rig } = this.humanoid(id, color, visor);
    group.position.set(x, 0, z);
    this.scene.add(group);
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) this.rayTargets.push(child);
    });
    const actor: Actor = {
      id,
      kind,
      group,
      spawn: group.position.clone(),
      health,
      maxHealth: health,
      alive: true,
      speed: kind === 'civilian' ? 2.2 : 3.1,
      cooldown: seeded(id.length, 44),
      wanderAngle: seeded(id.charCodeAt(0), 45) * Math.PI * 2,
      flee: 0,
      materials,
      rig,
      aiState: kind === 'enemy' || kind === 'boss'
        ? createNpcAiState({ npcId: id, squadId: 'choir-wardens', homePosition: group.position })
        : undefined,
      damagePulse: 0,
      lastDamageAmount: 0,
      // A working magazine — wardens run dry and duck to reload instead of
      // hosing forever. Drones are machines; undefined means the cell never empties.
      magAmmo: kind === 'enemy' || kind === 'boss' ? 12 : undefined,
    };
    this.actors.push(actor);
    return actor;
  }

  private createDrone(id: string, x: number, z: number) {
    const group = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a4143, roughness: 0.28, metalness: 0.8 });
    const eye = new THREE.MeshStandardMaterial({ color: 0xd55a3f, emissive: 0xd32f22, emissiveIntensity: 2.2 });
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.68, 0), metal);
    core.userData.actorId = id;
    group.add(core);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), eye);
    lens.position.z = -0.6;
    lens.userData.actorId = id;
    group.add(lens);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 6, 20), metal);
    ring.rotation.x = Math.PI / 2;
    ring.userData.actorId = id;
    group.add(ring);
    // Patrol-scan cone: a soft volumetric-looking shaft under the drone that
    // brightens over civilians — the Choir reading the streets.
    const scanMaterial = new THREE.MeshBasicMaterial({
      color: 0xd65a45, transparent: true, opacity: 0.05,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const scan = new THREE.Mesh(new THREE.ConeGeometry(1.7, 7.5, 12, 1, true), scanMaterial);
    scan.position.y = -3.9;
    group.add(scan);
    group.position.set(x, 8 + seeded(id.length, 60) * 5, z);
    this.scene.add(group);
    this.rayTargets.push(core, lens, ring);
    const actor: Actor = {
      id,
      kind: 'drone',
      group,
      spawn: group.position.clone(),
      health: 55,
      maxHealth: 55,
      alive: true,
      speed: 4.8,
      cooldown: seeded(id.length, 61) * 2,
      wanderAngle: seeded(id.charCodeAt(0), 62) * Math.PI * 2,
      flee: 0,
      materials: [metal, eye],
      damagePulse: 0,
      lastDamageAmount: 0,
    };
    this.actors.push(actor);
  }

  // The Bulwark — a Morrow-pattern heavy. Slow, armored, and plated across
  // the front: shots into the shield arc deflect for a quarter of their
  // bite. Flanking, Veil-sneak angles, and Pulse staggers all open it.
  private createBulwark(id: string, x: number, z: number) {
    const actor = this.addActor(id, 'enemy', x, z, 0x2e3a42, 0xe8a44a, 240);
    actor.speed = 1.7;
    actor.shielded = true;
    actor.group.scale.setScalar(1.12);
    const plateMaterial = new THREE.MeshStandardMaterial({
      color: 0x1c2226, roughness: 0.34, metalness: 0.82,
      emissive: 0xe8a44a, emissiveIntensity: 0.22,
    });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.94, 1.5, 0.09), plateMaterial);
    plate.position.set(0, 1.32, -0.52);
    plate.name = 'bulwark-shield';
    plate.userData.actorId = id;
    actor.group.add(plate);
    actor.shieldMesh = plate;
    actor.materials.push(plateMaterial);
    this.rayTargets.push(plate);
    // Sloped crown so the plate reads at range — a wall coming at you.
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.14, 0.14), plateMaterial);
    crown.position.set(0, 2.62, -0.4);
    crown.rotation.x = 0.5;
    crown.userData.actorId = id;
    actor.group.add(crown);
    this.rayTargets.push(crown);
    return actor;
  }

  private civilianArchetype(x: number, z: number, index: number) {
    const district = DISTRICTS.find((d) => d.test(x, z))?.name ?? 'The Outer Choir';
    const pick = (colors: number[]) => colors[index % colors.length];
    switch (district) {
      case 'Crown District':
        return { coat: pick([0x8a7a54, 0xa89a70, 0x6e6450, 0x958a68]), accessory: 'halo' as const, accent: 0xd8b46a };
      case 'Old Spine':
        return { coat: pick([0x544134, 0x4a3c30, 0x5c4636, 0x46382c]), accessory: 'pack' as const, accent: 0x7a5c40 };
      case 'Gilded Docks':
        return { coat: pick([0x2f4a50, 0x35555a, 0x2c4248, 0x3a5058]), accessory: 'scarf' as const, accent: 0x6a9aa4 };
      case 'Ash Gardens':
        return { coat: pick([0x3a3d40, 0x44474a, 0x36383c, 0x4a4c50]), accessory: 'hood' as const, accent: 0x565a60 };
      case 'Meridian':
        return { coat: pick([0x46384a, 0x50425a, 0x3e3448, 0x4a3e54]), accessory: 'pack' as const, accent: 0x8a76a0 };
      default:
        return { coat: pick([0x35404a, 0x4a4035, 0x3d4738, 0x4b4a3b]), accessory: 'none' as const, accent: 0x8c7a5a };
    }
  }

  private addCivilianAccessory(actor: Actor, kind: 'halo' | 'hood' | 'pack' | 'scarf' | 'none', accent: number) {
    if (kind === 'none' || !actor.rig) return;
    const mat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.72, metalness: 0.08 });
    let prop: THREE.Mesh;
    if (kind === 'halo') {
      prop = new THREE.Mesh(
        new THREE.TorusGeometry(0.22, 0.02, 6, 18),
        new THREE.MeshStandardMaterial({ color: 0xd8b46a, emissive: 0x8a6a2f, emissiveIntensity: 0.9, roughness: 0.4 }),
      );
      prop.position.y = 0.46;
      prop.rotation.x = Math.PI / 2;
      actor.rig.head.add(prop);
    } else if (kind === 'hood') {
      prop = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.52, 8), mat);
      prop.position.y = 0.26;
      actor.rig.head.add(prop);
    } else if (kind === 'scarf') {
      prop = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.07, 6, 14), mat);
      prop.position.y = -0.16;
      prop.rotation.x = Math.PI / 2;
      actor.rig.head.add(prop);
    } else {
      prop = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.2), mat);
      prop.position.set(0, 1.5, 0.3);
      actor.group.add(prop);
    }
  }

  private createActors() {
    const wardens: Array<[number, number]> = [[-10, -48], [10, -48], [-13, -61], [13, -61], [0, -67]];
    wardens.forEach(([x, z], index) => this.addActor(`warden-${index + 1}`, 'enemy', x, z, 0x302c2c, 0xd65b43, 78));

    const citizens: Actor[] = [];
    for (let i = 0; i < 34; i += 1) {
      const road = Math.floor(seeded(i, 70) * 9 - 4) * 30;
      const along = (seeded(i, 71) - 0.5) * 250;
      const horizontal = seeded(i, 72) > 0.5;
      const x = horizontal ? along : road + (seeded(i, 73) > 0.5 ? 5.6 : -5.6);
      const z = horizontal ? road + (seeded(i, 74) > 0.5 ? 5.6 : -5.6) : along;
      const archetype = this.civilianArchetype(x, z, i);
      const citizen = this.addActor(
        `citizen-${i + 1}`,
        'civilian',
        x,
        z,
        archetype.coat,
        0x8c7a5a,
        42,
      );
      this.addCivilianAccessory(citizen, archetype.accessory, archetype.accent);
      citizens.push(citizen);
      // Ambient-life vignettes: pairs face each other in conversation, loners
      // idle or lean. Wanderers keep the original drift behavior.
      const roll = seeded(i, 130);
      if (i % 5 === 4 && citizens.length > 1) {
        // Pair this citizen with the previous one as a talking duo.
        const partner = citizens[citizens.length - 2];
        partner.vignette = 'talk';
        citizen.vignette = 'talk';
        citizen.group.position.copy(partner.group.position).add(new THREE.Vector3(1.1, 0, 0.4));
        citizen.spawn.copy(citizen.group.position);
        partner.group.rotation.y = Math.atan2(1.1, 0.4);
        citizen.group.rotation.y = Math.atan2(-1.1, -0.4);
      } else if (roll < 0.22) {
        citizen.vignette = 'idle';
      } else if (roll < 0.32) {
        citizen.vignette = 'lean';
        citizen.group.rotation.x = -0.08;
      } else if (roll < 0.42) {
        // Ambient runner — hurrying through the storm, glancing back.
        citizen.vignette = 'run';
        citizen.wanderAngle = seeded(i, 133) * Math.PI * 2;
        citizen.vignetteTimer = 1 + seeded(i, 134) * 3;
      } else {
        citizen.vignette = 'wander';
      }
    }

    // Sena — Saint Orison's caretaker, posted at the last lamp on the
    // approach. Warm umber coat and a copper scarf set her apart from the
    // Crown palette; `posted` keeps her at the lamp until the cordon beat.
    let senaLamp = (this.streetLamps ?? [])[0] ?? null;
    (this.streetLamps ?? []).forEach((lamp) => {
      if (!senaLamp || Math.hypot(lamp.x - SENA_LAMP_SPOT.x, lamp.z - SENA_LAMP_SPOT.z)
        < Math.hypot(senaLamp.x - SENA_LAMP_SPOT.x, senaLamp.z - SENA_LAMP_SPOT.z)) senaLamp = lamp;
    });
    this.senaLamp = new THREE.Vector3(senaLamp?.x ?? SENA_LAMP_SPOT.x, 0, senaLamp?.z ?? SENA_LAMP_SPOT.z);
    const sena = this.addActor(
      'sena',
      'civilian',
      this.senaLamp.x + 0.95,
      this.senaLamp.z + 0.75,
      0x5c4a38,
      0x8a6242,
      42,
    );
    sena.posted = true;
    sena.vignette = 'idle';
    this.addCivilianAccessory(sena, 'scarf', 0xb5764a);
    this.sena = sena;

    [[62, 26], [-58, 4], [102, 95], [-110, 78], [8, -100], [88, -72]].forEach(([x, z], index) => {
      this.createDrone(`choir-drone-${index + 1}`, x, z);
    });

    [[84, 62], [98, 84], [-86, 66]].forEach(([x, z], index) => {
      const sentinel = this.addActor(`sentinel-${index + 1}`, 'enemy', x, z, 0x2c2622, 0xe8a34c, 150);
      sentinel.speed = 2.35;
      sentinel.group.scale.multiplyScalar(1.14);
    });
    [[40, -88], [-30, -104], [110, -30], [-116, -20]].forEach(([x, z], index) => {
      const stalker = this.addActor(`stalker-${index + 1}`, 'enemy', x, z, 0x223034, 0x5fd8e8, 46);
      stalker.speed = 4.35;
      stalker.group.scale.multiplyScalar(0.92);
    });
  }

  private createGate(position: THREE.Vector3, scale = 1, rotationY = 0) {
    const group = new THREE.Group();
    const ringMaterial = new THREE.MeshStandardMaterial({
      color: 0xd7b55e,
      emissive: 0x8c631c,
      emissiveIntensity: 2.2,
      metalness: 0.78,
      roughness: 0.22,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7 * scale, 0.24 * scale, 10, 72), ringMaterial);
    ring.castShadow = true;
    group.add(ring);
    const veil = new THREE.Mesh(
      new THREE.CircleGeometry(6.72 * scale, 56),
      new THREE.MeshBasicMaterial({ color: 0xe6d39b, transparent: true, opacity: 0.055, side: THREE.DoubleSide }),
    );
    veil.position.z = 0.03;
    group.add(veil);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1 * scale, 3.4 * scale, 26, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xe8cd8a,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    shaft.position.y = -3;
    group.add(shaft);
    group.position.copy(position);
    group.rotation.y = rotationY;
    this.scene.add(group);
    const gate = { group, ring, veil, shaft };
    this.gates.push(gate);
    return gate;
  }

  private createGatesAndEchoes() {
    this.createGate(new THREE.Vector3(0, 8.4, -54), 1.05, 0);
    this.createGate(new THREE.Vector3(90, 9.2, 76), 1.2, Math.PI / 2);
    this.createGate(new THREE.Vector3(-94, 7.4, 78), 0.82, -Math.PI / 2);

    const echoPositions: Array<[string, number, number]> = [
      ['echo-mercy', -72, 48],
      ['echo-truth', -112, 72],
      ['echo-name', -82, 104],
    ];
    echoPositions.forEach(([id, x, z], index) => {
      const group = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({
        color: 0xcdb56f,
        emissive: 0x9f711e,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.12,
        roughness: 0.2,
        metalness: 0.48,
      });
      const shape = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 1), material);
      group.add(shape);
      for (let ringIndex = 0; ringIndex < 2; ringIndex += 1) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.8 + ringIndex * 0.5, 0.035, 5, 28),
          new THREE.MeshBasicMaterial({ color: 0xd8bd74, transparent: true, opacity: 0.18 }),
        );
        ring.rotation.x = ringIndex ? Math.PI / 2 : Math.PI / 4;
        group.add(ring);
      }
      group.position.set(x, 2.4 + index * 0.2, z);
      group.visible = true;
      this.scene.add(group);
      this.echoes.push({ id, group, activated: false });
    });
  }

  private createObjectiveMarker() {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xe8c96f, transparent: true, opacity: 0.86, depthTest: false });
    const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.65, 0), material);
    group.add(diamond);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.045, 5, 32), material);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    // Sky-column beacon: a soft additive shaft rising off the objective, so
    // the "go here" read survives at street level between towers — not just
    // on the minimap. Shares the marker's see-through-walls contract.
    const beamCanvas = document.createElement('canvas');
    beamCanvas.width = 8;
    beamCanvas.height = 128;
    const beamCtx = beamCanvas.getContext('2d');
    if (beamCtx) {
      const fade = beamCtx.createLinearGradient(0, 0, 0, 128);
      fade.addColorStop(0, 'rgba(255,255,255,0)');
      fade.addColorStop(0.55, 'rgba(255,255,255,0.32)');
      fade.addColorStop(1, 'rgba(255,255,255,0.85)');
      beamCtx.fillStyle = fade;
      beamCtx.fillRect(0, 0, 8, 128);
    }
    const beamTexture = new THREE.CanvasTexture(beamCanvas);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.95, 24, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xe8c96f,
        map: beamTexture,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    beam.name = 'objective-beam';
    beam.position.y = 7.8;
    group.add(beam);
    group.renderOrder = 20;
    this.scene.add(group);
    this.objectiveMarker = group;
    this.updateObjectiveMarker();
  }

  // The Chapel of the Unburied — the city's one enterable interior, sitting
  // in the Old Spine clearing at (-72, 48). Door faces east toward the road.
  private createChapel() {
    const cx = -72;
    const cz = 48;
    const chapel = new THREE.Group();
    chapel.position.set(cx, 0, cz);

    const stone = this.chapelStone ?? new THREE.MeshStandardMaterial({ color: 0x2e2c2a, roughness: 0.9, metalness: 0.05 });
    const stoneDark = this.chapelStoneDark ?? new THREE.MeshStandardMaterial({ color: 0x232120, roughness: 0.94 });
    const wood = this.chapelWood ?? new THREE.MeshStandardMaterial({ color: 0x3d2f22, roughness: 0.82 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x2a3550, emissive: 0x5a78c8, emissiveIntensity: 1.5, roughness: 0.2 });
    const glassWarm = new THREE.MeshStandardMaterial({ color: 0x503528, emissive: 0xc8864a, emissiveIntensity: 1.4, roughness: 0.2 });
    const candleMat = new THREE.MeshStandardMaterial({ color: 0xe8d8b0, emissive: 0xffb84a, emissiveIntensity: 2.4 });

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = this.highTier();
      mesh.receiveShadow = true;
      chapel.add(mesh);
      return mesh;
    };

    // Floor + threshold step.
    box(13.6, 0.26, 11.6, 0, 0.05, 0, stoneDark);
    box(1.2, 0.14, 3.2, 7.0, 0.07, 0, stone);

    // Back wall (west), side walls, front wall split by a 2.8m door gap.
    box(0.6, 6.2, 11.6, -6.5, 3.1, 0, stone);
    box(13.6, 6.2, 0.6, 0, 3.1, -5.5, stone);
    box(13.6, 6.2, 0.6, 0, 3.1, 5.5, stone);
    box(0.6, 6.2, 4.4, 6.5, 3.1, -3.6, stone);
    box(0.6, 6.2, 4.4, 6.5, 3.1, 3.6, stone);
    box(0.6, 2.2, 2.8, 6.5, 5.1, 0, stone);

    // Colliders — real walls, so cover + bullet obstruction work indoors.
    const wall = (x: number, z: number, w: number, d: number) => {
      this.collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(cx + x - w / 2, 0, cz + z - d / 2),
        new THREE.Vector3(cx + x + w / 2, 6.2, cz + z + d / 2),
      ));
    };
    wall(-6.5, 0, 0.6, 11.6);
    wall(0, -5.5, 13.6, 0.6);
    wall(0, 5.5, 13.6, 0.6);
    wall(6.5, -3.6, 0.6, 4.4);
    wall(6.5, 3.6, 0.6, 4.4);

    // Roof slab + interior cross beams.
    box(14.2, 0.45, 12.2, 0, 6.35, 0, stoneDark);
    [-3.2, 0, 3.2].forEach((bx) => box(0.34, 0.5, 11.0, bx, 5.85, 0, wood));

    // Stained glass panels along the side walls — the chapel's only exterior read.
    // The center one carries the generated memory-window art once it verifies.
    [-2.8, 0, 2.8].forEach((gz, index) => {
      box(0.12, 3.4, 1.1, -6.1, 3.2, gz, index === 1 ? glassWarm : glass);
      // The glass bleeds: a slanted shaft falling from each pane to the
      // aisle floor — narrow at the window, spread where it lands. Blue
      // off the side panes, ember through the center.
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 1.45, 5.0, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: index === 1 ? 0xe0a05c : 0x6a86d8,
          transparent: true,
          opacity: 0.05,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      // +Y tips toward the west wall (~52°) so the narrow end meets the pane
      // and the wide end pools on the flagstones around x≈-2.3.
      shaft.position.set(-4.2, 1.62, gz);
      shaft.rotation.z = 0.91;
      chapel.add(shaft);
    });
    this.chapelWindowAnchor = new THREE.Vector3(cx - 6.02, 3.2, cz);
    [-3.4, 3.4].forEach((gz) => {
      box(1.1, 3.0, 0.12, -3.5, 3.1, gz * 1.5, glass);
    });

    // Altar + hanging ring + votive candles.
    box(2.4, 1.15, 1.3, -4.4, 0.7, 0, stone);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.05, 8, 40), new THREE.MeshStandardMaterial({
      color: 0xd8b46a, emissive: 0xa8842f, emissiveIntensity: 1.8, roughness: 0.35, metalness: 0.7,
    }));
    ring.position.set(-4.4, 4.1, 0);
    ring.rotation.y = Math.PI / 2;
    chapel.add(ring);

    // Pews: two rows split by a center aisle. The seat boxes are real
    // colliders — low enough to vault onto or take cover behind.
    [-2.2, 0.4].forEach((px) => {
      [-2.4, 2.4].forEach((pz) => {
        box(0.5, 0.5, 3.4, px, 0.55, pz, wood);
        box(0.5, 0.9, 0.18, px, 0.95, pz - 1.55, wood);
        box(0.5, 0.9, 0.18, px, 0.95, pz + 1.55, wood);
        this.collisionBoxes.push(new THREE.Box3(
          new THREE.Vector3(cx + px - 0.28, 0, cz + pz - 1.72),
          new THREE.Vector3(cx + px + 0.28, 0.9, cz + pz + 1.72),
        ));
      });
    });

    // Candles flanking the altar.
    [-1.6, 1.6].forEach((offset) => {
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.5, 8), candleMat);
      candle.position.set(-4.4, 1.5, offset);
      chapel.add(candle);
      const flame = new THREE.PointLight(0xffb05a, 4.5, 7, 1.8);
      flame.position.set(-4.2, 1.9, offset);
      chapel.add(flame);
      this.chapelCandles.push(flame);
    });
    const altarLight = new THREE.PointLight(0x8ab0ff, 9, 12, 1.6);
    altarLight.position.set(-3.6, 4.4, 0);
    chapel.add(altarLight);

    // The Arius relic — a weathered stone head reconstructed from a real
    // laser-scan cloud (James-2012 reference dataset, 8.7M points). It sits
    // on the altar facing the pews; the candles were lit for it.
    void loadVerifiedProp('arius-relic-head').then((prop) => {
      if (this.disposed) return;
      const bounds = new THREE.Box3().setFromObject(prop);
      const size = new THREE.Vector3();
      bounds.getSize(size);
      prop.scale.setScalar(0.58 / Math.max(size.y, 0.01));
      bounds.setFromObject(prop);
      prop.position.set(-4.4 - (bounds.min.x + bounds.max.x) / 2, 1.275 - bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
      prop.rotation.y = Math.PI / 2; // face the aisle
      prop.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.material = new THREE.MeshStandardMaterial({ color: 0x9a917e, roughness: 0.94, metalness: 0.02 });
          node.castShadow = this.highTier();
          node.receiveShadow = true;
        }
      });
      chapel.add(prop);
    }).catch(() => {});

    this.scene.add(chapel);
    this.chapelZone = new THREE.Box3(
      new THREE.Vector3(cx - 6.2, -1, cz - 5.2),
      new THREE.Vector3(cx + 6.2, 6, cz + 5.2),
    );

    // Photogrammetry guardians flanking the door + a crypt door on the south wall.
    void this.instancedProp('gothic_statue', [
      { x: cx + 7.6, y: 0, z: cz - 2.2, yaw: Math.PI / 2 },
      { x: cx + 7.6, y: 0, z: cz + 2.2, yaw: Math.PI / 2 },
    ], { targetHeight: 1.9, collider: { w: 1.0, d: 1.0, h: 1.9 } });
    void this.instancedProp('large_castle_door', [
      { x: cx + 3.4, y: 0, z: cz - 5.38, yaw: 0 },
    ], { targetHeight: 2.9, surface: 'generic', collider: 'none' });
  }

  // The Memorial Obelisk — a genuine photogrammetry reconstruction standing
  // in the chapel clearing. Loads async; the clearing is valid without it.
  private createMemorial() {
    const mx = -69;
    const mz = 55.5;
    this.memorialZone = new THREE.Box3(
      new THREE.Vector3(mx - 4.5, -1, mz - 4.5),
      new THREE.Vector3(mx + 4.5, 7, mz + 4.5),
    );
    void loadVerifiedProp('memorial-obelisk').then((prop) => {
      if (this.disposed) { prop.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); return; }
      const bounds = new THREE.Box3().setFromObject(prop);
      const size = new THREE.Vector3();
      bounds.getSize(size);
      const scale = 5.2 / Math.max(size.y, 0.01);
      prop.scale.setScalar(scale);
      bounds.setFromObject(prop);
      prop.position.set(mx - (bounds.min.x + bounds.max.x) / 2, -bounds.min.y, mz - (bounds.min.z + bounds.max.z) / 2);
      prop.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = this.highTier();
          node.receiveShadow = true;
          node.userData.blocksShot = true;
          this.rayTargets.push(node);
        }
      });
      this.scene.add(prop);
      this.memorialMesh = prop;
      this.collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(mx - 0.85, 0, mz - 0.85),
        new THREE.Vector3(mx + 0.85, 5.4, mz + 0.85),
      ));
    }).catch(() => {
      // The clearing stands without the memorial if the asset can't verify.
    });
  }

  // Saint Orison Station — the second enterable interior. A canopied hall
  // on the plaza's east edge: departure board, ticket gates, benches — and a
  // stairwell diving under the north wall into the Undergate vestibule, the
  // buried door the first mission's briefing only implies.
  private createStation() {
    const sx = 17;
    const sz = -54;
    const station = new THREE.Group();
    station.position.set(sx, 0, sz);

    const iron = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.58, metalness: 0.72 });
    const tile = new THREE.MeshStandardMaterial({ color: 0x8c8a80, roughness: 0.66, metalness: 0.08 });
    const tileDark = new THREE.MeshStandardMaterial({ color: 0x54524c, roughness: 0.8, metalness: 0.05 });
    const amber = new THREE.MeshStandardMaterial({ color: 0x6a4a22, emissive: 0xffb35a, emissiveIntensity: 1.9, roughness: 0.5 });
    const gateMat = new THREE.MeshStandardMaterial({ color: 0x1d2438, emissive: 0x7a5fd0, emissiveIntensity: 2.6, roughness: 0.3, transparent: true, opacity: 0.92 });
    const rock = new THREE.MeshStandardMaterial({ color: 0x24211e, roughness: 0.96, metalness: 0.02 });

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = this.highTier();
      mesh.receiveShadow = true;
      station.add(mesh);
      return mesh;
    };
    // Solid wall colliders live at street level; underground walls get their
    // own band so the street never blocks the vestibule.
    const wall = (x: number, z: number, w: number, d: number, y0 = 0, y1 = 4.8) => {
      this.collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(sx + x - w / 2, y0, sz + z - d / 2),
        new THREE.Vector3(sx + x + w / 2, y1, sz + z + d / 2),
      ));
    };

    // Floor slab (raised 14cm — auto-step) with the stairwell void cut out.
    box(11.7, 0.14, 11.0, -1.65, 0.07, 0, tile);
    box(1.1, 0.14, 11.0, 6.95, 0.07, 0, tile);
    box(2.2, 0.14, 8.9, 5.3, 0.07, 1.05, tile);
    // Threshold aprons at the two entrances.
    box(1.4, 0.1, 5.6, -8.2, 0.05, 0, tileDark);
    box(3.4, 0.1, 1.4, 0, 0.05, 6.2, tileDark);

    // West wall — 5.2m entry arch facing the plaza gate.
    box(0.6, 4.8, 2.9, -7.5, 2.4, -4.05, tileDark);
    box(0.6, 4.8, 2.9, -7.5, 2.4, 4.05, tileDark);
    box(0.6, 1.7, 5.2, -7.5, 3.95, 0, tileDark);
    wall(-7.5, -4.05, 0.6, 2.9);
    wall(-7.5, 4.05, 0.6, 2.9);
    // South wall — 3m side arch.
    box(15.6, 4.8, 0.6, -0.6, 2.4, 5.5, tileDark);
    box(3.0, 1.7, 0.6, 0, 3.95, 5.5, tileDark);
    wall(-3.15, 5.5, 6.3, 0.6);
    wall(3.15, 5.5, 6.3, 0.6);
    wall(6.9, 5.5, 1.8, 0.6);
    // North + east walls solid. The north wall's collider is split at the
    // stairwell: a raised header lets the stair dive beneath it — at street
    // level it still blocks; deeper than -1.0m the descent passes under.
    box(12.4, 4.8, 0.6, -2.2, 2.4, -5.5, tileDark);
    box(0.6, 4.8, 0.6, 6.9, 2.4, -5.5, tileDark);
    box(2.6, 3.9, 0.6, 5.3, 2.85, -5.5, tileDark);
    box(0.6, 4.8, 11.0, 7.5, 2.4, 0, tileDark);
    wall(-2.2, -5.5, 12.4, 0.6);
    wall(6.9, -5.5, 0.6, 0.6);
    wall(5.3, -5.5, 2.6, 0.6, 0.9, 4.8);
    wall(7.5, 0, 0.6, 11.0);

    // Roof with skylight slots — three pale bands of daylight inside.
    box(16.4, 0.35, 12.0, 0, 4.95, 0, tileDark);
    [-3.4, 0, 3.4].forEach((gz) => box(0.9, 0.06, 9.6, -7.2, 4.74, gz, new THREE.MeshStandardMaterial({
      color: 0x9ab4d8, emissive: 0x5a78a8, emissiveIntensity: 1.1, transparent: true, opacity: 0.6, roughness: 0.2,
    })));

    // Columns, benches, ticket gates.
    [[-4, -3], [-4, 3], [2.5, -3], [2.5, 3]].forEach(([px, pz]) => {
      box(0.5, 4.8, 0.5, px, 2.4, pz, iron);
      wall(px, pz, 0.5, 0.5);
    });
    [[-2.5, -1.6], [-2.5, 1.6]].forEach(([px, pz]) => {
      box(3.0, 0.46, 0.55, px, 0.37, pz, iron);
      box(3.0, 0.5, 0.16, px, 0.7, pz + 0.3, iron);
      wall(px, pz, 3.0, 0.62, 0, 0.72);
    });
    [-1.6, 0, 1.6].forEach((px) => {
      box(0.24, 1.0, 0.9, px + 0.6, 0.5, -4.9, iron);
      wall(px + 0.6, -4.9, 0.24, 0.9, 0, 1.0);
    });

    // Departure board — one line still flickering for a train that never came.
    const board = box(3.6, 0.9, 0.14, 6.9, 3.4, 0, iron);
    board.rotation.y = -Math.PI / 2;
    const boardFace = box(3.3, 0.62, 0.04, 6.82, 3.4, 0, new THREE.MeshStandardMaterial({
      color: 0x101418, emissive: 0xd8a94a, emissiveIntensity: 1.35, roughness: 0.4,
    }));
    boardFace.rotation.y = -Math.PI / 2;

    // The job board — a lit civic panel that never stopped posting work for
    // anyone the Choir hasn't named yet.
    box(0.08, 1.3, 1.7, 7.14, 1.7, 1.5, iron);
    const jobFace = box(0.04, 1.1, 1.5, 7.09, 1.7, 1.5, new THREE.MeshStandardMaterial({
      color: 0x14202c, emissive: 0x3f9ac8, emissiveIntensity: 1.5, roughness: 0.35,
    }));
    jobFace.rotation.y = -Math.PI / 2;
    this.jobBoardGlow = jobFace;

    // Hanging lamps — emissive heads + two real lights so the hall reads at night.
    [[-4.5, 0], [2.5, 0]].forEach(([px, pz]) => {
      box(0.1, 0.9, 0.1, px, 4.4, pz, iron);
      box(0.5, 0.16, 0.5, px, 3.92, pz, amber);
      const lamp = new THREE.PointLight(0xffb35a, 5.5, 11, 1.7);
      lamp.position.set(px, 3.7, pz);
      station.add(lamp);
    });

    // Stairwell — nine steps dive under the north wall into the vestibule.
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const top = -0.14 - i * 0.36;
      const zc = -3.65 - i * 0.44;
      box(2.2, 0.5, 0.46, 5.3, top - 0.25, zc, tileDark);
      this.collisionBoxes.push(new THREE.Box3(
        new THREE.Vector3(sx + 4.2, -4.4, sz + zc - 0.23),
        new THREE.Vector3(sx + 6.4, top, sz + zc + 0.23),
      ));
    }
    // Stair cheek walls keep the descent honest — visible as iron rails.
    wall(4.05, -5.5, 0.3, 4.6, -3.8, 1.4);
    wall(6.55, -5.5, 0.3, 4.6, -3.8, 1.4);
    box(0.12, 1.1, 4.6, 4.05, 0.7, -5.5, iron);
    box(0.12, 1.1, 4.6, 6.55, 0.7, -5.5, iron);
    // The shaft removes the implicit street floor so steps actually catch.
    this.groundHoles.push(new THREE.Box3(
      new THREE.Vector3(sx + 4.0, -10, sz - 5.7),
      new THREE.Vector3(sx + 6.6, 10, sz - 3.2),
    ));

    // The vestibule — rough-cut stone, one low ceiling, the Undergate at its head.
    // Floor sits 0.4 below the last step — inside the 0.45 climb tolerance so
    // the player can walk back out.
    const UY = -3.42;
    box(5.6, 0.25, 5.6, 5.0, UY - 0.125, -8.9, rock);              // floor
    this.collisionBoxes.push(new THREE.Box3(
      new THREE.Vector3(sx + 2.2, UY - 0.3, sz - 11.7),
      new THREE.Vector3(sx + 7.8, UY, sz - 6.1),
    ));
    box(5.6, 0.5, 5.6, 5.0, -0.5, -8.9, rock);                     // ceiling
    box(0.5, 3.4, 5.6, 2.45, UY + 1.7, -8.9, rock);                // west
    box(0.5, 3.4, 5.6, 7.55, UY + 1.7, -8.9, rock);                // east
    box(5.6, 3.4, 0.5, 5.0, UY + 1.7, -11.65, rock);               // north
    // South wall flanks the stair arrival (gap x 4.2→6.4).
    box(2.2, 3.4, 0.5, 3.1, UY + 1.7, -6.15, rock);
    box(1.4, 3.4, 0.5, 7.1, UY + 1.7, -6.15, rock);
    wall(2.45, -8.9, 0.5, 5.6, -4.2, -0.3);
    wall(7.55, -8.9, 0.5, 5.6, -4.2, -0.3);
    wall(5.0, -11.65, 5.6, 0.5, -4.2, -0.3);
    wall(3.1, -6.15, 2.2, 0.5, -4.2, -0.3);
    wall(7.1, -6.15, 1.4, 0.5, -4.2, -0.3);

    // The Undergate itself — a sealed arch of lit stone.
    box(0.4, 2.9, 0.6, 3.6, UY + 1.45, -11.3, rock);
    box(0.4, 2.9, 0.6, 6.4, UY + 1.45, -11.3, rock);
    box(3.2, 0.5, 0.6, 5.0, UY + 3.1, -11.3, rock);
    const undergateVeil = box(2.4, 2.65, 0.12, 5.0, UY + 1.42, -11.3, gateMat);
    undergateVeil.name = 'undergate-veil';
    const undergateLight = new THREE.PointLight(0x8a6fe0, 6.5, 9, 1.7);
    undergateLight.position.set(5.0, UY + 1.6, -10.4);
    station.add(undergateLight);
    this.undergateLight = undergateLight;
    this.undergateVeil = undergateVeil;
    this.undergatePos = new THREE.Vector3(sx + 5.0, UY + 1.4, sz - 11.3);

    this.scene.add(station);
    this.stationZone = new THREE.Box3(
      new THREE.Vector3(sx - 7.5, -4.5, sz - 11.9),
      new THREE.Vector3(sx + 7.5, 5.2, sz + 5.5),
    );
  }

  private updateChapel() {
    // The Undergate breathes — a slow violet pulse under the station.
    if (this.undergateLight) {
      this.undergateLight.intensity = 6.5 + Math.sin(this.elapsed * 1.9) * 1.8;
      const veil = this.undergateVeil;
      if (veil && veil.material instanceof THREE.MeshStandardMaterial) {
        veil.material.emissiveIntensity = 2.4 + Math.sin(this.elapsed * 1.9 + 0.7) * 0.7;
      }
    }
    // Candle flames breathe even before the player finds the chapel.
    this.chapelCandles?.forEach((flame, index) => {
      flame.intensity = 4.2 + Math.sin(this.elapsed * 7.3 + index * 2.1) * 0.7 + Math.sin(this.elapsed * 13.7 + index * 4.3) * 0.4;
    });
    if (!this.chapelZone || !this.player) return;
    const position = this.currentVehicle?.group.position ?? this.player.position;
    const inside = this.chapelZone.containsPoint(position);
    const inStation = this.stationZone?.containsPoint(position) ?? false;
    this.stationInterior = inStation;
    const insideAny = inside || inStation;
    if (inside !== this.chapelInterior) this.chapelInterior = inside;
    if (insideAny !== this.interiorActive) {
      this.interiorActive = insideAny;
      this.audio.setInterior?.(insideAny ? 1 : 0);
      // Interior IBL: the abandoned-church HDRI reads as candlelit stone.
      if (this.streetEnvTexture && this.chapelEnvTexture) {
        this.scene.environment = insideAny ? this.chapelEnvTexture : this.streetEnvTexture;
        this.scene.environmentIntensity = insideAny ? 0.85 : 0.6;
      }
    }
    if (inside && this.narrative?.relicSeen !== true) {
      const altarDistance = this.altarDistance();
      if (altarDistance !== null && altarDistance < 1.9) {
        const narrative = (this.narrative ??= {});
        narrative.relicSeen = true;
        this.audio.whisperBlip?.();
        this.emitSubtitle('The Arius Relic', 'A saint\'s head, worn to the bone by two hundred years of hands. The stone still remembers being carved.');
        this.saveCheckpoint();
      }
    }
    if (!inside || this.chapelVisited) return;
    this.chapelVisited = true;
    this.emitSubtitle('The Archivist', 'The Unburied Chapel. The Choir burned the records — the candles remember anyway.');
    this.audio.whisperBlip?.();
    this.audio.ui(true);
  }

  // Eight hidden sigils — permanent world collectibles paying marks.
  private static readonly SIGIL_SPOTS: Array<{ id: string; x: number; z: number; lore: string }> = [
    { id: 'sigil-spire-plaza', x: 0, z: 34, lore: 'A sigil of the First Architect — the plaza was her signature.' },
    { id: 'sigil-south-gate', x: 0, z: -54, lore: 'Carved by a gate-keeper who refused the Choir\'s hymn.' },
    { id: 'sigil-chapel', x: -69, z: 52.5, lore: 'The Unburied marked this stone before the burning.' },
    { id: 'sigil-docks', x: 90, z: 76, lore: 'Dockhands scratched it into the pier the night the bells drowned.' },
    { id: 'sigil-gardens', x: -112, z: 72, lore: 'An Ash Gardens warden hid it where the rain falls sideways.' },
    { id: 'sigil-north-ridge', x: -82, z: 104, lore: 'The ridge runners swore it hums before a storm breaks.' },
    { id: 'sigil-east-verge', x: 140, z: -140, lore: 'Half-buried at the city\'s edge — the last thing exiles touched.' },
    { id: 'sigil-west-hollow', x: -140, z: -60, lore: 'The Hollow kept it dark for sixty years. Now it answers you.' },
  ];

  private createSigils() {
    const coreMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a5ac8, emissive: 0x7a3fd4, emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.4, transparent: true,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xb98af0, transparent: true, opacity: 0.55 });
    HeavensGateEngine.SIGIL_SPOTS.forEach((spot) => {
      // Nudge out of geometry if a spot lands inside a collider.
      let { x, z } = spot;
      for (let r = 0; r <= 8 && this.collides(x, z, 0.6); r += 1) {
        x = spot.x + Math.cos(r * 1.3) * r * 0.8;
        z = spot.z + Math.sin(r * 1.3) * r * 0.8;
      }
      const group = new THREE.Group();
      group.position.set(x, 1.05, z);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), coreMaterial);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.018, 6, 28), ringMaterial);
      ring.rotation.x = Math.PI / 2;
      const pillar = new THREE.Mesh(
        new THREE.ConeGeometry(0.34, 1.15, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x7a3fd4, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      pillar.position.y = 0.55;
      group.add(core, ring, pillar);
      this.scene.add(group);
      this.sigils.push({ id: spot.id, group, collected: false });
    });
  }

  private updateSigils(delta: number, time: number) {
    if (!this.player || this.currentVehicle) return;
    (this.sigils ?? []).forEach((sigil, index) => {
      if (sigil.collected) return;
      sigil.group.rotation.y += delta * 1.7;
      sigil.group.position.y = 1.05 + Math.sin(time * 1.9 + index * 1.4) * 0.14;
      if (distance2D(sigil.group.position.x, sigil.group.position.z, this.player.position.x, this.player.position.z) < 2.1) {
        sigil.collected = true;
        sigil.group.visible = false;
        this.sigilsCollected.add(sigil.id);
        this.shards += 25;
        const spot = HeavensGateEngine.SIGIL_SPOTS.find((s) => s.id === sigil.id);
        this.emitSubtitle('Hidden Sigil', spot?.lore ?? 'The mark answers.');
        this.emitToast('Sigil claimed', `+25 marks · ${this.sigilsCollected.size} of ${HeavensGateEngine.SIGIL_SPOTS.length}`, 'success');
        this.audio.ui(true);
        this.audio.whisperBlip?.();
        this.saveCheckpoint();
      }
    });
  }

  private updateMemorial() {
    if (!this.memorialZone || !this.memorialMesh || this.memorialVisited || !this.player) return;
    const position = this.currentVehicle?.group.position ?? this.player.position;
    if (!this.memorialZone.containsPoint(position)) return;
    this.memorialVisited = true;
    this.emitSubtitle('The Archivist', 'The Memorial Obelisk — raised from photographs alone. The city keeps what the light remembers.');
    this.audio.whisperBlip?.();
    this.audio.ui(true);
  }

  private highTier() {
    return this.settings.quality === 'high' || this.settings.quality === 'ultra';
  }

  private targetPixelRatio() {
    const dpr = window.devicePixelRatio;
    if (this.settings.quality === 'ultra') return Math.min(2, dpr * 1.5);
    if (this.settings.quality === 'medium') return Math.min(dpr, 1.3);
    if (this.settings.quality === 'low') return Math.min(dpr, 1);
    return Math.min(dpr, 1.6);
  }

  private applyQuality() {
    this.dynamicPixelRatio = this.targetPixelRatio();
    this.renderer.setPixelRatio(this.dynamicPixelRatio);
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low';
    if (this.sun) {
      const shadowSize = this.settings.quality === 'ultra' ? 4096 : 2048;
      if (this.sun.shadow.mapSize.x !== shadowSize) {
        this.sun.shadow.mapSize.set(shadowSize, shadowSize);
        // Drop the render target so the shadow map rebuilds at the new size.
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    const gtao = this.highTier() && Boolean(this.gtaoPass);
    if (this.gtaoPass) {
      this.gtaoPass.enabled = gtao;
      this.gtaoPass.updateGtaoMaterial({ samples: this.settings.quality === 'ultra' ? 24 : 16 });
    }
    // GTAO only renders normals/depth and multiplies AO over the beauty the
    // RenderPass already produced — the RenderPass must stay on beneath it.
    if (this.renderPass) this.renderPass.enabled = true;
    this.renderer.toneMappingExposure = this.settings.highContrast ? 1.28 : 1.16;
    if (this.bloomPass) {
      this.bloomPass.strength = this.highTier() ? 0.62 : 0.45;
      this.bloomPass.radius = 0.55;
      this.bloomPass.threshold = 0.82;
    }
    if (this.rain) this.rain.mesh.visible = this.settings.quality !== 'low';
    if (this.rainSplash) this.rainSplash.mesh.visible = this.settings.quality !== 'low';
    this.audio.setRainBed(this.settings.quality !== 'low');
    this.scannedSurfaces.forEach((surface) => surface.setQuality(this.settings.quality));
    this.resize();
  }

  setSettings(settings: GameSettings) {
    const qualityChanged = settings.quality !== this.settings.quality || settings.highContrast !== this.settings.highContrast;
    const skinChanged = settings.characterSkin !== this.settings.characterSkin;
    if (settings.keybinds !== this.settings.keybinds) this.clearInput();
    this.settings = settings;
    this.audio.setVolume(settings.volume);
    if (qualityChanged) this.applyQuality();
    if (skinChanged) {
      this.applyPlayerSkin(settings.characterSkin);
      void this.swapHeroCharacter(settings.characterSkin);
    }
  }

  getSettings() {
    return this.settings;
  }

  async start(save?: SaveState | null) {
    if (!this.initialized) return;
    await this.audio.unlock();
    this.audio.setVolume(this.settings.volume);
    this.audio.setCityBed(true);
    this.audio.setRainBed(this.settings.quality !== 'low');
    this.resetCampaign(save ?? null);
    this.clearInput();
    this.mode = 'playing';
    this.paused = false;
    this.lastFrameTime = performance.now();
    this.emitMissionBriefing();
    this.updateObjectiveMarker();
    this.beginCinematic();
    this.saveCheckpoint();
    try { await this.canvas.requestPointerLock?.(); } catch { /* Pointer lock is optional for gamepads. */ }
  }

  private resetCampaign(save: SaveState | null) {
    save = normalizeSave(save);
    this.heroCharacter?.resetAnimation();
    this.photoMode = false;
    this.lastSave = save;
    this.health = save?.health ?? 100;
    this.armor = save?.armor ?? 50;
    this.shards = save?.shards ?? 0;
    this.ownedUpgrades = new Set(save?.upgrades ?? []);
    this.ammo = save?.ammo ?? 18;
    this.reserveAmmo = save?.reserveAmmo ?? 126;
    this.resonance = save?.resonance ?? 100;
    this.stamina = MOVEMENT_SPEC.staminaMaximum;
    this.crouching = false;
    this.slideRemaining = 0;
    this.dodgeRemaining = 0;
    this.dodgeCooldown = 0;
    this.killStreak = 0;
    this.killStreakUntil = 0;
    this.heat = 0;
    this.reinforcementTimer = 0;
    this.missionIndex = clamp(save?.missionIndex ?? 0, 0, MISSIONS.length - 1);
    this.defeatedWardens = save?.defeatedWardens ?? 0;
    this.echoesActivated = new Set(save?.echoesActivated ?? []);
    this.sigilsCollected = new Set(save?.sigilsCollected ?? []);
    this.replays = save?.replays ?? 0;
    (this.sigils ?? []).forEach((sigil) => {
      sigil.collected = this.sigilsCollected.has(sigil.id);
      sigil.group.visible = !sigil.collected;
    });
    this.radioSignals = [];
    this.elapsed = save?.elapsed ?? 0;
    this.reloading = 0;
    this.shotCooldown = 0;
    this.weaponRecoil = 0;
    this.shotIndex = 0;
    this.weaponId = save?.weaponId ?? 'morrow';
    this.weaponPools = { ...(save?.weaponAmmo ?? {}) };
    this.weaponPools[this.weaponId] = { ammo: this.ammo, reserve: this.reserveAmmo };
    this.applyWeaponVisibility();
    this.cinematic = null;
    this.hitStop = 0;
    this.shakeTrauma = 0;
    this.corpses?.forEach((corpse) => {
      corpse.group.visible = false;
      corpse.materials.forEach((material) => { material.opacity = 1; material.transparent = false; });
    });
    this.corpses = [];
    this.drops?.forEach((drop) => {
      this.scene.remove(drop.group);
      this.disposeObject(drop.group);
    });
    this.drops = [];
    this.arrivalFlashes?.forEach((flash) => {
      this.scene.remove(flash.group);
      this.disposeObject(flash.group);
    });
    this.arrivalFlashes = [];
    this.trafficCars?.forEach((car) => {
      car.progress = car.spawnProgress;
      car.speed = 0;
      car.panic = 0;
      car.damage = 0;
      car.wrecked = false;
      car.driverFled = false;
      car.group.rotation.z = 0;
      car.group.position.y = 0;
      if (car.smoke) {
        car.group.remove(car.smoke);
        this.disposeObject(car.smoke);
        car.smoke = undefined;
      }
    });
    this.invulnerability = 0;
    this.reticleHit = 0;
    this.hitDamagePool = 0;
    this.hitDamageTimer = 0;
    this.damageFlash = 0;
    this.lastCombat = this.elapsed - 8;
    this.gameOverSent = false;
    this.choiceRequested = false;
    this.missionDeadline = null;
    // Scene beats restore from the save: a delivered Sena goes back to tending
    // her lamp — no repeat dialogue, and the bell never tolls twice.
    this.narrative = save?.narrative ? { ...save.narrative } : {};
    this.senaChoiceOpen = false;
    this.senaChoiceAt = 0;
    this.senaChoiceDeadline = 0;
    this.senaTalkingUntil = 0;
    this.bellFired = false;
    // A delivered receipt in the save means the scene already ran — Sena just
    // tends her lamp and the bell never tolls twice.
    this.bellAt = null;
    this.callbacks?.onDialogueChoice?.(null);
    this.veilActive = false;
    this.veilTimer = 0;
    this.veilCooldown = 0;
    this.pulseCooldown = 0;
    this.currentVehicle = null;
    this.vehicleEnter = null;
    this.player.visible = true;
    this.playerVelocity.set(0, 0, 0);
    const spawn = MISSION_SPAWNS[this.missionIndex] ?? MISSION_SPAWNS[0];
    this.player.position.set(spawn[0], spawn[1], spawn[2]);

    this.vehicles.forEach((vehicle) => {
      vehicle.group.position.copy(vehicle.spawn);
      vehicle.speed = 0;
      vehicle.occupied = false;
      vehicle.damage = 0;
      vehicle.wrecked = false;
      vehicle.group.rotation.z = 0;
      vehicle.group.position.y = 0;
      if (vehicle.smoke) {
        vehicle.group.remove(vehicle.smoke);
        this.disposeObject(vehicle.smoke);
        vehicle.smoke = undefined;
      }
      vehicle.group.visible = true;
      vehicle.group.rotation.x = 0;
      vehicle.group.rotation.z = 0;
      if (vehicle.spot) vehicle.spot.intensity = 0;
      if (vehicle.tailMaterial) vehicle.tailMaterial.emissiveIntensity = 0.9;
    });
    this.actors.forEach((actor) => {
      actor.group.position.copy(actor.spawn);
      actor.group.rotation.x = 0;
      actor.group.rotation.z = 0;
      actor.materials?.forEach((material) => { material.opacity = 1; material.transparent = false; });
      actor.health = actor.maxHealth;
      actor.alive = true;
      actor.group.visible = true;
      actor.flee = 0;
      actor.damagePulse = 0;
      actor.lastDamageAmount = 0;
      actor.aiState = actor.kind === 'enemy' || actor.kind === 'boss'
        ? createNpcAiState({ npcId: actor.id, squadId: 'choir-wardens', homePosition: actor.spawn })
        : undefined;
      if (actor.id.startsWith('warden-') && this.missionIndex > 1) {
        actor.alive = false;
        actor.group.visible = false;
      }
    });
    // The cordon is per-session scenery: strike whatever a previous state
    // left, then re-post it only when a mid-beat save says it already stood.
    this.clearCordon();
    this.cordonAt = null;
    this.cordonAlerted = false;
    this.cordonPassed = false;
    this.cordonTellCooldown = 0;
    this.breadcrumbTarget = null;
    this.exitCostAt = null;
    this.aftermathAt = null;
    this.cordonResolved = false;
    // The witness and the quiet Seraph are per-session beats — strike
    // whatever a previous state left, then re-raise only what's still owed.
    const quiet = this.quietSeraph;
    if (quiet) {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], quiet.group);
      this.scene?.remove(quiet.group);
      this.disposeObject(quiet.group);
      this.actors = (this.actors ?? []).filter((actor) => actor !== quiet);
      this.quietSeraph = null;
    }
    const witness = this.chapelWitness;
    if (witness) {
      this.scene?.remove(witness.group);
      this.disposeObject(witness.group);
      this.chapelWitness = null;
    }
    if (this.missionIndex === 0 && this.narrative?.cordonSeen === true) this.spawnCordon(false);
    // If a save landed after the cordon resolved but before the talk, he's
    // still waiting — the cordon re-resolving also respawns him in-session.
    if (this.missionIndex === 0 && this.narrative?.aftermathHeard === true) this.spawnQuietSeraph();
    // Contract-spawned patrols are session work — strike them on reset.
    const contractSpawned = this.activeContract?.spawned ?? [];
    contractSpawned.forEach((actor) => {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], actor.group);
      this.scene?.remove(actor.group);
      this.disposeObject(actor.group);
    });
    if (contractSpawned.length) this.actors = (this.actors ?? []).filter((actor) => !contractSpawned.includes(actor));
    this.activeContract = null;
    // Reinforcements ride the heat — the reset zeroes it, so any live
    // hunters or Bulwarks stand down and dissolve rather than haunting a
    // quieted city.
    const reinforcements = (this.actors ?? []).filter((actor) => actor.id.startsWith('reinforce-') || actor.id.startsWith('driver-'));
    reinforcements.forEach((actor) => {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], actor.group);
      this.scene?.remove(actor.group);
      this.disposeObject(actor.group);
    });
    if (reinforcements.length) this.actors = (this.actors ?? []).filter((actor) => !reinforcements.includes(actor));
    // A street event mid-scene is session dressing — strike it on reset.
    this.despawnStreetEvent();
    this.nextStreetEventAt = this.elapsed + 18;
    // Shot-out lanterns come back on with the checkpoint.
    this.relightLamps();
    // Shattered panes reglaze too.
    this.windowPaneHits?.forEach((originals, paneMesh) => {
      originals.forEach((color, local) => paneMesh.setColorAt(local, color));
      if (paneMesh.instanceColor) paneMesh.instanceColor.needsUpdate = true;
    });
    this.windowPaneHits?.clear();
    this.echoes.forEach((echo) => {
      echo.activated = this.echoesActivated.has(echo.id);
      echo.group.visible = !echo.activated;
    });
    if (this.boss) {
      this.rayTargets = withoutSubtree(this.rayTargets, this.boss.group);
      this.scene.remove(this.boss.group);
      this.disposeObject(this.boss.group);
      this.actors = this.actors.filter((actor) => actor !== this.boss);
      this.boss = null;
    }
    this.gates.forEach((gate) => {
      gate.ring.material.emissiveIntensity = 2.2;
      gate.veil.material.opacity = 0.055;
    });
    this.setVeil(false, true);
    if (this.missionIndex === 5) this.spawnBoss();
    if (save?.ending) this.applyEndingWorld(save.ending);
  }

  pause() {
    this.paused = true;
    this.clearInput();
    this.audio.setIntensity(0.05);
    if (document.pointerLockElement) void document.exitPointerLock();
  }

  async resume() {
    if (this.mode !== 'playing') return;
    await this.audio.unlock();
    this.clearInput();
    this.paused = false;
    this.lastFrameTime = performance.now();
    try { await this.canvas.requestPointerLock?.(); } catch { /* Pointer lock is optional. */ }
  }

  isPaused() {
    return this.paused;
  }

  retryCheckpoint() {
    this.resetCampaign(this.lastSave);
    this.clearInput();
    this.mode = 'playing';
    this.paused = false;
    this.emitMissionBriefing();
    this.updateObjectiveMarker();
    this.beginCinematic();
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
  }

  testAudio() {
    void this.audio.unlock().then(() => this.audio.testMix());
  }

  resolveEnding(ending: 'open' | 'seal') {
    if (this.missionIndex !== 6) return;
    this.choiceRequested = false;
    this.missionIndex = 7;
    this.paused = true;
    this.applyEndingWorld(ending);
    this.audio.gate();
    this.saveCheckpoint(ending);
    this.callbacks.onCampaignComplete(ending);
  }

  async enterFreeRoam() {
    this.paused = false;
    this.mode = 'playing';
    this.missionIndex = 7;
    await this.resume();
    this.beginCinematic();
  }

  // Post-campaign replay: jump back into any operation. Keeps earned
  // upgrades, marks, sigils, and stats — only the mission pointer moves.
  replayMission(missionIndex: number) {
    if (!Number.isInteger(missionIndex) || missionIndex < 0 || missionIndex > 6) return;
    const base = this.lastSave;
    const replays = (base?.replays ?? 0) + 1;
    this.resetCampaign(base
      ? { ...base, missionIndex, ending: undefined, echoesActivated: missionIndex === 4 ? [] : base.echoesActivated, replays }
      : {
          version: 1,
          missionIndex,
          health: 100,
          armor: 50,
          ammo: 18,
          reserveAmmo: 126,
          resonance: 100,
          defeatedWardens: 0,
          echoesActivated: [],
          replays,
          elapsed: 0,
          updatedAt: Date.now(),
        });
    this.clearInput();
    this.mode = 'playing';
    this.paused = false;
    if (replays > 0) {
      this.emitToast(`NG+${replays > 1 ? ` +${replays - 1}` : ''}`, 'The Choir remembers you — patrols fire faster.', 'danger');
    }
    this.emitMissionBriefing();
    this.updateObjectiveMarker();
    this.beginCinematic();
  }

  returnToTitle() {
    this.mode = 'attract';
    this.paused = false;
    this.clearInput();
    this.audio.setEngine(0, false);
    this.audio.setIntensity(0.08);
    if (document.pointerLockElement) void document.exitPointerLock();
  }

  private applyEndingWorld(ending: 'open' | 'seal') {
    if (ending === 'open') {
      this.scene.background = new THREE.Color(0x172029);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.setHex(0x182329);
        this.scene.fog.density = 0.0048;
      }
      this.gates.forEach((gate) => {
        gate.ring.material.emissiveIntensity = 4.2;
        gate.veil.material.opacity = 0.22;
      });
    } else {
      this.scene.background = new THREE.Color(0x040607);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.setHex(0x050708);
        this.scene.fog.density = 0.009;
      }
      this.gates.forEach((gate) => {
        gate.ring.material.emissiveIntensity = 0.28;
        gate.veil.material.opacity = 0.015;
      });
    }
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const frameMilliseconds = Math.max(0, now - this.lastFrameTime);
    let delta = Math.min(frameMilliseconds / 1000, 0.05);
    if (this.hitStop > 0) {
      this.hitStop -= delta;
      delta *= 0.22;
    }
    this.lastFrameTime = now;
    this.renderTime += delta;
    this.frameTimeSampler.record(frameMilliseconds);
    if (this.contextLost) return;
    const time = this.renderTime;
    if (!this.initialized) return;

    if (this.mode === 'attract') {
      this.updateAttract(time, delta);
    } else if (!this.paused) {
      this.updateGame(delta, time);
    }
    this.updateAmbientAnimation(delta, time);
    if (!this.contextLost) {
      if (this.composer && this.settings.quality !== 'low') this.composer.render();
      else this.renderer.render(this.scene, this.camera);
      this.updatePerformance(frameMilliseconds / 1000);
    }
  };

  private updateAttract(time: number, delta: number) {
    if (this.settings.reducedMotion) {
      this.camera.position.set(42, 27, 48);
      this.camera.lookAt(0, 10, -42);
      return;
    }
    const radius = 62 + Math.sin(time * 0.07) * 7;
    this.camera.position.set(Math.sin(time * 0.055) * radius, 28 + Math.sin(time * 0.13) * 4, 6 + Math.cos(time * 0.055) * radius);
    this.camera.lookAt(0, 10, -42);
    this.worldHours += delta * 0.002;
  }

  private updateGame(delta: number, time: number) {
    this.elapsed += delta;
    this.pollGamepad(delta);
    if (this.paused) return;
    this.processActions();
    if (this.paused) return;
    if (this.photoMode) {
      // Photo mode freezes the world — AI, traffic, missions, clocks — but
      // keeps the camera alive. Ambient dressing (rain, litter, clouds)
      // runs in updateAmbientAnimation outside this gate, so a frozen
      // street still weathers.
      this.updatePhotoCamera(delta);
      this.updateHUD(delta);
      this.input.finishFrame();
      this.touchPressed.clear();
      return;
    }
    this.worldHours += delta * 0.013;
    if (this.cinematic && (
      this.settings.reducedMotion
      || this.isActionHeld('moveForward') || this.isActionHeld('moveBackward')
      || this.isActionHeld('moveLeft') || this.isActionHeld('moveRight')
      || Math.hypot(this.gamepadAxes.moveX, this.gamepadAxes.moveY) > 0.4
      || Math.hypot(this.touchMove?.x ?? 0, this.touchMove?.y ?? 0) > 0.4
      || this.mouseShootHeld || this.gamepadAxes.shoot > 0.55 || this.touchFire
      || this.wasActionPressed('jump')
    )) this.cinematic = null;

    this.shotCooldown = Math.max(0, this.shotCooldown - delta);
    this.weaponRecoil = recoverShotRecoil(this.weaponRecoil, delta, this.isAiming(), this.activeWeaponSpec());
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - delta);
      if (this.reloading === 0) this.finishReload();
    }
    this.invulnerability = Math.max(0, this.invulnerability - delta);
    this.whizCooldown = Math.max(0, (this.whizCooldown ?? 0) - delta);
    if (this.deathCamTimer > 0) {
      this.deathCamTimer -= delta;
      if (this.deathCamTimer <= 0) this.callbacks.onGameOver(this.lastKiller);
    }
    this.veilCooldown = Math.max(0, this.veilCooldown - delta);
    this.pulseCooldown = Math.max(0, this.pulseCooldown - delta);
    this.reticleHit = Math.max(0, this.reticleHit - delta * 5);
    this.reticleKill = Math.max(0, (this.reticleKill ?? 0) - delta);
    // Low-health heartbeat — a slow double-thump that quickens as HP drops.
    if (this.health <= 30 && this.health > 0 && !this.gameOverSent) {
      this.heartbeatTimer = (this.heartbeatTimer ?? 0) - delta;
      if (this.heartbeatTimer <= 0) {
        this.audio.heartbeat?.(1 - this.health / 30);
        this.heartbeatTimer = 1.15 - (1 - this.health / 30) * 0.35;
      }
    }
    this.hitDamageTimer = Math.max(0, (this.hitDamageTimer ?? 0) - delta);
    this.damageFlash = Math.max(0, this.damageFlash - delta * 2.4);
    this.damageDirectionTimer = Math.max(0, this.damageDirectionTimer - delta);
    if (this.damageDirectionTimer === 0) this.damageDirection = null;

    if (this.mouseShootHeld && this.shotCooldown <= 0) this.tryShoot();
    if ((this.gamepadAxes.shoot > 0.55 || this.touchFire) && this.shotCooldown <= 0) this.tryShoot();

    if (this.currentVehicle) this.updateVehicle(delta);
    else this.updatePlayer(delta);

    this.updateActors(delta, time);
    this.updateReinforcements(delta);
    this.updateTraffic(delta);
    this.updateCorpses(delta);
    this.updateDrops(delta, time);
    this.updateArrivals(delta);
    this.updateCharges(delta);
    this.updateCasings(delta);
    this.updateChapel();
    this.updateMemorial();
    this.updateSigils(delta, this.elapsed);
    this.updateVeil(delta);
    this.updateWeaponSway(delta);
    this.updateEffects(delta);
    this.updateMission();
    this.updateSena();
    this.updateCordon(delta);
    this.updateWitness();
    this.updateContract();
    this.updateStreetEvents();
    this.updateCamera(delta);
    this.updateHeat(delta);
    this.updateHUD(delta);
    this.input.finishFrame();
    this.touchPressed.clear();
  }

  private processActions() {
    if (this.wasActionPressed('inspect') && this.currentVehicle) {
      // In a vehicle the inspect key becomes the bonnet/first-person cam.
      this.bonnetCam = !this.bonnetCam;
      this.emitToast(
        this.bonnetCam ? 'Bonnet cam' : 'Chase cam',
        this.bonnetCam ? 'Hood-level view — look is free, crouch checks the mirror.' : 'Third-person camera restored.',
        'info',
      );
    } else if (this.wasActionPressed('inspect')) {
      this.photoMode = !this.photoMode;
      if (this.photoMode) {
        // Seed the free cam where the chase cam is — the world freezes,
        // the camera doesn't. Re-lock the pointer so mouse-look flies it.
        this.photoCamPos.copy(this.camera.position);
        this.photoFov = this.camera.fov;
        if (!this.pointerLocked && !this.pointerFallback) {
          const lockRequest = this.canvas?.requestPointerLock?.();
          if (lockRequest) void lockRequest.catch(() => this.enablePointerFallback());
        }
      }
      if (!this.photoMode && this.renderer?.domElement) this.renderer.domElement.style.filter = '';
      this.emitToast(
        this.photoMode ? 'Photo mode' : 'Photo mode closed',
        this.photoMode
          ? `World frozen. Move to fly, ${this.bindingLabel('jump')}/${this.bindingLabel('crouch')} for height, sprint is fast. Wheel zooms, ${this.bindingLabel('weaponSwap')} grades. ${this.bindingLabel('inspect')} returns.`
          : 'Third-person camera restored.',
        'success',
      );
    }
    if (this.photoMode) {
      if (this.wasActionPressed('weaponSwap')) {
        this.photoFilterIndex = ((this.photoFilterIndex ?? 0) + 1) % HeavensGateEngine.PHOTO_FILTERS.length;
        const grade = HeavensGateEngine.PHOTO_FILTERS[this.photoFilterIndex];
        if (this.renderer?.domElement) this.renderer.domElement.style.filter = grade.css;
        this.emitToast(`Photo grade: ${grade.name}`, grade.hint, 'info');
      }
      // The frozen world ignores every other action — no reloads, pulses,
      // or interactions while you're composing the shot.
      return;
    }
    // Mid door-walk: half a second of scripted root motion owns the body.
    if (this.vehicleEnter) return;
    if (this.wasActionPressed('reload')) this.startReload();
    // While Sena's prompt is up, E/Q answer her instead of interacting/veiling.
    const senaAnswering = this.senaChoiceOpen === true;
    if (this.wasActionPressed('veil')) {
      if (senaAnswering) this.chooseDialogueOption(1);
      else this.toggleVeil();
    }
    if (this.wasActionPressed('pulse')) this.usePulse();
    if (this.wasActionPressed('weaponSwap')) this.cycleWeapon();
    if (this.wasActionPressed('melee')) this.tryMelee();
    if (this.wasActionPressed('throwCharge')) this.throwCharge();
    if (this.wasActionPressed('shoulderSwap')) {
      this.shoulderSide = -(this.shoulderSide ?? 1);
      this.emitToast('Shoulder swapped', this.shoulderSide > 0 ? 'Camera favors the right shoulder' : 'Camera favors the left shoulder', 'info');
    }
    if (this.wasActionPressed('interact')) {
      if (senaAnswering) this.chooseDialogueOption(0);
      else this.interact();
    }
  }

  private isActionHeld(action: KeybindAction) {
    return this.input.isHeld(action, this.settings.keybinds, this.settings.gamepadBinds) || (this.touchHeld?.has(action) ?? false);
  }

  private wasActionPressed(action: KeybindAction) {
    return this.input.wasPressed(action, this.settings.keybinds, this.settings.gamepadBinds) || (this.touchPressed?.has(action) ?? false);
  }

  private clearInput() {
    this.input.reset();
    this.gamepadAxes = this.input.gamepadAxes;
    this.mouseShootHeld = false;
    this.mouseAimHeld = false;
    this.aimToggled = false;
    this.clearTouchInput();
  }

  private requestPause() {
    this.pause();
    this.callbacks.onPauseRequested();
  }

  private bindingLabel(action: KeybindAction) {
    const binding = this.settings.keybinds[action];
    return binding === ' ' ? 'SPACE' : binding.toUpperCase();
  }

  private connectedGamepad() {
    try {
      return navigator.getGamepads?.().find((pad) => pad?.connected && pad.mapping === 'standard') ?? null;
    } catch {
      // Embedders can deny the Gamepad API through Permissions Policy.
      return null;
    }
  }

  private pollGamepad(delta: number) {
    this.input.sampleGamepad(this.connectedGamepad());
    this.gamepadAxes = this.input.gamepadAxes;
    if (this.input.wasPausePressed()) {
      this.requestPause();
      return;
    }
    const look = gamepadLookDelta(this.gamepadAxes, this.settings.sensitivity, delta);
    this.cameraYaw += look.yaw;
    this.cameraPitch = this.photoMode
      ? clamp(this.cameraPitch + look.pitch, -1.45, 1.45)
      : clamp(this.cameraPitch + look.pitch, -0.24, 0.74);
    // Aim assist (gamepad only): while holding LT, ease the reticle toward
    // the nearest hostile inside a narrow cone — magnetism, not snapping.
    if (this.settings.aimAssist && this.gamepadAxes.aim > 0.2 && this.actors?.length) {
      const origin = this.camera.position;
      this.camera.getWorldDirection(this.cameraForward);
      let bestAngle = 0.1;
      let best: Actor | null = null;
      for (const actor of this.actors) {
        if (!actor.alive || actor.kind === 'civilian') continue;
        const to = actor.group.position.clone().sub(origin);
        to.y += 1.3;
        const distance = to.length();
        if (distance < 4 || distance > 64) continue;
        to.normalize();
        const angle = to.angleTo(this.cameraForward);
        if (angle < bestAngle) { bestAngle = angle; best = actor; }
      }
      if (best) {
        const chest = best.group.position.clone();
        chest.y += 1.3;
        const toTarget = chest.sub(origin).normalize();
        const desiredYaw = Math.atan2(-toTarget.x, -toTarget.z);
        const desiredPitch = Math.asin(clamp(toTarget.y, -1, 1));
        let yawDelta = desiredYaw - this.cameraYaw;
        while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        const strength = 1 - Math.exp(-9 * delta);
        this.cameraYaw += yawDelta * strength * 0.35;
        this.cameraPitch = clamp(this.cameraPitch + (desiredPitch - this.cameraPitch) * strength * 0.3, -0.24, 0.74);
      }
    }
  }

  private isAiming() {
    if (this.currentVehicle) return false;
    return this.mouseAimHeld || this.aimToggled || this.gamepadAxes.aim > 0.2 || this.touchAim;
  }

  setTouchMove(x: number, y: number) {
    this.touchMove.x = clamp(x, -1, 1);
    this.touchMove.y = clamp(y, -1, 1);
  }

  applyTouchLook(deltaX: number, deltaY: number) {
    if (this.mode !== 'playing' || this.paused) return;
    const sensitivity = this.settings.sensitivity * 0.0062;
    this.cameraYaw -= deltaX * sensitivity;
    this.cameraPitch = this.photoMode
      ? clamp(this.cameraPitch - deltaY * sensitivity, -1.45, 1.45)
      : clamp(this.cameraPitch - deltaY * sensitivity, -0.24, 0.74);
  }

  setTouchFire(active: boolean) {
    if (active && !this.touchFire) this.tryShoot();
    this.touchFire = active;
  }

  setTouchAim(active: boolean) {
    this.touchAim = active;
  }

  pressTouchAction(action: KeybindAction) {
    if (!this.touchHeld.has(action)) this.touchPressed.add(action);
    this.touchHeld.add(action);
  }

  releaseTouchAction(action: KeybindAction) {
    this.touchHeld.delete(action);
  }

  clearTouchInput() {
    this.touchMove.x = 0;
    this.touchMove.y = 0;
    this.touchFire = false;
    this.touchAim = false;
    this.touchHeld?.clear();
    this.touchPressed?.clear();
  }

  private pulseGamepad(duration: number, strongMagnitude: number, weakMagnitude: number) {
    const gamepad = this.connectedGamepad();
    const actuator = gamepad?.vibrationActuator;
    if (!actuator) return;
    void actuator.playEffect('dual-rumble', {
      duration,
      startDelay: 0,
      strongMagnitude: clamp(strongMagnitude, 0, 1),
      weakMagnitude: clamp(weakMagnitude, 0, 1),
    }).catch(() => { /* Haptics are an optional enhancement. */ });
  }

  private updatePlayer(delta: number) {
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - delta);
    const forwardInput = (this.isActionHeld('moveForward') ? 1 : 0) - (this.isActionHeld('moveBackward') ? 1 : 0) - this.gamepadAxes.moveY - (this.touchMove?.y ?? 0);
    const sideInput = (this.isActionHeld('moveRight') ? 1 : 0) - (this.isActionHeld('moveLeft') ? 1 : 0) + this.gamepadAxes.moveX + (this.touchMove?.x ?? 0);
    const inputLength = Math.hypot(forwardInput, sideInput);
    const aiming = this.isAiming();
    const sprintIntent = this.isActionHeld('sprint');

    const forward = (this.moveForward ??= new THREE.Vector3()).set(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    const right = (this.moveRight ??= new THREE.Vector3()).set(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
    const desiredDirection = (this.moveDesired ??= new THREE.Vector3()).set(0, 0, 0);
    if (inputLength > 0.05) {
      desiredDirection.addScaledVector(forward, forwardInput / Math.max(1, inputLength));
      desiredDirection.addScaledVector(right, sideInput / Math.max(1, inputLength));
      desiredDirection.normalize();
      this.playerHeading = Math.atan2(desiredDirection.x, desiredDirection.z);
    }
    if (aiming) this.playerHeading = Math.atan2(forward.x, forward.z);

    const crouchPressed = this.wasActionPressed('crouch');
    const planarSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    // Cover: crouching beside a collision face or wrecked car attaches you to
    // it — movement slides along the wall, and holding fire peeks over it.
    this.coverFace = this.crouching && this.slideRemaining <= 0 ? this.findCoverFace() : null;
    if (crouchPressed && this.slideRemaining <= 0 && this.dodgeRemaining <= 0) {
      if (sprintIntent && canStartSlide(this.stamina, this.grounded, planarSpeed)) {
        this.slideRemaining = MOVEMENT_SPEC.slideSeconds;
        this.stamina -= MOVEMENT_SPEC.slideCost;
        this.crouching = true;
        this.slideDirection.copy(this.playerVelocity).setY(0);
        if (this.slideDirection.lengthSq() < 0.05) this.slideDirection.copy(desiredDirection.lengthSq() ? desiredDirection : forward);
        this.slideDirection.normalize();
        this.heroCharacter?.playOnce('slide', 0.06);
        this.pulseGamepad(90, 0.28, 0.38);
      } else {
        this.crouching = !this.crouching;
      }
    }

    const dodgePressed = this.wasActionPressed('dodge');
    if (dodgePressed && canStartDodge(this.stamina, this.grounded, this.dodgeCooldown) && this.slideRemaining <= 0) {
      this.dodgeRemaining = MOVEMENT_SPEC.dodgeSeconds;
      this.dodgeCooldown = MOVEMENT_SPEC.dodgeCooldownSeconds;
      this.stamina -= MOVEMENT_SPEC.dodgeCost;
      this.crouching = false;
      this.dodgeDirection.copy(desiredDirection.lengthSq() ? desiredDirection : forward).normalize();
      this.invulnerability = Math.max(this.invulnerability, 0.2);
      this.heroCharacter?.playOnce('slide', 0.045);
      this.pulseGamepad(70, 0.2, 0.34);
    }

    const sprinting = sprintIntent
      && !aiming
      && !this.crouching
      && this.slideRemaining <= 0
      && this.dodgeRemaining <= 0
      && this.stamina > 0.5
      && inputLength > 0.05;
    // Sprint cancels a reload in progress — hands go to the run.
    if (sprinting && !this.playerSprinting && this.reloading > 0) {
      this.reloading = 0;
      this.emitToast('Reload canceled', 'Sprinting holstered the magazine', 'info');
    }
    this.playerSprinting = sprinting;
    this.stamina = updateStamina(this.stamina, delta, sprinting);
    const desired = desiredDirection.multiplyScalar(movementSpeed({ aiming, crouching: this.crouching, sprinting }) * Math.min(1, inputLength));
    // During the door-walk blend input is ignored — the script owns the body.
    if (this.vehicleEnter) desired.set(0, 0, 0);
    if (this.coverFace) {
      // Strip the into-wall/out-of-wall component so cover movement is pure
      // tangent slide; leaving is just walking away while crouched.
      const into = desired.x * this.coverFace.x + desired.z * this.coverFace.z;
      desired.x -= this.coverFace.x * into;
      desired.z -= this.coverFace.z * into;
      // Gentle press against the face keeps spacing consistent.
      desired.x += this.coverFace.x * -0.4;
      desired.z += this.coverFace.z * -0.4;
    }
    if (this.slideRemaining > 0) {
      desired.copy(this.slideDirection).multiplyScalar(slideSpeed(this.slideRemaining));
      this.slideRemaining = Math.max(0, this.slideRemaining - delta);
    } else if (this.dodgeRemaining > 0) {
      desired.copy(this.dodgeDirection).multiplyScalar(MOVEMENT_SPEC.dodgeSpeed);
      this.dodgeRemaining = Math.max(0, this.dodgeRemaining - delta);
    }
    const groundResponse = this.slideRemaining > 0 || this.dodgeRemaining > 0 ? 24 : 11;
    this.playerVelocity.x = damp(this.playerVelocity.x, desired.x, this.grounded ? groundResponse : 2.2, delta);
    this.playerVelocity.z = damp(this.playerVelocity.z, desired.z, this.grounded ? groundResponse : 2.2, delta);

    const jumpPressed = this.wasActionPressed('jump');
    if ((this.vaultTimer ?? 0) > 0) {
      // Animated vault: arc over the obstacle, no gravity/snap/collision.
      this.vaultTimer = Math.max(0, this.vaultTimer - delta);
      const t = 1 - this.vaultTimer / 0.38;
      this.player.position.lerpVectors(this.vaultFrom, this.vaultTo, t);
      const interpolatedY = this.player.position.y;
      this.player.position.y = interpolatedY + Math.sin(t * Math.PI) * (this.vaultPeak - interpolatedY);
      this.clampWorld(this.player.position);
      if (this.vaultTimer <= 0) {
        this.grounded = this.vaultTo.y > 0.2;
        this.playerVelocity.y = this.grounded ? 0 : -1.5;
        this.hurtKick = (this.hurtKick ?? 0) + 0.06;
        this.audio.footstep(true, this.footstepSurface());
      }
    } else if (this.vehicleEnter) {
      // Door-walk blend: ease toward the door point while the gait machine
      // sees a door-ward velocity, so the walk clip and footsteps play. On
      // arrival the seat logic runs.
      const enter = this.vehicleEnter;
      enter.timer = Math.max(0, enter.timer - delta);
      const t = 1 - enter.timer / enter.total;
      const ease = 1 - Math.pow(1 - t, 3);
      this.player.position.lerpVectors(enter.from, enter.to, ease);
      this.player.position.y = this.groundHeightAt(this.player.position.x, this.player.position.z, enter.from.y + 1) ?? enter.from.y;
      this.playerVelocity.set(enter.to.x - enter.from.x, 0, enter.to.z - enter.from.z).normalize().multiplyScalar(3.1);
      this.playerHeading = Math.atan2(this.playerVelocity.x, this.playerVelocity.z);
      if (enter.timer <= 0) {
        this.vehicleEnter = null;
        this.playerVelocity.set(0, 0, 0);
        if (this.health > 0 && !enter.vehicle.wrecked) {
          this.audio.surfaceImpact(enter.to, this.player.position, this.cameraYaw, false, 'metal');
          this.seatVehicle(enter.vehicle);
        }
      }
    } else {
      if (jumpPressed && this.grounded && this.slideRemaining <= 0 && this.dodgeRemaining <= 0) {
        this.crouching = false;
        this.playerVelocity.y = 8.4;
        this.grounded = false;
        this.heroCharacter?.playOnce('jump');
        this.audio.ui(true);
      }
      this.playerVelocity.y -= 21 * delta;

      const previous = this.player.position.clone();
      this.player.position.addScaledVector(this.playerVelocity, delta);
      const groundHeight = this.groundHeightAt(this.player.position.x, this.player.position.z, this.player.position.y);
      if (this.player.position.y <= groundHeight) {
        this.player.position.y = groundHeight;
        if (!this.grounded) {
          const impact = clamp(-this.playerVelocity.y, 0, 24);
          this.landDip = Math.max(this.landDip, impact * 0.011);
          this.addTrauma(clamp(impact * 0.02, 0, 0.38));
          if (impact > 7) {
            this.audio.footstep(true, this.footstepSurface());
            this.pulseGamepad(50, clamp(impact * 0.02, 0.1, 0.4), clamp(impact * 0.014, 0.08, 0.3));
          }
          // Hard drops tuck into a recovery roll instead of a flat stomp.
          // The airtime gate keeps teleports/edge step-offs from faking a fall.
          if (impact > 13 && this.airTime > 0.22 && !this.settings?.reducedMotion) {
            this.heroCharacter?.playOnce('slide', 0.05);
            this.hurtKick = Math.min(0.4, this.hurtKick + impact * 0.012);
          }
        }
        this.playerVelocity.y = 0;
        this.grounded = true;
        this.airTime = 0;
      } else {
        this.airTime += delta;
      }
      this.clampWorld(this.player.position);
      const floorY = this.player.position.y;
      const sweptPosition = sweepPlanarCollision(previous, this.player.position,
        (x, z) => this.collides(x, z, PLAYER_RADIUS, floorY));
      if (sweptPosition.swept) {
        this.player.position.x = sweptPosition.x;
        this.player.position.z = sweptPosition.z;
      }
      if (sweptPosition.swept || this.collides(this.player.position.x, this.player.position.z, PLAYER_RADIUS, floorY)) {
        const vaultDirection = desired.clone().setY(0);
        const vaultTarget = previous.clone();
        let vaulted = false;
        if (jumpPressed && vaultDirection.lengthSq() > 0.1 && this.stamina >= 8) {
          vaultDirection.normalize();
          vaultTarget.addScaledVector(vaultDirection, 2.35);
          // Landing can be the top of low cover — probe the target ground so
          // a vault onto a pew or crate sticks instead of bouncing off.
          const landingGround = this.groundHeightAt(vaultTarget.x, vaultTarget.z, this.player.position.y + 1.5);
          if (!this.collides(vaultTarget.x, vaultTarget.z, PLAYER_RADIUS * 0.78, landingGround)) {
            this.stamina = Math.max(0, this.stamina - 8);
            this.grounded = false;
            vaulted = true;
            if (this.settings?.reducedMotion) {
              this.player.position.x = vaultTarget.x;
              this.player.position.z = vaultTarget.z;
              this.player.position.y = Math.max(this.player.position.y, landingGround + 0.08, 0.52);
              this.playerVelocity.y = Math.max(this.playerVelocity.y, landingGround > 0.2 ? 2.6 : 4.2);
            } else {
              this.vaultTimer = 0.38;
              (this.vaultFrom ??= new THREE.Vector3()).copy(this.player.position);
              (this.vaultTo ??= new THREE.Vector3()).copy(vaultTarget).setY(landingGround);
              this.vaultPeak = Math.max(this.vaultFrom.y, this.vaultTo.y) + 0.45;
              this.heroCharacter?.playOnce('jump');
            }
          }
        }
        if (!vaulted) {
          const resolved = sweptPosition.swept ? sweptPosition : resolvePlanarCollision(previous, this.player.position,
            (x, z) => this.collides(x, z, PLAYER_RADIUS, floorY));
          this.player.position.x = resolved.x;
          this.player.position.z = resolved.z;
          if (resolved.blockedX) this.playerVelocity.x = 0;
          if (resolved.blockedZ) this.playerVelocity.z = 0;
        }
      }
    }

    this.player.rotation.y = smoothHeading(this.player.rotation.y, this.playerHeading, delta);
    const movement = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    // Turn-in-place: stationary but the body is still catching up to the
    // desired heading — walk reads as a shuffle-step instead of a pivot slide.
    let headingError = this.playerHeading - this.player.rotation.y;
    while (headingError > Math.PI) headingError -= Math.PI * 2;
    while (headingError < -Math.PI) headingError += Math.PI * 2;
    const turningInPlace = movement <= 0.7 && Math.abs(headingError) > 0.42 && this.grounded;
    this.heroCharacter?.setMotion(
      !this.grounded
        ? 'jump'
        : this.slideRemaining > 0 || this.dodgeRemaining > 0
          ? 'slide'
          : aiming
            ? 'aim'
            : this.crouching
              ? 'crouch'
              : movement > 8
                ? 'run'
                : movement > 0.7 || turningInPlace
                  ? 'walk'
                  : 'idle',
    );
    this.walkPhase += movement * delta * 1.8;
    this.playerParts.forEach((part) => {
      const side = Number(part.userData.side ?? 1);
      const limbDirection = part.userData.limb === 'arm' ? -1 : 1;
      part.rotation.x = Math.sin(this.walkPhase) * Math.min(0.62, movement * 0.06) * side * limbDirection;
    });
    this.footstepTimer -= delta;
    if (movement > 1.4 && this.grounded && this.slideRemaining <= 0 && this.dodgeRemaining <= 0 && this.footstepTimer <= 0) {
      this.audio.footstep(sprinting, this.footstepSurface());
      this.footstepTimer = sprinting ? 0.29 : 0.44;
    }
  }

  private updateVehicle(delta: number) {
    const vehicle = this.currentVehicle;
    if (!vehicle) return;
    const throttle = clamp((this.isActionHeld('moveForward') ? 1 : 0) - (this.isActionHeld('moveBackward') ? 1 : 0) - this.gamepadAxes.moveY - (this.touchMove?.y ?? 0), -1, 1);
    const steering = clamp((this.isActionHeld('moveLeft') ? 1 : 0) - (this.isActionHeld('moveRight') ? 1 : 0) - this.gamepadAxes.moveX - (this.touchMove?.x ?? 0), -1, 1);
    const boost = this.isActionHeld('sprint');
    const handbrake = this.isActionHeld('jump');
    const spec = vehicle.spec ?? HeavensGateEngine.VEHICLE_SPECS.seraph;
    const maxSpeed = vehicle.wrecked ? 0
      : (boost ? spec.boost : spec.top) * (vehicle.damage > 80 ? 0.45 : vehicle.damage > 40 ? 0.8 : 1);
    const targetSpeed = throttle >= 0 ? throttle * maxSpeed : throttle * spec.top * 0.47;
    vehicle.speed = damp(vehicle.speed, targetSpeed, throttle ? spec.accel : 1.8, delta);
    if (handbrake) {
      vehicle.speed = damp(vehicle.speed, 0, 9.5, delta);
      if (Math.abs(vehicle.speed) > 9 && this.screechTimer <= 0) {
        this.audio.tireScreech?.(clamp(Math.abs(vehicle.speed) / 40, 0.2, 1));
        this.screechTimer = 0.22;
      }
    }
    this.statDistanceDriven += Math.abs(vehicle.speed) * delta;
    this.screechTimer = Math.max(0, this.screechTimer - delta);
    // Tire marks: handbrake slides and hard cornering write dark strips
    // under the rear axle, spaced by distance travelled rather than frames.
    const sliding = Math.abs(vehicle.speed) > 12 && (handbrake || Math.abs(steering) > 0.55);
    if (!sliding) this.skidDistance = 0;
    else {
      this.skidDistance += Math.abs(vehicle.speed) * delta;
      if (this.skidDistance > 0.5) {
        this.skidDistance = 0;
        const rearX = vehicle.group.position.x + Math.sin(vehicle.heading) * 1.05;
        const rearZ = vehicle.group.position.z + Math.cos(vehicle.heading) * 1.05;
        const latX = -Math.cos(vehicle.heading) * 0.72;
        const latZ = Math.sin(vehicle.heading) * 0.72;
        this.laySkidMark(rearX + latX, rearZ + latZ, vehicle.heading);
        this.laySkidMark(rearX - latX, rearZ - latZ, vehicle.heading);
      }
    }
    // Handbrake loosens the rear: steering gains authority while the body
    // leans further, reading as a slide without a full slip sim.
    const steerAuthority = handbrake ? 1.75 : 1;
    const steerStrength = clamp(Math.abs(vehicle.speed) / 9, 0.15, 1) * steerAuthority;
    vehicle.heading += steering * steerStrength * delta * spec.steer * Math.sign(vehicle.speed || 1);
    const previous = (this.vehiclePrev ??= new THREE.Vector3()).copy(vehicle.group.position);
    vehicle.group.position.x += -Math.sin(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.position.z += -Math.cos(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.rotation.y = vehicle.heading;
    this.clampWorld(vehicle.group.position, 5);
    const vehicleSweep = sweepPlanarCollision(previous, vehicle.group.position,
      (x, z) => this.collides(x, z, 2.25, vehicle.group.position.y), 0.5);
    if (vehicleSweep.swept) {
      vehicle.group.position.x = vehicleSweep.x;
      vehicle.group.position.z = vehicleSweep.z;
      const impact = Math.abs(vehicle.speed);
      if (impact > 8) {
        this.audio.crash?.(clamp(impact / 34, 0.2, 1));
        this.addTrauma(clamp(impact / 34, 0.15, 0.65));
        vehicle.damage = (vehicle.damage ?? 0) + impact * 1.1 * spec.damageScale;
        vehicle.bumpDip = clamp(impact * 0.008, 0.06, 0.16);
      }
      if (impact > 16) {
        this.takePlayerDamage(impact * 0.34);
        this.audio.explosion();
      }
      vehicle.speed *= -0.22;
    }
    const braking = handbrake || (throttle < 0 && vehicle.speed > 4);
    const steerVisual = steering * clamp(Math.abs(vehicle.speed) / 12, 0, 1);
    vehicle.bumpDip = damp(vehicle.bumpDip ?? 0, 0, 5.5, delta);
    const speedFactor = clamp(Math.abs(vehicle.speed) / 40, 0, 1);
    vehicle.wheels?.forEach((wheel, wheelIndex) => {
      wheel.pivot.rotation.y = wheel.front ? -steerVisual * 0.42 : 0;
      wheel.pivot.rotation.x += (vehicle.speed * delta) / 0.52;
      // Suspension travel: road jitter at speed, corner compression from
      // body lean, and a dip that absorbs collision impacts.
      const side = wheel.pivot.position.x >= 0 ? 1 : -1;
      const roadNoise = Math.sin(this.elapsed * 16 + wheelIndex * 1.9 + vehicle.group.position.x * 0.4) * speedFactor * 0.042;
      const leanCompression = clamp(-vehicle.group.rotation.z * side * 1.2, -0.07, 0.07);
      wheel.pivot.position.y = 0.58 + roadNoise + leanCompression + vehicle.bumpDip;
    });
    if (vehicle.tailMaterial) {
      vehicle.tailMaterial.emissiveIntensity = damp(vehicle.tailMaterial.emissiveIntensity, braking ? 3.4 : 0.95, 10, delta);
    }
    const targetLean = -steering * clamp(Math.abs(vehicle.speed) / 38, 0, 1) * (handbrake ? 0.095 : 0.055);
    const targetPitch = braking ? -0.035 : clamp(throttle, 0, 1) * (boost ? 0.035 : 0.02);
    vehicle.group.rotation.z = damp(vehicle.group.rotation.z, targetLean, 6, delta);
    vehicle.group.rotation.x = damp(vehicle.group.rotation.x, targetPitch, 6, delta);
    // Staged damage: past 40 the engine bay smokes, past 80 the car limps.
    if (vehicle.damage > 40 && !vehicle.smoke) {
      const smoke = new THREE.Group();
      for (let i = 0; i < 3; i += 1) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(0.4 + i * 0.26, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        puff.position.set(0, 1.05 + i * 0.5, 2.4);
        puff.scale.y = 1.3;
        smoke.add(puff);
      }
      vehicle.smoke = smoke;
      vehicle.group.add(smoke);
      this.emitToast('Seraph damaged', 'Collision impact registered — watch the engine.', 'danger');
    }
    if (vehicle.smoke) {
      const time = this.elapsed;
      vehicle.smoke.children.forEach((puff, index) => {
        puff.position.y = 1.05 + index * 0.5 + Math.sin(time * 2.4 + index * 1.7) * 0.14;
        const severity = clamp(vehicle.damage / 110, 0.3, 1);
        (puff as THREE.Mesh).scale.setScalar(1 + Math.sin(time * 3.1 + index) * 0.12);
        ((puff as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.1 + severity * 0.1;
      });
    }
    // Total loss: the engine dies, the bay catches, the driver is thrown out.
    if (vehicle.damage >= 110 && !vehicle.wrecked) this.wreckVehicle(vehicle);
    this.player.position.copy(vehicle.group.position);
    this.audio.setEngine(vehicle.wrecked ? 0 : vehicle.speed, true);
  }

  private clampWorld(position: THREE.Vector3, margin = 2) {
    const edge = WORLD_SIZE / 2 - margin;
    position.x = clamp(position.x, -edge, edge);
    position.z = clamp(position.z, -edge, edge);
  }

  private coverFaceVector = new THREE.Vector3();
  private coverFace: THREE.Vector3 | null = null;

  // Nearest collision face within arm's reach, as a unit normal pointing from
  // the surface toward the player. Axis-aligned boxes give axis normals;
  // dynamic obstacles (cars) give radial normals.
  private findCoverFace() {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    let best = 1.6;
    let nx = 0;
    let nz = 0;
    for (const box of this.collisionBoxes) {
      const cx = clamp(px, box.min.x, box.max.x);
      const cz = clamp(pz, box.min.z, box.max.z);
      const dx = px - cx;
      const dz = pz - cz;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.01 && dist < best) {
        best = dist;
        nx = dx / dist;
        nz = dz / dist;
      }
    }
    for (const obstacle of this.dynamicObstacles ?? []) {
      const dx = px - obstacle.x;
      const dz = pz - obstacle.z;
      const dist = Math.hypot(dx, dz) - obstacle.radius;
      if (dist > 0.01 && dist < best) {
        best = dist;
        const radial = Math.hypot(dx, dz) || 1;
        nx = dx / radial;
        nz = dz / radial;
      }
    }
    if (!best || best >= 1.6) return null;
    this.coverFaceVector.set(nx, 0, nz).normalize();
    return this.coverFaceVector;
  }

  // floorY enables height-aware collision: boxes whose tops sit at or below
  // the mover's feet (plus step tolerance) don't block — the basis for
  // vaulting and standing on low cover. Actors/vehicles pass no floor and
  // collide exactly as before.
  private collides(x: number, z: number, radius: number, floorY = -Infinity) {
    const unbounded = floorY === -Infinity;
    const blocked = this.collisionBoxes.some((box) =>
      box !== this.vaultIgnore
      && (unbounded || box.max.y > floorY + 0.42)
      && (unbounded || box.min.y < floorY + 1.9)
      && x + radius > box.min.x && x - radius < box.max.x && z + radius > box.min.z && z - radius < box.max.z,
    );
    if (blocked) return true;
    const obstacles = this.dynamicObstacles;
    if (!obstacles) return false;
    for (const obstacle of obstacles) {
      const combined = radius + obstacle.radius;
      const dx = x - obstacle.x;
      const dz = z - obstacle.z;
      if (dx * dx + dz * dz < combined * combined) return true;
    }
    return false;
  }

  // The ground plane under a point: the highest collider top the mover
  // could realistically be standing on (within step reach of currentY).
  // Stair shafts/undercroft mouths remove the implicit street floor — the
  // mover falls through them onto the steps below.
  private inGroundHole(x: number, z: number) {
    return this.groundHoles.some((b) => x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z);
  }

  private groundHeightAt(x: number, z: number, currentY: number) {
    // Below grade (undercroft/vestibule) or inside a registered shaft the
    // street plane doesn't apply — seed from negative space so sunken
    // floors can ground the mover.
    let ground = (currentY < -0.4 || this.inGroundHole(x, z)) ? -Infinity : 0;
    for (const box of this.collisionBoxes) {
      if (x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z
        && box.max.y <= currentY + 0.45 && box.max.y > ground && box.max.y < 2.2) {
        ground = box.max.y;
      }
    }
    return ground === -Infinity ? currentY : ground;
  }

  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3) {
    return this.firstWorldObstruction(from, to) === null;
  }

  // Body discovery: an unaware patrol that gets eyes on a corpse walks the
  // find like a noise — investigate point at the body, suspicion climbing.
  // First spotter radios it in; each actor only notices a body once.
  private corpseStimulus(actor: Actor) {
    if (!this.corpses?.length) return undefined;
    const eye = this.tmpLosFrom.copy(actor.group.position).setY(actor.group.position.y + 1.55);
    for (const body of this.corpses) {
      if (body.noticedBy.has(actor.id) || !body.group.visible) continue;
      const dx = body.group.position.x - actor.group.position.x;
      const dz = body.group.position.z - actor.group.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 11 || distance < 0.4) continue;
      const forward = this.tmpActorFwd2.set(Math.sin(actor.group.rotation.y), 0, Math.cos(actor.group.rotation.y));
      if ((forward.x * dx + forward.z * dz) / distance < 0.1) continue;
      if (this.firstWorldObstruction(eye, this.tmpLosTo.copy(body.group.position).setY(0.6))) continue;
      body.noticedBy.add(actor.id);
      if (!body.reported) {
        body.reported = true;
        this.radioSignals.push({
          squadId: 'choir-wardens',
          senderId: actor.id,
          sequence: this.radioSeq++,
          targetPosition: { x: body.group.position.x, y: body.group.position.y, z: body.group.position.z },
          confidence: 0.75,
          threat: 'damage',
        });
        this.audio.radioBark?.(actor.group.position, this.player.position, this.cameraYaw, false);
      }
      return {
        position: { x: body.group.position.x, y: body.group.position.y, z: body.group.position.z },
        distanceMeters: distance,
        loudness: 0.62,
      };
    }
    return undefined;
  }

  private firstWorldObstruction(from: THREE.Vector3, to: THREE.Vector3, padding = 0) {
    const delta = (this.losDelta ??= new THREE.Vector3()).copy(to).sub(from);
    const distance = delta.length();
    if (distance < 0.000001) return null;
    const ray = this.losRay ??= new THREE.Ray();
    ray.origin.copy(from);
    ray.direction.copy(delta).divideScalar(distance);
    const hit = this.losHit ??= new THREE.Vector3();
    let nearest: THREE.Vector3 | null = null;
    let nearestDistanceSq = distance * distance;
    const expanded = this.losBox ??= new THREE.Box3();
    for (const collider of this.collisionBoxes) {
      const box = padding > 0 ? expanded.copy(collider).expandByScalar(padding) : collider;
      if (box.containsPoint(from)) return from.clone();
      if (ray.intersectBox(box, hit)) {
        const distanceSq = hit.distanceToSquared(from);
        if (distanceSq <= nearestDistanceSq) {
          nearestDistanceSq = distanceSq;
          nearest = hit.clone();
        }
      }
    }
    return nearest;
  }

  private constrainCamera(focus: THREE.Vector3) {
    // Correct after smoothing so the interpolated position cannot remain behind cover.
    const hit = this.firstWorldObstruction(focus, this.camera.position, 0.25);
    if (hit) this.camera.position.copy(hit).lerp(focus, 0.001);
  }

  private npcCoverCandidates(actor: Actor, target: THREE.Vector3) {
    const away = actor.group.position.clone().sub(target).setY(0);
    if (away.lengthSq() < 0.001) away.set(0, 0, 1);
    away.normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const options = [
      actor.group.position.clone().addScaledVector(side, 5.5),
      actor.group.position.clone().addScaledVector(side, -5.5),
      actor.group.position.clone().addScaledVector(away, 4.5),
    ];
    return options
      .map((position, index) => ({
        id: `${actor.id}-cover-${index}`,
        position: { x: position.x, y: position.y, z: position.z },
        distanceMeters: actor.group.position.distanceTo(position),
        exposure: clamp(position.distanceTo(target) / 42, 0.12, 0.92),
        routeCost: this.collides(position.x, position.z, 0.75, position.y) ? 1 : 0.18,
        flankQuality: index === 2 ? 0.35 : 0.72,
      }))
      .filter((candidate) => candidate.routeCost < 1);
  }

  private beginCinematic(focus?: THREE.Vector3) {
    if (this.settings.reducedMotion || this.cinematic) return;
    const target = this.missionTarget();
    this.cinematic = {
      start: this.renderTime,
      duration: 3.8,
      focus: focus ?? (target ? new THREE.Vector3(target.x, 0, target.z) : this.player.position.clone()),
    };
  }

  // Photo mode free cam: the world is frozen upstream in updateGame, so
  // this owns the camera outright. Move keys fly along the view direction
  // (pitch included — it's a fly cam, not a walk), jump/crouch ride the
  // vertical, sprint is the boost, and the wheel narrows the lens.
  private updatePhotoCamera(delta: number) {
    const yaw = this.cameraYaw;
    const pitch = this.cameraPitch;
    const cosPitch = Math.cos(pitch);
    const forward = (this.camForward ??= new THREE.Vector3()).set(
      -Math.sin(yaw) * cosPitch, -Math.sin(pitch), -Math.cos(yaw) * cosPitch,
    );
    const right = (this.camRight ??= new THREE.Vector3()).set(Math.cos(yaw), 0, -Math.sin(yaw));
    let ix = 0;
    let iz = 0;
    if (this.isActionHeld('moveForward')) iz += 1;
    if (this.isActionHeld('moveBackward')) iz -= 1;
    if (this.isActionHeld('moveRight')) ix += 1;
    if (this.isActionHeld('moveLeft')) ix -= 1;
    ix += (this.gamepadAxes?.moveX ?? 0) + (this.touchMove?.x ?? 0);
    iz -= (this.gamepadAxes?.moveY ?? 0) + (this.touchMove?.y ?? 0);
    let iy = 0;
    if (this.isActionHeld('jump')) iy += 1;
    if (this.isActionHeld('crouch')) iy -= 1;
    const boost = this.isActionHeld('sprint') ? 3.4 : 1;
    const speed = 11 * boost;
    this.photoCamPos.addScaledVector(forward, iz * speed * delta);
    this.photoCamPos.addScaledVector(right, ix * speed * delta);
    this.photoCamPos.y += iy * speed * delta;
    const bound = WORLD_SIZE / 2 - 2;
    this.photoCamPos.x = clamp(this.photoCamPos.x, -bound, bound);
    this.photoCamPos.z = clamp(this.photoCamPos.z, -bound, bound);
    this.photoCamPos.y = clamp(this.photoCamPos.y, -2.5, 70);
    this.camera.position.copy(this.photoCamPos);
    const look = (this.camLook ??= new THREE.Vector3()).copy(this.photoCamPos).addScaledVector(forward, 12);
    this.camera.lookAt(look);
    this.camera.fov = damp(this.camera.fov, this.photoFov, 8, delta);
    this.camera.updateProjectionMatrix();
    if (this.inspectionKey) {
      this.inspectionKey.position.copy(this.photoCamPos).addScaledVector(forward, 2.2);
      this.inspectionKey.position.y += 0.6;
      this.inspectionKey.intensity = damp(this.inspectionKey.intensity, 26, 6, delta);
    }
  }

  private updateCamera(delta: number) {
    if (this.cinematic) {
      const t = clamp((this.renderTime - this.cinematic.start) / this.cinematic.duration, 0, 1);
      if (t >= 1 || this.photoMode) {
        this.cinematic = null;
      } else {
        const ease = 1 - Math.pow(1 - t, 3);
        const focus = this.cinematic.focus;
        const playerFocus = this.player.position.clone().add(new THREE.Vector3(0, 1.7, 0));
        const angle = this.cameraYaw + (1 - ease) * 1.35;
        const distance = 36 - ease * 26.5;
        const height = 24 - ease * 18.5;
        const desiredCamera = new THREE.Vector3(
          focus.x + Math.sin(angle) * distance,
          height,
          focus.z + Math.cos(angle) * distance,
        );
        this.camera.position.lerp(desiredCamera, 1 - Math.exp(-3.2 * delta));
        this.constrainCamera(focus.clone().add(new THREE.Vector3(0, 2, 0)));
        const lookTarget = focus.clone().lerp(playerFocus, ease);
        lookTarget.y = Math.max(1.8, lookTarget.y);
        this.camera.lookAt(lookTarget);
        this.camera.fov = damp(this.camera.fov, 56, 4.5, delta);
        this.camera.updateProjectionMatrix();
        return;
      }
    }
    const targetPosition = this.currentVehicle ? this.currentVehicle.group.position : this.player.position;
    const speed = this.currentVehicle ? Math.abs(this.currentVehicle.speed) : Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const stanceOffset = !this.currentVehicle && (this.crouching || this.slideRemaining > 0) ? -0.42 : 0;
    if (this.photoMode) return;
    // Death cam: a slow rising orbit around the body before the game-over
    // screen takes over.
    if (this.deathCamTimer > 0) {
      const body = this.currentVehicle?.group.position ?? this.player.position;
      const t = 2.4 - this.deathCamTimer;
      const angle = this.cameraYaw + 0.6 + t * 0.42;
      const radius = 6.2 + t * 1.6;
      const desiredDeath = new THREE.Vector3(
        body.x + Math.sin(angle) * radius,
        body.y + 2.6 + t * 1.9,
        body.z + Math.cos(angle) * radius,
      );
      this.camera.position.lerp(desiredDeath, 1 - Math.exp(-4.5 * delta));
      this.camera.lookAt(body.x, body.y + 1.1, body.z);
      this.camera.fov = damp(this.camera.fov, 42, 3, delta);
      this.camera.updateProjectionMatrix();
      return;
    }
    // Bonnet cam: hood-height first-person driving. Free look via the
    // normal yaw/pitch; holding crouch snaps the view to the mirror.
    if (this.bonnetCam && this.currentVehicle) {
      const vehicle = this.currentVehicle;
      const lookBackBonnet = this.isActionHeld('crouch');
      const hoodYaw = lookBackBonnet ? vehicle.heading + Math.PI : this.cameraYaw;
      const forwardHood = new THREE.Vector3(-Math.sin(hoodYaw), 0, -Math.cos(hoodYaw));
      const hoodPos = this.tmpMove.set(
        vehicle.group.position.x - Math.sin(vehicle.heading) * 1.55,
        vehicle.group.position.y + 1.62,
        vehicle.group.position.z - Math.cos(vehicle.heading) * 1.55,
      );
      this.camera.position.lerp(hoodPos, 1 - Math.exp(-22 * delta));
      const hoodTarget = hoodPos.clone().addScaledVector(forwardHood, 8);
      hoodTarget.y -= Math.sin(this.cameraPitch) * 6;
      this.camera.lookAt(hoodTarget);
      this.applyCameraShake(delta);
      const hoodFov = clamp(this.settings?.fov ?? 56, 48, 78) + clamp(Math.abs(vehicle.speed) * 0.34, 0, 14);
      this.camera.fov = damp(this.camera.fov, hoodFov, 5, delta);
      this.camera.updateProjectionMatrix();
      return;
    }
    const aiming = !this.currentVehicle && this.isAiming();
    // Look-back: hold crouch (R3 / C) while driving to face the chase.
    const lookBack = Boolean(this.currentVehicle) && this.isActionHeld('crouch');
    const yaw = lookBack ? this.cameraYaw + Math.PI : this.cameraYaw;
    const distance = this.currentVehicle ? 10.5 + speed * 0.065 : aiming ? 3.15 : 4.55;
    const height = this.currentVehicle ? 4.4 : aiming ? 1.9 : 2.65;
    const forward = (this.camForward ??= new THREE.Vector3()).set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = (this.camRight ??= new THREE.Vector3()).set(Math.cos(yaw), 0, -Math.sin(yaw));
    if (this.currentVehicle && Math.abs(this.gamepadAxes.lookX) < 0.1 && !this.pointerLocked) {
      this.cameraYaw = damp(this.cameraYaw, this.currentVehicle.heading, 1.8, delta);
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    }
    const desiredCamera = (this.camDesired ??= new THREE.Vector3()).copy(targetPosition).addScaledVector(forward, -distance);
    this.shoulderOffset = damp(this.shoulderOffset ?? 0.78, 0.78 * (this.shoulderSide ?? 1), 10, delta);
    if (aiming) desiredCamera.addScaledVector(right, this.shoulderOffset);
    // Cover peek: while aiming from cover the camera slides along the wall
    // tangent — a readable lean instead of full exposure.
    this.peekLean = damp(this.peekLean ?? 0, this.coverFace && aiming ? 1 : 0, 8, delta);
    if (this.peekLean > 0.01 && this.coverFace) {
      const tangent = this.tmpMove.set(-this.coverFace.z, 0, this.coverFace.x);
      if (tangent.dot(right) * (this.shoulderSide ?? 1) < 0) tangent.negate();
      desiredCamera.addScaledVector(tangent, this.peekLean * 0.62);
    }
    this.landDip = damp(this.landDip ?? 0, 0, 9.5, delta);
    this.hurtKick = damp(this.hurtKick ?? 0, 0, 8, delta);
    const bob = !this.settings?.reducedMotion && !this.currentVehicle && this.grounded && this.slideRemaining <= 0
      ? Math.sin((this.walkPhase ?? 0) * 2) * 0.026 * clamp(speed / 9, 0, 1)
      : 0;
    desiredCamera.y += height + stanceOffset * 0.55 + this.cameraPitch * 5.5 + bob - this.landDip;
    this.camera.position.lerp(desiredCamera, 1 - Math.exp(-9 * delta));
    this.constrainCamera((this.camConstrain ??= new THREE.Vector3()).copy(targetPosition).setY(targetPosition.y + 1.6 + stanceOffset));
    const lookTarget = (this.camLook ??= new THREE.Vector3()).copy(targetPosition).setY(targetPosition.y + (this.currentVehicle ? 1.1 : (aiming ? 1.52 : 1.6) + stanceOffset));
    if (this.peekLean > 0.01 && this.coverFace) {
      const tangent = this.tmpMove.set(-this.coverFace.z, 0, this.coverFace.x);
      if (tangent.dot(right) * (this.shoulderSide ?? 1) < 0) tangent.negate();
      lookTarget.addScaledVector(tangent, this.peekLean * 0.4);
    }
    lookTarget.addScaledVector(forward, (aiming ? 7 : 3.25) + this.cameraPitch * 2);
    lookTarget.y += bob * 0.6 - this.landDip * 0.4;
    if (this.hurtKick > 0.01) {
      lookTarget.addScaledVector(right, Math.sin(this.damageDirection ?? 0) * this.hurtKick * 1.15);
      lookTarget.y -= this.hurtKick * 0.4;
    }
    this.camera.lookAt(lookTarget);
    this.applyCameraShake(delta);
    const baseFov = clamp(this.settings?.fov ?? 56, 48, 78);
    const sprintKick = !this.currentVehicle && !aiming && (this.playerSprinting ?? false) ? 3.2 : 0;
    const targetFov = this.currentVehicle ? baseFov + 2 + clamp(speed * 0.28, 0, 12) : aiming ? baseFov * 0.875 : baseFov + sprintKick;
    this.camera.fov = damp(this.camera.fov, targetFov, 4.5, delta);
    this.camera.updateProjectionMatrix();
    if (this.inspectionKey && !this.currentVehicle) {
      const desiredLight = (this.camLight ??= new THREE.Vector3()).copy(this.camera.position).lerp(targetPosition, 0.12);
      desiredLight.y += 0.72;
      this.inspectionKey.position.lerp(desiredLight, 1 - Math.exp(-8 * delta));
      this.inspectionKey.intensity = damp(this.inspectionKey.intensity, aiming ? 20 : 12, 5, delta);
    } else if (this.inspectionKey) {
      this.inspectionKey.intensity = damp(this.inspectionKey.intensity, 0, 5, delta);
    }
  }

  private addTrauma(amount: number) {
    this.shakeTrauma = clamp(this.shakeTrauma + amount, 0, 1);
  }

  // Trauma-squared shake after lookAt — damage, blasts, crashes and hard
  // landings kick the frame. Decays fast, respects reduced motion.
  private applyCameraShake(delta: number) {
    if (this.shakeTrauma <= 0) return;
    this.shakeTrauma = Math.max(0, this.shakeTrauma - delta * 1.6);
    if (this.settings?.reducedMotion) return;
    const amp = this.shakeTrauma * this.shakeTrauma;
    const t = this.elapsed * 31;
    this.camera.rotation.x += Math.sin(t * 1.13) * amp * 0.017;
    this.camera.rotation.y += Math.sin(t * 0.91 + 1.7) * amp * 0.017;
    this.camera.rotation.z += Math.sin(t * 1.29 + 3.4) * amp * 0.022;
  }

  private updateWeaponSway(delta: number) {
    const mount = this.player?.userData.weapon as THREE.Object3D | undefined;
    if (!mount || this.currentVehicle) {
      this.prevCameraYaw = this.cameraYaw;
      this.prevCameraPitch = this.cameraPitch;
      return;
    }
    if (!mount.userData.restRotation) {
      mount.userData.restRotation = mount.rotation.clone();
      mount.userData.restPosition = mount.position.clone();
    }
    if (!mount.userData.restPosition) mount.userData.restPosition = mount.position.clone();
    const rest = mount.userData.restRotation as THREE.Euler;
    const restPosition = mount.userData.restPosition as THREE.Vector3;
    const lookYaw = clamp((this.cameraYaw - this.prevCameraYaw) * 2.4, -0.16, 0.16);
    const lookPitch = clamp((this.cameraPitch - this.prevCameraPitch) * 2.0, -0.12, 0.12);
    this.weaponSway.yaw = damp(this.weaponSway.yaw, -lookYaw, 11, delta);
    this.weaponSway.pitch = damp(this.weaponSway.pitch, lookPitch, 11, delta);
    this.weaponKick = Math.max(0, this.weaponKick - delta * 7.5);
    this.weaponInspect = Math.max(0, (this.weaponInspect ?? 0) - delta);
    // Swap flourish: the gun raises and tilts inward for a beat — reads as a
    // draw/inspect instead of an instant model pop.
    const inspect = this.weaponInspect > 0 ? Math.sin((1 - this.weaponInspect / 0.85) * Math.PI) : 0;
    const speedFactor = clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 9.5, 0, 1);
    const aimFactor = this.isAiming() ? 0.28 : 1;
    const bob = Math.sin((this.walkPhase ?? 0) * 2) * 0.028 * speedFactor * aimFactor;
    const kick = this.weaponKick * this.weaponKick;
    const aimPitch = -this.cameraPitch * 0.55;
    const worldUnits = this.weaponSwayParentScale.set(1, 1, 1);
    mount.parent?.getWorldScale(worldUnits);
    const localUnits = 1 / Math.max(0.001, Math.abs(worldUnits.x));
    mount.rotation.set(
      rest.x + (this.weaponSway.pitch * aimFactor + bob * 0.45 - kick * 0.16 + aimPitch) * (1 - inspect * 0.7) + inspect * 0.42,
      rest.y + this.weaponSway.yaw * aimFactor * (1 - inspect * 0.7) + inspect * 0.5,
      rest.z + (bob * 0.5 + kick * 0.05) * (1 - inspect * 0.7) + inspect * 0.34,
    );
    mount.position.set(
      restPosition.x + this.weaponSway.yaw * 0.05 * localUnits,
      restPosition.y + (bob * 0.05 - kick * 0.028 + inspect * 0.055) * localUnits,
      restPosition.z + (kick * 0.09 + inspect * 0.04) * localUnits,
    );
    this.prevCameraYaw = this.cameraYaw;
    this.prevCameraPitch = this.cameraPitch;
  }

  private updateActors(delta: number, time: number) {
    const playerPosition = this.currentVehicle?.group.position ?? this.player.position;
    const activeCombat = this.missionIndex >= 1 && this.missionIndex <= 5;
    const frameRadio = [...this.radioSignals];
    this.radioSignals = [];
    this.actors.forEach((actor, actorIndex) => {
      if (!actor.alive || !actor.group.visible) return;
      const distance = actor.group.position.distanceTo(playerPosition);
      actor.lod = distance;
      actor.cooldown -= delta;
      if ((actor.reloadTimer ?? 0) > 0) {
        actor.reloadTimer = Math.max(0, (actor.reloadTimer ?? 0) - delta);
        if (actor.reloadTimer === 0) actor.magAmmo = 12;
      }
      actor.damagePulse = Math.max(0, actor.damagePulse - delta);
      actor.hitReact = Math.max(0, (actor.hitReact ?? 0) - delta * 2.6);

      // Positional footsteps — a hunter you can hear before you see. Stride
      // accumulates from real movement so boots match the walk, not a timer.
      if (actor.kind !== 'drone' && distance < 34) {
        const moved = actor.prevX === undefined || actor.prevZ === undefined ? 0
          : Math.hypot(actor.group.position.x - actor.prevX, actor.group.position.z - actor.prevZ);
        actor.stepAccum = (actor.stepAccum ?? 0) + moved;
        const running = moved > 3.2 * delta;
        const stride = running ? 0.92 : 0.78;
        if (actor.stepAccum > stride) {
          actor.stepAccum = 0;
          const occluded = this.firstWorldObstruction(
            this.tmpLosFrom.copy(actor.group.position).setY(1.2),
            this.tmpLosTo.copy(playerPosition).setY(1.4),
          ) !== null;
          this.audio.npcFootstep?.(actor.group.position, playerPosition, this.cameraYaw, occluded, running);
        }
      }
      actor.prevX = actor.group.position.x;
      actor.prevZ = actor.group.position.z;

      if (actor.kind === 'civilian') {
        const posted = actor.posted === true && this.missionIndex === 0;
        const threatened = !posted && (actor.flee > 0 || (this.heat > 12 && distance < 22));
        if (threatened) {
          actor.flee = Math.max(actor.flee, 3.5);
          // A set heading wins over panic direction — the released civilians
          // take the north lane out instead of just scattering from Aurel.
          const away = actor.fleeHeading !== undefined
            ? this.tmpMove.set(Math.sin(actor.fleeHeading), 0, Math.cos(actor.fleeHeading))
            : this.tmpMove.copy(actor.group.position).sub(playerPosition).setY(0).normalize();
          this.moveActor(actor, away, actor.speed * 2.25, delta);
          actor.flee -= delta;
          if (actor.flee <= 0) delete actor.fleeHeading;
        } else if (posted) {
          // Tending loop: she faces the lamp — or Aurel while the delivery
          // exchange runs — and one arm keeps a slow wipe against the glass.
          const focus = (this.elapsed < (this.senaTalkingUntil ?? 0) || this.senaChoiceOpen)
            ? playerPosition
            : this.senaLamp;
          if (focus) {
            const dx = focus.x - actor.group.position.x;
            const dz = focus.z - actor.group.position.z;
            if (dx * dx + dz * dz > 0.04) {
              actor.group.rotation.y = Math.atan2(dx, dz);
            }
          }
          actor.group.position.x = actor.spawn.x + Math.sin(time * 0.32 + actorIndex) * 0.05;
          this.animateActorLod(actor, 0, delta);
          if (actor.rig) {
            const reach = Math.max(0, Math.sin(time * 0.9));
            actor.rig.arms[0].rotation.x = -0.35 - reach * 0.85;
            actor.rig.arms[0].rotation.z = -0.14;
          }
        } else if (actor.vignette === 'talk') {
          // Conversation loop: face partner, gesture sway, occasional blip.
          actor.group.position.y = Math.sin(time * 1.6 + actorIndex) * 0.015;
          actor.wanderAngle += delta * 0.1;
          actor.vignetteTimer = (actor.vignetteTimer ?? seeded(actorIndex, 131) * 6) - delta;
          if (actor.vignetteTimer <= 0) {
            actor.vignetteTimer = 2.4 + seeded(actorIndex + Math.floor(time), 132) * 4.5;
            if (distance < 42) {
              const occluded = this.firstWorldObstruction(
                this.tmpMove.copy(actor.group.position).setY(1.5),
                this.tmpActorFwd.copy(playerPosition).setY(1.6),
              ) !== null;
              this.audio.pedestrianBlip(actor.group.position, playerPosition, this.cameraYaw, occluded);
            }
          }
          this.animateActorLod(actor, 0, delta);
        } else if (actor.vignette === 'run') {
          // Street event: a citizen hurrying somewhere — or from something.
          // Bursts of speed, periodic heading changes, occasional look-backs.
          actor.vignetteTimer = (actor.vignetteTimer ?? 2) - delta;
          if (actor.vignetteTimer <= 0) {
            actor.vignetteTimer = 1.8 + seeded(actorIndex + Math.floor(time * 0.7), 136) * 3.4;
            actor.wanderAngle += (seeded(actorIndex + Math.floor(time), 137) - 0.5) * 2.4;
          }
          const glance = Math.sin(time * 2.7 + actorIndex * 1.7) > 0.82;
          this.moveActor(actor, this.tmpMove.set(
            Math.sin(actor.wanderAngle + (glance ? 0.4 : 0)), 0,
            Math.cos(actor.wanderAngle + (glance ? 0.4 : 0)),
          ), actor.speed * (glance ? 1.35 : 1.9), delta);
        } else if (actor.vignette === 'idle' || actor.vignette === 'lean') {
          // Standing life: weight-shift sway, head-look drift, and occasional
          // full-body glances — a slow noisy turn instead of a frozen stance.
          actor.group.position.x = actor.spawn.x + Math.sin(time * 0.4 + actorIndex) * 0.08;
          actor.wanderAngle += delta * 0.06;
          actor.vignetteTimer = (actor.vignetteTimer ?? seeded(actorIndex, 141) * 7) - delta;
          if (actor.vignetteTimer <= 0) {
            actor.vignetteTimer = 4.5 + seeded(actorIndex + Math.floor(time * 0.4), 142) * 6;
            actor.hitReactSide = (seeded(actorIndex + Math.floor(time), 143) - 0.5) * 2;
          }
          // Ease toward the occasional glance direction.
          const glance = Math.max(0, 1 - (actor.vignetteTimer ?? 0) / 1.2);
          actor.group.rotation.y += (actor.hitReactSide ?? 0) * glance * 0.45 * delta;
          this.animateActorLod(actor, 0, delta);
        } else {
          actor.wanderAngle += Math.sin(time * 0.18 + actorIndex) * delta * 0.12;
          this.moveActor(actor, this.tmpMove.set(Math.sin(actor.wanderAngle), 0, Math.cos(actor.wanderAngle)), actor.speed * 0.42, delta);
        }
        return;
      }

      if (actor.kind === 'drone') {
        const shouldAttack = this.heatTierValue() >= 2 || (this.missionIndex === 5 && distance < 64);
        actor.group.position.y = actor.spawn.y + Math.sin(time * 1.4 + actorIndex) * 1.1;
        actor.group.rotation.z += delta * 0.65;
        if (shouldAttack && distance < 72) {
          const direction = this.tmpMove.copy(playerPosition).sub(actor.group.position).setY(0).normalize();
          this.moveActor(actor, direction, distance > 18 ? actor.speed : -actor.speed * 0.35, delta);
          actor.group.lookAt(playerPosition.x, actor.group.position.y, playerPosition.z);
          if (actor.cooldown <= 0 && distance < 48) {
            this.enemyFire(actor, 7);
            actor.cooldown = (1.45 + seeded(actorIndex + Math.floor(time), 90) * 0.7) * this.ngFireScale();
          }
        } else {
          actor.wanderAngle += delta * 0.25;
          actor.group.position.x = actor.spawn.x + Math.cos(actor.wanderAngle) * 7;
          actor.group.position.z = actor.spawn.z + Math.sin(actor.wanderAngle) * 7;
          // Scan pulse: brighter while a civilian is inside the cone radius.
          const scan = actor.group.children[3] as THREE.Mesh | undefined;
          const scanMaterial = scan?.material as THREE.MeshBasicMaterial | undefined;
          if (scanMaterial) {
            let nearestCivilian = 99;
            for (const other of this.actors) {
              if (other.kind !== 'civilian' || !other.alive) continue;
              const dx = other.group.position.x - actor.group.position.x;
              const dz = other.group.position.z - actor.group.position.z;
              const d = Math.hypot(dx, dz);
              if (d < nearestCivilian) nearestCivilian = d;
            }
            const target = nearestCivilian < 7 ? 0.16 : 0.045;
            scanMaterial.opacity = target + Math.sin(time * 3.4 + actorIndex) * 0.018;
          }
        }
        return;
      }

      const hostile = actor.kind === 'boss' || activeCombat || this.heat > 6;
      if (actor.aiState) {
        const actorPosition = actor.group.position;
        const toPlayer = this.tmpToPlayer.copy(playerPosition).sub(actorPosition).setY(0);
        const playerDirection = this.tmpPlayerDir.copy(toPlayer).normalize();
        const actorForward = this.tmpActorFwd.set(Math.sin(actor.group.rotation.y), 0, Math.cos(actor.group.rotation.y));
        const target = hostile && distance < 96 ? {
          position: { x: playerPosition.x, y: playerPosition.y + 1.4, z: playerPosition.z },
          distanceMeters: distance,
          viewAlignment: actorForward.dot(playerDirection),
          inLineOfSight: this.hasLineOfSight(
            this.tmpLosFrom.copy(actorPosition).setY(actorPosition.y + 1.55),
            this.tmpLosTo.copy(playerPosition).setY(playerPosition.y + 1.4),
          ),
          visibility: (this.veilActive && distance > 8 ? 0.18 : 1) * (this.crouching ? 0.45 : 1),
          movement: clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 10.5, 0, 1),
        } : undefined;
        const sound = hostile && this.elapsed - this.lastCombat < 1.35 ? {
          position: { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z },
          distanceMeters: distance,
          // Baffled fire carries half as far through the net.
          loudness: this.ownedUpgrades?.has('shroud') ? 0.45 : 0.9,
        } : undefined;
        // A body in the patrol's view reads as a stimulus — investigate the
        // corpse, climb suspicion, first spotter radios the squad.
        const corpsePing = !sound && actor.aiState.phase !== 'combat'
          ? this.corpseStimulus(actor)
          : undefined;
        const aiStep = stepNpcAi(actor.aiState, {
          deltaSeconds: delta,
          position: { x: actorPosition.x, y: actorPosition.y, z: actorPosition.z },
          health: actor.health,
          maxHealth: actor.maxHealth,
          target,
          sound: sound ?? corpsePing,
          damage: actor.lastDamageAmount > 0 ? {
            amount: actor.lastDamageAmount,
            sourcePosition: { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z },
          } : undefined,
          underFire: actor.damagePulse > 0,
          needsReload: (actor.reloadTimer ?? 0) > 0,
          coverCandidates: hostile ? this.npcCoverCandidates(actor, playerPosition) : [],
          radioSignals: frameRadio,
        });
        actor.aiState = aiStep.state;
        actor.lastDamageAmount = 0;
        if (actor.shieldMesh) {
          // Pulse-staggered plate: dips and flares while the brace is open.
          const shieldDown = (actor.shieldDownUntil ?? 0) > this.elapsed;
          actor.shieldMesh.position.y = damp(actor.shieldMesh.position.y, shieldDown ? 0.58 : 1.32, 8, delta);
          (actor.shieldMesh.material as THREE.MeshStandardMaterial).emissiveIntensity = shieldDown ? 1.5 : 0.22;
        }
        if (aiStep.emittedRadio) {
          frameRadio.push(aiStep.emittedRadio);
          // The squad net audible: a bark when a warden calls in contact.
          if (distance < 48) {
            const occluded = this.firstWorldObstruction(
              this.tmpMove.copy(actorPosition).setY(1.5),
              this.tmpLosTo.copy(playerPosition).setY(1.6),
            ) !== null;
            this.audio.radioBark?.(actorPosition, playerPosition, this.cameraYaw, occluded);
          }
        }

        const destination = aiStep.decision.destination
          ? this.tmpDestination.set(aiStep.decision.destination.x, actorPosition.y, aiStep.decision.destination.z)
          : undefined;
        const aimTarget = aiStep.decision.aimTarget
          ? this.tmpAimTarget.set(aiStep.decision.aimTarget.x, actorPosition.y + 1.4, aiStep.decision.aimTarget.z)
          : playerPosition;
        if (aiStep.decision.action === 'engage') {
          const direction = toPlayer.lengthSq() > 0.001 ? playerDirection : this.tmpMove.set(0, 0, 1);
          const ideal = actor.kind === 'boss' ? 13 : 10;
          if (distance > ideal) this.moveActor(actor, direction, actor.speed, delta);
          else if (distance < ideal * 0.7) this.moveActor(actor, direction, -actor.speed * 0.45, delta);
          else this.animateActorLod(actor, 0, delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
          if (actor.cooldown <= 0 && aiStep.perception.targetSeen && distance < (actor.kind === 'boss' ? 42 : 31)) {
            this.enemyFire(actor, actor.kind === 'boss' ? 18 : actor.shielded ? 14 : 10);
            const bossCadence = this.bossPhase >= 2 ? 0.48 : 0.72;
            actor.cooldown = (actor.kind === 'boss' ? bossCadence : actor.shielded ? 2.1 : 1.2 + seeded(actorIndex + Math.floor(time), 91) * 0.9) * this.ngFireScale();
            const shockEvery = this.bossPhase >= 2 ? 2 : this.bossPhase === 1 ? 3 : 4;
            if (actor.kind === 'boss' && Math.floor(time) % shockEvery === 0) this.createShockwave(actor.group.position);
          }
        } else if (aiStep.decision.action === 'take-cover' && destination) {
          const direction = destination.sub(actorPosition).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * 1.15, delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
        } else if (aiStep.decision.action === 'react-to-damage') {
          const direction = this.tmpMove.copy(actorPosition).sub(aimTarget).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * 0.72, delta);
          actor.group.rotation.y = Math.atan2(-direction.x, -direction.z);
        } else if ((aiStep.decision.action === 'investigate' || aiStep.decision.action === 'search' || aiStep.decision.action === 'return') && destination) {
          const direction = destination.sub(actorPosition).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * (aiStep.decision.action === 'search' ? 0.78 : 0.58), delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
        } else if (actor.posted === true && this.missionIndex === 0) {
          // Cordon overwatch — no patrol-wander. Hold the post, square back
          // to the watched approach, rifle raised or at low ready per post.
          const holdYaw = actor.spawnYaw ?? actor.group.rotation.y;
          let yawDiff = holdYaw - actor.group.rotation.y;
          while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
          while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
          actor.group.rotation.y += yawDiff * Math.min(1, delta * 2.6);
          actor.group.position.x = actor.spawn.x + Math.sin(time * 0.3 + actorIndex) * 0.04;
          this.animateActorLod(actor, 0, delta);
          if (actor.rig) {
            actor.rig.arms[1].rotation.x = actor.overwatchAim ? -1.18 : -0.55;
            actor.rig.arms[1].rotation.z = -0.05;
            actor.rig.arms[0].rotation.x = actor.overwatchAim ? -0.38 : -0.2;
          }
        } else {
          actor.wanderAngle += Math.sin(time * 0.2 + actorIndex) * delta * 0.18;
          const offset = this.tmpMove.copy(actor.spawn).sub(actor.group.position).setY(0);
          const direction = offset.length() > 7
            ? offset.normalize()
            : offset.set(Math.sin(actor.wanderAngle), 0, Math.cos(actor.wanderAngle));
          this.moveActor(actor, direction, actor.speed * 0.34, delta);
        }
      }
    });
    this.radioSignals = frameRadio.slice(-48);
    this.audio.setIntensity(clamp(this.heat / 100 + (this.missionIndex === 5 ? 0.45 : 0), 0, 1));
    // The city bed breathes against the score — the Veil hushes it, combat
    // presses it up, calm streets sit at the baseline wash.
    this.audio.setCityBedLevel(this.veilActive ? 0.22 : clamp(0.42 + this.heat / 220 + (this.missionIndex === 5 ? 0.2 : 0), 0, 1));
  }

  private moveActor(actor: Actor, direction: THREE.Vector3, speed: number, delta: number) {
    const previous = this.tmpPrevPos.copy(actor.group.position);
    actor.group.position.addScaledVector(direction, speed * delta);
    this.clampWorld(actor.group.position, 4);
    if (actor.kind !== 'drone' && this.collides(actor.group.position.x, actor.group.position.z, 0.62, actor.group.position.y)) {
      actor.group.position.copy(previous);
      actor.wanderAngle += Math.PI * 0.63;
    }
    this.animateActorLod(actor, Math.abs(speed), delta);
  }

  // Animation LOD: distant actors animate at a reduced rate. The mixer
  // accepts arbitrary dt, so stepping with the accumulated delta keeps
  // the pose advancing smoothly at ~8 fps beyond 110 m, ~20 fps beyond 62 m.
  private animateActorLod(actor: Actor, speed: number, delta: number) {
    const distance = actor.lod ?? 0;
    const interval = distance > 110 ? 0.13 : distance > 62 ? 0.05 : 0;
    if (interval <= 0) {
      this.animateActor(actor, speed, delta);
      return;
    }
    actor.animBudget = (actor.animBudget ?? 0) + delta;
    if (actor.animBudget < interval) return;
    this.animateActor(actor, speed, actor.animBudget);
    actor.animBudget = 0;
  }

  private animateActor(actor: Actor, speed: number, delta: number) {
    const rig = actor.rig;
    if (!rig) return;
    rig.stride = damp(rig.stride, clamp(speed / Math.max(1, actor.speed), 0, 2.4), 8, delta);
    rig.phase += delta * (2.2 + speed * 1.45);
    const amplitude = Math.min(0.72, rig.stride * 0.42);
    rig.legs.forEach((leg, index) => {
      const side = index === 0 ? -1 : 1;
      leg.rotation.x = Math.sin(rig.phase) * amplitude * side;
      leg.rotation.z = side * Math.min(0.035, amplitude * 0.08);
    });
    rig.arms.forEach((arm, index) => {
      const side = index === 0 ? -1 : 1;
      arm.rotation.x = -Math.sin(rig.phase) * amplitude * side * 0.78;
      arm.rotation.z = side * (0.1 + Math.sin(this.elapsed * 0.9 + index) * 0.012);
    });
    rig.chest.rotation.y = Math.sin(rig.phase) * amplitude * 0.08;
    rig.chest.rotation.x = -0.08 + Math.sin(this.elapsed * 1.7 + rig.phase * 0.04) * 0.018;
    rig.head.rotation.y = Math.sin(this.elapsed * 0.55 + rig.phase * 0.1) * (actor.kind === 'civilian' ? 0.12 : 0.045);
    // Locational hit reaction: chest snaps back and twists away from the
    // shot's side, decaying over a third of a second.
    if (actor.hitReact && actor.hitReact > 0) {
      const snap = Math.sin(Math.min(1, actor.hitReact * 2.4) * Math.PI) * 0.55;
      rig.chest.rotation.x -= snap * 0.42;
      rig.chest.rotation.y += snap * (actor.hitReactSide ?? 0) * 0.5;
      rig.head.rotation.x = -snap * 0.3;
    }
  }

  /** Replayed missions tighten the Choir's trigger finger — up to 28% faster. */
  private ngFireScale() {
    return Math.max(0.72, 1 - this.replays * 0.08);
  }

  private enemyFire(actor: Actor, damage: number) {
    // A spent magazine starts the reload — the warden calls it and ducks.
    if (actor.magAmmo !== undefined && actor.magAmmo <= 0) {
      if ((actor.reloadTimer ?? 0) <= 0) {
        actor.reloadTimer = actor.kind === 'boss' ? 1.6 : 2.2;
        this.audio.radioBark?.(actor.group.position, this.player.position, this.cameraYaw, true);
      }
      return;
    }
    if (actor.magAmmo !== undefined) actor.magAmmo -= 1;
    const origin = actor.group.position.clone().add(new THREE.Vector3(0, actor.kind === 'drone' ? 0 : 1.6, 0));
    this.audio.enemyShot(origin, this.camera.position, this.cameraYaw, !this.hasLineOfSight(origin, this.camera.position));
    const target = (this.currentVehicle?.group.position ?? this.player.position).clone().add(new THREE.Vector3(0, 1.1, 0));
    const distance = origin.distanceTo(target);
    const baseAccuracy = actor.kind === 'boss' ? 0.84 : clamp(0.82 - distance / 140, 0.42, 0.78);
    // Dynamic accuracy: ambush opener bonus, suppression penalty, and the
    // per-shot burst bloom all ride on the AI state. The exact-shot hook
    // keeps the burst counter honest for fast-firing bosses.
    const accuracy = effectiveHitChance(baseAccuracy, npcAccuracyScale(actor.aiState));
    if (actor.aiState) actor.aiState = recordNpcShotFired(actor.aiState);
    const hits = seeded(Math.floor(this.elapsed * 17) + actor.id.length, 112) < accuracy;
    // Miss spread scales with range and current aim bloom so long shots read
    // as suppressing fire — and tracers get a per-kind signature color.
    const spread = (4 + distance * 0.14) * npcAimBloom(actor.aiState);
    const end = hits ? target : target.clone().add(new THREE.Vector3((seeded(actor.id.length, 113) - 0.5) * spread, 1 + seeded(actor.id.length, 115) * 2.4, (seeded(actor.id.length, 114) - 0.5) * spread));
    const obstruction = this.firstWorldObstruction(origin, end);
    const muzzle = origin.clone().addScaledVector(end.clone().sub(origin).normalize(), 0.55);
    this.createMuzzleFlash(muzzle);
    const tracerColor = actor.kind === 'boss' ? 0xff7a3c : actor.kind === 'drone' ? 0x9fd0ff : 0xd65a45;
    this.createTracer(origin, obstruction ?? end, tracerColor);
    // Wanted pressure: each heat tier sharpens the Choir's fire — tier 5
    // hits ~45% harder than a first-star patrol.
    const heatScale = 1 + this.heatTierValue() * 0.09;
    if (hits && !obstruction) this.takePlayerDamage(damage * heatScale * difficultyDamage(this.settings.difficulty), origin);
    // Near-miss snap: if the round's closest approach to the player's head is
    // within ~2.2m, crack a whiz from that direction — sells suppression even
    // when the shot never lands.
    if (!hits && (this.whizCooldown ?? 0) <= 0) {
      const head = (this.currentVehicle?.group.position ?? this.player.position).clone().add(new THREE.Vector3(0, 1.55, 0));
      const segment = (obstruction ?? end).clone().sub(origin);
      const t = clamp(head.clone().sub(origin).dot(segment) / Math.max(0.001, segment.lengthSq()), 0, 1);
      const closest = origin.clone().addScaledVector(segment, t);
      if (closest.distanceTo(head) < 2.2) {
        this.audio.bulletWhiz?.(closest, this.camera.position, this.cameraYaw);
        this.whizCooldown = 0.16;
      }
    }
  }

  private takePlayerDamage(amount: number, source?: THREE.Vector3) {
    if (this.invulnerability > 0 || this.gameOverSent) return;
    this.invulnerability = 0.16;
    this.addTrauma(clamp(amount * 0.014, 0.12, 0.45));
    // Cover blocks most fire arriving from beyond the held face. Aiming
    // peeks over/around it — exposed, but not fully.
    if (source && this.coverFace) {
      const position = this.currentVehicle?.group.position ?? this.player.position;
      const toSource = Math.hypot(source.x - position.x, source.z - position.z) || 1;
      const exposure = ((source.x - position.x) / toSource) * -this.coverFace.x
        + ((source.z - position.z) / toSource) * -this.coverFace.z;
      if (exposure > 0.35) amount *= this.isAiming() ? 0.62 : 0.35;
    }
    if (this.ownedUpgrades?.has('plating')) amount *= 0.78;
    if (source) {
      const position = this.currentVehicle?.group.position ?? this.player.position;
      const bearing = Math.atan2(source.x - position.x, source.z - position.z);
      const forwardBearing = Math.atan2(-Math.sin(this.cameraYaw), -Math.cos(this.cameraYaw));
      let relative = forwardBearing - bearing;
      while (relative > Math.PI) relative -= Math.PI * 2;
      while (relative < -Math.PI) relative += Math.PI * 2;
      this.damageDirection = relative;
      this.damageDirectionTimer = 1.15;
      // Physical jolt — the camera snaps a touch toward the hit side.
      if (!this.settings?.reducedMotion) this.hurtKick = Math.min(0.6, this.hurtKick + amount * 0.017);
    }
    const armorAbsorb = Math.min(this.armor, amount * 0.62);
    this.armor -= armorAbsorb;
    this.health = Math.max(0, this.health - (amount - armorAbsorb));
    this.damageFlash = 1;
    this.heroCharacter?.playOnce(this.health <= 0 ? 'death' : 'hit');
    this.audio.playerDamage();
    this.pulseGamepad(95, 0.62, 0.42);
    if (this.health <= 0 && !this.gameOverSent) {
      this.gameOverSent = true;
      this.mouseShootHeld = false;
      this.mouseAimHeld = false;
      this.aimToggled = false;
      this.audio.setEngine(0, false);
      // Death cam: brief orbit before the game-over screen, with a recap line
      // naming whatever fired the killing shot.
      this.deathCamTimer = 2.4;
      let killer = 'the city';
      if (source) {
        let best: Actor | null = null;
        let bestDistance = 9;
        for (const actor of this.actors ?? []) {
          if (!actor.alive || actor.kind === 'civilian') continue;
          const distance = actor.group.position.distanceTo(source);
          if (distance < bestDistance) { best = actor; bestDistance = distance; }
        }
        killer = best ? (best.kind === 'boss' ? 'the False Archon' : best.kind === 'drone' ? 'a sentry drone' : 'a Warden') : 'the city';
      }
      this.lastKiller = killer;
      this.emitToast('Aurel has fallen', `Slain by ${killer}`, 'danger');
    }
  }

  private tryShoot() {
    if (this.shotCooldown > 0 || this.paused || this.photoMode) return;
    // Reload cancel: pulling the trigger mid-reload with rounds left drops
    // the reload and fires — standard shooter behavior.
    if (this.reloading > 0) {
      if (this.ammo <= 0) return;
      this.reloading = 0;
    }
    const spec = this.activeWeaponSpec();
    if (this.ammo <= 0) {
      this.audio.empty();
      this.shotCooldown = 0.25;
      if (this.reserveAmmo > 0) this.startReload();
      return;
    }
    this.heroCharacter?.playOnce('fire', 0.045);
    this.ammo -= 1;
    if (this.ammo > 0 && this.ammo <= 3) this.audio.lowAmmo?.();
    this.statShots += spec.pellets;
    this.shotCooldown = shotIntervalSeconds(spec);
    this.weaponRecoil = addShotRecoil(this.weaponRecoil, spec);
    this.weaponKick = Math.min(1, this.weaponKick + (spec.pellets > 1 ? 0.85 : 0.55));
    this.cameraPitch = clamp(this.cameraPitch + (this.isAiming() ? spec.aimCameraKick : spec.hipCameraKick), -0.24, 0.74);
    this.audio.shoot(spec.id, this.ownedUpgrades?.has('shroud') === true);
    this.pulseGamepad(42, spec.pellets > 1 ? 0.8 : 0.46, spec.pellets > 1 ? 0.95 : 0.78);
    this.lastCombat = this.elapsed;

    const mount = this.player.userData.weapon as THREE.Object3D | undefined;
    const activeModel = mount?.children.find((child) => child.visible) ?? mount;
    const muzzleOffset = (activeModel?.userData.muzzle as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -0.47);
    // Drive-by: fire from the window line, hip-fire only with heavy spread.
    const driveBy = Boolean(this.currentVehicle);
    const origin = driveBy
      ? this.player.position.clone().add(new THREE.Vector3(0, 1.35, 0))
      : activeModel
        ? activeModel.localToWorld(muzzleOffset.clone())
        : this.player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
    this.createMuzzleFlash(origin);
    this.spawnCasing(origin);

    const movement = clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 10.5, 0, 1);
    const spread = shotSpreadRadians(
      { aiming: this.isAiming(), movement: Math.max(movement, driveBy ? 0.85 : 0), recoil: this.weaponRecoil },
      spec,
    ) * (driveBy ? 1.5 : 1);
    const ndcRadius = Math.tan(spread) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const raycaster = new THREE.Raycaster();
    raycaster.far = 130;
    let landedHit = false;
    for (let pellet = 0; pellet < spec.pellets; pellet += 1) {
      const shotOffset = deterministicShotOffset(this.shotIndex, ndcRadius);
      this.shotIndex += 1;
      raycaster.setFromCamera(new THREE.Vector2(shotOffset.x / Math.max(0.75, this.camera.aspect), shotOffset.y), this.camera);
      const hits = raycaster.intersectObjects(this.rayTargets, false);
      const hit = hits.find((candidate) => visibleInScene(candidate.object, this.scene));
      const end = hit?.point ?? this.camera.position.clone().add(raycaster.ray.direction.clone().multiplyScalar(110));
      const obstruction = this.firstWorldObstruction(origin, end);
      this.createTracer(origin, obstruction ?? end, spec.tracerColor);
      this.createImpact(obstruction ?? end, !obstruction && Boolean(hit?.object.userData.actorId));
      if (hit && !hit.object.userData.actorId && hit.face) {
        const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        this.placeDecal(hit.point, worldNormal);
      }
      if (hit && !hit.object.userData.actorId) {
        // Foley surface crack — material read off the prop tag, then the PBR
        // metalness, so lamps ring, glass tinks, everything else thuds. The
        // impact sits on the visible shot line, so it is never occluded.
        const hitMaterial = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        const surfaceKind = (hit.object.userData.surfaceKind as 'glass' | 'metal' | 'generic' | undefined)
          ?? (/glass/i.test(hitMaterial?.name ?? '') ? 'glass'
            : (hit.object.userData.trafficId !== undefined || (hitMaterial?.metalness ?? 0) > 0.6 ? 'metal' : 'generic'));
        this.audio.surfaceImpact?.(obstruction ?? hit.point, this.camera.position, this.cameraYaw, false, surfaceKind);
      }
      const lampIndex = hit && (hit.object.userData.lampGlow || hit.object.userData.lampPole) && hit.instanceId !== undefined
        ? (hit.object.userData.instanceIds as number[] | undefined)?.[hit.instanceId]
        : undefined;
      if (lampIndex !== undefined && !obstruction) this.killLamp(lampIndex, hit!.point);
      if (hit && hit.object.userData.windowPane && hit.instanceId !== undefined && !obstruction) {
        const paneMesh = hit.object as THREE.InstancedMesh;
        const hitsByMesh = (this.windowPaneHits ??= new Map());
        let originals = hitsByMesh.get(paneMesh);
        if (!originals) { originals = new Map(); hitsByMesh.set(paneMesh, originals); }
        if (!originals.has(hit.instanceId)) {
          const original = new THREE.Color();
          paneMesh.getColorAt(hit.instanceId, original);
          originals.set(hit.instanceId, original);
          paneMesh.setColorAt(hit.instanceId, this.windowDeadColor);
          if (paneMesh.instanceColor) paneMesh.instanceColor.needsUpdate = true;
        }
      }
      const trafficId = hit?.object.userData.trafficId as number | undefined;
      if (trafficId !== undefined && !obstruction) {
        const car = this.trafficCars[trafficId];
        if (car && !car.wrecked) {
          car.panic = 6;
          car.damage += weaponDamage(origin.distanceTo(hit!.point), false, false, spec);
          if (car.damage > 95) this.wreckTrafficCar(car);
        }
      }
      const actorId = hit?.object.userData.actorId as string | undefined;
      if (actorId && hit && !obstruction) {
        const actor = this.actors.find((candidate) => candidate.id === actorId);
        if (actor?.alive) {
          const critical = hit.object.name === 'head';
          this.damageActor(actor, weaponDamage(origin.distanceTo(hit.point), critical, actor.kind === 'boss', spec), critical);
          landedHit = true;
          this.statHits += 1;
          this.audio.hit(critical);
        }
      } else if (!actorId && this.actors) {
        // Suppression graze: a round that snaps within ~1.4m of a hostile's
        // chest spikes their underFire pulse — they flinch toward cover and
        // their aim cone blooms even though the pellet missed.
        const segEnd = obstruction ?? end;
        this.tmpShotSeg.copy(segEnd).sub(origin);
        const segLenSq = Math.max(0.001, this.tmpShotSeg.lengthSq());
        for (const actor of this.actors) {
          if (!actor.alive || actor.kind === 'civilian' || actor.damagePulse > 0.32) continue;
          const chestX = actor.group.position.x - origin.x;
          const chestY = actor.group.position.y + 1.3 - origin.y;
          const chestZ = actor.group.position.z - origin.z;
          const t = clamp((chestX * this.tmpShotSeg.x + chestY * this.tmpShotSeg.y + chestZ * this.tmpShotSeg.z) / segLenSq, 0, 1);
          const dx = chestX - this.tmpShotSeg.x * t;
          const dy = chestY - this.tmpShotSeg.y * t;
          const dz = chestZ - this.tmpShotSeg.z * t;
          if (dx * dx + dy * dy + dz * dz < 1.4 * 1.4) actor.damagePulse = Math.max(actor.damagePulse, 0.32);
        }
      }
    }
    if (landedHit) this.reticleHit = 1;
    // A gunshot empties the sidewalk: civilians within earshot scatter away
    // from the muzzle, and traffic within a block stamps the gas. Shroud
    // baffles shrink the report to a cough — nobody flinches.
    if (!this.ownedUpgrades?.has('shroud')) {
      this.actors?.forEach((actor) => {
        if (!actor.alive || actor.kind !== 'civilian') return;
        if (actor.posted === true && this.missionIndex === 0) return;
        if (actor.group.position.distanceTo(this.player.position) > 26) return;
        actor.flee = Math.max(actor.flee ?? 0, 6);
        actor.fleeHeading = Math.atan2(
          actor.group.position.x - this.player.position.x,
          actor.group.position.z - this.player.position.z,
        );
      });
      this.trafficCars?.forEach((car) => {
        if (car.wrecked) return;
        if (car.group.position.distanceTo(this.player.position) < 30) car.panic = Math.max(car.panic, 4);
      });
    }
    if (this.ammo === 0 && this.reserveAmmo > 0) this.emitToast('Magazine empty', `Press ${this.bindingLabel('reload')} or X to reload`, 'info');
  }

  private damageActor(actor: Actor, damage: number, critical = false) {
    const coilBoosted = this.ownedUpgrades?.has('coil') ? damage * 1.2 : damage;
    // Veil sneak strike: an unaware target (calm/suspicious, not yet in
    // combat) hit while the Veil is open takes a stealth multiplier.
    const unaware = actor.aiState && actor.aiState.phase !== 'combat';
    const sneak = this.veilActive && unaware && actor.kind !== 'civilian';
    let boosted = coilBoosted * (sneak ? 1.7 : 1);
    // Directional flinch: which side of the actor the hit came from.
    const toActor = Math.atan2(
      actor.group.position.x - this.player.position.x,
      actor.group.position.z - this.player.position.z,
    );
    let rel = toActor - actor.group.rotation.y;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    // Bulwark plate: frontal hits deflect — Pulse staggers, flanks, and
    // sneak angles are the counters, not raw DPS.
    const shieldUp = actor.shielded === true && (actor.shieldDownUntil ?? 0) < this.elapsed;
    const frontal = Math.abs(rel) > 2.05;
    if (shieldUp && frontal && !sneak) {
      boosted *= critical ? 0.42 : 0.2;
      this.audio.surfaceImpact(actor.group.position, this.player.position, this.cameraYaw, false, 'metal');
      if (this.hitDamageTimer <= 0 && boosted < 4) this.emitToast('Deflected', 'Plate armor — flank it, Veil past it, or Pulse it open', 'info');
    }
    actor.health -= boosted;
    if (this.hitDamageTimer <= 0) {
      this.hitDamagePool = 0;
      this.hitDamageSeq += 1;
    }
    this.hitDamagePool += boosted;
    this.hitDamageTimer = 0.85;
    actor.lastDamageAmount = Math.max(actor.lastDamageAmount, boosted);
    actor.damagePulse = Math.max(actor.damagePulse, critical ? 0.75 : 0.48);
    actor.hitReactSide = Math.sin(rel);
    actor.hitReact = Math.max(actor.hitReact ?? 0, critical ? 0.5 : 0.3);
    actor.lastHitAngle = toActor;
    actor.lastHitCritical = critical;
    actor.materials.forEach((material) => {
      const original = material.emissive.clone();
      material.emissive.setHex(critical ? 0xffd98a : 0xa9382d);
      material.emissiveIntensity = 2.8;
      const timeout = setTimeout(() => {
        material.emissive.copy(original);
        material.emissiveIntensity = actor.kind === 'drone' ? 0.5 : 0.15;
        this.timeouts.delete(timeout);
      }, 90);
      this.timeouts.add(timeout);
    });
    if (actor.kind === 'civilian') {
      this.heat = clamp(this.heat + 28, 0, 100);
      actor.flee = 8;
      this.emitToast('Civilian harmed', 'Choir response escalating', 'danger');
    } else {
      this.heat = clamp(this.heat + (actor.kind === 'boss' ? 2 : this.ownedUpgrades?.has('shroud') ? 3 : 6), 0, 100);
    }
    this.lastCombat = this.elapsed;
    if (actor.health <= 0) this.killActor(actor);
  }

  private killActor(actor: Actor) {
    actor.alive = false;
    if (actor.kind === 'drone' || actor.kind === 'boss') this.audio.explosion();
    else this.audio.enemyDeath?.(actor.group.position, this.player.position, this.cameraYaw);
    if (actor.kind !== 'civilian') {
      this.reticleKill = 0.55;
      this.statKills += 1;
    } else {
      this.statCivilians += 1;
      if (this.statCivilians === 1) this.emitSubtitle('Nia', 'Aurel — that was a civilian. The Choir will feed on this.');
      else if (this.statCivilians === 3) this.emitSubtitle('Nia', 'Stop. Every body you drop is a soul the Gate swallows.');
    }
    if (actor.kind !== 'civilian' && !this.settings.reducedMotion) {
      // Crit kills and the boss get a longer beat — the frame hangs so
      // the directional fall and kill-flash read before motion resumes.
      const beat = actor.kind === 'boss' ? 0.22 : actor.lastHitCritical ? 0.15 : 0.085;
      this.hitStop = Math.max(this.hitStop, beat);
    }
    const total = actor.kind === 'boss' ? 2.6 : actor.kind === 'drone' ? 1.15 : 1.6;
    actor.materials.forEach((material) => { material.transparent = true; });
    // Directional fall: align the body so the Z-tip carries it along the
    // incoming shot. Headshots snap back toward the shooter; body hits fall away.
    if (actor.kind !== 'drone' && actor.lastHitAngle !== undefined) {
      actor.group.rotation.y = actor.lastHitAngle + Math.PI / 2;
    }
    (this.corpses ??= []).push({
      group: actor.group,
      materials: actor.materials,
      life: total,
      total,
      tip: actor.kind === 'drone'
        ? 0
        : actor.lastHitAngle !== undefined
          ? (actor.lastHitCritical ? -1 : 1) * Math.PI / 2
          : (Math.PI / 2) * (seeded(actor.id.length, 311) > 0.5 ? 1 : -1),
      noticedBy: new Set<string>(),
      reported: false,
    });
    this.spawnDrop(actor);
    if (actor.id.startsWith('warden-')) {
      this.defeatedWardens += 1;
      this.emitToast('Warden severed', `${this.defeatedWardens} of 5`, 'success');
    } else if (actor.id.startsWith('sentinel-')) {
      this.emitToast('Sentinel broken', 'Heavy patrol neutralized', 'success');
    } else if (actor.id.startsWith('stalker-')) {
      this.emitToast('Stalker silenced', 'Fast patrol neutralized', 'success');
    } else if (actor.id.startsWith('cordon-')) {
      this.emitToast('Seraph patrol down', 'The cordon has a gap', 'success');
    } else if (actor.shielded) {
      this.emitToast('Bulwark down', 'The plate finally gave', 'success');
    } else if (actor.id.startsWith('reinforce-')) {
      this.emitToast('Hunter down', 'Reinforcement destroyed', 'success');
    } else if (actor.kind === 'drone') {
      this.emitToast('Choir drone disabled', 'Response network weakened', 'success');
    } else if (actor.kind === 'boss') {
      this.emitSubtitle('Archon', 'If the door opens… you will miss the cage.');
      this.beginCinematic(actor.group.position.clone());
    }
    const marks = marksForActor(actor.id, actor.kind) + (actor.shielded ? 10 : 0);
    // Kill streak: hostiles downed within 7s of the last kill chain a payout
    // multiplier — up to 2.25× at a six-streak. Civilians break the chain.
    if (actor.kind === 'civilian') {
      this.killStreak = 0;
    } else {
      this.killStreak = this.elapsed < this.killStreakUntil ? this.killStreak + 1 : 1;
      this.killStreakUntil = this.elapsed + 7;
    }
    const streakMult = 1 + Math.min(this.killStreak - 1, 5) * 0.25;
    if (marks > 0) {
      const payout = Math.round(marks * streakMult);
      this.shards += payout;
      const streakNote = this.killStreak >= 2 ? ` · streak ×${this.killStreak}` : '';
      this.emitToast('Marks claimed', `+${payout}${streakNote} · spend in Pause → Attunements`, 'success');
    }
    // Sneak-kill flourish: a whisper and a doubled mark bounty when the
    // target never reached combat while the Veil was open.
    if (this.veilActive && actor.aiState && actor.aiState.phase !== 'combat' && actor.kind !== 'civilian') {
      this.shards += 3;
      this.audio.whisperBlip?.();
      this.emitToast('Veil execution', '+3 marks — they never saw you', 'success');
    }
  }

  private updateCorpses(delta: number) {
    this.corpses = (this.corpses ?? []).filter((corpse) => {
      corpse.life -= delta;
      if (corpse.group.position.y > 0.04) {
        corpse.group.position.y = Math.max(0.02, corpse.group.position.y - delta * 15);
      }
      corpse.group.rotation.z = damp(corpse.group.rotation.z, corpse.tip, 4.6, delta);
      const fade = clamp(corpse.life / (corpse.total * 0.42), 0, 1);
      corpse.materials.forEach((material) => { material.opacity = fade; });
      if (corpse.life > 0) return true;
      corpse.group.visible = false;
      return false;
    });
  }

  private spawnDrop(actor: Actor) {
    if (actor.kind === 'civilian' || !this.scene) return;
    const kind = seeded(actor.id.length + actor.group.position.x, 320) > 0.55 ? 'resonance' : 'ammo';
    const color = kind === 'ammo' ? 0xd8b76a : 0x9fd6ff;
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: kind === 'ammo' ? 0xb98a2e : 0x3f96c8,
      emissiveIntensity: 1.9,
      roughness: 0.28,
      metalness: 0.6,
      transparent: true,
    });
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), material);
    group.add(core);
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.02, 6, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
    halo.rotation.x = Math.PI / 2;
    group.add(halo);
    group.position.set(actor.group.position.x, Math.max(0.72, Math.min(actor.group.position.y, 3)), actor.group.position.z);
    this.scene.add(group);
    (this.drops ??= []).push({ group, kind, life: 32 });
  }

  private updateDrops(delta: number, time: number) {
    const position = this.currentVehicle?.group.position ?? this.player.position;
    this.drops = (this.drops ?? []).filter((drop) => {
      drop.life -= delta;
      drop.group.rotation.y += delta * 2.1;
      drop.group.position.y = 0.74 + Math.sin(time * 2.3 + drop.group.position.x * 0.7) * 0.12;
      const fade = clamp(drop.life / 3, 0, 1);
      if (fade < 1) {
        drop.group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const material = child.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
            material.transparent = true;
            material.opacity = Math.min(material.opacity, fade);
          }
        });
      }
      const dropDistance = distance2D(drop.group.position.x, drop.group.position.z, position.x, position.z);
      if (dropDistance < 6 && dropDistance > 0.01) {
        const pull = (1 - dropDistance / 6) * 9 * delta;
        drop.group.position.x += ((position.x - drop.group.position.x) / dropDistance) * pull;
        drop.group.position.z += ((position.z - drop.group.position.z) / dropDistance) * pull;
      }
      const near = dropDistance < 2;
      if (near || drop.life <= 0) {
        if (near) {
          if (drop.kind === 'ammo') {
            const gain = Math.ceil(this.activeWeaponSpec().magazineSize * 0.5);
            this.reserveAmmo += gain;
            this.emitToast('Cell recovered', `+${gain} ${this.activeWeaponSpec().name} reserve`, 'success');
          } else {
            this.resonance = Math.min(100, this.resonance + 14);
            this.emitToast('Resonance shard', '+14 resonance', 'success');
          }
          this.audio.ui(true);
        }
        this.scene.remove(drop.group);
        this.disposeObject(drop.group);
        return false;
      }
      return true;
    });
  }

  private startReload() {
    const spec = this.activeWeaponSpec();
    if (this.reloading > 0) {
      this.reloading = 0;
      this.emitToast('Reload canceled', `${this.ammo} rounds remain in the magazine`, 'info');
      return;
    }
    if (this.ammo >= spec.magazineSize || this.reserveAmmo <= 0 || this.currentVehicle) return;
    this.reloading = spec.reloadSeconds;
    this.heroCharacter?.playOnce('reload', 0.08);
    this.audio.reload();
    this.pulseGamepad(90, 0.14, 0.2);
    this.emitToast(`Reloading ${spec.name}`, `${this.reserveAmmo} rounds in reserve`, 'info');
  }

  private finishReload() {
    const result = transferReload(this.ammo, this.reserveAmmo, this.activeWeaponSpec());
    this.ammo = result.ammo;
    this.reserveAmmo = result.reserve;
    this.reloading = 0;
  }

  private toggleVeil() {
    if (this.veilActive) {
      this.setVeil(false);
      return;
    }
    if (this.veilCooldown > 0 || this.resonance < 18) {
      this.emitToast('Veil unavailable', this.resonance < 18 ? 'Resonance depleted' : 'The gate is still recovering', 'danger');
      return;
    }
    this.setVeil(true);
  }

  private setVeil(active: boolean, silent = false) {
    this.veilActive = active;
    this.veilTimer = active ? 8 : 0;
    this.audio.setVeilBed(active);
    this.veilWhisperTimer = 1.2;
    if (!active && !silent) this.veilCooldown = 7.5;
    if (active) {
      this.resonance = Math.max(0, this.resonance - 18);
      if (!silent) {
        this.audio.gate();
        this.emitSubtitle('Nia', 'Veil open. Memory is now physical.');
      }
    }
    this.scene.background = new THREE.Color(active ? 0x111225 : 0x070a0d);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(active ? 0x17142d : 0x090d10);
      this.scene.fog.density = active ? 0.0095 : 0.0068;
    }
    this.phaseMaterials.forEach((material) => {
      material.emissive.setHex(active ? 0x2a2048 : 0x0d1111);
      material.emissiveIntensity = active ? 0.78 : 0.28;
    });
    this.echoes.forEach((echo) => {
      echo.group.traverse((child) => {
        if (child instanceof THREE.Mesh && 'opacity' in child.material) {
          (child.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial).opacity = active ? 0.92 : 0.12;
        }
      });
    });
    this.applyVeilToHero(active);
    if (!active && this.lastSave?.ending) this.applyEndingWorld(this.lastSave.ending);
  }

  // The veil reads on the body too — hero + fallback + the held weapon fade
  // to a ghost-sheen so the state is legible in third person, not just on
  // the minimap and the fog. Original opacities are restored on close.
  private applyVeilToHero(active: boolean) {
    const roots: THREE.Object3D[] = [this.player];
    if (this.heroCharacter) roots.push(this.heroCharacter.object);
    roots.forEach((root) => root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (active) {
          if (!this.veilHeroStates.has(material)) {
            this.veilHeroStates.set(material, {
              opacity: material.opacity,
              emissive: material instanceof THREE.MeshStandardMaterial ? material.emissive.getHex() : 0,
              emissiveIntensity: material instanceof THREE.MeshStandardMaterial ? material.emissiveIntensity : 0,
            });
          }
          material.transparent = true;
          material.opacity = 0.42;
          if (material instanceof THREE.MeshStandardMaterial) {
            material.emissive.lerp(veilTint, 0.35);
            material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.3);
          }
        } else {
          const original = this.veilHeroStates.get(material);
          if (!original) return;
          material.opacity = original.opacity;
          material.transparent = original.opacity < 1;
          if (material instanceof THREE.MeshStandardMaterial) {
            material.emissive.setHex(original.emissive);
            material.emissiveIntensity = original.emissiveIntensity;
          }
        }
      });
    }));
    if (!active) this.veilHeroStates.clear();
  }

  private updateVeil(delta: number) {
    if (this.veilActive) {
      this.veilTimer -= delta;
      this.resonance = Math.max(0, this.resonance - delta * 1.4);
      this.veilWhisperTimer = Math.max(0, (this.veilWhisperTimer ?? 2) - delta);
      if (this.veilWhisperTimer === 0) {
        this.audio.whisperBlip();
        this.veilWhisperTimer = 1.6 + seeded(Math.floor(this.elapsed * 10), 500) * 3.4;
      }
      if (this.veilTimer <= 0 || this.resonance <= 0) this.setVeil(false);
    } else {
      const regen = this.ownedUpgrades?.has('flow') ? 3.15 : 2.1;
      this.resonance = Math.min(100, this.resonance + delta * regen);
      if (this.ownedUpgrades?.has('aegis')) {
        this.armor = Math.min(90, this.armor + delta * 1.1);
      }
    }
  }

  private usePulse() {
    if (this.pulseCooldown > 0 || this.resonance < 24) {
      this.emitToast('Resonance pulse unavailable', this.resonance < 24 ? 'Need 24 resonance' : 'Pulse is recharging', 'danger');
      return;
    }
    this.pulseCooldown = 8;
    this.resonance -= 24;
    this.audio.pulse();
    const origin = (this.currentVehicle?.group.position ?? this.player.position).clone();
    this.createPulseEffect(origin);
    this.actors.forEach((actor) => {
      if (!actor.alive || actor.kind === 'civilian') return;
      const distance = actor.group.position.distanceTo(origin);
      if (distance < 15) {
        this.damageActor(actor, actor.kind === 'boss' ? 32 : 58);
        // The wave staggers a Bulwark's brace — the plate drops open.
        if (actor.shielded) {
          actor.shieldDownUntil = this.elapsed + 4.5;
          this.emitToast('Bulwark staggered', 'The plate is open — hit it now', 'success');
        }
        const knock = actor.group.position.clone().sub(origin).setY(0).normalize();
        actor.group.position.addScaledVector(knock, Math.max(1, 7 - distance * 0.3));
      }
    });
  }

  private tryMelee() {
    this.meleeCooldown = Math.max(0, (this.meleeCooldown ?? 0));
    if (this.meleeCooldown > 0 || this.currentVehicle || this.paused || this.photoMode) return;
    this.meleeCooldown = 0.78;
    this.audio.meleeSwing();
    this.weaponKick = Math.min(1.6, this.weaponKick + 0.9);
    this.camera.getWorldDirection(this.cameraForward);
    let landed = false;
    this.actors.forEach((actor) => {
      if (!actor.alive) return;
      const dx = actor.group.position.x - this.player.position.x;
      const dz = actor.group.position.z - this.player.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 3.1 || distance < 0.001) return;
      const dot = (dx * this.cameraForward.x + dz * this.cameraForward.z) / distance;
      if (dot < 0.35) return;
      landed = true;
      // Silent takedown: an unaware hostile, veiled or struck from behind,
      // drops outright — the Choir never hears a shot because there isn't one.
      const unaware = actor.aiState === undefined || actor.aiState.phase !== 'combat';
      let rel = Math.atan2(dx, dz) - actor.group.rotation.y;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const fromBehind = Math.abs(rel) < 1.1;
      const takedown = unaware && (this.veilActive || fromBehind)
        && actor.kind !== 'civilian' && actor.kind !== 'boss';
      actor.group.position.x += (dx / distance) * 0.6;
      actor.group.position.z += (dz / distance) * 0.6;
      actor.hitReact = Math.max(actor.hitReact ?? 0, 0.65);
      if (takedown) {
        this.damageActor(actor, actor.health + 50);
        this.emitToast('Silent takedown', 'No shot fired — the Choir never heard it', 'info');
      } else {
        this.damageActor(actor, actor.kind === 'civilian' ? 24 : 42);
      }
    });
    if (landed) {
      this.audio.meleeHit();
      this.addTrauma(0.14);
      if (!this.settings.reducedMotion) this.hitStop = Math.max(this.hitStop, 0.05);
    }
  }

  private throwCharge() {
    this.chargeCooldown = Math.max(0, this.chargeCooldown ?? 0);
    if (this.currentVehicle || this.paused || this.photoMode || this.chargeCooldown > 0) return;
    if (this.resonance < 18) {
      this.emitToast('Resonance charge unavailable', 'Need 18 resonance', 'danger');
      return;
    }
    if (!this.charges.length) {
      for (let i = 0; i < 4; i += 1) {
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x4fa8ff, emissiveIntensity: 2.6, roughness: 0.3 }),
        );
        mesh.visible = false;
        const light = new THREE.PointLight(0x6ab8ff, 0, 9);
        mesh.add(light);
        this.scene.add(mesh);
        this.charges.push({ mesh, light, velocity: new THREE.Vector3(), timer: 0, active: false });
      }
    }
    const charge = this.charges.find((candidate) => !candidate.active);
    if (!charge) {
      this.emitToast('Charges in flight', 'Wait for a charge to detonate', 'info');
      return;
    }
    this.chargeCooldown = 0.9;
    this.resonance -= 18;
    this.camera.getWorldDirection(this.cameraForward);
    charge.mesh.position.copy(this.camera.position).addScaledVector(this.cameraForward, 1.1);
    charge.mesh.position.y = Math.max(0.5, charge.mesh.position.y - 0.25);
    charge.velocity.copy(this.cameraForward).multiplyScalar(24);
    charge.velocity.y += 5.5;
    charge.timer = 2.4;
    charge.active = true;
    charge.mesh.visible = true;
    charge.light.intensity = 8;
    this.audio.chargeThrow();
  }

  private updateCharges(delta: number) {
    this.meleeCooldown = Math.max(0, (this.meleeCooldown ?? 0) - delta);
    this.chargeCooldown = Math.max(0, (this.chargeCooldown ?? 0) - delta);
    if (!this.charges?.length) return;
    this.charges.forEach((charge) => {
      if (!charge.active) return;
      charge.timer -= delta;
      charge.velocity.y -= 21 * delta;
      charge.mesh.position.addScaledVector(charge.velocity, delta);
      charge.mesh.rotation.x += delta * 9;
      charge.mesh.rotation.y += delta * 7;
      const pos = charge.mesh.position;
      const grounded = pos.y <= 0.18;
      const obstructed = this.collides(pos.x, pos.z, 0.24, pos.y);
      const hitActor = this.actors.some((actor) => actor.alive && actor.group.position.distanceToSquared(pos) < 1.1);
      if (grounded || obstructed || hitActor || charge.timer <= 0) {
        charge.active = false;
        charge.mesh.visible = false;
        charge.light.intensity = 0;
        this.explodeCharge(pos);
      }
    });
  }

  private spawnCasing(origin: THREE.Vector3) {
    if (!this.scene || !this.casings) return;
    if (!this.casings.length) {
      const geometry = new THREE.CylinderGeometry(0.012, 0.012, 0.045, 6);
      for (let i = 0; i < 24; i += 1) {
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: 0xc9a13b, metalness: 0.85, roughness: 0.3 }),
        );
        mesh.visible = false;
        this.scene.add(mesh);
        this.casings.push({ mesh, velocity: new THREE.Vector3(), spin: 0, timer: 0, active: false, bounced: false });
      }
    }
    const casing = this.casings.find((candidate) => !candidate.active) ?? this.casings[0];
    this.camera.getWorldDirection(this.cameraForward);
    const rightX = -this.cameraForward.z;
    const rightZ = this.cameraForward.x;
    casing.mesh.position.copy(origin);
    casing.mesh.position.y -= 0.08;
    casing.velocity.set(
      rightX * (1.5 + Math.random() * 0.9) + this.cameraForward.x * 0.25,
      1.7 + Math.random() * 0.9,
      rightZ * (1.5 + Math.random() * 0.9) + this.cameraForward.z * 0.25,
    );
    casing.spin = 14 + Math.random() * 10;
    casing.timer = 5.5;
    casing.bounced = false;
    casing.active = true;
    casing.mesh.visible = true;
    casing.mesh.scale.setScalar(1);
    casing.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  }

  private updateCasings(delta: number) {
    if (!this.casings?.length) return;
    this.casings.forEach((casing) => {
      if (!casing.active) return;
      casing.timer -= delta;
      if (casing.timer <= 0) {
        casing.active = false;
        casing.mesh.visible = false;
        return;
      }
      // Rest height follows the real floor — brass lands on the Undergate's
      // stone instead of falling through to street level.
      const restY = (this.collisionBoxes
        ? this.groundHeightAt(casing.mesh.position.x, casing.mesh.position.z, casing.mesh.position.y)
        : 0) + 0.045;
      const resting = casing.mesh.position.y <= restY && casing.velocity.y <= 0;
      if (!resting) {
        casing.velocity.y -= 16 * delta;
        casing.mesh.position.addScaledVector(casing.velocity, delta);
        casing.mesh.rotation.x += casing.spin * delta;
        casing.mesh.rotation.z += casing.spin * 0.7 * delta;
        if (casing.mesh.position.y <= restY) {
          casing.mesh.position.y = restY;
          if (!casing.bounced) {
            casing.bounced = true;
            this.audio.casingTink?.();
          }
          casing.velocity.y *= -0.32;
          casing.velocity.x *= 0.55;
          casing.velocity.z *= 0.55;
        }
      } else {
        // Shrink out instead of a per-mesh material fade.
        if (casing.timer < 0.6) casing.mesh.scale.setScalar(Math.max(0.01, casing.timer / 0.6));
      }
    });
  }

  private explodeCharge(position: THREE.Vector3) {
    this.audio.explosion();
    this.createImpact(position, false);
    this.createShockwave?.(position);
    this.heat = clamp(this.heat + 9, 0, 100);
    this.actors.forEach((actor) => {
      if (!actor.alive) return;
      const distance = actor.group.position.distanceTo(position);
      if (distance > 6.5) return;
      const falloff = 1 - distance / 6.5;
      this.damageActor(actor, (actor.kind === 'boss' ? 34 : 62) * falloff + 8);
      const knock = actor.group.position.clone().sub(position).setY(0).normalize();
      actor.group.position.addScaledVector(knock, falloff * 2.4);
    });
    // Vehicles feel the blast too — damage enough and the engine bay goes,
    // and the concussion shoves the chassis along its heading.
    this.vehicles.forEach((vehicle) => {
      const distance = vehicle.group.position.distanceTo(position);
      if (distance > 7) return;
      const falloff = 1 - distance / 7;
      vehicle.damage += falloff * 46;
      if (vehicle.damage >= 110 && !vehicle.wrecked) {
        this.wreckVehicle(vehicle);
        return;
      }
      const forward = this.tmpMove.set(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      const shove = vehicle.group.position.clone().sub(position).setY(0).normalize().dot(forward);
      vehicle.speed = clamp(vehicle.speed + shove * falloff * 7, -vehicle.spec.top * 0.47, vehicle.spec.top);
    });
    // And the traffic lanes — a charge under a moving cab wrecks it like a
    // magazine dumped through the door.
    this.trafficCars?.forEach((car) => {
      if (car.wrecked) return;
      const distance = car.group.position.distanceTo(position);
      if (distance > 6.5) return;
      car.damage += (1 - distance / 6.5) * 90;
      if (car.damage > 95) this.wreckTrafficCar(car);
      else car.panic = Math.max(car.panic, 6);
    });
    // The blast shatters every lantern it reaches — the street goes dark in a
    // ring around the crater.
    this.streetLamps?.forEach((lamp, index) => {
      if (this.deadLamps?.has(index)) return;
      const distance = Math.hypot(lamp.x - position.x, lamp.z - position.z);
      if (distance < 7) this.killLamp(index, new THREE.Vector3(lamp.x, 4.7, lamp.z));
    });
    const playerDistance = this.player.position.distanceTo(position);
    this.addTrauma(clamp(0.62 - playerDistance * 0.032, 0.12, 0.62));
    if (playerDistance < 4 && !this.currentVehicle) this.takePlayerDamage(12 * (1 - playerDistance / 4));
  }

  private interact() {
    if (this.currentVehicle) {
      this.exitVehicle();
      return;
    }
    if (this.senaInRange()) {
      this.startSenaDelivery();
      return;
    }
    if (this.exitReleaseInRange()) {
      this.pullExitRelease();
      return;
    }
    if (this.quietSeraphInRange()) {
      this.startQuietSeraph();
      return;
    }
    if (this.contractBoardInRange()) {
      this.readJobBoard();
      return;
    }
    const nearbyVehicle = this.vehicles
      .filter((vehicle) => !vehicle.occupied && !vehicle.wrecked)
      .sort((a, b) => a.group.position.distanceTo(this.player.position) - b.group.position.distanceTo(this.player.position))[0];
    if (nearbyVehicle && nearbyVehicle.group.position.distanceTo(this.player.position) < 4.8) {
      this.enterVehicle(nearbyVehicle);
      return;
    }
    // The Undergate beneath Saint Orison — a sealed door that answers touch
    // with resonance. First contact is a beat; after that it hums.
    if (this.undergatePos && this.elapsed - this.lastUndergateAt > 12) {
      const gateDistance = this.player.position.distanceTo(this.undergatePos);
      if (gateDistance < 2.6) {
        this.lastUndergateAt = this.elapsed;
        this.resonance = Math.min(100, this.resonance + 40);
        const narrative = (this.narrative ??= {});
        const first = narrative.undergateTouched !== true;
        narrative.undergateTouched = true;
        this.audio.whisperBlip?.();
        this.audio.gate();
        this.emitSubtitle('The Undergate', first
          ? 'The door beneath the station is older than the door above. It does not open. It listens.'
          : 'The Undergate hums the note it was named for.');
        this.emitToast(first ? 'The door below' : 'Resonance drawn', '+40 resonance', 'success');
        this.saveCheckpoint();
        return;
      }
    }
    // The chapel altar is a resonance shrine — a quiet moment that refills
    // the meter and flares the candles.
    if (this.elapsed - this.lastAltarAt > 12) {
      const altarDistance = this.altarDistance();
      if (altarDistance !== null && altarDistance < 2.8) {
        this.lastAltarAt = this.elapsed;
        this.resonance = Math.min(100, this.resonance + 45);
        this.chapelCandles.forEach((flame) => { flame.intensity = 14; });
        this.audio.gate();
        this.emitSubtitle('The Altar of the Unburied', 'The candles lean toward you. For a moment the storm forgets your name.');
        this.emitToast('Resonance restored', '+45 resonance — the shrine remembers', 'success');
        return;
      }
    }
    if (this.veilActive) {
      const echo = this.echoes.find((candidate) => !candidate.activated && candidate.group.position.distanceTo(this.player.position) < 5);
      if (echo) {
        echo.activated = true;
        echo.group.visible = false;
        this.echoesActivated.add(echo.id);
        this.audio.gate();
        const lines: Record<string, string> = {
          'echo-mercy': 'Mercy was never weakness. It was the first technology.',
          'echo-truth': 'The Choir did not discover heaven. It privatized the door.',
          'echo-name': 'Aurel was not born. Aurel was remembered.',
        };
        this.emitSubtitle('Memory Echo', lines[echo.id] ?? 'The city restores a missing truth.');
        this.emitToast('Memory restored', `${this.echoesActivated.size} of 3 echoes`, 'success');
        this.saveCheckpoint();
      }
    }
  }

  private enterVehicle(vehicle: Vehicle) {
    // Walk to the nearest door — a scripted root-motion blend instead of the
    // teleport-pop. seatVehicle() runs the actual link when the walk lands.
    const upAxis = (this.tmpUpAxis ??= new THREE.Vector3(0, 1, 0));
    const doors = [-2.15, 2.15]
      .map((x) => new THREE.Vector3(x, 0, 0.35).applyAxisAngle(upAxis, vehicle.heading).add(vehicle.group.position))
      .sort((a, b) => a.distanceToSquared(this.player.position) - b.distanceToSquared(this.player.position));
    this.vehicleEnter = { timer: 0.5, total: 0.5, vehicle, from: this.player.position.clone(), to: doors[0] };
    // Cloth-and-click reads as the handle pull; the door thunk lands on seat.
    this.audio.swap();
  }

  private seatVehicle(vehicle: Vehicle) {
    this.currentVehicle = vehicle;
    this.aimToggled = false;
    vehicle.occupied = true;
    vehicle.bodyMaterial.emissive.setHex(0x4c3612);
    vehicle.bodyMaterial.emissiveIntensity = 0.5;
    if (vehicle.spot) vehicle.spot.intensity = 640;
    this.player.visible = false;
    this.cameraYaw = vehicle.heading;
    this.audio.ui(true);
    const driveKeys = ['moveForward', 'moveLeft', 'moveBackward', 'moveRight'].map((action) => this.bindingLabel(action as KeybindAction)).join(' / ');
    this.emitToast(`${vehicle.spec.name} linked`, `${driveKeys} / left stick to drive · ${this.bindingLabel('jump')} / A to brake · ${this.bindingLabel('interact')} / Y to exit`, 'success');
  }

  private exitVehicle() {
    const vehicle = this.currentVehicle;
    if (!vehicle) return;
    const edge = WORLD_SIZE / 2 - 2;
    const exit = [[3.3, 0], [-3.3, 0], [0, 4.5], [0, -4.5]]
      .map(([x, z]) => new THREE.Vector3(x, 0, z)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.heading)
        .add(vehicle.group.position))
      .find((candidate) => Math.abs(candidate.x) <= edge && Math.abs(candidate.z) <= edge
        && !this.collides(candidate.x, candidate.z, PLAYER_RADIUS)
        && !sweepPlanarCollision(vehicle.group.position, candidate,
          (x, z) => this.collides(x, z, PLAYER_RADIUS)).swept);
    if (!exit) {
      this.emitToast('Exit blocked', 'Move the vehicle to a clear area before exiting.', 'info');
      return;
    }
    this.currentVehicle = null;
    this.bonnetCam = false;
    vehicle.occupied = false;
    vehicle.bodyMaterial.emissiveIntensity = 0;
    if (vehicle.spot) vehicle.spot.intensity = 0;
    vehicle.group.rotation.x = 0;
    vehicle.group.rotation.z = 0;
    this.player.visible = true;
    this.player.position.copy(exit);
    this.playerVelocity.set(0, 0, 0);
    vehicle.speed *= 0.4;
    this.audio.setEngine(0, false);
    this.audio.ui();
  }

  // Total loss: the engine dies, the bay catches, the driver is thrown out.
  // Shared by collision accumulation and explosion damage — parked cars
  // wreck from a charge the same as a crashed one.
  private wreckVehicle(vehicle: Vehicle) {
    vehicle.wrecked = true;
    vehicle.speed = 0;
    vehicle.bodyMaterial.emissive.setHex(0x30140c);
    vehicle.bodyMaterial.emissiveIntensity = 0.9;
    vehicle.group.rotation.z = 0.05;
    vehicle.group.position.y -= 0.05;
    this.placeDecal(vehicle.group.position, this.tmpMove.set(0, 1, 0), 15);
    this.createShockwave(vehicle.group.position);
    this.audio.explosion();
    this.addTrauma(vehicle.occupied || this.currentVehicle === vehicle ? 0.8
      : clamp(0.5 - vehicle.group.position.distanceTo(this.player.position) * 0.03, 0.1, 0.5));
    this.heat = clamp(this.heat + 10, 0, 100);
    this.emitToast(`${vehicle.spec.name} destroyed`, 'The engine bay gave out — get clear', 'danger');
    this.takePlayerDamage(24, vehicle.group.position);
    if (vehicle.occupied) this.exitVehicle();
  }

  private updateMission() {
    const mission = MISSIONS[this.missionIndex];
    if (!mission || mission.kind === 'complete') return;
    const playerPosition = this.currentVehicle?.group.position ?? this.player.position;
    if (mission.kind === 'reach' && mission.target) {
      if (distance2D(playerPosition.x, playerPosition.z, mission.target[0], mission.target[2]) <= (mission.radius ?? 8)) this.completeMission();
    } else if (mission.kind === 'eliminate' && this.defeatedWardens >= (mission.count ?? 5)) {
      this.completeMission();
    } else if (mission.kind === 'vehicle' && this.currentVehicle) {
      this.completeMission();
    } else if (mission.kind === 'drive' && mission.target) {
      // The fiction promises a closing gate — honor it. 110 seconds of real
      // pressure, then Meridian seals and the run resets to the checkpoint.
      if (this.missionDeadline === null) {
        this.missionDeadline = this.elapsed + 110;
        this.emitSubtitle('Nia', 'Meridian is ninety seconds from lockdown. Go.');
      }
      if (this.currentVehicle
        && distance2D(playerPosition.x, playerPosition.z, mission.target[0], mission.target[2]) <= (mission.radius ?? 10)) {
        this.completeMission();
      } else if (this.elapsed >= this.missionDeadline) {
        this.missionDeadline = null;
        this.emitToast('Meridian sealed', 'The gate locked before you arrived', 'danger');
        this.emitSubtitle('Nia', 'Too late. Back to the mouth of the run — faster this time.');
        this.retryCheckpoint();
      }
    } else if (mission.kind === 'echoes' && this.echoesActivated.size >= (mission.count ?? 3)) {
      this.completeMission();
    } else if (mission.kind === 'boss') {
      if (!this.boss) this.spawnBoss();
      this.updateBossPhase();
      if (this.boss && !this.boss.alive) this.completeMission();
    } else if (mission.kind === 'choice' && !this.choiceRequested) {
      this.choiceRequested = true;
      this.paused = true;
      if (document.pointerLockElement) void document.exitPointerLock();
      this.callbacks.onChoiceRequested();
    }
    this.updateInteractionPrompt();
  }

  private completeMission() {
    const completed = MISSIONS[this.missionIndex];
    if (!completed) return;
    this.audio.gate();
    this.emitToast(`${completed.title} complete`, completed.completionLine, 'success');
    this.emitSubtitle('Nia', completed.completionLine);
    this.missionIndex = Math.min(this.missionIndex + 1, MISSIONS.length - 1);
    this.missionDeadline = null;
    if (this.missionIndex === 5) this.spawnBoss();
    this.updateObjectiveMarker();
    this.beginCinematic();
    this.saveCheckpoint();
    const timeout = setTimeout(() => {
      this.emitMissionBriefing();
      this.timeouts.delete(timeout);
    }, 1800);
    this.timeouts.add(timeout);
  }

  private spawnBoss() {
    if (this.boss) return;
    const actor = this.addActor('false-archon', 'boss', 0, -54, 0x41362d, 0xf3bf54, 520);
    actor.group.scale.setScalar(1.75);
    actor.speed = 3.7;
    actor.group.visible = true;
    const haloMaterial = new THREE.MeshStandardMaterial({ color: 0xd7b45e, emissive: 0xd08224, emissiveIntensity: 2.6, metalness: 0.7 });
    const halo = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.1, 8, 36), haloMaterial);
    halo.position.y = 3.1;
    halo.userData.actorId = actor.id;
    actor.group.add(halo);
    this.rayTargets.push(halo);
    actor.materials.push(haloMaterial);
    this.boss = actor;
    this.bossPhase = 0;
    this.nextBossVoiceAt = this.elapsed + 6;
    this.audio.archonVoice?.(0.4);
    this.bossHalo = haloMaterial;
    this.emitToast('BOSS // FALSE ARCHON', 'Break the halo. Silence the voice.', 'danger');
    this.beginCinematic(actor.group.position.clone());
  }

  // The Archon escalates instead of sponging — at two-thirds the Choir
  // answers, at one-third the mask slips: speed, cadence, and the halo all
  // turn hostile while the fight's fiction says why.
  private updateBossPhase() {
    const boss = this.boss;
    if (!boss || !boss.alive) return;
    if (this.elapsed >= this.nextBossVoiceAt) {
      this.nextBossVoiceAt = this.elapsed + 9 + Math.random() * 5;
      this.audio.archonVoice?.(0.35 + this.bossPhase * 0.25);
    }
    const fraction = boss.health / 520;
    if (this.bossPhase === 0 && fraction <= 0.66) {
      this.bossPhase = 1;
      this.emitToast('The Choir sings', 'Wardens answer the failing voice', 'danger');
      this.emitSubtitle('False Archon', 'A door does not bleed. A door does not fear.');
      this.audio.archonVoice?.(0.7);
      [[-6, 4], [6, 4]].forEach(([dx, dz], index) => {
        const add = this.addActor(`archon-choir-${index + 1}`, 'enemy',
          boss.group.position.x + dx, boss.group.position.z + dz, 0x2c2622, 0xe8a34c, 120);
        if (add.aiState) add.aiState = { ...add.aiState, suspicion: 1, phase: 'combat' };
      });
      this.createShockwave(boss.group.position);
    } else if (this.bossPhase === 1 && fraction <= 0.33) {
      this.bossPhase = 2;
      boss.speed = 5.1;
      this.bossHalo?.emissive.setHex(0xd63a2a);
      this.bossHalo?.color.setHex(0x8a2a1e);
      this.emitToast('THE MASK SLIPS', 'The Archon is done pretending to be merciful', 'danger');
      this.emitSubtitle('Nia', 'The voice is breaking up — end it, Aurel.');
      this.audio.archonVoice?.(1);
      this.createShockwave(boss.group.position);
    }
  }

  private emitMissionBriefing() {
    const mission = MISSIONS[this.missionIndex];
    if (!mission) return;
    this.emitToast(mission.title, mission.summary, 'info');
    mission.briefing.forEach((line, index) => {
      const timeout = setTimeout(() => {
        const separator = line.indexOf(':');
        this.emitSubtitle(separator > -1 ? line.slice(0, separator) : 'Nia', separator > -1 ? line.slice(separator + 1).trim() : line);
        this.timeouts.delete(timeout);
      }, index * 2600 + 350);
      this.timeouts.add(timeout);
    });
  }

  private updateObjectiveMarker() {
    if (!this.objectiveMarker) return;
    const mission = MISSIONS[this.missionIndex];
    // An accepted contract takes the marker — the mission resumes it after.
    const contract = this.activeContract;
    const target = contract ? new THREE.Vector3(contract.def.x, 0, contract.def.z) : this.missionTarget();
    this.objectiveMarker.visible = Boolean(target && (contract || mission.kind !== 'complete'));
    if (target) this.objectiveMarker.position.set(target.x, 4.2, target.z);
  }

  private missionTarget() {
    const mission = MISSIONS[this.missionIndex];
    if (!mission) return null;
    if (mission.kind === 'vehicle') return this.vehicles[0]?.group.position ?? null;
    if (mission.kind === 'echoes') {
      const active = this.echoes.filter((echo) => !echo.activated);
      if (!active.length) return null;
      return active.sort((a, b) => a.group.position.distanceTo(this.player.position) - b.group.position.distanceTo(this.player.position))[0].group.position;
    }
    if (mission.kind === 'eliminate') return new THREE.Vector3(0, 0, -54);
    if (mission.kind === 'boss') return this.boss?.group.position ?? new THREE.Vector3(0, 0, -54);
    if (mission.target) return new THREE.Vector3(...mission.target);
    return null;
  }

  private altarDistance(): number | null {
    if (!this.chapelZone?.containsPoint(this.player.position)) return null;
    const center = this.chapelZone.getCenter(this.tmpMove);
    center.x -= 4.4;
    return Math.hypot(this.player.position.x - center.x, this.player.position.z - center.z);
  }

  private updateInteractionPrompt() {
    let prompt: InteractionPrompt | null = null;
    const interact = `${this.bindingLabel('interact')} / Y`;
    if (this.currentVehicle) prompt = { action: interact, label: 'Exit Seraph' };
    else {
      if (this.senaInRange()) prompt = { action: interact, label: 'Talk to Sena' };
      // The exit release only exists while the cordon stands — and only
      // honestly while Sena's choice isn't borrowing the interact key.
      if (!prompt && this.exitReleaseInRange()) prompt = { action: interact, label: 'Pull the exit release' };
      if (!prompt && this.quietSeraphInRange()) prompt = { action: interact, label: 'Approach the Seraph' };
      if (!prompt && this.contractBoardInRange()) {
        prompt = { action: interact, label: this.activeContract ? 'Check the job board' : 'Read the job board' };
      }
      const vehicle = prompt ? undefined : this.vehicles.find((candidate) => candidate.group.position.distanceTo(this.player.position) < 4.8);
      if (vehicle) prompt = { action: interact, label: `Enter ${vehicle.spec.name}` };
      if (!prompt && this.undergatePos && this.elapsed - this.lastUndergateAt > 12
        && this.player.position.distanceTo(this.undergatePos) < 2.6) {
        prompt = { action: interact, label: 'Touch the Undergate' };
      }
      if (!prompt && this.elapsed - this.lastAltarAt > 12) {
        const altarDistance = this.altarDistance();
        if (altarDistance !== null && altarDistance < 2.8) {
          prompt = { action: interact, label: 'Kneel at the Altar' };
        }
      }
      const echo = this.echoes.find((candidate) => !candidate.activated && candidate.group.position.distanceTo(this.player.position) < 5);
      if (echo) prompt = this.veilActive
        ? { action: interact, label: 'Restore Memory Echo' }
        : { action: `${this.bindingLabel('veil')} / LB`, label: 'Open Veil to reveal memory' };
    }
    const signature = prompt ? `${prompt.action}:${prompt.label}` : '';
    if (signature !== this.lastInteraction) {
      this.lastInteraction = signature;
      this.callbacks.onInteraction(prompt);
    }
  }

  // Sena takes the delivery before the altar/vehicle checks — her prompt only
  // exists while the parcel is still on Aurel during the opening operation.
  private senaInRange() {
    const sena = this.sena;
    if (!sena?.alive || !sena.group.visible || !this.player) return false;
    if (this.missionIndex !== 0 || this.narrative?.senaDelivered) return false;
    return sena.group.position.distanceTo(this.player.position) < 3.4;
  }

  private queueSubtitle(speaker: string, text: string, delayMs: number) {
    const timeouts = (this.timeouts ??= new Set());
    const timeout = setTimeout(() => {
      this.emitSubtitle(speaker, text);
      timeouts.delete(timeout);
    }, delayMs);
    timeouts.add(timeout);
  }

  private startSenaDelivery() {
    const narrative = (this.narrative ??= {});
    if (narrative.senaDelivered) return;
    narrative.senaDelivered = true;
    const elapsed = this.elapsed ?? 0;
    this.senaTalkingUntil = elapsed + 20.5;
    // Briefing cadence — one line at a time so subtitles never stack or clip.
    SENA_DELIVERY_LINES.forEach(([speaker, text], index) => {
      this.queueSubtitle(speaker, text, index * 2600 + 350);
    });
    this.senaChoiceAt = elapsed + 18.2;
    this.bellAt = elapsed + 23.6;
    this.audio.ui(true);
    // The receipt records delivery exactly once — persisted before the beat.
    this.saveCheckpoint();
  }

  private openSenaChoice() {
    this.senaChoiceOpen = true;
    this.senaChoiceDeadline = (this.elapsed ?? 0) + 14;
    this.senaTalkingUntil = (this.elapsed ?? 0) + 14;
    this.callbacks?.onDialogueChoice?.({
      prompt: 'Sena waits on the receipt.',
      options: [
        { action: `${this.bindingLabel('interact')} / Y`, label: '“Who was she?”', detail: 'Ask about the name on the order' },
        { action: `${this.bindingLabel('veil')} / LB`, label: '“Your signature will do.”', detail: 'Close the delivery' },
      ],
    });
  }

  private closeSenaChoice() {
    if (!this.senaChoiceOpen) return;
    this.senaChoiceOpen = false;
    this.callbacks?.onDialogueChoice?.(null);
  }

  chooseDialogueOption(index: number) {
    if (!this.senaChoiceOpen) return;
    this.closeSenaChoice();
    const narrative = (this.narrative ??= {});
    const asked = index === 0;
    narrative.senaAsked = asked;
    const elapsed = this.elapsed ?? 0;
    this.senaTalkingUntil = elapsed + 7;
    this.emitSubtitle('Aurel', asked ? 'Who was she?' : 'Your signature will do.');
    this.queueSubtitle('Sena', asked ? SENA_REPLY_ASKED : SENA_REPLY_SIGNED, 2400);
    // The answer gets its moment — the bell lands about four seconds after it.
    this.bellAt = elapsed + 10;
    this.audio.ui(asked);
    this.saveCheckpoint();
  }

  private updateSena() {
    const sena = this.sena;
    if (!sena) return;
    const narrative = this.narrative;
    const elapsed = this.elapsed ?? 0;
    const playerPosition = this.currentVehicle?.group.position ?? this.player?.position;
    const distance = playerPosition ? sena.group.position.distanceTo(playerPosition) : 0;
    if (this.senaChoiceOpen) {
      // Walking away, waiting too long, or the cordon arriving first all
      // close the question — the delivery stands either way.
      if (distance > 9 || this.missionIndex !== 0 || elapsed > this.senaChoiceDeadline) {
        this.closeSenaChoice();
        if ((this.bellAt ?? 0) > 0) this.bellAt = Math.max(this.bellAt ?? 0, elapsed + 4.2);
      }
    } else if (
      this.missionIndex === 0 && sena.alive
      && narrative?.senaDelivered && narrative.senaAsked === undefined
      && !this.bellFired && (this.senaChoiceAt ?? 0) > 0 && elapsed >= this.senaChoiceAt
      && distance < 9
    ) {
      this.openSenaChoice();
    }
    if (
      narrative?.senaDelivered && !this.bellFired && !this.senaChoiceOpen
      && (this.bellAt ?? 0) > 0 && elapsed >= (this.bellAt ?? 0)
    ) {
      if (this.missionIndex === 0) this.fireBell();
      else this.bellAt = null; // The cordon came first — the bell stays silent.
    }
  }

  private fireBell() {
    if (this.bellFired) return;
    this.bellFired = true;
    this.closeSenaChoice();
    const elapsed = this.elapsed ?? 0;
    this.senaTalkingUntil = elapsed + 15;
    // The cordon answer to the toll — materializes on the approach ~12 s in.
    this.cordonAt = elapsed + CORDON_SPAWN_DELAY;
    // From below the platform — the toll is essential, so it is captioned
    // rather than carried on audio alone.
    this.audio.bell?.({ x: 0, y: -5, z: -56 }, this.camera?.position ?? { x: 0, y: 1.6, z: 0 }, this.cameraYaw ?? 0);
    this.emitSubtitle('Below the platform', 'A bell tolls — once — deep under Saint Orison.');
    if (this.settings?.reducedMotion) {
      // Reduced-motion skips the flash: the glimpse is a captioned beat.
      this.queueSubtitle('Below the platform', 'Silent figures fill the platform for a breath — then no one is there.', 3400);
    } else {
      this.lightningFlash = 1;
      this.spawnBellEchoes();
    }
    const replies = this.sena?.alive ? SENA_BELL_LINES : SENA_BELL_LINES.filter(([speaker]) => speaker !== 'Sena');
    const base = this.settings?.reducedMotion ? 6600 : 4400;
    replies.forEach(([speaker, text], index) => {
      this.queueSubtitle(speaker, text, base + index * 2700);
    });
  }

  // The platform, briefly occupied — the civilian figure read as dark
  // translucent shapes, cleared by the standard fade/dispose effect pass.
  private spawnBellEchoes() {
    if (!this.scene) return;
    const group = new THREE.Group();
    const spots: Array<[number, number]> = [
      [-4.2, -51.8], [2.6, -55.2], [0.4, -58.6], [-6.6, -55.6],
      [5.4, -50.4], [1.6, -48.8], [-2.2, -60.2], [7.4, -57.8],
    ];
    spots.forEach(([x, z], index) => {
      const echo = this.humanoid(`citizen-bell-echo-${index}`, 0x0a0d12, 0x0a0d12);
      echo.group.position.set(x, 0, z);
      echo.group.rotation.y = seeded(index, 380) * Math.PI * 2;
      echo.materials.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.58;
        material.color.setHex(0x06090d);
        material.emissive.setHex(0x000000);
        material.emissiveIntensity = 0;
        material.depthWrite = false;
      });
      group.add(echo.group);
    });
    this.scene.add(group);
    this.pushEffect({ object: group, life: 2.5, total: 2.5, mode: 'fade' });
  }

  // Beat C tail — the Seraph cordon materializes across the station approach
  // after the bell: a posted line, a marked detection cone per rifle, and
  // Nia's reroute to the waterline. Fully skippable — crossing the cone with
  // heat over the alarm threshold just wakes the normal combat AI.
  private spawnCordon(radio: boolean) {
    if (!this.scene || this.missionIndex !== 0 || (this.cordonPatrol ?? []).length) return;
    const patrol = (this.cordonPatrol ??= []);
    const scans = (this.cordonScans ??= []);
    CORDON_POSTS.forEach((post, index) => {
      const actor = this.addActor(`cordon-seraph-${index + 1}`, 'enemy', post.x, post.z, 0x2c2622, 0xe8a34c, 96);
      actor.posted = true;
      actor.overwatchAim = post.aim;
      actor.spawnYaw = post.yaw;
      actor.speed = 2.55;
      actor.group.scale.multiplyScalar(1.06);
      actor.group.rotation.y = post.yaw;
      patrol.push(actor);
      // The marked cone — a faint wedge on the pavement each rifle watches.
      const material = new THREE.MeshBasicMaterial({
        color: 0xd65a45, transparent: true, opacity: 0.05,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const geometry = (this.cordonConeGeometry ??= new THREE.CircleGeometry(
        CORDON_CONE_RANGE, 20, -Math.PI / 2 - CORDON_CONE_HALF_ANGLE, CORDON_CONE_HALF_ANGLE * 2,
      ));
      const pivot = new THREE.Group();
      const wedge = new THREE.Mesh(geometry, material);
      wedge.rotation.x = -Math.PI / 2;
      pivot.add(wedge);
      pivot.position.set(post.x, 0.07, post.z);
      pivot.rotation.y = post.yaw;
      this.scene.add(pivot);
      scans.push({ actor, mesh: pivot, material });
    });
    const props = (this.cordonProps ??= { meshes: [], boxes: [] });
    const generation = (this.cordonGeneration = (this.cordonGeneration ?? 0) + 1);
    void this.instancedProp('concrete_road_barrier', CORDON_BARRIERS.map((spot) => ({ ...spot })), {
      targetHeight: 1.1, collider: { w: 2.4, d: 0.6, h: 1.1 }, track: props,
    }).then(() => {
      // A reset mid-load must not leave barrier strays behind.
      if (this.cordonGeneration !== generation) this.dropCordonProps(props);
    });
    this.breadcrumbTarget = new THREE.Vector3(CORDON_FLANK.x, 0, CORDON_FLANK.z);
    this.spawnExitRelease();
    if (radio) {
      // Queued past the bell replies so the radio beat never clips them.
      const base = this.settings?.reducedMotion ? 6600 : 4300;
      this.queueSubtitle('Nia', 'Cordon’s up on Meridian. Four rifles. They’ll see you before you see the door.', base);
      this.queueSubtitle('Nia', 'Veil works on eyes, not on locks. Take the waterline.', base + 4300);
      (this.narrative ??= {}).cordonSeen = true;
      this.saveCheckpoint();
    }
  }

  // Beat E's other half — the lit exit release on the cordon's north face:
  // a lever post the prompt can name, and the holding door it frees. Cheap
  // geometry so it dies with the cordon; a re-pulled save rebuilds it open.
  private spawnExitRelease() {
    if (!this.scene || this.exitRelease) return;
    const released = this.narrative?.exitReleased === true;
    const group = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.18, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x272b2d, roughness: 0.48, metalness: 0.72 }),
    );
    post.position.set(EXIT_RELEASE_POST.x, 0.59, EXIT_RELEASE_POST.z);
    const lamp = new THREE.MeshStandardMaterial({
      color: 0xd8b46a, emissive: 0xe8a34c, emissiveIntensity: released ? 0.6 : 2.4, roughness: 0.3, metalness: 0.3,
    });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.2), lamp);
    head.position.set(EXIT_RELEASE_POST.x, 1.26, EXIT_RELEASE_POST.z);
    head.rotation.x = -0.42;
    // The holding door — hinged on its east edge, swings south when freed.
    const doorPivot = new THREE.Group();
    doorPivot.position.set(EXIT_RELEASE_DOOR.x + EXIT_RELEASE_DOOR.w / 2, 0, EXIT_RELEASE_DOOR.z);
    doorPivot.rotation.y = EXIT_RELEASE_DOOR.yaw - (released ? 1.85 : 0);
    const doorMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4143, roughness: 0.42, metalness: 0.78, emissive: 0x18211f, emissiveIntensity: 0.5,
    });
    const door = new THREE.Mesh(new THREE.BoxGeometry(EXIT_RELEASE_DOOR.w, EXIT_RELEASE_DOOR.h, 0.1), doorMaterial);
    door.position.set(-EXIT_RELEASE_DOOR.w / 2, EXIT_RELEASE_DOOR.h / 2, 0);
    // A lit strip along the top edge — powered hardware, not scrap.
    const strip = new THREE.Mesh(new THREE.BoxGeometry(EXIT_RELEASE_DOOR.w - 0.24, 0.06, 0.12), lamp);
    strip.position.set(-EXIT_RELEASE_DOOR.w / 2, EXIT_RELEASE_DOOR.h - 0.12, 0);
    doorPivot.add(door, strip);
    group.add(post, head, doorPivot);
    group.traverse((child) => { child.userData.surfaceKind = 'metal'; });
    this.scene.add(group);
    const collider = new THREE.Box3(
      new THREE.Vector3(EXIT_RELEASE_DOOR.x - 1.0, 0, EXIT_RELEASE_DOOR.z - 0.3),
      new THREE.Vector3(EXIT_RELEASE_DOOR.x + 1.0, EXIT_RELEASE_DOOR.h, EXIT_RELEASE_DOOR.z + 0.3),
    );
    if (!released) (this.collisionBoxes ??= []).push(collider);
    this.exitRelease = { group, doorPivot, lamp, collider, opening: false, open: released ? 1 : 0 };
  }

  private exitReleaseInRange() {
    const release = this.exitRelease;
    if (!release || release.opening || release.open > 0) return false;
    if (this.senaChoiceOpen === true) return false;
    if (!(this.cordonPatrol ?? []).some((actor) => actor.alive)) return false;
    const position = this.player?.position;
    if (!position) return false;
    return distance2D(position.x, position.z, EXIT_RELEASE_POST.x, EXIT_RELEASE_POST.z) < EXIT_RELEASE_RANGE;
  }

  // One pull does the whole beat: the caption names what the cordon is
  // doing, the klaxon answers, the door swings, the held civilians take the
  // north lane out. `exitReleased` is written once — before the checkpoint.
  private pullExitRelease() {
    const release = this.exitRelease;
    const narrative = (this.narrative ??= {});
    if (!release || narrative.exitReleased) return;
    narrative.exitReleased = true;
    release.opening = true;
    this.collisionBoxes = (this.collisionBoxes ?? []).filter((box) => box !== release.collider);
    this.audio.klaxon?.(
      { x: EXIT_RELEASE_POST.x, y: 1.3, z: EXIT_RELEASE_POST.z },
      this.camera?.position ?? { x: 0, y: 1.6, z: 0 },
      this.cameraYaw ?? 0,
    );
    this.emitSubtitle('Nia', 'The north exit is locked. They’ve left people in there.');
    this.emitToast('North exit released', 'The holding door is open', 'success');
    // The crowd steps out a beat behind the klaxon so the door reads as the
    // cause — then Aurel's send-off lands after Nia's line clears.
    const timeout = setTimeout(() => {
      this.releaseCordonCivilians();
      this.queueSubtitle('Aurel', 'Go. North side.', 2400);
      (this.timeouts ??= new Set()).delete(timeout);
    }, 900);
    (this.timeouts ??= new Set()).add(timeout);
    this.saveCheckpoint();
  }

  private releaseCordonCivilians() {
    if (!this.scene) return;
    for (let i = 0; i < EXIT_RELEASE_CIVILIANS; i += 1) {
      const civilian = this.addActor(
        `citizen-release-${i + 1}`,
        'civilian',
        4.7 + seeded(i, 510) * 0.4,
        EXIT_RELEASE_DOOR.z - 1.0 - seeded(i, 511) * 0.5,
        [0x8a7a54, 0xa89a70, 0x6e6450, 0x958a68][i % 4],
        0x8c7a5a,
        42,
      );
      civilian.vignette = 'run';
      civilian.wanderAngle = 0;
      civilian.flee = 16;
      civilian.fleeHeading = 0; // north — out of the cordon, up the approach.
    }
  }

  // ------------------------------------------------------------------
  // Station job board — repeatable contracts for free roam.
  private contractBoardInRange() {
    const p = this.player?.position;
    if (!p) return false;
    return distance2D(p.x, p.z, CONTRACT_BOARD.x, CONTRACT_BOARD.z) < CONTRACT_BOARD.range;
  }

  private readJobBoard() {
    if (this.activeContract) {
      const c = this.activeContract.def;
      const left = c.kind === 'cache'
        ? ` ${Math.max(0, Math.ceil(this.activeContract.deadline - this.elapsed))}s left`
        : ` ${this.activeContract.spawned.filter((a) => a.alive).length} left`;
      this.emitSubtitle('Job Board', `${c.title} —${left}.`);
      return;
    }
    if (this.elapsed < this.contractCooldownUntil) {
      this.emitSubtitle('Job Board', 'Nothing new posted. The ink is still drying on the last one.');
      return;
    }
    const def = CONTRACTS[this.contractIndex % CONTRACTS.length];
    this.contractIndex += 1;
    const spawned: Actor[] = [];
    if (def.kind === 'sweep') {
      for (let i = 0; i < (def.count ?? 3); i += 1) {
        const a = this.addActor(
          `contract-${def.id}-${i}`,
          'enemy',
          def.x + (seeded(i, 601) - 0.5) * 8,
          def.z + (seeded(i, 602) - 0.5) * 8,
          0x3a322c,
          0xe8a34c,
          70,
        );
        a.vignette = 'wander';
        spawned.push(a);
      }
    }
    this.activeContract = {
      def,
      spawned,
      deadline: this.elapsed + (def.seconds ?? 0),
      acceptedAt: this.elapsed,
    };
    this.audio.ui(true);
    this.emitSubtitle('Job Board', `${def.title}. ${def.brief}`);
    this.emitToast('Contract accepted', `${def.payout} marks on completion`, 'success');
  }

  private updateContract() {
    const contract = this.activeContract;
    if (!contract || !this.player) return;
    const { def } = contract;
    if (def.kind === 'sweep') {
      if (contract.spawned.every((a) => !a.alive)) {
        this.completeContract();
      }
      return;
    }
    // cache — timed reach
    if (this.elapsed > contract.deadline) {
      this.emitSubtitle('Job Board', `${def.title} — too slow. The Choir scanned it first.`);
      this.emitToast('Contract failed', 'The board will repost it', 'danger');
      this.activeContract = null;
      this.contractCooldownUntil = this.elapsed + 15;
      return;
    }
    if (distance2D(this.player.position.x, this.player.position.z, def.x, def.z) < 3.4) {
      this.completeContract();
    }
  }

  private completeContract() {
    const contract = this.activeContract;
    if (!contract) return;
    this.shards += contract.def.payout;
    this.audio.gate();
    this.emitSubtitle('Job Board', `${contract.def.title} — done. The board credits your name.`);
    this.emitToast('Contract complete', `+${contract.def.payout} marks`, 'success');
    this.activeContract = null;
    this.contractCooldownUntil = this.elapsed + 20;
    this.saveCheckpoint();
  }

  // Ambient set-pieces — small composed scenes that materialize ahead of the
  // courier in free roam: an argument, a stalled van, a crate preacher, a
  // snatch chase. One at a time, always ahead of the player, and every piece
  // of it despawns cleanly behind them — the city plays scenes, not scatter.
  private spawnStreetEvent() {
    if (!this.scene || !this.player || this.streetEvent) return;
    const yaw = this.cameraYaw ?? 0;
    const seed = Math.floor(this.elapsed * 7.3);
    let x = 0;
    let z = 0;
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      const dist = 26 + seeded(seed, 210 + i) * 18;
      const side = (seeded(seed, 230 + i) - 0.5) * 30;
      // cameraYaw forward is (-sin, -cos); right is (cos, -sin).
      const cx = this.player.position.x - Math.sin(yaw) * dist + Math.cos(yaw) * side;
      const cz = this.player.position.z - Math.cos(yaw) * dist - Math.sin(yaw) * side;
      // Needs a clear 3.5 m stage — probe the center plus four edge points.
      const clear = !this.collides(cx, cz, 1.4)
        && !this.collides(cx + 3, cz, 0.8) && !this.collides(cx - 3, cz, 0.8)
        && !this.collides(cx, cz + 3, 0.8) && !this.collides(cx, cz - 3, 0.8);
      if (clear && Math.abs(cx) < WORLD_SIZE / 2 - 8 && Math.abs(cz) < WORLD_SIZE / 2 - 8) {
        x = cx; z = cz; found = true;
      }
    }
    if (!found) {
      this.nextStreetEventAt = this.elapsed + 10;
      return;
    }
    const kind = (['argument', 'breakdown', 'preacher', 'snatch'] as const)[seed % 4];
    const props: THREE.Object3D[] = [];
    const actorIds: string[] = [];
    let tailMaterial: THREE.MeshStandardMaterial | undefined;
    let chase: { runner: string; chaser: string } | undefined;
    const npc = (id: string, dx: number, dz: number, vignette: Actor['vignette'], faceYaw = 0) => {
      const actor = this.addActor(`event-${id}`, 'civilian', x + dx, z + dz,
        [0x4a5560, 0x5d5348, 0x3d4a55, 0x554b5a][seed % 4], 0xb8c4d0, 42);
      actor.vignette = vignette;
      actor.spawnYaw = faceYaw;
      actor.group.rotation.y = faceYaw;
      actorIds.push(actor.id);
      return actor;
    };
    if (kind === 'argument') {
      npc('argue-a', -0.55, 0, 'talk', Math.PI / 2);
      npc('argue-b', 0.55, 0, 'talk', -Math.PI / 2);
      npc('watcher', 0, 2.4, 'idle', Math.PI);
    } else if (kind === 'breakdown') {
      const { group, tailMaterial: tail } = this.buildCarBody(0x4c4438, 'morrow');
      group.position.set(x, 0, z);
      group.rotation.y = yaw + 0.35;
      this.scene.add(group);
      props.push(group);
      tailMaterial = tail;
      npc('driver', -2.6, -1.1, 'lean', 1.2);
      npc('helper', 2.3, 2.0, 'idle', -2.2);
    } else if (kind === 'preacher') {
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 0.62, 1.05),
        new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.85, metalness: 0.1 }),
      );
      crate.position.set(x, 0.31, z);
      crate.castShadow = true;
      this.scene.add(crate);
      props.push(crate);
      const preacher = npc('preacher', 0, 0, 'talk', Math.PI);
      preacher.group.position.y = 0.62;
      npc('crowd-a', -1.7, -2.1, 'idle', -0.7);
      npc('crowd-b', 0.2, -2.5, 'idle', 0);
      npc('crowd-c', 1.9, -1.8, 'idle', 0.75);
    } else {
      const runner = npc('runner', 0, -1.5, 'run', Math.PI);
      const chaser = npc('chaser', 0, 1.8, 'run', Math.PI);
      runner.speed *= 1.35;
      chaser.speed *= 1.5;
      chase = { runner: runner.id, chaser: chaser.id };
    }
    this.streetEvent = { kind, props, actorIds, expiresAt: this.elapsed + 55, tailMaterial, chase };
    this.nextStreetEventAt = this.elapsed + 55 + seeded(seed, 250) * 30;
  }

  private updateStreetEvents() {
    const event = this.streetEvent;
    if (!event) {
      // Only in free roam, never during the cordon beat or a boss stage.
      if (this.mode === 'playing' && this.missionIndex === 0 && !this.boss
        && !this.cinematic && this.elapsed >= this.nextStreetEventAt) {
        this.spawnStreetEvent();
      }
      return;
    }
    const player = this.player?.position;
    const eventActors = (this.actors ?? []).filter((a) => event.actorIds.includes(a.id));
    const anchor = eventActors[0]?.group.position ?? event.props[0]?.position;
    const gone = this.elapsed > event.expiresAt
      || !anchor
      || (player && anchor && Math.hypot(anchor.x - player.x, anchor.z - player.z) > 95);
    // A scene that loses its people dissolves early.
    if (!gone && eventActors.every((a) => !a.alive || !a.group.visible)) return this.despawnStreetEvent();
    if (gone) {
      this.despawnStreetEvent();
      return;
    }
    if (event.kind === 'breakdown' && event.tailMaterial) {
      // Hazard blink on the stalled van.
      event.tailMaterial.emissiveIntensity = Math.sin(this.elapsed * 6.4) > 0 ? 3.4 : 0.35;
    } else if (event.kind === 'snatch' && event.chase) {
      const runner = eventActors.find((a) => a.id === event.chase!.runner);
      const chaser = eventActors.find((a) => a.id === event.chase!.chaser);
      if (runner?.alive && chaser?.alive) {
        const dx = runner.group.position.x - chaser.group.position.x;
        const dz = runner.group.position.z - chaser.group.position.z;
        chaser.wanderAngle = Math.atan2(dx, dz);
        // The victim shouts for help as they run.
        if (Math.sin(this.elapsed * 2.1) > 0.985) {
          this.audio.pedestrianBlip(runner.group.position, player ?? runner.group.position, this.cameraYaw, false);
        }
      }
    }
  }

  private despawnStreetEvent() {
    const event = this.streetEvent;
    if (!event) return;
    const ids = new Set(event.actorIds);
    const leaving = (this.actors ?? []).filter((actor) => ids.has(actor.id));
    leaving.forEach((actor) => {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], actor.group);
      this.scene?.remove(actor.group);
      this.disposeObject(actor.group);
    });
    if (leaving.length) this.actors = this.actors.filter((actor) => !ids.has(actor.id));
    event.props.forEach((prop) => {
      this.scene?.remove(prop);
      this.disposeObject(prop);
    });
    this.streetEvent = null;
  }

  // The speaker exchange fires the first time the cordon commits — the cone
  // alarm tripped or a rifle already answering. Combat proceeds under it.
  private fireCordonVox() {
    const narrative = (this.narrative ??= {});
    if (narrative.voxHeard) return;
    narrative.voxHeard = true;
    this.audio.radioBark?.(
      { x: 0, y: 5, z: -54 },
      this.camera?.position ?? { x: 0, y: 1.6, z: 0 },
      this.cameraYaw ?? 0,
      false,
    );
    CORDON_VOX_LINES.forEach(([speaker, text], index) => {
      this.queueSubtitle(speaker, text, index * 2900);
    });
    this.saveCheckpoint();
  }

  // A Seraph who stopped — posted, unarmed in practice, leaning at the
  // clearing's edge. Civilian kind keeps him off the combat AI and the
  // hostile minimap layer; posted keeps him from fleeing his own beat.
  private spawnQuietSeraph() {
    if (this.quietSeraph || !this.scene || this.missionIndex !== 0) return;
    if (this.narrative?.seraphHeard === true) return;
    const actor = this.addActor('seraph-quiet', 'civilian', QUIET_SERAPH_POS.x, QUIET_SERAPH_POS.z, 0x39424c, 0x9fb2c4, 42);
    actor.posted = true;
    actor.vignette = 'lean';
    actor.spawnYaw = QUIET_SERAPH_POS.yaw;
    this.quietSeraph = actor;
  }

  private quietSeraphInRange() {
    const seraph = this.quietSeraph;
    if (!seraph?.alive || !seraph.group.visible || !this.player) return false;
    if (this.missionIndex !== 0 || this.narrative?.seraphHeard === true) return false;
    return distance2D(this.player.position.x, this.player.position.z, seraph.group.position.x, seraph.group.position.z) < 3.2;
  }

  private startQuietSeraph() {
    const narrative = (this.narrative ??= {});
    if (narrative.seraphHeard) return;
    narrative.seraphHeard = true;
    // His fourth line answers what the player actually did at the door.
    const lines = narrative.exitReleased === true ? QUIET_SERAPH_LINES_FREED : QUIET_SERAPH_LINES;
    lines.forEach(([speaker, text], index) => this.queueSubtitle(speaker, text, index * 2700 + 300));
    this.audio.ui(true);
    this.saveCheckpoint();
  }

  // The witness isn't an actor — it's a kept memory, a translucent figure
  // that breathes at the altar until the courier gets close enough to hear.
  private spawnChapelWitness() {
    if (!this.scene || this.chapelWitness) return;
    const { group, materials } = this.humanoid('chapel-witness', 0x2b3b52, 0xa8c4e8);
    group.position.set(WITNESS_POS.x, 0, WITNESS_POS.z);
    group.rotation.y = -Math.PI / 2;
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.32;
      material.depthWrite = false;
      material.emissive = new THREE.Color(0x6f8fc4);
      material.emissiveIntensity = 0.55;
    });
    const light = new THREE.PointLight(0x9ab8ff, 2.5, 9, 1.8);
    light.position.set(0, 2.1, 0);
    group.add(light);
    this.scene.add(group);
    this.chapelWitness = { group, materials, light, bornAt: this.elapsed ?? 0, triggeredAt: null };
  }

  private triggerChapelWitness() {
    const witness = this.chapelWitness;
    const narrative = (this.narrative ??= {});
    if (!witness || narrative.chapelWitnessed) return;
    narrative.chapelWitnessed = true;
    witness.triggeredAt = this.elapsed ?? 0;
    this.audio.whisperBlip?.();
    WITNESS_LINES.forEach(([speaker, text], index) => this.queueSubtitle(speaker, text, index * 2700 + 250));
    this.saveCheckpoint();
  }

  private updateWitness() {
    const player = this.player;
    if (!player || this.missionIndex !== 0) return;
    const narrative = this.narrative;
    if (!this.chapelWitness && narrative?.seraphHeard === true && narrative?.chapelWitnessed !== true) {
      const zone = this.chapelZone;
      if (zone && player.position.distanceTo(zone.getCenter(this.tmpMove)) < WITNESS_SPAWN_RANGE) {
        this.spawnChapelWitness();
      }
    }
    const witness = this.chapelWitness;
    if (!witness) return;
    const elapsed = this.elapsed ?? 0;
    if (witness.triggeredAt === null) {
      const age = elapsed - witness.bornAt;
      const shimmer = 0.32 + Math.sin(age * 1.7) * 0.08;
      witness.materials.forEach((material) => { material.opacity = shimmer; });
      witness.light.intensity = 2.5 + Math.sin(age * 2.3) * 0.9;
      if (player.position.distanceTo(witness.group.position) < WITNESS_TRIGGER_RANGE) this.triggerChapelWitness();
      return;
    }
    const t = elapsed - witness.triggeredAt;
    if (t <= 13.8) {
      // The candles lean in — the light climbs while the lines play.
      witness.light.intensity = Math.min(14, 2.5 + t * 6);
      witness.materials.forEach((material) => { material.opacity = Math.min(0.5, 0.32 + t * 0.04); });
      return;
    }
    const fade = clamp((t - 13.8) / 2.2, 0, 1);
    witness.materials.forEach((material) => { material.opacity = 0.5 * (1 - fade); });
    witness.light.intensity = 14 * (1 - fade);
    if (fade >= 1) {
      this.scene?.remove(witness.group);
      this.disposeObject(witness.group);
      this.chapelWitness = null;
    }
  }

  private dropCordonProps(props: { meshes: THREE.Object3D[]; boxes: THREE.Box3[] }) {
    props.meshes.forEach((mesh) => {
      this.scene?.remove(mesh);
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], mesh);
      this.disposeObject(mesh);
    });
    const dropped = new Set(props.boxes);
    this.collisionBoxes = (this.collisionBoxes ?? []).filter((box) => !dropped.has(box));
    props.meshes.length = 0;
    props.boxes.length = 0;
  }

  private clearCordon() {
    const patrol = this.cordonPatrol ?? [];
    patrol.forEach((actor) => {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], actor.group);
      this.scene?.remove(actor.group);
      this.disposeObject(actor.group);
    });
    if (patrol.length) this.actors = (this.actors ?? []).filter((actor) => !patrol.includes(actor));
    this.cordonPatrol = [];
    (this.cordonScans ?? []).forEach((scan) => {
      this.scene?.remove(scan.mesh);
      this.disposeObject(scan.mesh);
    });
    this.cordonScans = [];
    this.cordonConeGeometry = null;
    if (this.cordonProps) this.dropCordonProps(this.cordonProps);
    this.cordonGeneration = (this.cordonGeneration ?? 0) + 1;
    this.breadcrumbTarget = null;
    // The release — and anyone it freed — are part of the same one-shot beat.
    const release = this.exitRelease;
    if (release) {
      this.scene?.remove(release.group);
      this.disposeObject(release.group);
      this.collisionBoxes = (this.collisionBoxes ?? []).filter((box) => box !== release.collider);
      this.exitRelease = null;
    }
    const freed = (this.actors ?? []).filter((actor) => actor.id.startsWith('citizen-release-'));
    freed.forEach((actor) => {
      this.rayTargets = withoutSubtree(this.rayTargets ?? [], actor.group);
      this.scene?.remove(actor.group);
      this.disposeObject(actor.group);
    });
    if (freed.length) this.actors = this.actors.filter((actor) => !freed.includes(actor));
  }

  private updateCordon(delta: number) {
    const elapsed = this.elapsed ?? 0;
    // The line materializes on the approach while the opening is still live.
    if ((this.cordonAt ?? 0) > 0 && elapsed >= (this.cordonAt ?? 0)) {
      if (this.missionIndex === 0) this.spawnCordon(true);
      this.cordonAt = null;
    }
    const scans = this.cordonScans ?? [];
    if (!(this.cordonPatrol ?? []).length) return;
    const playerPosition = this.currentVehicle?.group.position ?? this.player?.position;
    if (!playerPosition) return;

    // Detection tension, not instant combat: inside a posted cone with a
    // real sight line, heat builds ~2/s toward the standing alarm at heat>6.
    // The Veil works on eyes — it and broken sight lines bleed it back down.
    const canDetect = this.missionIndex === 0 && !this.cordonAlerted && !this.veilActive;
    const range = CORDON_CONE_RANGE * (this.crouching ? 0.55 : 1);
    let spotted = false;
    scans.forEach((scan) => {
      const guard = scan.actor;
      const watching = guard.alive && guard.group.visible;
      let seeing = false;
      if (watching && canDetect) {
        seeing = cordonConeDetect(
          guard.group.position.x, guard.group.position.z, guard.group.rotation.y,
          playerPosition.x, playerPosition.z, range, CORDON_CONE_HALF_ANGLE,
        ) && this.hasLineOfSight(
          (this.tmpLosFrom ??= new THREE.Vector3()).copy(guard.group.position).setY(guard.group.position.y + 1.55),
          (this.tmpLosTo ??= new THREE.Vector3()).copy(playerPosition).setY(playerPosition.y + 1.4),
        );
      }
      spotted = spotted || seeing;
      scan.mesh.visible = watching && this.missionIndex === 0 && !this.cordonAlerted;
      scan.material.opacity = damp(scan.material.opacity, seeing ? 0.16 : 0.045, 8, delta);
    });

    if (spotted) {
      this.heat = clamp((this.heat ?? 0) + delta * CORDON_HEAT_RATE, 0, 100);
      // Pin the combat clock so the ambient cooldown can't fight the build.
      this.lastCombat = elapsed;
      this.cordonTellCooldown = (this.cordonTellCooldown ?? 0) - delta;
      if (this.cordonTellCooldown <= 0) {
        const level = clamp(this.heat / 8, 0, 1);
        this.audio.detectionTell?.(level);
        this.cordonTellCooldown = 0.9 - level * 0.45;
      }
      if (this.heat > 6) {
        // The alarm is up — the posted line becomes ordinary combat AI.
        this.cordonAlerted = true;
        this.breadcrumbTarget = null;
        this.fireCordonVox();
      }
    } else if (this.missionIndex === 0) {
      this.heat = Math.max(0, (this.heat ?? 0) - delta * 3.1);
    }

    // The Vox beat also fires when the cordon commits without the cone —
    // a guard opening up on sight, or one already down.
    const patrol = this.cordonPatrol ?? [];
    if (this.missionIndex === 0 && !this.cordonAlerted
      && patrol.some((actor) => !actor.alive || actor.aiState?.phase === 'combat')) {
      this.cordonAlerted = true;
      this.breadcrumbTarget = null;
      this.fireCordonVox();
    }

    const clearingDistance = distance2D(playerPosition.x, playerPosition.z, CORDON_CLEARING.x, CORDON_CLEARING.z);
    if (!this.cordonPassed && !this.cordonAlerted
      && this.missionIndex <= 1 && clearingDistance <= CORDON_CLEARING.radius) {
      this.cordonPassed = true;
      this.breadcrumbTarget = null;
      this.emitSubtitle('Aurel', 'Past them.');
    }
    if (this.breadcrumbTarget) {
      const nearFlank = distance2D(playerPosition.x, playerPosition.z, this.breadcrumbTarget.x, this.breadcrumbTarget.z) < 3.2;
      if (nearFlank || this.cordonPassed || this.cordonAlerted || this.missionIndex !== 0) this.breadcrumbTarget = null;
    }

    // The released door swings on its hinge until it rests open.
    const release = this.exitRelease;
    if (release?.opening) {
      release.open = Math.min(1, release.open + delta * 1.6);
      release.doorPivot.rotation.y = EXIT_RELEASE_DOOR.yaw - 1.85 * release.open;
      if (release.open >= 1) release.opening = false;
    }

    // Resolution — slipped the clearing or the whole posted line is down.
    // The cost line plays only when the release was never pulled; Beat F's
    // aftermath lands after a held breath (longer if the cost line spoke).
    if (this.missionIndex === 0 && !this.cordonResolved
      && (this.cordonPassed || (this.cordonAlerted && patrol.every((actor) => !actor.alive)))) {
      this.cordonResolved = true;
      this.spawnQuietSeraph();
      if (this.narrative?.exitReleased !== true) this.exitCostAt = elapsed + 2.6;
      if (this.narrative?.aftermathHeard !== true) {
        this.aftermathAt = elapsed + (this.exitCostAt !== null ? 8.4 : AFTERMATH_QUIET);
      }
    }
    if (this.exitCostAt !== null && elapsed >= this.exitCostAt) {
      this.exitCostAt = null;
      this.emitSubtitle('Nia', 'They held those people the whole time.');
    }
    if (this.aftermathAt !== null && elapsed >= this.aftermathAt) {
      this.aftermathAt = null;
      const narrative = (this.narrative ??= {});
      if (!narrative.aftermathHeard) {
        narrative.aftermathHeard = true;
        AFTERMATH_LINES.forEach(([speaker, text], index) => this.queueSubtitle(speaker, text, index * 2700));
        this.saveCheckpoint();
      }
    }
  }

  private updateHeat(delta: number) {
    if (this.elapsed - this.lastCombat > 8) this.heat = Math.max(0, this.heat - delta * 2.4);
  }

  private heatTierValue() {
    return heatTier(this.heat);
  }

  private updateHUD(delta: number) {
    this.hudTimer -= delta;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.09;
    const mission = MISSIONS[this.missionIndex];
    const target = this.missionTarget();
    const position = this.currentVehicle?.group.position ?? this.player.position;
    const targetDistance = target ? distance2D(position.x, position.z, target.x, target.z) : null;
    let progress = 0;
    let objectiveText = mission.summary;
    if (mission.kind === 'eliminate') {
      progress = objectiveProgress(this.defeatedWardens, mission.count ?? 5);
      objectiveText = `Wardens severed ${this.defeatedWardens}/${mission.count ?? 5}`;
    } else if (mission.kind === 'echoes') {
      progress = objectiveProgress(this.echoesActivated.size, mission.count ?? 3);
      objectiveText = `Memory echoes restored ${this.echoesActivated.size}/${mission.count ?? 3}`;
    } else if (mission.kind === 'boss' && this.boss) {
      progress = 1 - this.boss.health / this.boss.maxHealth;
      objectiveText = 'Defeat the False Archon';
    } else if (mission.kind === 'drive' && this.missionDeadline !== null) {
      const remaining = Math.max(0, this.missionDeadline - this.elapsed);
      progress = clamp(remaining / 110, 0, 1);
      objectiveText = `Meridian lockdown in ${Math.ceil(remaining)}s`;
    } else if (targetDistance !== null && mission.radius) {
      progress = clamp(1 - targetDistance / 140, 0, 0.98);
    }

    const hud: HUDState = {
      ...INITIAL_HUD,
      health: this.health,
      armor: this.armor,
      stamina: this.stamina,
      stance: this.dodgeRemaining > 0
        ? 'dodging'
        : this.slideRemaining > 0
          ? 'sliding'
          : this.coverFace
            ? 'cover'
            : this.crouching
              ? 'crouched'
              : 'standing',
      ammo: this.ammo,
      reserveAmmo: this.reserveAmmo,
      weapon: this.activeWeaponSpec().hudLabel,
      resonance: this.resonance,
      shards: this.shards,
      killStreak: this.elapsed < this.killStreakUntil ? this.killStreak : 0,
      upgrades: [...(this.ownedUpgrades ?? [])],
      heat: this.heat,
      heatTier: this.heatTierValue(),
      vehicleSpeed: this.currentVehicle ? Math.abs(this.currentVehicle.speed) * 3.6 : 0,
      vehicleIntegrity: this.currentVehicle ? Math.max(0, Math.round(100 - (this.currentVehicle.damage / 110) * 100)) : 100,
      inVehicle: Boolean(this.currentVehicle),
      veilActive: this.veilActive,
      veilCooldown: this.veilCooldown,
      pulseCooldown: this.pulseCooldown,
      objectiveTitle: mission.title,
      objectiveText,
      objectiveProgress: progress,
      objectiveDistance: targetDistance,
      contract: this.activeContract ? {
        title: this.activeContract.def.title,
        text: this.activeContract.def.kind === 'cache'
          ? `Reach the cache — ${Math.max(0, Math.ceil(this.activeContract.deadline - this.elapsed))}s`
          : `Wardens remaining — ${this.activeContract.spawned.filter((a) => a.alive).length}`,
        progress: this.activeContract.def.kind === 'cache'
          ? clamp((this.activeContract.deadline - this.elapsed) / (this.activeContract.def.seconds ?? 60), 0, 1)
          : 1 - this.activeContract.spawned.filter((a) => a.alive).length / Math.max(1, this.activeContract.spawned.length),
      } : null,
      district: this.currentDistrict(position.x, position.z),
      timeLabel: formatTime(this.worldHours),
      fps: this.fps,
      aiming: this.isAiming(),
      reticleSpread: shotSpreadRadians({
        aiming: this.isAiming(),
        movement: clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 10.5, 0, 1),
        recoil: this.weaponRecoil,
      }, this.activeWeaponSpec()) * 180 / Math.PI,
      reticleHit: this.reticleHit > 0,
      reticleKill: (this.reticleKill ?? 0) > 0,
      lowHealth: this.health <= 30 && this.health > 0,
      hitDamage: this.hitDamageTimer > 0 ? Math.max(1, Math.round(this.hitDamagePool)) : null,
      hitDamageSeq: this.hitDamageSeq,
      stats: {
        kills: this.statKills,
        shots: this.statShots,
        hits: this.statHits,
        civilians: this.statCivilians,
        distanceDriven: Math.round(this.statDistanceDriven),
        sigils: this.sigilsCollected.size,
        sigilsTotal: HeavensGateEngine.SIGIL_SPOTS.length,
      },
      reloading: this.reloading > 0,
      damageFlash: this.damageFlash,
      hitStop: this.hitStop > 0,
      damageDirection: this.damageDirection,
      bossHealth: this.boss?.alive ? clamp(this.boss.health / this.boss.maxHealth, 0, 1) : null,
      cinematic: Boolean(this.cinematic),
      photoMode: this.photoMode,
    };
    this.callbacks.onHUD(hud, this.createMapSnapshot());
  }

  private currentDistrict(x: number, z: number) {
    return DISTRICTS.find((district) => district.test(x, z))?.name ?? 'The Outer Choir';
  }

  private createMapSnapshot(): MapSnapshot {
    const position = this.currentVehicle?.group.position ?? this.player.position;
    const points: MapSnapshot['points'] = [
      { x: position.x, z: position.z, kind: 'player', rotation: this.currentVehicle?.heading ?? this.playerHeading },
    ];
    const target = this.missionTarget();
    if (target) points.push({ x: target.x, z: target.z, kind: 'objective' });
    this.actors.forEach((actor) => {
      if (!actor.alive || !actor.group.visible) return;
      if (actor.kind === 'civilian') points.push({ x: actor.group.position.x, z: actor.group.position.z, kind: 'civilian' });
      else if (actor.group.position.distanceTo(position) < 74 || this.veilActive) {
        points.push({ x: actor.group.position.x, z: actor.group.position.z, kind: 'hostile' });
      }
    });
    this.vehicles.forEach((vehicle) => {
      if (!vehicle.occupied) points.push({ x: vehicle.group.position.x, z: vehicle.group.position.z, kind: 'vehicle' });
    });
    this.gates.forEach((gate) => points.push({ x: gate.group.position.x, z: gate.group.position.z, kind: 'gate' }));
    this.echoes?.forEach((echo) => {
      if (!echo.activated && echo.group.position.distanceTo(position) < 55) {
        points.push({ x: echo.group.position.x, z: echo.group.position.z, kind: 'echo' });
      }
    });
    this.sigils?.forEach((sigil) => {
      if (sigil.collected) points.push({ x: sigil.group.position.x, z: sigil.group.position.z, kind: 'sigil' });
    });
    return { points, worldSize: WORLD_SIZE };
  }

  private updateAmbientAnimation(delta: number, time: number) {
    this.heroCharacter?.update(
      delta, time,
      clamp(this.heat / 75 + (this.mouseShootHeld ? 0.2 : 0), 0, 1),
      this.cameraPitch,
      this.grounded && !this.currentVehicle && this.vaultTimer <= 0 && this.slideRemaining <= 0,
    );
    // The one lit barrel stove — a low, uneven flicker on the chapel route.
    if (this.stoveLight) {
      this.stoveLight.intensity = 2.4 * (0.72 + Math.sin(time * 13.1) * 0.14 + Math.sin(time * 5.7 + 1.3) * 0.14);
    }
    this.gates.forEach((gate, index) => {
      gate.ring.rotation.z += delta * (0.07 + index * 0.015);
      gate.veil.scale.setScalar(0.98 + Math.sin(time * 1.4 + index) * 0.018);
      gate.veil.material.opacity = (this.veilActive ? 0.17 : 0.055) + Math.sin(time * 1.2 + index) * 0.018;
      if (gate.shaft) gate.shaft.material.opacity = 0.04 + Math.sin(time * 0.9 + index * 2.1) * 0.014 + (this.veilActive ? 0.03 : 0);
    });
    // The storm listens — Choir heat and the living Archon both thicken the
    // rain and shorten the gap between strikes.
    const storm = clamp(this.heat / 100 + (this.boss?.alive ? 0.3 : 0), 0, 1);
    if (this.rain && this.rain.mesh.visible) {
      (this.rain.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + storm * 0.22;
      const center = this.currentVehicle?.group.position ?? this.player.position;
      const { drops, count, mesh } = this.rain;
      const wrap = Math.floor(time * 9);
      const fallSpeed = 36 + storm * 16;
      for (let i = 0; i < count; i += 1) {
        let x = drops[i * 3];
        let y = drops[i * 3 + 1];
        let z = drops[i * 3 + 2];
        y -= delta * fallSpeed;
        if (y < -1.5 || Math.abs(x - center.x) > 70 || Math.abs(z - center.z) > 70) {
          y = 24 + seeded(i, wrap + i * 3) * 16;
          x = center.x + (seeded(i, wrap + i * 7 + 31) - 0.5) * 120;
          z = center.z + (seeded(i, wrap + i * 13 + 57) - 0.5) * 120;
        }
        drops[i * 3] = x;
        drops[i * 3 + 1] = y;
        drops[i * 3 + 2] = z;
        this.rainMatrix.makeTranslation(x, y, z);
        mesh.setMatrixAt(i, this.rainMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.rainSplash && this.rainSplash.mesh.visible) {
      const center = this.currentVehicle?.group.position ?? this.player.position;
      const { ages, spots, count: splashCount, mesh: splashMesh } = this.rainSplash;
      const color = this.tmpColor;
      for (let i = 0; i < splashCount; i += 1) {
        ages[i] += delta * (1 + storm * 0.7);
        if (ages[i] > 0.42) {
          ages[i] = 0;
          spots[i * 2] = center.x + (seeded(i, Math.floor(time * 7) + 11) - 0.5) * 22;
          spots[i * 2 + 1] = center.z + (seeded(i, Math.floor(time * 7) + 23) - 0.5) * 22;
        }
        const spread = 0.5 + ages[i] * 2.2;
        this.rainMatrix.makeScale(spread, 1, spread);
        this.rainMatrix.setPosition(spots[i * 2], 0.03, spots[i * 2 + 1]);
        splashMesh.setMatrixAt(i, this.rainMatrix);
        const fade = Math.max(0, 1 - ages[i] / 0.42);
        splashMesh.setColorAt(i, color.setScalar(fade * Math.sqrt(fade) * 0.35));
      }
      splashMesh.instanceMatrix.needsUpdate = true;
      if (splashMesh.instanceColor) splashMesh.instanceColor.needsUpdate = true;
    }
    this.updateLitter(delta, time);
    if (this.cloudLayer) {
      this.cloudLayer.texture.offset.x = time * 0.0045;
      this.cloudLayer.texture.offset.y = time * 0.0022;
      const eye = this.currentVehicle?.group.position ?? this.player.position;
      this.cloudLayer.mesh.position.set(eye.x, 165, eye.z);
    }
    this.updateVeilMotes(time);
    this.updateBreadcrumb(time);
    this.updateSearchlight(delta, time);
    if (this.sun && this.sunTarget) {
      const focus = this.currentVehicle?.group.position ?? this.player.position;
      const sx = Math.round(focus.x / 4) * 4;
      const sz = Math.round(focus.z / 4) * 4;
      this.sunTarget.position.set(sx, 0, sz);
      this.sun.position.set(sx - 84, 116, sz + 58);
    }
    this.updateContactShadows();
    this.echoes.forEach((echo, index) => {
      if (echo.activated) return;
      echo.group.rotation.y += delta * (0.38 + index * 0.08);
      echo.group.position.y = 2.5 + Math.sin(time * 1.2 + index) * 0.35;
    });
    if (this.objectiveMarker?.visible) {
      this.objectiveMarker.rotation.y += delta * 0.8;
      this.objectiveMarker.position.y = 4.2 + Math.sin(time * 2.1) * 0.35;
      // The beam doesn't bob — counter the group's float so the column's
      // base stays planted, and breathe the opacity instead.
      const beam = this.objectiveMarker.children.find((child) => child.name === 'objective-beam') as THREE.Mesh | undefined;
      if (beam) {
        beam.position.y = 7.8 - (this.objectiveMarker.position.y - 4.2);
        (beam.material as THREE.MeshBasicMaterial).opacity = 0.13 + Math.sin(time * 1.7) * 0.045;
      }
    }
    if (this.dust) {
      this.dust.rotation.y += delta * 0.002;
      const position = this.dust.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 1; i < position.count * 3; i += 9) {
        position.array[i] = ((Number(position.array[i]) + delta * 0.45) % 36) + 0.2;
      }
      position.needsUpdate = true;
    }
    this.lightningTimer = (this.lightningTimer ?? 9) - delta;
    if (this.lightningTimer <= 0) {
      this.lightningTimer = (10 + seeded(Math.floor(time), 360) * 26) * (1 - storm * 0.55);
      this.lightningFlash = 1;
      const loud = 0.45 + seeded(Math.floor(time), 361) * 0.55;
      const timeout = setTimeout(() => {
        this.timeouts.delete(timeout);
        this.audio.thunder(loud);
      }, 600 + seeded(Math.floor(time), 363) * 1400);
      this.timeouts.add(timeout);
    }
    if (this.stormLight) {
      if (this.lightningFlash > 0) {
        this.lightningFlash = Math.max(0, this.lightningFlash - delta * 3.4);
        const flicker = this.lightningFlash * (0.5 + seeded(Math.floor(time * 34), 362) * 0.5);
        this.stormLight.intensity = flicker * 7.5;
      } else {
        this.stormLight.intensity = 0;
      }
    }
    if (this.sun && this.skyOrb) {
      const cycle = ((this.worldHours - 5) / 24) * Math.PI * 2;
      const x = Math.cos(cycle) * 140;
      const y = Math.sin(cycle) * 90;
      this.sun.position.set(x, Math.max(8, y), -75);
      this.skyOrb.position.set(x, Math.max(24, y), -150);
      this.sun.intensity = 2.15 + Math.max(0, Math.sin(cycle)) * 3.05;
    }
  }

  private updateEffects(delta: number) {
    this.effects = this.effects.filter((effect) => {
      effect.life -= delta;
      const progress = clamp(1 - effect.life / effect.total, 0, 1);
      if (effect.mode === 'pulse') effect.object.scale.setScalar(1 + progress * 14);
      effect.object.traverse((child) => {
        if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
          const material = child.material as THREE.Material & { opacity?: number };
          if ('opacity' in material) {
            material.transparent = true;
            material.opacity = Math.max(0, 1 - progress);
          }
        }
      });
      if (effect.life <= 0) {
        this.releasePooledEffect(effect);
        return false;
      }
      return true;
    });
  }

  private releasePooledEffect(effect: { object: THREE.Object3D; pooled?: boolean }) {
    if (effect.pooled) {
      effect.object.visible = false;
    } else {
      this.scene?.remove(effect.object);
      this.disposeObject(effect.object);
    }
  }

  private requeuePooled(object: THREE.Object3D) {
    // A reused pooled object may still have a live effect entry — retire it first.
    this.effects = (this.effects ?? []).filter((effect) => effect.object !== object);
  }

  private pushEffect(effect: TimedEffect) {
    (this.effects ??= []).push(effect);
  }

  private createTracer(origin: THREE.Vector3, end: THREE.Vector3, color: number) {
    if (!this.scene) return;
    if (!this.tracerPool.length) {
      for (let i = 0; i < 20; i += 1) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.88 }));
        line.visible = false;
        line.frustumCulled = false;
        this.scene.add(line);
        this.tracerPool.push(line);
      }
    }
    const line = this.tracerPool[this.tracerCursor % this.tracerPool.length];
    this.tracerCursor += 1;
    this.requeuePooled(line);
    const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.setXYZ(0, origin.x, origin.y, origin.z);
    attribute.setXYZ(1, end.x, end.y, end.z);
    attribute.needsUpdate = true;
    const material = line.material as THREE.LineBasicMaterial;
    material.color.setHex(color);
    material.opacity = 0.88;
    line.visible = true;
    this.pushEffect({ object: line, life: 0.08, total: 0.08, mode: 'fade', pooled: true });
  }

  private createMuzzleFlash(position: THREE.Vector3) {
    if (!this.scene) return;
    if (!this.flashPool.length) {
      const flareGeometry = new THREE.SphereGeometry(0.085, 6, 4);
      for (let i = 0; i < 6; i += 1) {
        const flash = new THREE.Group();
        const flare = new THREE.Mesh(flareGeometry, new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0.95 }));
        const light = new THREE.PointLight(0xffa84d, 30, 3.4, 2);
        flash.add(flare, light);
        flash.visible = false;
        this.scene.add(flash);
        this.flashPool.push(flash);
      }
    }
    const flash = this.flashPool[this.flashCursor % this.flashPool.length];
    this.flashCursor += 1;
    this.requeuePooled(flash);
    flash.position.copy(position);
    (flash.children[0] as THREE.Mesh).scale.setScalar(0.85 + Math.random() * 0.5);
    ((flash.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.95;
    flash.visible = true;
    this.pushEffect({ object: flash, life: 0.055, total: 0.055, mode: 'fade', pooled: true });
  }

  private createImpact(position: THREE.Vector3, hostile: boolean) {
    if (!this.scene) return;
    if (!this.impactPool.length) {
      const sparkGeometry = new THREE.SphereGeometry(0.14, 6, 4);
      const chipGeometry = new THREE.BoxGeometry(0.045, 0.045, 0.045);
      const ringGeometry = new THREE.TorusGeometry(0.2, 0.018, 5, 18);
      for (let i = 0; i < 12; i += 1) {
        const material = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
        const group = new THREE.Group();
        const spark = new THREE.Mesh(sparkGeometry, material);
        group.add(spark);
        for (let chipIndex = 0; chipIndex < 5; chipIndex += 1) {
          const chip = new THREE.Mesh(chipGeometry, material);
          const angle = seeded(chipIndex + i * 13, 340) * Math.PI * 2;
          const lift = seeded(chipIndex + i * 7, 341);
          chip.position.set(Math.cos(angle) * (0.12 + lift * 0.2), lift * 0.3, Math.sin(angle) * (0.12 + lift * 0.2));
          chip.rotation.set(angle, lift * 3, angle * 0.5);
          group.add(chip);
        }
        const ring = new THREE.Mesh(ringGeometry, material);
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        group.visible = false;
        this.scene.add(group);
        this.impactPool.push(group);
      }
    }
    const group = this.impactPool[this.impactCursor % this.impactPool.length];
    this.impactCursor += 1;
    this.requeuePooled(group);
    group.position.copy(position);
    group.rotation.y = Math.random() * Math.PI * 2;
    group.scale.setScalar(1);
    (group.children[0] as THREE.Mesh).scale.setScalar(hostile ? 1.5 : 0.8);
    const material = (group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    material.color.setHex(hostile ? 0xf1cc6a : 0x96b5bd);
    material.opacity = 1;
    group.visible = true;
    this.pushEffect({ object: group, life: hostile ? 0.26 : 0.2, total: hostile ? 0.26 : 0.2, mode: 'pulse', pooled: true });
  }

  private placeDecal(point: THREE.Vector3, normal: THREE.Vector3, scale = 1) {
    if (!this.scene) return;
    if (!this.decalMesh) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      gradient.addColorStop(0, 'rgba(8,8,9,0.92)');
      gradient.addColorStop(0.4, 'rgba(10,10,12,0.72)');
      gradient.addColorStop(1, 'rgba(12,12,14,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.16), material, 96);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < 96; i += 1) mesh.setMatrixAt(i, zero);
      this.scene.add(mesh);
      this.decalMesh = mesh;
    }
    const index = this.decalCursor % 96;
    this.decalCursor += 1;
    this.decalNormal.copy(normal).normalize();
    this.decalQuaternion.setFromUnitVectors(this.decalZ, this.decalNormal);
    this.contactShadowPosition.copy(point).addScaledVector(this.decalNormal, 0.014);
    this.decalMatrix.compose(this.contactShadowPosition, this.decalQuaternion, this.litterScale.set(scale, scale, scale));
    this.decalMesh.setMatrixAt(index, this.decalMatrix);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  /** Tire marks during slides — a dedicated pool, laid under the rear axle. */
  private createSkidMarks() {
    const geometry = new THREE.PlaneGeometry(0.24, 0.9);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0x0b0d0f, transparent: true, opacity: 0.38, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, 128);
    mesh.frustumCulled = false;
    for (let i = 0; i < 128; i += 1) {
      this.rainMatrix.makeTranslation(0, -10, 0);
      mesh.setMatrixAt(i, this.rainMatrix);
    }
    this.scene.add(mesh);
    this.skidMesh = mesh;
  }

  private laySkidMark(x: number, z: number, heading: number) {
    if (!this.skidMesh) return;
    this.rainMatrix.makeRotationY(heading);
    this.rainMatrix.setPosition(x, 0.018, z);
    this.skidMesh.setMatrixAt(this.skidCursor % 128, this.rainMatrix);
    this.skidCursor += 1;
    this.skidMesh.instanceMatrix.needsUpdate = true;
  }

  private createPulseEffect(position: THREE.Vector3) {
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xdfc36e, wireframe: true, transparent: true, opacity: 0.7 }),
    );
    ring.position.copy(position).add(new THREE.Vector3(0, 1.2, 0));
    this.scene.add(ring);
    this.effects.push({ object: ring, life: 0.48, total: 0.48, mode: 'pulse' });
  }

  private createShockwave(position: THREE.Vector3) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 6, 36),
      new THREE.MeshBasicMaterial({ color: 0xd95743, transparent: true, opacity: 0.62 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(position).add(new THREE.Vector3(0, 0.16, 0));
    this.scene.add(ring);
    this.effects.push({ object: ring, life: 0.62, total: 0.62, mode: 'pulse' });
    // The shockwave scorches the street — a wide ground decal that outlives
    // the ring and reads as a burn scar.
    this.placeDecal(position, this.tmpMove.set(0, 1, 0), 26);
    const playerPosition = this.currentVehicle?.group.position ?? this.player.position;
    if (playerPosition.distanceTo(position) < 13) this.takePlayerDamage(16 * difficultyDamage(this.settings.difficulty), position);
  }

  private updatePerformance(delta: number) {
    this.fpsTimer += delta;
    this.fpsFrames += 1;
    if (this.fpsTimer >= 1) {
      this.fps = Math.round(this.fpsFrames / this.fpsTimer);
      this.fpsTimer = 0;
      this.fpsFrames = 0;
      const target = this.targetPixelRatio();
      if (this.fps < 42 && this.dynamicPixelRatio > 0.6) {
        this.dynamicPixelRatio = Math.max(0.6, this.dynamicPixelRatio - 0.12);
        this.renderer.setPixelRatio(this.dynamicPixelRatio);
        this.resize();
      } else if (this.fps > 56 && this.dynamicPixelRatio < target) {
        this.dynamicPixelRatio = Math.min(target, this.dynamicPixelRatio + 0.08);
        this.renderer.setPixelRatio(this.dynamicPixelRatio);
        this.resize();
      }
    }
  }

  getPerformanceSnapshot() {
    const frameTime = this.frameTimeSampler.summary();
    return {
      ...frameTime,
      fps: this.fps,
      pixelRatio: this.dynamicPixelRatio,
      quality: this.settings.quality,
      mode: this.mode,
      paused: this.paused,
      viewportWidth: this.renderer.domElement.clientWidth,
      viewportHeight: this.renderer.domElement.clientHeight,
      renderWidth: this.renderer.domElement.width,
      renderHeight: this.renderer.domElement.height,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  private emitSubtitle(speaker: string, text: string, duration = 3600) {
    if (!this.settings.subtitles) return;
    const line: SubtitleLine = { id: ++this.subtitleId, speaker, text, duration };
    // Aurel's face actually mouths his lines — the viseme driver was built
    // but never wired to dialogue.
    if (speaker.toLowerCase().includes('aurel')) this.heroCharacter?.speak(duration / 1000, this.subtitleId);
    this.callbacks.onSubtitle(line);
  }

  private emitToast(title: string, detail?: string, tone: ToastMessage['tone'] = 'info') {
    this.callbacks.onToast({ id: ++this.toastId, title, detail, tone });
  }

  buyUpgrade(id: string): boolean {
    const def = UPGRADES.find((upgrade) => upgrade.id === id);
    if (!def || this.ownedUpgrades.has(id)) return false;
    if (this.shards < def.cost) {
      this.emitToast('Attunement declined', `${def.name} needs ${def.cost} marks`, 'danger');
      return false;
    }
    this.shards -= def.cost;
    this.ownedUpgrades.add(id);
    if (id === 'vitals') this.health = 130;
    if (id === 'aegis') this.armor = Math.max(this.armor, 60);
    this.audio.ui(true);
    this.emitToast(`${def.name} attuned`, def.detail, 'success');
    this.saveCheckpoint();
    return true;
  }

  private saveCheckpoint(ending?: 'open' | 'seal') {
    const save = createCheckpoint({
      version: SAVE_VERSION,
      missionIndex: this.missionIndex,
      health: Math.max(35, Math.round(this.health)),
      armor: Math.round(this.armor),
      ammo: this.ammo,
      reserveAmmo: this.reserveAmmo,
      resonance: Math.round(this.resonance),
      shards: this.shards,
      upgrades: [...this.ownedUpgrades],
      defeatedWardens: this.defeatedWardens,
      echoesActivated: [...this.echoesActivated],
      sigilsCollected: [...this.sigilsCollected],
      replays: this.replays,
      elapsed: this.elapsed,
      weaponId: this.weaponId,
      weaponAmmo: {
        ...this.weaponPools,
        [this.weaponId]: { ammo: this.ammo, reserve: this.reserveAmmo },
      },
      ...(Object.keys(this.narrative ?? {}).length ? { narrative: { ...this.narrative } } : {}),
      ending,
      updatedAt: Date.now(),
    }, this.lastSave);
    if (!save) {
      this.emitToast('Checkpoint unavailable', 'The current checkpoint failed validation; the previous save is unchanged.', 'danger');
      return;
    }
    this.lastSave = save;
    this.callbacks.onSave(save);
  }

  private resize() {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.dynamicPixelRatio);
      this.composer.setSize(width, height);
    }
  }

  private disposeObject(object: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
        if (child.geometry) geometries.add(child.geometry);
        const ownedMaterials = Array.isArray(child.material) ? child.material : [child.material];
        ownedMaterials.forEach((material) => { if (material) materials.add(material); });
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.heroLoadToken += 1;
    if (this.heroCharacter) {
      this.player.remove(this.heroCharacter.object);
      this.heroCharacter.dispose();
      this.heroCharacter = null;
    }
    this.audio.dispose();
    ScannedSurfaceMaterial.onQueueDrained = null;
    this.scannedSurfaces.forEach((surface) => surface.dispose());
    this.scannedSurfaces = [];
    this.scannedGround = null;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.envMapTexture?.dispose();
    this.envMapTexture = null;
    this.streetEnvTexture?.dispose();
    this.chapelEnvTexture?.dispose();
    this.streetEnvTexture = null;
    this.chapelEnvTexture = null;
    this.stoveLight = null;
    this.chapelWindowAnchor = null;
    this.scene.environment = null;
    this.billboardTextures.forEach((texture) => texture.dispose());
    this.disposeObject(this.scene);
    this.renderer.dispose();
  }
}
