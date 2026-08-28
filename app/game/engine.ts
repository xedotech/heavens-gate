import * as THREE from 'three';
import { AudioEngine } from './audio';
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
  INITIAL_HUD,
  MISSIONS,
  type CharacterSkin,
  type EngineCallbacks,
  type GameSettings,
  type HUDState,
  type InteractionPrompt,
  type MapSnapshot,
  type SaveState,
  type SubtitleLine,
  type ToastMessage,
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

interface Vehicle {
  id: string;
  group: THREE.Group;
  spawn: THREE.Vector3;
  heading: number;
  speed: number;
  occupied: boolean;
  bodyMaterial: THREE.MeshStandardMaterial;
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
  private pointerLocked = false;

  private player = new THREE.Group();
  private playerParts: THREE.Object3D[] = [];
  private playerSkinMaterials: PlayerSkinMaterials | null = null;
  private playerVelocity = new THREE.Vector3();
  private playerHeading = 0;
  private cameraYaw = 0.12;
  private cameraPitch = 0.18;
  private grounded = true;
  private walkPhase = 0;
  private footstepTimer = 0;

  private actors: Actor[] = [];
  private vehicles: Vehicle[] = [];
  private currentVehicle: Vehicle | null = null;
  private echoes: MemoryEcho[] = [];
  private gates: GateObject[] = [];
  private phaseMaterials: THREE.MeshStandardMaterial[] = [];
  private collisionBoxes: THREE.Box3[] = [];
  private rayTargets: THREE.Object3D[] = [];
  private effects: TimedEffect[] = [];
  private objectiveMarker: THREE.Group | null = null;
  private dust: THREE.Points | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private skyOrb: THREE.Mesh | null = null;

