import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  createNpcAiState,
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
  recoverShotRecoil,
  shotIntervalSeconds,
  shotSpreadRadians,
  transferReload,
  weaponDamage,
  type WeaponSpec,
} from './combat';
import {
  clamp,
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
import { ScannedGroundMaterial } from './scanned-materials';
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

interface Vehicle {
  id: string;
  group: THREE.Group;
  spawn: THREE.Vector3;
  heading: number;
  speed: number;
  occupied: boolean;
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
  wrecked: boolean;
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
}

const WORLD_SIZE = 340;
const PLAYER_RADIUS = 1.05;
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
  private readonly inspectionCenter = new THREE.Vector3(0, 2.05, 0);
  private inspectionHeight = 3.7;
  private grounded = true;
  private crouching = false;
  private stamina: number = MOVEMENT_SPEC.staminaMaximum;
  private slideRemaining = 0;
  private readonly slideDirection = new THREE.Vector3();
  private dodgeRemaining = 0;
  private dodgeCooldown = 0;
  private readonly dodgeDirection = new THREE.Vector3();
  private walkPhase = 0;
  private footstepTimer = 0;

  private actors: Actor[] = [];
  private radioSignals: SquadRadioSignal[] = [];
  private vehicles: Vehicle[] = [];
  private currentVehicle: Vehicle | null = null;
  private echoes: MemoryEcho[] = [];
  private gates: GateObject[] = [];
  private phaseMaterials: THREE.MeshStandardMaterial[] = [];
  private collisionBoxes: THREE.Box3[] = [];
  private rayTargets: THREE.Object3D[] = [];
  private scannedGround: ScannedGroundMaterial | null = null;
  private effects: TimedEffect[] = [];
  private objectiveMarker: THREE.Group | null = null;
  private dust: THREE.Points | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private stormLight: THREE.DirectionalLight | null = null;
  private lightningTimer = 9;
  private lightningFlash = 0;
  private reinforcementTimer = 0;
  private reinforcementSeq = 0;
  private playerSprinting = false;
  private inspectionKey: THREE.PointLight | null = null;
  private skyOrb: THREE.Mesh | null = null;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private trafficCars: TrafficCar[] = [];
  private dynamicObstacles: Array<{ x: number; z: number; radius: number }> = [];
  private cinematic: MissionCinematic | null = null;
  private hitStop = 0;
  private rain: { mesh: THREE.InstancedMesh; drops: Float32Array; count: number } | null = null;
  private corpses: Corpse[] = [];
  private drops: DropPickup[] = [];
  private envMapTexture: THREE.Texture | null = null;
  private landDip = 0;
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
  private shotCooldown = 0;
  private weaponRecoil = 0;
  private shotIndex = 0;
  private reloading = 0;
  private invulnerability = 0;
  private weaponId: WeaponId = 'morrow';
  private weaponPools: Partial<Record<WeaponId, { ammo: number; reserve: number }>> = {};

  private health = 100;
  private armor = 50;
  private ammo = 18;
  private reserveAmmo = 126;
  private resonance = 100;
  private heat = 0;
  private lastCombat = 0;
  private veilActive = false;
  private veilTimer = 0;
  private veilCooldown = 0;
  private pulseCooldown = 0;
  private reticleHit = 0;
  private hitDamagePool = 0;
  private hitDamageTimer = 0;
  private hitDamageSeq = 0;
  private damageFlash = 0;
  private missionIndex = 0;
  private defeatedWardens = 0;
  private echoesActivated = new Set<string>();
  private boss: Actor | null = null;
  private choiceRequested = false;
  private gameOverSent = false;
  private elapsed = 0;
  private worldHours = 3.28;
  private lastSave: SaveState | null = null;

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
    if (!this.pointerLocked || this.mode !== 'playing' || this.paused || this.contextLost) return;
    const sensitivity = this.settings.sensitivity * 0.0022;
    this.cameraYaw -= event.movementX * sensitivity;
    this.cameraPitch = clamp(this.cameraPitch - event.movementY * sensitivity, -0.24, 0.74);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if ((event.button !== 0 && event.button !== 2) || this.mode !== 'playing' || this.paused || this.contextLost || event.target !== this.canvas) return;
    if (!this.pointerLocked) {
      const lockRequest = this.canvas.requestPointerLock?.();
      if (lockRequest) void lockRequest.catch(() => { this.pointerLocked = false; });
      return;
    }
    if (event.button === 2) {
      this.mouseAimHeld = true;
      return;
    }
    this.mouseShootHeld = true;
    this.tryShoot();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.mouseShootHeld = false;
    if (event.button === 2) this.mouseAimHeld = false;
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (this.mode !== 'playing' || this.paused || this.contextLost || !this.pointerLocked || event.deltaY === 0) return;
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
  }

  private createComposer() {
    try {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(
        Math.max(1, size.x),
        Math.max(1, size.y),
        { type: THREE.HalfFloatType, samples: this.settings.quality === 'high' ? 4 : 2 },
      );
      this.composer?.dispose();
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(size, 0.6, 0.5, 0.82);
      composer.addPass(this.bloomPass);
      composer.addPass(new OutputPass());
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
      this.createActors();
      await this.nextFrame();
      this.callbacks.onLoadProgress(0.76, 'Tuning the gates');
      this.createGatesAndEchoes();
      this.createObjectiveMarker();
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

  private createAtmosphere() {
    this.scene.background = new THREE.Color(0x091016);
    this.scene.fog = new THREE.FogExp2(0x101920, 0.0064);

    const hemisphere = new THREE.HemisphereLight(0xc6dcf0, 0x24180f, 2.45);
    this.scene.add(hemisphere);

    const ambientBounce = new THREE.AmbientLight(0x6c8497, 0.46);
    this.scene.add(ambientBounce);

    this.sun = new THREE.DirectionalLight(0xffd98a, 3.8);
    this.sun.position.set(-84, 116, 58);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -86;
    this.sun.shadow.camera.right = 86;
    this.sun.shadow.camera.top = 86;
    this.sun.shadow.camera.bottom = -86;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.scene.add(this.sun);

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
  }

  private createCity() {
    this.scannedGround = new ScannedGroundMaterial(WORLD_SIZE, this.renderer.capabilities.getMaxAnisotropy(), () => {
      this.emitToast('Ground detail unavailable', 'The last working ground material is retained. You can keep playing.', 'info');
    });
    this.scannedGround.setQuality(this.settings.quality);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), this.scannedGround.material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData.blocksShot = true;
    this.scene.add(ground);
    this.rayTargets.push(ground);

    const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x11191c, roughness: 0.34, metalness: 0.55 });
    const laneMaterial = new THREE.MeshBasicMaterial({ color: 0x927b46, transparent: true, opacity: 0.5 });
    for (let line = -150; line <= 150; line += 30) {
      const roadX = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, 8.4), roadMaterial);
      roadX.rotation.x = -Math.PI / 2;
      roadX.position.set(0, 0.018, line);
      roadX.receiveShadow = true;
      this.scene.add(roadX);
      const roadZ = new THREE.Mesh(new THREE.PlaneGeometry(8.4, WORLD_SIZE), roadMaterial);
      roadZ.rotation.x = -Math.PI / 2;
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

    const buildingMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.47,
      metalness: 0.42,
      emissive: 0x0d1111,
      emissiveIntensity: 0.28,
    });
    this.phaseMaterials.push(buildingMaterial);
    const buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, buildingData.length);
    buildings.castShadow = this.settings.quality === 'high';
    buildings.receiveShadow = true;
    buildings.userData.blocksShot = true;
    const matrix = new THREE.Matrix4();
    buildingData.forEach((building, buildingIndex) => {
      matrix.compose(building.position, new THREE.Quaternion(), building.scale);
      buildings.setMatrixAt(buildingIndex, matrix);
      buildings.setColorAt(buildingIndex, building.color);
    });
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    this.scene.add(buildings);
    this.rayTargets.push(buildings);

    const windowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const windowGeometry = new THREE.BoxGeometry(0.66, 0.34, 0.1);
    const windowCount = this.settings.quality === 'low' ? 240 : this.settings.quality === 'medium' ? 620 : 1080;
    const windows = new THREE.InstancedMesh(windowGeometry, windowMaterial, windowCount);
    const windowColor = new THREE.Color();
    const faceQuaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
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
      windows.setMatrixAt(i, matrix);
      const pick = seeded(i, 35);
      if (pick < 0.56) windowColor.setRGB(1.15, 0.82, 0.42).multiplyScalar(0.45 + seeded(i, 36) * 0.65);
      else if (pick < 0.78) windowColor.setRGB(0.48, 0.95, 1.18).multiplyScalar(0.5 + seeded(i, 36) * 0.6);
      else if (pick < 0.9) windowColor.setRGB(2.6, 1.9, 0.85);
      else windowColor.setRGB(2.1, 0.65, 1.5);
      if (seeded(i, 38) < 0.16) windowColor.multiplyScalar(0.1);
      windows.setColorAt(i, windowColor);
    }
    windows.instanceMatrix.needsUpdate = true;
    if (windows.instanceColor) windows.instanceColor.needsUpdate = true;
    this.scene.add(windows);
    this.createNeonStrips(buildingData);
    this.createStreetlamps();
    this.createBillboards(buildingData);
    this.createRooftopProps(buildingData);
    this.createStreetProps();

    this.createLandmark(new THREE.Vector3(0, 0, -54), 0xd1ad61, 'Crown Basilica');
    this.createLandmark(new THREE.Vector3(90, 0, 76), 0x7fa7b0, 'Meridian Needle');
    this.createLandmark(new THREE.Vector3(-94, 0, 78), 0x8e8264, 'The Archive');
  }

  private districtColor(x: number, z: number) {
    if (x < -42 && z > 12) return new THREE.Color(0x252423);
    if (x > 48 && z > 12) return new THREE.Color(0x1c292d);
    if (x < -28 && z < -42) return new THREE.Color(0x222a23);
    if (x > 32 && z < -24) return new THREE.Color(0x28231d);
    return new THREE.Color(0x232a2c);
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
    const stripsH = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 0.12), neonMaterial, Math.max(1, horizontal.length));
    horizontal.forEach((strip, index) => {
      quaternion.setFromAxisAngle(upAxis, strip.yaw);
      matrix.compose(strip.position, quaternion, new THREE.Vector3(strip.length, 1, 1));
      stripsH.setMatrixAt(index, matrix);
      stripsH.setColorAt(index, strip.color);
    });
    const stripsV = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1, 0.12), neonMaterial, Math.max(1, vertical.length));
    vertical.forEach((strip, index) => {
      matrix.compose(strip.position, new THREE.Quaternion(), new THREE.Vector3(1, strip.height, 1));
      stripsV.setMatrixAt(index, matrix);
      stripsV.setColorAt(index, strip.color);
    });
    [stripsH, stripsV].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
    });
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
    const dark = new THREE.MeshStandardMaterial({ color: 0x14181a, roughness: 0.5, metalness: 0.6 });
    const headMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const coneMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.35, 1.06, 0.52),
      transparent: true,
      opacity: 0.055,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 5.0, 6), dark, lamps.length);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.12, 0.26), headMaterial, lamps.length);
    const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 4.7, 10, 1, true), coneMaterial, lamps.length);
    const matrix = new THREE.Matrix4();
    const headColor = new THREE.Color();
    lamps.forEach((lamp, index) => {
      matrix.makeTranslation(lamp.x, 2.5, lamp.z);
      poles.setMatrixAt(index, matrix);
      matrix.makeTranslation(lamp.x + lamp.armX, 4.96, lamp.z + lamp.armZ);
      heads.setMatrixAt(index, matrix);
      headColor.setRGB(1.9, 1.5, 0.72).multiplyScalar(0.85 + seeded(index, 52) * 0.3);
      heads.setColorAt(index, headColor);
      matrix.makeTranslation(lamp.x + lamp.armX, 2.62, lamp.z + lamp.armZ);
      cones.setMatrixAt(index, matrix);
    });
    [poles, heads, cones].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      this.scene.add(mesh);
    });
    cones.renderOrder = 5;
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
    const metal = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.46, metalness: 0.5 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x4c3a2c, roughness: 0.7, metalness: 0.34 });
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 0.3) });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);

    const antennaMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.07, 1, 5), dark, Math.max(1, antennas.length));
    antennas.forEach((antenna, index) => {
      matrix.compose(antenna.position, new THREE.Quaternion(), new THREE.Vector3(1, antenna.height, 1));
      antennaMesh.setMatrixAt(index, matrix);
    });
    const beaconMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 5), beaconMaterial, Math.max(1, beacons.length));
    beacons.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      beaconMesh.setMatrixAt(index, matrix);
    });
    const unitMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.68, 1.05), metal, Math.max(1, units.length));
    units.forEach((unit, index) => {
      quaternion.setFromAxisAngle(upAxis, unit.yaw);
      matrix.compose(unit.position, quaternion, new THREE.Vector3(unit.scale, 1, unit.scale));
      unitMesh.setMatrixAt(index, matrix);
    });
    const tankMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), rust, Math.max(1, tanks.length));
    tanks.forEach((tank, index) => {
      matrix.compose(tank.position, new THREE.Quaternion(), new THREE.Vector3(tank.radius, tank.height, tank.radius));
      tankMesh.setMatrixAt(index, matrix);
    });
    [antennaMesh, beaconMesh, unitMesh, tankMesh].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      this.scene.add(mesh);
    });
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
          if (!this.collides(x, z, 0.4)) bollards.push(new THREE.Vector3(x, 0.32, z));
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
    const bollardMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.42, metalness: 0.68 });
    const planterMaterial = new THREE.MeshStandardMaterial({ color: 0x22312a, roughness: 0.8, metalness: 0.08 });
    const kioskBody = new THREE.MeshStandardMaterial({ color: 0x1d2326, roughness: 0.44, metalness: 0.55 });
    const kioskScreen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.7, 2.1) });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);

    const bollardMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.11, 0.64, 6), bollardMaterial, Math.max(1, bollards.length));
    bollards.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      bollardMesh.setMatrixAt(index, matrix);
    });
    const planterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.52, 0.62), planterMaterial, Math.max(1, planters.length));
    planters.forEach((planter, index) => {
      quaternion.setFromAxisAngle(upAxis, planter.yaw);
      matrix.compose(planter.position, quaternion, new THREE.Vector3(1, 1, 1));
      planterMesh.setMatrixAt(index, matrix);
    });
    const kioskMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 2.2, 0.5), kioskBody, Math.max(1, kiosks.length));
    const screenMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.86, 1.4), kioskScreen, Math.max(1, kiosks.length));
    kiosks.forEach((kiosk, index) => {
      quaternion.setFromAxisAngle(upAxis, kiosk.yaw);
      matrix.compose(kiosk.position, quaternion, new THREE.Vector3(1, 1, 1));
      kioskMesh.setMatrixAt(index, matrix);
      const screenPos = kiosk.position.clone();
      screenPos.y += 0.1;
      screenPos.x += Math.sin(kiosk.yaw) * 0.27;
      screenPos.z += Math.cos(kiosk.yaw) * 0.27;
      matrix.compose(screenPos, quaternion, new THREE.Vector3(1, 1, 1));
      screenMesh.setMatrixAt(index, matrix);
    });
    [bollardMesh, planterMesh, kioskMesh, screenMesh].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      this.scene.add(mesh);
    });
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
      character.object.updateMatrixWorld(true);
      this.updateInspectionFraming(character.object);
      const weapon = this.player.userData.weapon as THREE.Object3D | undefined;
      if (weapon && !character.attachHeldObject(weapon)) this.restoreFallbackWeaponTransform(weapon);
      this.emitToast('Character streaming complete', `${character.boneCount} bones · ${character.morphCount} facial/body shapes`, 'success');
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

  private buildCarBody(color: number) {
    const group = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 0.76 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x090d0f, roughness: 0.24, metalness: 0.7 });
    const headlightMaterial = new THREE.MeshStandardMaterial({ color: 0xe5c774, emissive: 0xe5a932, emissiveIntensity: 2.2 });
    const tailMaterial = new THREE.MeshStandardMaterial({ color: 0x5a1018, emissive: 0xd92632, emissiveIntensity: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.72, 7.1), bodyMaterial);
    body.position.y = 0.82;
    body.castShadow = true;
    group.add(body);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(3.25, 0.42, 2.3), bodyMaterial);
    hood.position.set(0, 1.25, -2.15);
    hood.rotation.x = -0.08;
    group.add(hood);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.92, 2.55), dark);
    cabin.position.set(0, 1.47, 0.55);
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
    const { group, bodyMaterial, tailMaterial, beamMaterial, wheels } = this.buildCarBody(color);
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
      const target = car.wrecked || blocked ? 0 : car.cruise * (car.panic > 0 ? 1.8 : 1);
      car.speed = damp(car.speed, target, blocked || car.wrecked ? 9 : 2.1, delta);
      car.progress += car.speed * car.direction * delta;
      if (car.progress > 150) car.progress -= 300;
      else if (car.progress < -150) car.progress += 300;
      if (car.axis === 'x') position.set(car.progress, 0, car.lane + car.offset);
      else position.set(car.lane + car.offset, 0, car.progress);
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
      const braking = car.wrecked || blocked || car.speed < target * 0.55;
      car.tailMaterial.emissiveIntensity = damp(
        car.tailMaterial.emissiveIntensity,
        car.wrecked ? 0.06 : braking ? 3.4 : 0.95,
        9,
        delta,
      );
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
    const hunter = this.addActor(`reinforce-${this.reinforcementSeq}`, 'enemy', x, z, 0x2a2f33, 0xe05a3a, 62);
    hunter.speed = 3.95;
    this.reinforcementTimer = 14;
    this.emitToast('Choir reinforcement', 'A hunter was dispatched to your position', 'danger');
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
    this.heat = clamp(this.heat + 8, 0, 100);
    this.emitToast('Vehicle disabled', 'Choir response escalating', 'danger');
    this.audio.explosion();
  }

  private createRain() {
    const count = 850;
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

  private createActors() {
    const wardens: Array<[number, number]> = [[-10, -48], [10, -48], [-13, -61], [13, -61], [0, -67]];
    wardens.forEach(([x, z], index) => this.addActor(`warden-${index + 1}`, 'enemy', x, z, 0x302c2c, 0xd65b43, 78));

    const civilianColors = [0x35404a, 0x4a4035, 0x3d4738, 0x46384a, 0x4b4a3b, 0x2f3f46, 0x544134, 0x3a3d52];
    for (let i = 0; i < 34; i += 1) {
      const road = Math.floor(seeded(i, 70) * 9 - 4) * 30;
      const along = (seeded(i, 71) - 0.5) * 250;
      const horizontal = seeded(i, 72) > 0.5;
      this.addActor(
        `citizen-${i + 1}`,
        'civilian',
        horizontal ? along : road + (seeded(i, 73) > 0.5 ? 5.6 : -5.6),
        horizontal ? road + (seeded(i, 74) > 0.5 ? 5.6 : -5.6) : along,
        civilianColors[i % civilianColors.length],
        0x8c7a5a,
        42,
      );
    }

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
    group.renderOrder = 20;
    this.scene.add(group);
    this.objectiveMarker = group;
    this.updateObjectiveMarker();
  }

  private applyQuality() {
    const baseRatio = this.settings.quality === 'high' ? 1.6 : this.settings.quality === 'medium' ? 1.3 : 1;
    this.dynamicPixelRatio = Math.min(window.devicePixelRatio, baseRatio);
    this.renderer.setPixelRatio(this.dynamicPixelRatio);
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low';
    this.renderer.toneMappingExposure = this.settings.highContrast ? 1.28 : 1.16;
    if (this.bloomPass) {
      this.bloomPass.strength = this.settings.quality === 'high' ? 0.62 : 0.45;
      this.bloomPass.radius = 0.55;
      this.bloomPass.threshold = 0.82;
    }
    if (this.rain) this.rain.mesh.visible = this.settings.quality !== 'low';
    this.audio.setRainBed(this.settings.quality !== 'low');
    this.scannedGround?.setQuality(this.settings.quality);
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
    this.ammo = save?.ammo ?? 18;
    this.reserveAmmo = save?.reserveAmmo ?? 126;
    this.resonance = save?.resonance ?? 100;
    this.stamina = MOVEMENT_SPEC.staminaMaximum;
    this.crouching = false;
    this.slideRemaining = 0;
    this.dodgeRemaining = 0;
    this.dodgeCooldown = 0;
    this.heat = 0;
    this.reinforcementTimer = 0;
    this.missionIndex = clamp(save?.missionIndex ?? 0, 0, MISSIONS.length - 1);
    this.defeatedWardens = save?.defeatedWardens ?? 0;
    this.echoesActivated = new Set(save?.echoesActivated ?? []);
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
    this.trafficCars?.forEach((car) => {
      car.progress = car.spawnProgress;
      car.speed = 0;
      car.panic = 0;
      car.damage = 0;
      car.wrecked = false;
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
    this.veilActive = false;
    this.veilTimer = 0;
    this.veilCooldown = 0;
    this.pulseCooldown = 0;
    this.currentVehicle = null;
    this.player.visible = true;
    this.playerVelocity.set(0, 0, 0);
    const spawn = MISSION_SPAWNS[this.missionIndex] ?? MISSION_SPAWNS[0];
    this.player.position.set(spawn[0], spawn[1], spawn[2]);

    this.vehicles.forEach((vehicle) => {
      vehicle.group.position.copy(vehicle.spawn);
      vehicle.speed = 0;
      vehicle.occupied = false;
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
    this.worldHours += delta * 0.013;
    this.pollGamepad(delta);
    if (this.paused) return;
    this.processActions();
    if (this.paused) return;
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
    this.veilCooldown = Math.max(0, this.veilCooldown - delta);
    this.pulseCooldown = Math.max(0, this.pulseCooldown - delta);
    this.reticleHit = Math.max(0, this.reticleHit - delta * 5);
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
    this.updateVeil(delta);
    this.updateEffects(delta);
    this.updateMission();
    this.updateCamera(delta);
    this.updateHeat(delta);
    this.updateHUD(delta);
    this.input.finishFrame();
    this.touchPressed.clear();
  }

  private processActions() {
    if (this.wasActionPressed('inspect') && !this.currentVehicle) {
      this.photoMode = !this.photoMode;
      if (this.photoMode && document.pointerLockElement) void document.exitPointerLock();
      this.emitToast(
        this.photoMode ? 'Character inspection active' : 'Character inspection closed',
        this.photoMode ? `The camera will orbit Aurel. Press ${this.bindingLabel('inspect')} / View again to return.` : 'Third-person camera restored.',
        'success',
      );
    }
    if (this.wasActionPressed('reload')) this.startReload();
    if (this.wasActionPressed('veil')) this.toggleVeil();
    if (this.wasActionPressed('pulse')) this.usePulse();
    if (this.wasActionPressed('weaponSwap')) this.cycleWeapon();
    if (this.wasActionPressed('interact')) this.interact();
  }

  private isActionHeld(action: KeybindAction) {
    return this.input.isHeld(action, this.settings.keybinds) || (this.touchHeld?.has(action) ?? false);
  }

  private wasActionPressed(action: KeybindAction) {
    return this.input.wasPressed(action, this.settings.keybinds) || (this.touchPressed?.has(action) ?? false);
  }

  private clearInput() {
    this.input.reset();
    this.gamepadAxes = this.input.gamepadAxes;
    this.mouseShootHeld = false;
    this.mouseAimHeld = false;
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
    this.cameraPitch = clamp(this.cameraPitch + look.pitch, -0.24, 0.74);
  }

  private isAiming() {
    return this.mouseAimHeld || this.gamepadAxes.aim > 0.2 || this.touchAim;
  }

  setTouchMove(x: number, y: number) {
    this.touchMove.x = clamp(x, -1, 1);
    this.touchMove.y = clamp(y, -1, 1);
  }

  applyTouchLook(deltaX: number, deltaY: number) {
    if (this.mode !== 'playing' || this.paused) return;
    const sensitivity = this.settings.sensitivity * 0.0062;
    this.cameraYaw -= deltaX * sensitivity;
    this.cameraPitch = clamp(this.cameraPitch - deltaY * sensitivity, -0.24, 0.74);
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

    const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    const right = new THREE.Vector3(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
    const desiredDirection = new THREE.Vector3();
    if (inputLength > 0.05) {
      desiredDirection.addScaledVector(forward, forwardInput / Math.max(1, inputLength));
      desiredDirection.addScaledVector(right, sideInput / Math.max(1, inputLength));
      desiredDirection.normalize();
      this.playerHeading = Math.atan2(desiredDirection.x, desiredDirection.z);
    }
    if (aiming) this.playerHeading = Math.atan2(forward.x, forward.z);

    const crouchPressed = this.wasActionPressed('crouch');
    const planarSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
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
    this.playerSprinting = sprinting;
    this.stamina = updateStamina(this.stamina, delta, sprinting);
    const desired = desiredDirection.multiplyScalar(movementSpeed({ aiming, crouching: this.crouching, sprinting }) * Math.min(1, inputLength));
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
    if (this.player.position.y <= 0) {
      this.player.position.y = 0;
      if (!this.grounded) {
        const impact = clamp(-this.playerVelocity.y, 0, 24);
        this.landDip = Math.max(this.landDip, impact * 0.011);
        if (impact > 7) {
          this.audio.footstep(true);
          this.pulseGamepad(50, clamp(impact * 0.02, 0.1, 0.4), clamp(impact * 0.014, 0.08, 0.3));
        }
      }
      this.playerVelocity.y = 0;
      this.grounded = true;
    }
    this.clampWorld(this.player.position);
    const sweptPosition = sweepPlanarCollision(previous, this.player.position,
      (x, z) => this.collides(x, z, PLAYER_RADIUS));
    if (sweptPosition.swept) {
      this.player.position.x = sweptPosition.x;
      this.player.position.z = sweptPosition.z;
    }
    if (sweptPosition.swept || this.collides(this.player.position.x, this.player.position.z, PLAYER_RADIUS)) {
      const vaultDirection = desired.clone().setY(0);
      const vaultTarget = previous.clone();
      let vaulted = false;
      if (jumpPressed && vaultDirection.lengthSq() > 0.1 && this.stamina >= 8) {
        vaultDirection.normalize();
        vaultTarget.addScaledVector(vaultDirection, 2.35);
        if (!this.collides(vaultTarget.x, vaultTarget.z, PLAYER_RADIUS * 0.78)) {
          this.player.position.x = vaultTarget.x;
          this.player.position.z = vaultTarget.z;
          this.player.position.y = Math.max(this.player.position.y, 0.52);
          this.playerVelocity.y = Math.max(this.playerVelocity.y, 4.2);
          this.stamina = Math.max(0, this.stamina - 8);
          this.grounded = false;
          vaulted = true;
        }
      }
      if (!vaulted) {
        const resolved = sweptPosition.swept ? sweptPosition : resolvePlanarCollision(previous, this.player.position,
          (x, z) => this.collides(x, z, PLAYER_RADIUS));
        this.player.position.x = resolved.x;
        this.player.position.z = resolved.z;
        if (resolved.blockedX) this.playerVelocity.x = 0;
        if (resolved.blockedZ) this.playerVelocity.z = 0;
      }
    }

    this.player.rotation.y = smoothHeading(this.player.rotation.y, this.playerHeading, delta);
    const movement = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
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
                : movement > 0.7
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
      this.audio.footstep(sprinting);
      this.footstepTimer = sprinting ? 0.29 : 0.44;
    }
  }

  private updateVehicle(delta: number) {
    const vehicle = this.currentVehicle;
    if (!vehicle) return;
    const throttle = clamp((this.isActionHeld('moveForward') ? 1 : 0) - (this.isActionHeld('moveBackward') ? 1 : 0) - this.gamepadAxes.moveY - (this.touchMove?.y ?? 0), -1, 1);
    const steering = clamp((this.isActionHeld('moveLeft') ? 1 : 0) - (this.isActionHeld('moveRight') ? 1 : 0) - this.gamepadAxes.moveX - (this.touchMove?.x ?? 0), -1, 1);
    const boost = this.isActionHeld('sprint');
    const maxSpeed = boost ? 48 : 38;
    const targetSpeed = throttle >= 0 ? throttle * maxSpeed : throttle * 18;
    vehicle.speed = damp(vehicle.speed, targetSpeed, throttle ? 2.7 : 1.8, delta);
    if (this.isActionHeld('jump')) vehicle.speed = damp(vehicle.speed, 0, 8, delta);
    const steerStrength = clamp(Math.abs(vehicle.speed) / 9, 0.15, 1);
    vehicle.heading += steering * steerStrength * delta * 1.42 * Math.sign(vehicle.speed || 1);
    const previous = vehicle.group.position.clone();
    vehicle.group.position.x += -Math.sin(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.position.z += -Math.cos(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.rotation.y = vehicle.heading;
    this.clampWorld(vehicle.group.position, 5);
    const vehicleSweep = sweepPlanarCollision(previous, vehicle.group.position,
      (x, z) => this.collides(x, z, 2.25), 0.5);
    if (vehicleSweep.swept) {
      vehicle.group.position.x = vehicleSweep.x;
      vehicle.group.position.z = vehicleSweep.z;
      if (Math.abs(vehicle.speed) > 16) {
        this.takePlayerDamage(Math.abs(vehicle.speed) * 0.34);
        this.audio.explosion();
      }
      vehicle.speed *= -0.22;
    }
    const braking = this.isActionHeld('jump') || (throttle < 0 && vehicle.speed > 4);
    const steerVisual = steering * clamp(Math.abs(vehicle.speed) / 12, 0, 1);
    vehicle.wheels?.forEach((wheel) => {
      wheel.pivot.rotation.y = wheel.front ? -steerVisual * 0.42 : 0;
      wheel.pivot.rotation.x += (vehicle.speed * delta) / 0.52;
    });
    if (vehicle.tailMaterial) {
      vehicle.tailMaterial.emissiveIntensity = damp(vehicle.tailMaterial.emissiveIntensity, braking ? 3.4 : 0.95, 10, delta);
    }
    const targetLean = -steering * clamp(Math.abs(vehicle.speed) / 38, 0, 1) * 0.055;
    const targetPitch = braking ? -0.035 : clamp(throttle, 0, 1) * (boost ? 0.035 : 0.02);
    vehicle.group.rotation.z = damp(vehicle.group.rotation.z, targetLean, 6, delta);
    vehicle.group.rotation.x = damp(vehicle.group.rotation.x, targetPitch, 6, delta);
    this.player.position.copy(vehicle.group.position);
    this.audio.setEngine(vehicle.speed, true);
  }

  private clampWorld(position: THREE.Vector3, margin = 2) {
    const edge = WORLD_SIZE / 2 - margin;
    position.x = clamp(position.x, -edge, edge);
    position.z = clamp(position.z, -edge, edge);
  }

  private collides(x: number, z: number, radius: number) {
    const blocked = this.collisionBoxes.some((box) =>
      x + radius > box.min.x && x - radius < box.max.x && z + radius > box.min.z && z - radius < box.max.z,
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

  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3) {
    return this.firstWorldObstruction(from, to) === null;
  }

  private firstWorldObstruction(from: THREE.Vector3, to: THREE.Vector3, padding = 0) {
    const delta = to.clone().sub(from);
    const distance = delta.length();
    if (distance < 0.000001) return null;
    const ray = new THREE.Ray(from, delta.divideScalar(distance));
    const hit = new THREE.Vector3();
    let nearest: THREE.Vector3 | null = null;
    let nearestDistanceSq = distance * distance;
    const expanded = new THREE.Box3();
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
        routeCost: this.collides(position.x, position.z, 0.75) ? 1 : 0.18,
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
    if (this.photoMode && !this.currentVehicle) {
      const angle = this.elapsed * 0.22;
      const focus = targetPosition.clone().add(this.inspectionCenter).add(new THREE.Vector3(0, stanceOffset, 0));
      const inspectionFov = 48;
      const distanceToFit = (this.inspectionHeight * 1.08) / (2 * Math.tan(THREE.MathUtils.degToRad(inspectionFov * 0.5)));
      const distance = Math.max(4.8, distanceToFit);
      const desiredCamera = focus.clone().add(new THREE.Vector3(Math.sin(angle) * distance, 0.42, Math.cos(angle) * distance));
      this.camera.position.lerp(desiredCamera, 1 - Math.exp(-7 * delta));
      this.constrainCamera(focus);
      this.camera.lookAt(focus);
      this.camera.fov = damp(this.camera.fov, inspectionFov, 4.5, delta);
      this.camera.updateProjectionMatrix();
      if (this.inspectionKey) {
        const desiredLight = this.camera.position.clone().lerp(focus, 0.16).add(new THREE.Vector3(0, 0.48, 0));
        this.inspectionKey.position.lerp(desiredLight, 1 - Math.exp(-10 * delta));
        this.inspectionKey.intensity = damp(this.inspectionKey.intensity, 48, 7, delta);
      }
      return;
    }
    const aiming = !this.currentVehicle && this.isAiming();
    const distance = this.currentVehicle ? 10.5 + speed * 0.065 : aiming ? 3.15 : 4.55;
    const height = this.currentVehicle ? 4.4 : aiming ? 1.9 : 2.65;
    const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    const right = new THREE.Vector3(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
    if (this.currentVehicle && Math.abs(this.gamepadAxes.lookX) < 0.1 && !this.pointerLocked) {
      this.cameraYaw = damp(this.cameraYaw, this.currentVehicle.heading, 1.8, delta);
      forward.set(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    }
    const desiredCamera = targetPosition.clone().addScaledVector(forward, -distance);
    if (aiming) desiredCamera.addScaledVector(right, 0.78);
    this.landDip = damp(this.landDip ?? 0, 0, 9.5, delta);
    const bob = !this.settings?.reducedMotion && !this.currentVehicle && this.grounded && this.slideRemaining <= 0
      ? Math.sin((this.walkPhase ?? 0) * 2) * 0.026 * clamp(speed / 9, 0, 1)
      : 0;
    desiredCamera.y += height + stanceOffset * 0.55 + this.cameraPitch * 5.5 + bob - this.landDip;
    this.camera.position.lerp(desiredCamera, 1 - Math.exp(-9 * delta));
    this.constrainCamera(targetPosition.clone().add(new THREE.Vector3(0, 1.6 + stanceOffset, 0)));
    const lookTarget = targetPosition.clone().add(new THREE.Vector3(0, this.currentVehicle ? 1.1 : (aiming ? 1.52 : 1.6) + stanceOffset, 0));
    lookTarget.addScaledVector(forward, (aiming ? 7 : 3.25) + this.cameraPitch * 2);
    lookTarget.y += bob * 0.6 - this.landDip * 0.4;
    this.camera.lookAt(lookTarget);
    const baseFov = clamp(this.settings?.fov ?? 56, 48, 78);
    const sprintKick = !this.currentVehicle && !aiming && (this.playerSprinting ?? false) ? 3.2 : 0;
    const targetFov = this.currentVehicle ? baseFov + 2 + clamp(speed * 0.28, 0, 12) : aiming ? baseFov * 0.875 : baseFov + sprintKick;
    this.camera.fov = damp(this.camera.fov, targetFov, 4.5, delta);
    this.camera.updateProjectionMatrix();
    if (this.inspectionKey && !this.currentVehicle) {
      const desiredLight = this.camera.position.clone().lerp(targetPosition, 0.12).add(new THREE.Vector3(0, 0.72, 0));
      this.inspectionKey.position.lerp(desiredLight, 1 - Math.exp(-8 * delta));
      this.inspectionKey.intensity = damp(this.inspectionKey.intensity, aiming ? 20 : 12, 5, delta);
    } else if (this.inspectionKey) {
      this.inspectionKey.intensity = damp(this.inspectionKey.intensity, 0, 5, delta);
    }
  }

  private updateActors(delta: number, time: number) {
    const playerPosition = this.currentVehicle?.group.position ?? this.player.position;
    const activeCombat = this.missionIndex >= 1 && this.missionIndex <= 5;
    const frameRadio = [...this.radioSignals];
    this.radioSignals = [];
    this.actors.forEach((actor, actorIndex) => {
      if (!actor.alive || !actor.group.visible) return;
      const distance = actor.group.position.distanceTo(playerPosition);
      actor.cooldown -= delta;
      actor.damagePulse = Math.max(0, actor.damagePulse - delta);

      if (actor.kind === 'civilian') {
        const threatened = actor.flee > 0 || (this.heat > 12 && distance < 22);
        if (threatened) {
          actor.flee = Math.max(actor.flee, 3.5);
          const away = actor.group.position.clone().sub(playerPosition).setY(0).normalize();
          this.moveActor(actor, away, actor.speed * 2.25, delta);
          actor.flee -= delta;
        } else {
          actor.wanderAngle += Math.sin(time * 0.18 + actorIndex) * delta * 0.12;
          this.moveActor(actor, new THREE.Vector3(Math.sin(actor.wanderAngle), 0, Math.cos(actor.wanderAngle)), actor.speed * 0.42, delta);
        }
        return;
      }

      if (actor.kind === 'drone') {
        const shouldAttack = this.heatTierValue() >= 2 || (this.missionIndex === 5 && distance < 64);
        actor.group.position.y = actor.spawn.y + Math.sin(time * 1.4 + actorIndex) * 1.1;
        actor.group.rotation.z += delta * 0.65;
        if (shouldAttack && distance < 72) {
          const direction = playerPosition.clone().sub(actor.group.position).setY(0).normalize();
          this.moveActor(actor, direction, distance > 18 ? actor.speed : -actor.speed * 0.35, delta);
          actor.group.lookAt(playerPosition.x, actor.group.position.y, playerPosition.z);
          if (actor.cooldown <= 0 && distance < 48) {
            this.enemyFire(actor, 7);
            actor.cooldown = 1.45 + seeded(actorIndex + Math.floor(time), 90) * 0.7;
          }
        } else {
          actor.wanderAngle += delta * 0.25;
          actor.group.position.x = actor.spawn.x + Math.cos(actor.wanderAngle) * 7;
          actor.group.position.z = actor.spawn.z + Math.sin(actor.wanderAngle) * 7;
        }
        return;
      }

      const hostile = actor.kind === 'boss' || activeCombat || this.heat > 6;
      if (actor.aiState) {
        const actorPosition = actor.group.position;
        const toPlayer = playerPosition.clone().sub(actorPosition).setY(0);
        const playerDirection = toPlayer.clone().normalize();
        const actorForward = new THREE.Vector3(Math.sin(actor.group.rotation.y), 0, Math.cos(actor.group.rotation.y));
        const target = hostile && distance < 96 ? {
          position: { x: playerPosition.x, y: playerPosition.y + 1.4, z: playerPosition.z },
          distanceMeters: distance,
          viewAlignment: actorForward.dot(playerDirection),
          inLineOfSight: this.hasLineOfSight(actorPosition.clone().add(new THREE.Vector3(0, 1.55, 0)), playerPosition.clone().add(new THREE.Vector3(0, 1.4, 0))),
          visibility: this.veilActive && distance > 8 ? 0.18 : 1,
          movement: clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 10.5, 0, 1),
        } : undefined;
        const sound = hostile && this.elapsed - this.lastCombat < 1.35 ? {
          position: { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z },
          distanceMeters: distance,
          loudness: 0.9,
        } : undefined;
        const aiStep = stepNpcAi(actor.aiState, {
          deltaSeconds: delta,
          position: { x: actorPosition.x, y: actorPosition.y, z: actorPosition.z },
          health: actor.health,
          maxHealth: actor.maxHealth,
          target,
          sound,
          damage: actor.lastDamageAmount > 0 ? {
            amount: actor.lastDamageAmount,
            sourcePosition: { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z },
          } : undefined,
          underFire: actor.damagePulse > 0,
          coverCandidates: hostile ? this.npcCoverCandidates(actor, playerPosition) : [],
          radioSignals: frameRadio,
        });
        actor.aiState = aiStep.state;
        actor.lastDamageAmount = 0;
        if (aiStep.emittedRadio) frameRadio.push(aiStep.emittedRadio);

        const destination = aiStep.decision.destination
          ? new THREE.Vector3(aiStep.decision.destination.x, actorPosition.y, aiStep.decision.destination.z)
          : undefined;
        const aimTarget = aiStep.decision.aimTarget
          ? new THREE.Vector3(aiStep.decision.aimTarget.x, actorPosition.y + 1.4, aiStep.decision.aimTarget.z)
          : playerPosition;
        if (aiStep.decision.action === 'engage') {
          const direction = toPlayer.lengthSq() > 0.001 ? playerDirection : new THREE.Vector3(0, 0, 1);
          const ideal = actor.kind === 'boss' ? 13 : 10;
          if (distance > ideal) this.moveActor(actor, direction, actor.speed, delta);
          else if (distance < ideal * 0.7) this.moveActor(actor, direction, -actor.speed * 0.45, delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
          if (actor.cooldown <= 0 && aiStep.perception.targetSeen && distance < (actor.kind === 'boss' ? 42 : 31)) {
            this.enemyFire(actor, actor.kind === 'boss' ? 18 : 10);
            actor.cooldown = actor.kind === 'boss' ? 0.72 : 1.2 + seeded(actorIndex + Math.floor(time), 91) * 0.9;
            if (actor.kind === 'boss' && Math.floor(time) % 4 === 0) this.createShockwave(actor.group.position);
          }
        } else if (aiStep.decision.action === 'take-cover' && destination) {
          const direction = destination.sub(actorPosition).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * 1.15, delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
        } else if (aiStep.decision.action === 'react-to-damage') {
          const direction = actorPosition.clone().sub(aimTarget).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * 0.72, delta);
          actor.group.rotation.y = Math.atan2(-direction.x, -direction.z);
        } else if ((aiStep.decision.action === 'investigate' || aiStep.decision.action === 'search' || aiStep.decision.action === 'return') && destination) {
          const direction = destination.sub(actorPosition).setY(0).normalize();
          this.moveActor(actor, direction, actor.speed * (aiStep.decision.action === 'search' ? 0.78 : 0.58), delta);
          actor.group.rotation.y = Math.atan2(direction.x, direction.z);
        } else {
          actor.wanderAngle += Math.sin(time * 0.2 + actorIndex) * delta * 0.18;
          const offset = actor.spawn.clone().sub(actor.group.position).setY(0);
          const direction = offset.length() > 7
            ? offset.normalize()
            : new THREE.Vector3(Math.sin(actor.wanderAngle), 0, Math.cos(actor.wanderAngle));
          this.moveActor(actor, direction, actor.speed * 0.34, delta);
        }
      }
    });
    this.radioSignals = frameRadio.slice(-48);
    this.audio.setIntensity(clamp(this.heat / 100 + (this.missionIndex === 5 ? 0.45 : 0), 0, 1));
  }

  private moveActor(actor: Actor, direction: THREE.Vector3, speed: number, delta: number) {
    const previous = actor.group.position.clone();
    actor.group.position.addScaledVector(direction, speed * delta);
    this.clampWorld(actor.group.position, 4);
    if (actor.kind !== 'drone' && this.collides(actor.group.position.x, actor.group.position.z, 0.62)) {
      actor.group.position.copy(previous);
      actor.wanderAngle += Math.PI * 0.63;
    }
    this.animateActor(actor, Math.abs(speed), delta);
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
  }

  private enemyFire(actor: Actor, damage: number) {
    const origin = actor.group.position.clone().add(new THREE.Vector3(0, actor.kind === 'drone' ? 0 : 1.6, 0));
    this.audio.enemyShot(origin, this.camera.position, this.cameraYaw, !this.hasLineOfSight(origin, this.camera.position));
    const target = (this.currentVehicle?.group.position ?? this.player.position).clone().add(new THREE.Vector3(0, 1.1, 0));
    const distance = origin.distanceTo(target);
    const accuracy = actor.kind === 'boss' ? 0.84 : clamp(0.82 - distance / 140, 0.42, 0.78);
    const hits = seeded(Math.floor(this.elapsed * 17) + actor.id.length, 112) < accuracy;
    const end = hits ? target : target.clone().add(new THREE.Vector3((seeded(actor.id.length, 113) - 0.5) * 8, 3, (seeded(actor.id.length, 114) - 0.5) * 8));
    const obstruction = this.firstWorldObstruction(origin, end);
    const muzzle = origin.clone().addScaledVector(end.clone().sub(origin).normalize(), 0.55);
    this.createMuzzleFlash(muzzle);
    this.createTracer(origin, obstruction ?? end, 0xd65a45);
    if (hits && !obstruction) this.takePlayerDamage(damage * difficultyDamage(this.settings.difficulty), origin);
  }

  private takePlayerDamage(amount: number, source?: THREE.Vector3) {
    if (this.invulnerability > 0 || this.gameOverSent) return;
    this.invulnerability = 0.16;
    if (source) {
      const position = this.currentVehicle?.group.position ?? this.player.position;
      const bearing = Math.atan2(source.x - position.x, source.z - position.z);
      const forwardBearing = Math.atan2(-Math.sin(this.cameraYaw), -Math.cos(this.cameraYaw));
      let relative = forwardBearing - bearing;
      while (relative > Math.PI) relative -= Math.PI * 2;
      while (relative < -Math.PI) relative += Math.PI * 2;
      this.damageDirection = relative;
      this.damageDirectionTimer = 1.15;
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
      this.audio.setEngine(0, false);
      this.callbacks.onGameOver();
    }
  }

  private tryShoot() {
    if (this.shotCooldown > 0 || this.reloading > 0 || this.currentVehicle || this.paused) return;
    const spec = this.activeWeaponSpec();
    if (this.ammo <= 0) {
      this.audio.empty();
      this.shotCooldown = 0.25;
      if (this.reserveAmmo > 0) this.startReload();
      return;
    }
    this.heroCharacter?.playOnce('fire', 0.045);
    this.ammo -= 1;
    this.shotCooldown = shotIntervalSeconds(spec);
    this.weaponRecoil = addShotRecoil(this.weaponRecoil, spec);
    this.cameraPitch = clamp(this.cameraPitch + (this.isAiming() ? spec.aimCameraKick : spec.hipCameraKick), -0.24, 0.74);
    this.audio.shoot(spec.id);
    this.pulseGamepad(42, spec.pellets > 1 ? 0.8 : 0.46, spec.pellets > 1 ? 0.95 : 0.78);
    this.lastCombat = this.elapsed;

    const mount = this.player.userData.weapon as THREE.Object3D | undefined;
    const activeModel = mount?.children.find((child) => child.visible) ?? mount;
    const muzzleOffset = (activeModel?.userData.muzzle as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -0.47);
    const origin = activeModel
      ? activeModel.localToWorld(muzzleOffset.clone())
      : this.player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
    this.createMuzzleFlash(origin);

    const movement = clamp(Math.hypot(this.playerVelocity.x, this.playerVelocity.z) / 10.5, 0, 1);
    const spread = shotSpreadRadians({ aiming: this.isAiming(), movement, recoil: this.weaponRecoil }, spec);
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
          this.audio.hit(critical);
        }
      }
    }
    if (landedHit) this.reticleHit = 1;
    if (this.ammo === 0 && this.reserveAmmo > 0) this.emitToast('Magazine empty', `Press ${this.bindingLabel('reload')} or X to reload`, 'info');
  }

  private damageActor(actor: Actor, damage: number, critical = false) {
    actor.health -= damage;
    if (this.hitDamageTimer <= 0) {
      this.hitDamagePool = 0;
      this.hitDamageSeq += 1;
    }
    this.hitDamagePool += damage;
    this.hitDamageTimer = 0.85;
    actor.lastDamageAmount = Math.max(actor.lastDamageAmount, damage);
    actor.damagePulse = Math.max(actor.damagePulse, critical ? 0.75 : 0.48);
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
      this.heat = clamp(this.heat + (actor.kind === 'boss' ? 2 : 6), 0, 100);
    }
    this.lastCombat = this.elapsed;
    if (actor.health <= 0) this.killActor(actor);
  }

  private killActor(actor: Actor) {
    actor.alive = false;
    this.audio.explosion();
    if (actor.kind !== 'civilian' && !this.settings.reducedMotion) this.hitStop = Math.max(this.hitStop, actor.kind === 'boss' ? 0.22 : 0.085);
    const total = actor.kind === 'boss' ? 2.6 : actor.kind === 'drone' ? 1.15 : 1.6;
    actor.materials.forEach((material) => { material.transparent = true; });
    (this.corpses ??= []).push({
      group: actor.group,
      materials: actor.materials,
      life: total,
      total,
      tip: actor.kind === 'drone' ? 0 : (Math.PI / 2) * (seeded(actor.id.length, 311) > 0.5 ? 1 : -1),
    });
    this.spawnDrop(actor);
    if (actor.id.startsWith('warden-')) {
      this.defeatedWardens += 1;
      this.emitToast('Warden severed', `${this.defeatedWardens} of 5`, 'success');
    } else if (actor.id.startsWith('sentinel-')) {
      this.emitToast('Sentinel broken', 'Heavy patrol neutralized', 'success');
    } else if (actor.id.startsWith('stalker-')) {
      this.emitToast('Stalker silenced', 'Fast patrol neutralized', 'success');
    } else if (actor.id.startsWith('reinforce-')) {
      this.emitToast('Hunter down', 'Reinforcement destroyed', 'success');
    } else if (actor.kind === 'drone') {
      this.emitToast('Choir drone disabled', 'Response network weakened', 'success');
    } else if (actor.kind === 'boss') {
      this.emitSubtitle('Archon', 'If the door opens… you will miss the cage.');
      this.beginCinematic(actor.group.position.clone());
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
    if (this.reloading > 0 || this.ammo >= spec.magazineSize || this.reserveAmmo <= 0 || this.currentVehicle) return;
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
      this.scene.fog.density = active ? 0.011 : 0.0078;
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
    if (!active && this.lastSave?.ending) this.applyEndingWorld(this.lastSave.ending);
  }

  private updateVeil(delta: number) {
    if (this.veilActive) {
      this.veilTimer -= delta;
      this.resonance = Math.max(0, this.resonance - delta * 1.4);
      if (this.veilTimer <= 0 || this.resonance <= 0) this.setVeil(false);
    } else {
      this.resonance = Math.min(100, this.resonance + delta * 2.1);
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
        const knock = actor.group.position.clone().sub(origin).setY(0).normalize();
        actor.group.position.addScaledVector(knock, Math.max(1, 7 - distance * 0.3));
      }
    });
  }

  private interact() {
    if (this.currentVehicle) {
      this.exitVehicle();
      return;
    }
    const nearbyVehicle = this.vehicles
      .filter((vehicle) => !vehicle.occupied)
      .sort((a, b) => a.group.position.distanceTo(this.player.position) - b.group.position.distanceTo(this.player.position))[0];
    if (nearbyVehicle && nearbyVehicle.group.position.distanceTo(this.player.position) < 4.8) {
      this.enterVehicle(nearbyVehicle);
      return;
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
    this.currentVehicle = vehicle;
    vehicle.occupied = true;
    vehicle.bodyMaterial.emissive.setHex(0x4c3612);
    vehicle.bodyMaterial.emissiveIntensity = 0.5;
    if (vehicle.spot) vehicle.spot.intensity = 640;
    this.player.visible = false;
    this.cameraYaw = vehicle.heading;
    this.audio.ui(true);
    const driveKeys = ['moveForward', 'moveLeft', 'moveBackward', 'moveRight'].map((action) => this.bindingLabel(action as KeybindAction)).join(' / ');
    this.emitToast('Seraph linked', `${driveKeys} / left stick to drive · ${this.bindingLabel('jump')} / A to brake · ${this.bindingLabel('interact')} / Y to exit`, 'success');
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
    } else if (mission.kind === 'drive' && mission.target && this.currentVehicle) {
      if (distance2D(playerPosition.x, playerPosition.z, mission.target[0], mission.target[2]) <= (mission.radius ?? 10)) this.completeMission();
    } else if (mission.kind === 'echoes' && this.echoesActivated.size >= (mission.count ?? 3)) {
      this.completeMission();
    } else if (mission.kind === 'boss') {
      if (!this.boss) this.spawnBoss();
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
    this.emitToast('BOSS // FALSE ARCHON', 'Break the halo. Silence the voice.', 'danger');
    this.beginCinematic(actor.group.position.clone());
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
    const target = this.missionTarget();
    this.objectiveMarker.visible = Boolean(target && mission.kind !== 'complete');
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

  private updateInteractionPrompt() {
    let prompt: InteractionPrompt | null = null;
    const interact = `${this.bindingLabel('interact')} / Y`;
    if (this.currentVehicle) prompt = { action: interact, label: 'Exit Seraph' };
    else {
      const vehicle = this.vehicles.find((candidate) => candidate.group.position.distanceTo(this.player.position) < 4.8);
      if (vehicle) prompt = { action: interact, label: `Enter ${vehicle.id.startsWith('seraph') ? 'Seraph' : 'Morrow'}` };
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
          : this.crouching
            ? 'crouched'
            : 'standing',
      ammo: this.ammo,
      reserveAmmo: this.reserveAmmo,
      weapon: this.activeWeaponSpec().hudLabel,
      resonance: this.resonance,
      heat: this.heat,
      heatTier: this.heatTierValue(),
      vehicleSpeed: this.currentVehicle ? Math.abs(this.currentVehicle.speed) * 3.6 : 0,
      inVehicle: Boolean(this.currentVehicle),
      veilActive: this.veilActive,
      veilCooldown: this.veilCooldown,
      pulseCooldown: this.pulseCooldown,
      objectiveTitle: mission.title,
      objectiveText,
      objectiveProgress: progress,
      objectiveDistance: targetDistance,
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
      hitDamage: this.hitDamageTimer > 0 ? Math.max(1, Math.round(this.hitDamagePool)) : null,
      hitDamageSeq: this.hitDamageSeq,
      reloading: this.reloading > 0,
      damageFlash: this.damageFlash,
      damageDirection: this.damageDirection,
      bossHealth: this.boss?.alive ? clamp(this.boss.health / this.boss.maxHealth, 0, 1) : null,
      cinematic: Boolean(this.cinematic),
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
    return { points, worldSize: WORLD_SIZE };
  }

  private updateAmbientAnimation(delta: number, time: number) {
    this.heroCharacter?.update(delta, time, clamp(this.heat / 75 + (this.mouseShootHeld ? 0.2 : 0), 0, 1));
    this.gates.forEach((gate, index) => {
      gate.ring.rotation.z += delta * (0.07 + index * 0.015);
      gate.veil.scale.setScalar(0.98 + Math.sin(time * 1.4 + index) * 0.018);
      gate.veil.material.opacity = (this.veilActive ? 0.17 : 0.055) + Math.sin(time * 1.2 + index) * 0.018;
      if (gate.shaft) gate.shaft.material.opacity = 0.04 + Math.sin(time * 0.9 + index * 2.1) * 0.014 + (this.veilActive ? 0.03 : 0);
    });
    if (this.rain && this.rain.mesh.visible) {
      const center = this.currentVehicle?.group.position ?? this.player.position;
      const { drops, count, mesh } = this.rain;
      const wrap = Math.floor(time * 9);
      for (let i = 0; i < count; i += 1) {
        let x = drops[i * 3];
        let y = drops[i * 3 + 1];
        let z = drops[i * 3 + 2];
        y -= delta * 36;
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
    this.echoes.forEach((echo, index) => {
      if (echo.activated) return;
      echo.group.rotation.y += delta * (0.38 + index * 0.08);
      echo.group.position.y = 2.5 + Math.sin(time * 1.2 + index) * 0.35;
    });
    if (this.objectiveMarker?.visible) {
      this.objectiveMarker.rotation.y += delta * 0.8;
      this.objectiveMarker.position.y = 4.2 + Math.sin(time * 2.1) * 0.35;
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
      this.lightningTimer = 10 + seeded(Math.floor(time), 360) * 26;
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
        this.scene.remove(effect.object);
        this.disposeObject(effect.object);
        return false;
      }
      return true;
    });
  }

  private createTracer(origin: THREE.Vector3, end: THREE.Vector3, color: number) {
    const geometry = new THREE.BufferGeometry().setFromPoints([origin, end]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.88 }));
    this.scene.add(line);
    this.effects.push({ object: line, life: 0.08, total: 0.08, mode: 'fade' });
  }

  private createMuzzleFlash(position: THREE.Vector3) {
    if (!this.scene) return;
    const flash = new THREE.Group();
    const flare = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0.95 }),
    );
    const light = new THREE.PointLight(0xffa84d, 34, 4.5, 2);
    flash.position.copy(position);
    flash.add(flare, light);
    this.scene.add(flash);
    this.effects.push({ object: flash, life: 0.055, total: 0.055, mode: 'fade' });
  }

  private createImpact(position: THREE.Vector3, hostile: boolean) {
    const group = new THREE.Group();
    group.position.copy(position);
    const color = hostile ? 0xf1cc6a : 0x96b5bd;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const spark = new THREE.Mesh(new THREE.SphereGeometry(hostile ? 0.2 : 0.11, 6, 4), material);
    group.add(spark);
    for (let i = 0; i < 5; i += 1) {
      const chip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.045), material);
      const angle = seeded(i + Math.floor(position.x * 13), 340) * Math.PI * 2;
      const lift = seeded(i + Math.floor(position.z * 7), 341);
      chip.position.set(Math.cos(angle) * (0.12 + lift * 0.2), lift * 0.3, Math.sin(angle) * (0.12 + lift * 0.2));
      chip.rotation.set(angle, lift * 3, angle * 0.5);
      group.add(chip);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.018, 5, 18), material);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    this.scene.add(group);
    this.effects.push({ object: group, life: hostile ? 0.26 : 0.2, total: hostile ? 0.26 : 0.2, mode: 'pulse' });
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
      if (this.settings.quality === 'high' && this.fps < 36 && this.dynamicPixelRatio > 0.85) {
        this.dynamicPixelRatio = Math.max(0.85, this.dynamicPixelRatio - 0.1);
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
    if (speaker.toLowerCase().includes('aurel')) this.heroCharacter?.speak(duration / 1000, this.subtitleId);
    this.callbacks.onSubtitle(line);
  }

  private emitToast(title: string, detail?: string, tone: ToastMessage['tone'] = 'info') {
    this.callbacks.onToast({ id: ++this.toastId, title, detail, tone });
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
      defeatedWardens: this.defeatedWardens,
      echoesActivated: [...this.echoesActivated],
      elapsed: this.elapsed,
      weaponId: this.weaponId,
      weaponAmmo: {
        ...this.weaponPools,
        [this.weaponId]: { ammo: this.ammo, reserve: this.reserveAmmo },
      },
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
    this.scannedGround?.dispose();
    this.scannedGround = null;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.envMapTexture?.dispose();
    this.envMapTexture = null;
    this.scene.environment = null;
    this.billboardTextures.forEach((texture) => texture.dispose());
    this.disposeObject(this.scene);
    this.renderer.dispose();
  }
}