  private keys = new Set<string>();
  private pressed = new Set<string>();
  private gamepadAxes = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, shoot: 0 };
  private lastGamepadButtons: boolean[] = [];
  private mouseShootHeld = false;
  private shotCooldown = 0;
  private reloading = 0;
  private invulnerability = 0;

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
  private dynamicPixelRatio = 1;
  private lastInteraction = '';
  private subtitleId = 0;
  private toastId = 0;
  private timeouts = new Set<ReturnType<typeof setTimeout>>();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!event.repeat) this.pressed.add(key);
    this.keys.add(key);
    if ([' ', 'tab'].includes(key)) event.preventDefault();
    if (key === 'escape' && this.mode === 'playing' && !this.paused) {
      event.preventDefault();
      this.callbacks.onPauseRequested();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.key.toLowerCase());
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.pointerLocked || this.mode !== 'playing' || this.paused) return;
    const sensitivity = this.settings.sensitivity * 0.0022;
    this.cameraYaw -= event.movementX * sensitivity;
    this.cameraPitch = clamp(this.cameraPitch - event.movementY * sensitivity, -0.24, 0.74);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.mode !== 'playing' || this.paused) return;
    if (!this.pointerLocked) {
      const lockRequest = this.canvas.requestPointerLock?.();
      if (lockRequest) void lockRequest.catch(() => { this.pointerLocked = false; });
      return;
    }
    this.mouseShootHeld = true;
    this.tryShoot();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) this.mouseShootHeld = false;
  };

  private readonly onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };

  private readonly onResize = () => this.resize();

  private readonly onVisibility = () => {
    if (document.hidden && this.mode === 'playing' && !this.paused) this.callbacks.onPauseRequested();
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
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.resize();
    this.applyQuality();
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
      this.createVehicles();
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
    this.scene.background = new THREE.Color(0x070a0d);
    this.scene.fog = new THREE.FogExp2(0x090d10, 0.0078);

    const hemisphere = new THREE.HemisphereLight(0xb9d5ec, 0x1a110a, 1.8);
    this.scene.add(hemisphere);

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

    const rim = new THREE.DirectionalLight(0x7fa6c8, 1.35);
    rim.position.set(70, 34, -90);
    this.scene.add(rim);

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
  }

  private createCity() {
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x0c1113, roughness: 0.88, metalness: 0.08 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData.blocksShot = true;
    this.scene.add(ground);
    this.rayTargets.push(ground);

    const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x11191c, roughness: 0.72, metalness: 0.16 });
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

    const windowMaterial = new THREE.MeshBasicMaterial({ color: 0xb89b58, transparent: true, opacity: 0.72 });
    const windowGeometry = new THREE.BoxGeometry(0.26, 0.13, 0.26);
    const windowCount = this.settings.quality === 'low' ? 70 : 170;
    const windows = new THREE.InstancedMesh(windowGeometry, windowMaterial, windowCount);
    for (let i = 0; i < windowCount; i += 1) {
      const building = buildingData[Math.floor(seeded(i, 31) * buildingData.length)];
      const edgeX = seeded(i, 32) > 0.5;
      const x = building.position.x + (edgeX ? (seeded(i, 33) > 0.5 ? 1 : -1) * building.scale.x * 0.51 : (seeded(i, 34) - 0.5) * building.scale.x * 0.7);
      const z = building.position.z + (!edgeX ? (seeded(i, 35) > 0.5 ? 1 : -1) * building.scale.z * 0.51 : (seeded(i, 36) - 0.5) * building.scale.z * 0.7);
      const y = 2 + seeded(i, 37) * Math.max(2, building.scale.y - 3);
      matrix.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      windows.setMatrixAt(i, matrix);
    }
    this.scene.add(windows);

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

    const weapon = new THREE.Group();
    weapon.name = 'Morrow sidearm';
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.8), armorMaterial);
    barrel.position.z = -0.28;
    weapon.add(barrel);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.3), goldMaterial);
    sight.position.set(0, 0.11, -0.24);
    weapon.add(sight);
    weapon.position.set(0.48, 1.7, -0.62);
    weapon.rotation.x = -0.08;
    this.player.add(weapon);
    this.player.userData.weapon = weapon;
    this.player.position.set(0, 0, 34);
    this.scene.add(this.player);
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

  private createVehicle(id: string, x: number, z: number, heading: number, color: number) {
    const group = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 0.76 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x090d0f, roughness: 0.24, metalness: 0.7 });
    const light = new THREE.MeshStandardMaterial({ color: 0xe5c774, emissive: 0xe5a932, emissiveIntensity: 2.2 });
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
    for (const side of [-1, 1]) {
      for (const front of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.38, 12), dark);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 1.86, 0.58, front * 2.2);
        group.add(wheel);
      }
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.12), light);
      headlight.position.set(side * 1.12, 0.92, -3.58);
      group.add(headlight);
    }
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    group.userData.vehicleId = id;
    this.scene.add(group);
    const vehicle: Vehicle = {
      id,
      group,
      spawn: group.position.clone(),
      heading,
      speed: 0,
      occupied: false,
      bodyMaterial,
    };
    this.vehicles.push(vehicle);
    return vehicle;
  }

  private createVehicles() {
    this.createVehicle('seraph-01', 26, -32, Math.PI / 2, 0x9d7b38);
    this.createVehicle('seraph-02', -30, 1, 0, 0x31434c);
    this.createVehicle('morrow-01', 60, 60, -Math.PI / 2, 0x4c3734);
    this.createVehicle('morrow-02', -90, 90, Math.PI, 0x2e3a31);
    this.createVehicle('choir-01', 116, -28, Math.PI / 2, 0x4b4b4a);
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
    };
    this.actors.push(actor);
  }

  private createActors() {
    const wardens: Array<[number, number]> = [[-10, -48], [10, -48], [-13, -61], [13, -61], [0, -67]];
    wardens.forEach(([x, z], index) => this.addActor(`warden-${index + 1}`, 'enemy', x, z, 0x302c2c, 0xd65b43, 78));

    const civilianColors = [0x35404a, 0x4a4035, 0x3d4738, 0x46384a, 0x4b4a3b];
    for (let i = 0; i < 20; i += 1) {
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
    group.position.copy(position);
    group.rotation.y = rotationY;
    this.scene.add(group);
    const gate = { group, ring, veil };
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
    this.renderer.toneMappingExposure = this.settings.highContrast ? 1.14 : 1.04;
    this.resize();
  }

  setSettings(settings: GameSettings) {
    const qualityChanged = settings.quality !== this.settings.quality || settings.highContrast !== this.settings.highContrast;
    const skinChanged = settings.characterSkin !== this.settings.characterSkin;
    this.settings = settings;
    this.audio.setVolume(settings.volume);
    if (qualityChanged) this.applyQuality();
    if (skinChanged) this.applyPlayerSkin(settings.characterSkin);
  }

  getSettings() {
    return this.settings;
  }

  async start(save?: SaveState | null) {
    if (!this.initialized) return;
    await this.audio.unlock();
    this.audio.setVolume(this.settings.volume);
    this.resetCampaign(save ?? null);
    this.mode = 'playing';
    this.paused = false;
    this.lastFrameTime = performance.now();
    this.emitMissionBriefing();
    this.updateObjectiveMarker();
    this.saveCheckpoint();
    try { await this.canvas.requestPointerLock?.(); } catch { /* Pointer lock is optional for gamepads. */ }
  }

  private resetCampaign(save: SaveState | null) {
    this.health = save?.health ?? 100;
    this.armor = save?.armor ?? 50;
    this.ammo = save?.ammo ?? 18;
    this.reserveAmmo = save?.reserveAmmo ?? 126;
    this.resonance = save?.resonance ?? 100;
    this.heat = 0;
    this.missionIndex = clamp(save?.missionIndex ?? 0, 0, MISSIONS.length - 1);
    this.defeatedWardens = save?.defeatedWardens ?? 0;
    this.echoesActivated = new Set(save?.echoesActivated ?? []);
    this.elapsed = save?.elapsed ?? 0;
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
    });
    this.actors.forEach((actor) => {
      actor.group.position.copy(actor.spawn);
      actor.health = actor.maxHealth;
      actor.alive = true;
      actor.group.visible = true;
      actor.flee = 0;
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
      this.scene.remove(this.boss.group);
      this.actors = this.actors.filter((actor) => actor !== this.boss);
      this.boss = null;
    }
    this.setVeil(false, true);
    if (this.missionIndex === 5) this.spawnBoss();
    if (save?.ending) this.applyEndingWorld(save.ending);
  }

  pause() {
    this.paused = true;
    this.mouseShootHeld = false;
    this.audio.setIntensity(0.05);
    if (document.pointerLockElement) void document.exitPointerLock();
  }

  async resume() {
    if (this.mode !== 'playing') return;
    await this.audio.unlock();
    this.paused = false;
    this.lastFrameTime = performance.now();
    try { await this.canvas.requestPointerLock?.(); } catch { /* Pointer lock is optional. */ }
  }

  isPaused() {
    return this.paused;
  }

  retryCheckpoint() {
    this.resetCampaign(this.lastSave);
    this.mode = 'playing';
    this.paused = false;
    this.emitMissionBriefing();
    this.updateObjectiveMarker();
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
  }

  returnToTitle() {
    this.mode = 'attract';
    this.paused = false;
    this.mouseShootHeld = false;
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
    const delta = Math.min(Math.max(0, (now - this.lastFrameTime) / 1000), 0.05);
    this.lastFrameTime = now;
    this.renderTime += delta;
    const time = this.renderTime;
    if (!this.initialized) return;

    if (this.mode === 'attract') {
      this.updateAttract(time, delta);
    } else if (!this.paused) {
      this.updateGame(delta, time);
    }
    this.updateAmbientAnimation(delta, time);
    this.renderer.render(this.scene, this.camera);
    this.updatePerformance(delta);
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
    this.pollGamepad();
    this.processActions();

    this.shotCooldown = Math.max(0, this.shotCooldown - delta);
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - delta);
      if (this.reloading === 0) this.finishReload();
    }
    this.invulnerability = Math.max(0, this.invulnerability - delta);
    this.veilCooldown = Math.max(0, this.veilCooldown - delta);
    this.pulseCooldown = Math.max(0, this.pulseCooldown - delta);
    this.reticleHit = Math.max(0, this.reticleHit - delta * 5);
    this.damageFlash = Math.max(0, this.damageFlash - delta * 2.4);

    if (this.mouseShootHeld && this.shotCooldown <= 0) this.tryShoot();
    if (this.gamepadAxes.shoot > 0.55 && this.shotCooldown <= 0) this.tryShoot();

    if (this.currentVehicle) this.updateVehicle(delta);
    else this.updatePlayer(delta);

    this.updateActors(delta, time);
    this.updateVeil(delta);
    this.updateEffects(delta);
    this.updateMission();
    this.updateCamera(delta);
    this.updateHeat(delta);
    this.updateHUD(delta);
    this.pressed.clear();
  }

  private processActions() {
    if (this.pressed.has('r') || this.pressed.has('gamepad-reload')) this.startReload();
    if (this.pressed.has('q') || this.pressed.has('gamepad-veil')) this.toggleVeil();
    if (this.pressed.has('f') || this.pressed.has('gamepad-pulse')) this.usePulse();
    if (this.pressed.has('e') || this.pressed.has('gamepad-interact')) this.interact();
  }

  private pollGamepad() {
    const gamepad = navigator.getGamepads?.().find((pad) => pad?.connected);
    if (!gamepad) {
      this.gamepadAxes = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, shoot: 0 };
      return;
    }
    const deadzone = (value: number) => Math.abs(value) < 0.14 ? 0 : value;
    this.gamepadAxes.moveX = deadzone(gamepad.axes[0] ?? 0);
    this.gamepadAxes.moveY = deadzone(gamepad.axes[1] ?? 0);
    this.gamepadAxes.lookX = deadzone(gamepad.axes[2] ?? 0);
    this.gamepadAxes.lookY = deadzone(gamepad.axes[3] ?? 0);
    this.gamepadAxes.shoot = gamepad.buttons[7]?.value ?? 0;

    const mappings: Array<[number, string]> = [
      [0, 'gamepad-jump'],
      [2, 'gamepad-reload'],
      [3, 'gamepad-interact'],
      [4, 'gamepad-veil'],
      [5, 'gamepad-pulse'],
      [9, 'gamepad-pause'],
    ];
    mappings.forEach(([buttonIndex, key]) => {
      const current = Boolean(gamepad.buttons[buttonIndex]?.pressed);
      if (current && !this.lastGamepadButtons[buttonIndex]) {
        this.pressed.add(key);
        if (key === 'gamepad-pause') this.callbacks.onPauseRequested();
      }
      this.lastGamepadButtons[buttonIndex] = current;
    });
    const lookSpeed = this.settings.sensitivity * 2.1 / 60;
    this.cameraYaw -= this.gamepadAxes.lookX * lookSpeed;
    this.cameraPitch = clamp(this.cameraPitch - this.gamepadAxes.lookY * lookSpeed, -0.24, 0.74);
  }

  private updatePlayer(delta: number) {
    const forwardInput = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0) - this.gamepadAxes.moveY;
    const sideInput = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0) + this.gamepadAxes.moveX;
    const inputLength = Math.hypot(forwardInput, sideInput);
    const sprint = this.keys.has('shift') || this.lastGamepadButtons[10];
    const speed = sprint ? 10.5 : 6.4;

    const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    const right = new THREE.Vector3(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
    const desired = new THREE.Vector3();
    if (inputLength > 0.05) {
      desired.addScaledVector(forward, forwardInput / Math.max(1, inputLength));
      desired.addScaledVector(right, sideInput / Math.max(1, inputLength));
      desired.multiplyScalar(speed);
      this.playerHeading = Math.atan2(desired.x, desired.z);
    }
    this.playerVelocity.x = damp(this.playerVelocity.x, desired.x, this.grounded ? 11 : 2.2, delta);
    this.playerVelocity.z = damp(this.playerVelocity.z, desired.z, this.grounded ? 11 : 2.2, delta);

    const jumpPressed = this.pressed.has(' ') || this.pressed.has('gamepad-jump');
    if (jumpPressed && this.grounded) {
      this.playerVelocity.y = 8.4;
      this.grounded = false;
      this.audio.ui(true);
    }
    this.playerVelocity.y -= 21 * delta;

    const previous = this.player.position.clone();
    this.player.position.addScaledVector(this.playerVelocity, delta);
    if (this.player.position.y <= 0) {
      this.player.position.y = 0;
      this.playerVelocity.y = 0;
      this.grounded = true;
    }
    this.clampWorld(this.player.position);
    if (this.collides(this.player.position.x, this.player.position.z, PLAYER_RADIUS)) {
      this.player.position.x = previous.x;
      this.player.position.z = previous.z;
      this.playerVelocity.x *= 0.15;
      this.playerVelocity.z *= 0.15;
    }

    this.player.rotation.y = damp(this.player.rotation.y, this.playerHeading, 14, delta);
    const movement = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    this.walkPhase += movement * delta * 1.8;
    this.playerParts.forEach((part) => {
      const side = Number(part.userData.side ?? 1);
      const limbDirection = part.userData.limb === 'arm' ? -1 : 1;
      part.rotation.x = Math.sin(this.walkPhase) * Math.min(0.62, movement * 0.06) * side * limbDirection;
    });
    this.footstepTimer -= delta;
    if (movement > 1.4 && this.grounded && this.footstepTimer <= 0) {
      this.audio.footstep(sprint);
      this.footstepTimer = sprint ? 0.29 : 0.44;
    }
  }

  private updateVehicle(delta: number) {
    const vehicle = this.currentVehicle;
    if (!vehicle) return;
    const throttle = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0) - this.gamepadAxes.moveY;
    const steering = (this.keys.has('a') ? 1 : 0) - (this.keys.has('d') ? 1 : 0) - this.gamepadAxes.moveX;
    const boost = this.keys.has('shift') || this.lastGamepadButtons[10];
    const maxSpeed = boost ? 48 : 38;
    const targetSpeed = throttle >= 0 ? throttle * maxSpeed : throttle * 18;
    vehicle.speed = damp(vehicle.speed, targetSpeed, throttle ? 2.7 : 1.8, delta);
    if (this.keys.has(' ')) vehicle.speed = damp(vehicle.speed, 0, 8, delta);
    const steerStrength = clamp(Math.abs(vehicle.speed) / 9, 0.15, 1);
    vehicle.heading += steering * steerStrength * delta * 1.42 * Math.sign(vehicle.speed || 1);
    const previous = vehicle.group.position.clone();
    vehicle.group.position.x += -Math.sin(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.position.z += -Math.cos(vehicle.heading) * vehicle.speed * delta;
    vehicle.group.rotation.y = vehicle.heading;
    this.clampWorld(vehicle.group.position, 5);
    if (this.collides(vehicle.group.position.x, vehicle.group.position.z, 2.25)) {
      vehicle.group.position.copy(previous);
      if (Math.abs(vehicle.speed) > 16) {
        this.takePlayerDamage(Math.abs(vehicle.speed) * 0.34);
        this.audio.explosion();
      }
      vehicle.speed *= -0.22;
    }
    this.player.position.copy(vehicle.group.position);
    this.audio.setEngine(vehicle.speed, true);
  }

  private clampWorld(position: THREE.Vector3, margin = 2) {
    const edge = WORLD_SIZE / 2 - margin;
    position.x = clamp(position.x, -edge, edge);
    position.z = clamp(position.z, -edge, edge);
  }

  private collides(x: number, z: number, radius: number) {
    return this.collisionBoxes.some((box) =>
      x + radius > box.min.x && x - radius < box.max.x && z + radius > box.min.z && z - radius < box.max.z,
    );
  }

  private updateCamera(delta: number) {
    const targetPosition = this.currentVehicle ? this.currentVehicle.group.position : this.player.position;
    const speed = this.currentVehicle ? Math.abs(this.currentVehicle.speed) : Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const distance = this.currentVehicle ? 10.5 + speed * 0.065 : 7.2;
    const height = this.currentVehicle ? 4.4 : 3.4;
    const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    if (this.currentVehicle && Math.abs(this.gamepadAxes.lookX) < 0.1 && !this.pointerLocked) {
      this.cameraYaw = damp(this.cameraYaw, this.currentVehicle.heading, 1.8, delta);
      forward.set(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    }
    const desiredCamera = targetPosition.clone().addScaledVector(forward, -distance);
    desiredCamera.y += height + this.cameraPitch * 5.5;
    this.camera.position.lerp(desiredCamera, 1 - Math.exp(-9 * delta));
    const lookTarget = targetPosition.clone().add(new THREE.Vector3(0, this.currentVehicle ? 1.1 : 1.75, 0));
    lookTarget.addScaledVector(forward, 4 + this.cameraPitch * 2);
    this.camera.lookAt(lookTarget);
    const targetFov = this.currentVehicle ? 58 + clamp(speed * 0.28, 0, 12) : 58;
    this.camera.fov = damp(this.camera.fov, targetFov, 4.5, delta);
    this.camera.updateProjectionMatrix();
  }

  private updateActors(delta: number, time: number) {
    const playerPosition = this.currentVehicle?.group.position ?? this.player.position;
    const activeCombat = this.missionIndex >= 1 && this.missionIndex <= 5;
    this.actors.forEach((actor, actorIndex) => {
      if (!actor.alive || !actor.group.visible) return;
      const distance = actor.group.position.distanceTo(playerPosition);
      actor.cooldown -= delta;

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
      if (hostile && distance < (actor.kind === 'boss' ? 90 : 56)) {
        const direction = playerPosition.clone().sub(actor.group.position).setY(0).normalize();
        const ideal = actor.kind === 'boss' ? 13 : 10;
        if (distance > ideal) this.moveActor(actor, direction, actor.speed, delta);
        else if (distance < ideal * 0.7) this.moveActor(actor, direction, -actor.speed * 0.45, delta);
        actor.group.rotation.y = Math.atan2(direction.x, direction.z);
        if (actor.cooldown <= 0 && distance < (actor.kind === 'boss' ? 42 : 31)) {
          this.enemyFire(actor, actor.kind === 'boss' ? 18 : 10);
          actor.cooldown = actor.kind === 'boss' ? 0.72 : 1.2 + seeded(actorIndex + Math.floor(time), 91) * 0.9;
          if (actor.kind === 'boss' && Math.floor(time) % 4 === 0) this.createShockwave(actor.group.position);
        }
      } else {
        actor.wanderAngle += Math.sin(time * 0.2 + actorIndex) * delta * 0.18;
        const offset = actor.spawn.clone().sub(actor.group.position).setY(0);
        const direction = offset.length() > 7
          ? offset.normalize()
          : new THREE.Vector3(Math.sin(actor.wanderAngle), 0, Math.cos(actor.wanderAngle));
        this.moveActor(actor, direction, actor.speed * 0.34, delta);
      }
    });
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
    const target = (this.currentVehicle?.group.position ?? this.player.position).clone().add(new THREE.Vector3(0, 1.1, 0));
    const distance = origin.distanceTo(target);
    const accuracy = actor.kind === 'boss' ? 0.84 : clamp(0.82 - distance / 140, 0.42, 0.78);
    const hits = seeded(Math.floor(this.elapsed * 17) + actor.id.length, 112) < accuracy;
    const end = hits ? target : target.clone().add(new THREE.Vector3((seeded(actor.id.length, 113) - 0.5) * 8, 3, (seeded(actor.id.length, 114) - 0.5) * 8));
    this.createTracer(origin, end, 0xd65a45);
    if (hits) this.takePlayerDamage(damage * difficultyDamage(this.settings.difficulty));
  }

  private takePlayerDamage(amount: number) {
    if (this.invulnerability > 0 || this.gameOverSent) return;
    this.invulnerability = 0.16;
    const armorAbsorb = Math.min(this.armor, amount * 0.62);
    this.armor -= armorAbsorb;
    this.health = Math.max(0, this.health - (amount - armorAbsorb));
    this.damageFlash = 1;
    this.audio.playerDamage();
    if (this.health <= 0 && !this.gameOverSent) {
      this.gameOverSent = true;
      this.mouseShootHeld = false;
      this.audio.setEngine(0, false);
      this.callbacks.onGameOver();
    }
  }

  private tryShoot() {
    if (this.shotCooldown > 0 || this.reloading > 0 || this.currentVehicle || this.paused) return;
    if (this.ammo <= 0) {
      this.audio.empty();
      this.shotCooldown = 0.25;
      if (this.reserveAmmo > 0) this.startReload();
      return;
    }
    this.ammo -= 1;
    this.shotCooldown = 0.14;
    this.audio.shoot();
    this.lastCombat = this.elapsed;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    raycaster.far = 130;
    const hits = raycaster.intersectObjects(this.rayTargets, false);
    const hit = hits[0];
    const end = hit?.point ?? this.camera.position.clone().add(raycaster.ray.direction.clone().multiplyScalar(110));
    const weapon = this.player.userData.weapon as THREE.Object3D | undefined;
    const origin = weapon ? weapon.getWorldPosition(new THREE.Vector3()) : this.player.position.clone().add(new THREE.Vector3(0, 1.6, 0));
    this.createTracer(origin, end, 0xe8c96f);
    this.createImpact(end, Boolean(hit?.object.userData.actorId));

    const actorId = hit?.object.userData.actorId as string | undefined;
    if (actorId) {
      const actor = this.actors.find((candidate) => candidate.id === actorId);
      if (actor?.alive) {
        const critical = hit.object.name === 'head';
        this.damageActor(actor, critical ? 62 : actor.kind === 'boss' ? 18 : 35, critical);
        this.reticleHit = 1;
        this.audio.hit(critical);
      }
    }
    if (this.ammo === 0 && this.reserveAmmo > 0) this.emitToast('Magazine empty', 'Press R or X to reload', 'info');
  }

  private damageActor(actor: Actor, damage: number, critical = false) {
    actor.health -= damage;
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
    actor.group.visible = false;
    this.audio.explosion();
    if (actor.id.startsWith('warden-')) {
      this.defeatedWardens += 1;
      this.emitToast('Warden severed', `${this.defeatedWardens} of 5`, 'success');
    } else if (actor.kind === 'drone') {
      this.emitToast('Choir drone disabled', 'Response network weakened', 'success');
    } else if (actor.kind === 'boss') {
      this.emitSubtitle('Archon', 'If the door opens… you will miss the cage.');
    }
  }

  private startReload() {
    if (this.reloading > 0 || this.ammo >= 18 || this.reserveAmmo <= 0 || this.currentVehicle) return;
    this.reloading = 1.05;
    this.audio.reload();
    this.emitToast('Reloading Morrow', `${this.reserveAmmo} rounds in reserve`, 'info');
  }

  private finishReload() {
    const needed = 18 - this.ammo;
    const loaded = Math.min(needed, this.reserveAmmo);
    this.ammo += loaded;
    this.reserveAmmo -= loaded;
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
    this.player.visible = false;
    this.cameraYaw = vehicle.heading;
    this.audio.ui(true);
    this.emitToast('Seraph linked', 'WASD / left stick to drive · E / Y to exit', 'success');
  }

  private exitVehicle() {
    const vehicle = this.currentVehicle;
    if (!vehicle) return;
    this.currentVehicle = null;
    vehicle.occupied = false;
    vehicle.bodyMaterial.emissiveIntensity = 0;
    this.player.visible = true;
    this.player.position.copy(vehicle.group.position).add(new THREE.Vector3(3.3, 0, 0));
    if (this.collides(this.player.position.x, this.player.position.z, PLAYER_RADIUS)) {
      this.player.position.copy(vehicle.group.position).add(new THREE.Vector3(-3.3, 0, 0));
    }
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
    if (this.currentVehicle) prompt = { action: 'E / Y', label: 'Exit Seraph' };
    else {
      const vehicle = this.vehicles.find((candidate) => candidate.group.position.distanceTo(this.player.position) < 4.8);
      if (vehicle) prompt = { action: 'E / Y', label: `Enter ${vehicle.id.startsWith('seraph') ? 'Seraph' : 'Morrow'}` };
      const echo = this.echoes.find((candidate) => !candidate.activated && candidate.group.position.distanceTo(this.player.position) < 5);
      if (echo) prompt = this.veilActive
        ? { action: 'E / Y', label: 'Restore Memory Echo' }
        : { action: 'Q / LB', label: 'Open Veil to reveal memory' };
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
      ammo: this.ammo,
      reserveAmmo: this.reserveAmmo,
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
      reticleHit: this.reticleHit > 0,
      damageFlash: this.damageFlash,
      bossHealth: this.boss?.alive ? clamp(this.boss.health / this.boss.maxHealth, 0, 1) : null,
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
    this.gates.forEach((gate, index) => {
      gate.ring.rotation.z += delta * (0.07 + index * 0.015);
      gate.veil.scale.setScalar(0.98 + Math.sin(time * 1.4 + index) * 0.018);
      gate.veil.material.opacity = (this.veilActive ? 0.17 : 0.055) + Math.sin(time * 1.2 + index) * 0.018;
    });
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
    if (this.sun && this.skyOrb) {
      const cycle = ((this.worldHours - 5) / 24) * Math.PI * 2;
      const x = Math.cos(cycle) * 140;
      const y = Math.sin(cycle) * 90;
      this.sun.position.set(x, Math.max(8, y), -75);
      this.skyOrb.position.set(x, Math.max(24, y), -150);
      this.sun.intensity = 1.4 + Math.max(0, Math.sin(cycle)) * 3.2;
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

  private createImpact(position: THREE.Vector3, hostile: boolean) {
    const material = new THREE.MeshBasicMaterial({ color: hostile ? 0xf1cc6a : 0x96b5bd, transparent: true });
    const spark = new THREE.Mesh(new THREE.SphereGeometry(hostile ? 0.22 : 0.12, 6, 4), material);
    spark.position.copy(position);
    this.scene.add(spark);
    this.effects.push({ object: spark, life: 0.22, total: 0.22, mode: 'pulse' });
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
    if (playerPosition.distanceTo(position) < 13) this.takePlayerDamage(16 * difficultyDamage(this.settings.difficulty));
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

  private emitSubtitle(speaker: string, text: string, duration = 3600) {
    if (!this.settings.subtitles) return;
    const line: SubtitleLine = { id: ++this.subtitleId, speaker, text, duration };
    this.callbacks.onSubtitle(line);
  }

  private emitToast(title: string, detail?: string, tone: ToastMessage['tone'] = 'info') {
    this.callbacks.onToast({ id: ++this.toastId, title, detail, tone });
  }

  private saveCheckpoint(ending?: 'open' | 'seal') {
    const save: SaveState = {
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
      ending,
      updatedAt: Date.now(),
    };
    this.lastSave = save;
    this.callbacks.onSave(save);
  }

  private resize() {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
        child.geometry?.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material?.dispose());
      }
    });
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
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.audio.dispose();
    this.disposeObject(this.scene);
    this.renderer.dispose();
  }
}
