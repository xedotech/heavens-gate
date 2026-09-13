import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { CharacterSkin } from './types';

export type CharacterMotion = 'idle' | 'walk' | 'run' | 'crouch' | 'slide' | 'aim' | 'reload' | 'jump' | 'fire' | 'hit' | 'death';

// MPFB exports the MakeHuman source at a 0.1 metre unit scale. Keep the
// authored mesh untouched and normalize it once at the gameplay root so the
// hero's feet, camera, collision capsule, and weapon sockets share world units.
export const HERO_CHARACTER_SCALE = 2.35;

const CLIP_NAMES: Record<CharacterMotion, string> = {
  idle: 'HG_Idle',
  walk: 'HG_Walk',
  run: 'HG_Run',
  crouch: 'HG_Crouch',
  slide: 'HG_Slide',
  aim: 'HG_Aim',
  reload: 'HG_Reload',
  jump: 'HG_Jump',
  fire: 'HG_Fire',
  hit: 'HG_Hit',
  death: 'HG_Death',
};

const CHARACTER_MANIFEST_URL = '/assets/characters/manifest.json';
const CHARACTER_ASSET_TIMEOUT_MS = 20_000;
const CHARACTER_ASSET_RETRIES = 2;

interface CharacterManifestEntry {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
  bones: number;
  morphTargets: number;
  meshes: number;
  actions: number;
}

interface CharacterManifest {
  schemaVersion: number;
  compilerVersion: string;
  delivery: {
    format: string;
    boneCount: number;
    morphTargetCount: number;
    meshCount: number;
    actionCount: number;
  };
  characters: CharacterManifestEntry[];
}

let characterManifestPromise: Promise<CharacterManifest> | null = null;

function manifestError(message: string): Error {
  return new Error(`Character manifest rejected: ${message}`);
}

function validateCharacterManifest(value: unknown): CharacterManifest {
  if (!value || typeof value !== 'object') throw manifestError('response was not an object');
  const manifest = value as Partial<CharacterManifest>;
  if (manifest.schemaVersion !== 2) throw manifestError(`schema ${String(manifest.schemaVersion)} is unsupported`);
  if (typeof manifest.compilerVersion !== 'string' || !manifest.compilerVersion) {
    throw manifestError('compiler version is missing');
  }
  const delivery = manifest.delivery;
  if (!delivery || delivery.format !== 'glTF 2.0 binary' || delivery.boneCount !== 53 ||
    delivery.morphTargetCount !== 67 || delivery.meshCount !== 9 || delivery.actionCount !== 11) {
    throw manifestError('delivery contract does not match the runtime contract');
  }
  if (!Array.isArray(manifest.characters) || manifest.characters.length < 1) {
    throw manifestError('no character entries were published');
  }
  for (const entry of manifest.characters) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.file !== 'string' ||
      !/^aurel-[a-z0-9-]+-hero\.glb$/u.test(entry.file) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) || entry.bytes <= 0 || entry.bones !== 53 ||
      entry.morphTargets !== 67 || entry.meshes !== 9 || entry.actions !== 11) {
      throw manifestError(`entry ${String(entry?.id)} is incomplete or violates the 53:67:9:11 contract`);
    }
  }
  return manifest as CharacterManifest;
}

async function loadCharacterManifest(): Promise<CharacterManifest> {
  if (!characterManifestPromise) {
    characterManifestPromise = fetch(CHARACTER_MANIFEST_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw manifestError(`HTTP ${response.status}`);
        return validateCharacterManifest(await response.json());
      })
      .catch((error) => {
        characterManifestPromise = null;
        throw error;
      });
  }
  return characterManifestPromise;
}

function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return Promise.resolve('');
  return globalThis.crypto.subtle.digest('SHA-256', bytes).then((digest) => (
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  ));
}

async function fetchCharacterBinary(url: string, expectedBytes: number, onProgress?: (progress: number) => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < CHARACTER_ASSET_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), CHARACTER_ASSET_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: 'force-cache', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onProgress?.(0.08);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(`expected ${expectedBytes} bytes, received ${bytes.byteLength}`);
      }
      onProgress?.(0.9);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < CHARACTER_ASSET_RETRIES) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 180 * (attempt + 1)));
      }
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Character asset request failed: ${detail}`);
}

const LOOPING = new Set<CharacterMotion>(['idle', 'walk', 'run', 'crouch', 'aim']);
const FACIAL_CHANNELS = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'browDownLeft',
  'browDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'viseme_aa',
  'viseme_E',
  'viseme_O',
  'viseme_PP',
] as const;

interface MorphBinding {
  influences: number[];
  channels: Map<string, number>;
}

function installOutfitBodyMask(material: THREE.MeshStandardMaterial) {
  if (material.userData.hgOutfitBodyMask) return;
  material.userData.hgOutfitBodyMask = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vHgRestPosition;',
      )
      .replace(
        '#include <begin_vertex>',
        'vHgRestPosition = position;\n#include <begin_vertex>',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vHgRestPosition;',
      )
      .replace(
        '#include <alphatest_fragment>',
        [
          '#include <alphatest_fragment>',
          '// Recreate MakeHuman delete-verts coverage after glTF export.',
          'float hgBelowCollar = 1.0 - step(1.335, vHgRestPosition.y);',
          'float hgHand = step(0.405, abs(vHgRestPosition.x)) * step(0.56, vHgRestPosition.y);',
          'if (hgBelowCollar > 0.5 && hgHand < 0.5) discard;',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'hg-outfit-body-mask-v1';
  material.needsUpdate = true;
}

function isRenderableMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh || object instanceof THREE.SkinnedMesh;
}

function createSkinMicroNormal() {
  const size = 64;
  const height = new Float32Array(size * size);
  let seed = 0x6d2b79f5;
  for (let index = 0; index < height.length; index += 1) {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    height[index] = ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  }
  const data = new Uint8Array(size * size * 4);
  const sample = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * 0.7;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * 0.7;
      const normal = new THREE.Vector3(-dx, -dy, 1).normalize();
      const offset = (y * size + x) * 4;
      data[offset] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'HG skin micro-normal';
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(42, 42);
  texture.needsUpdate = true;
  return texture;
}

function tuneMaterial(material: THREE.Material, anisotropy: number) {
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  const name = material.name.toLowerCase();
  const role = typeof material.userData.hg_material_role === 'string' ? material.userData.hg_material_role : '';
  const isSkin = role === 'skin' || name.endsWith('.body');
  const isEye = role === 'eye' || name.includes('high-poly') || name.includes('.eye');
  const isHair = role === 'hair' || ['short', 'hair', 'bob', 'braid', 'ponytail'].some((token) => name.includes(token));
  const isBrowOrLash = ['eyebrow', 'eyelash'].includes(role) || name.includes('eyebrow') || name.includes('eyelash');
  const isCloth = role === 'cloth' || name.includes('suit') || name.includes('coat') || name.includes('shirt');
  const isFootwear = role === 'footwear' || name.includes('shoe') || name.includes('boot');
  const isTeeth = role === 'teeth' || name.includes('teeth');
  const usesCutout = isBrowOrLash || isHair || isEye;
  material.transparent = false;
  material.alphaTest = isEye ? 0.1 : isBrowOrLash ? 0.3 : isHair ? 0.24 : 0;
  material.depthWrite = true;
  material.side = usesCutout ? THREE.DoubleSide : THREE.FrontSide;
  material.dithering = isSkin || usesCutout;
  material.envMapIntensity = isEye ? 2.1 : isSkin ? 0.88 : isFootwear ? 0.92 : 0.7;
  if (isSkin) {
    material.roughness = 0.58;
    material.metalness = 0;
    if (!material.normalMap) material.normalMap = createSkinMicroNormal();
    material.normalScale.set(0.18, 0.18);
    installOutfitBodyMask(material);
  } else if (isEye) {
    material.roughness = 0.08;
    material.metalness = 0;
  } else if (isHair || isBrowOrLash) {
    material.roughness = 0.74;
    material.metalness = 0;
  } else if (isCloth) {
    material.roughness = 0.86;
    material.metalness = 0;
    if (material instanceof THREE.MeshPhysicalMaterial) material.clearcoat = 0;
  } else if (isFootwear) {
    material.roughness = 0.38;
    material.metalness = 0.03;
  } else if (isTeeth) {
    material.roughness = 0.28;
    material.metalness = 0;
  }
  for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
    if (texture) texture.anisotropy = anisotropy;
  }
  material.needsUpdate = true;
}

export class HeroCharacter {
  readonly object: THREE.Group;
  readonly clips: readonly THREE.AnimationClip[];
  readonly boneCount: number;
  readonly morphCount: number;

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterMotion, THREE.AnimationAction>();
  private readonly morphs: MorphBinding[] = [];
  private readonly rightHand: THREE.Bone | null;
  private readonly spineBones: THREE.Bone[] = [];
  private readonly rightGripBones: Array<{ bone: THREE.Bone; bind: THREE.Quaternion; curl: number }>;
  private aimPitchTarget = 0;
  private aimPitchCurrent = 0;
  private heldObject: THREE.Object3D | null = null;
  // `null` is intentional: the first call to setMotion('idle') must start the
  // authored idle clip instead of being treated as a no-op against the
  // source rig's rest pose (which is an A-pose).
  private activeMotion: CharacterMotion | null = null;
  private activeAction: THREE.AnimationAction | null = null;
  private requestedMotion: CharacterMotion = 'idle';
  private oneShotRemaining = 0;
  private speakingRemaining = 0;
  private speechSeed = 0;
  private nextBlink = 1.2;
  private blinkPhase = 0;
  private disposed = false;

  constructor(object: THREE.Group, clips: THREE.AnimationClip[], anisotropy: number) {
    this.object = object;
    this.clips = clips;
    this.mixer = new THREE.AnimationMixer(object);
    let bones = 0;
    let morphs = 0;
    let rightHand: THREE.Bone | null = null;
    const rightGripBones: Array<{ bone: THREE.Bone; bind: THREE.Quaternion; curl: number }> = [];

    object.traverse((child) => {
      if (child instanceof THREE.Bone) {
        bones += 1;
        if (child.name.toLowerCase() === 'hand_r') rightHand = child;
        if (/^spine_0[23]$/i.test(child.name)) this.spineBones.push(child);
        const finger = child.name.match(/^(thumb|index|middle|ring|pinky)_0([1-3])_r$/i);
        if (finger) {
          const segment = Number(finger[2]);
          const isThumb = finger[1].toLowerCase() === 'thumb';
          const isTriggerFinger = finger[1].toLowerCase() === 'index';
          const curl = isThumb
            ? [0, 0.18, 0.28, 0.2][segment]
            : isTriggerFinger
            ? [0, 0.12, 0.08, 0.05][segment]
            : [0, 0.42, 0.62, 0.46][segment];
          rightGripBones.push({ bone: child, bind: child.quaternion.clone(), curl });
        }
      }
      if (!isRenderableMesh(child)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = true;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => tuneMaterial(material, anisotropy));
      if (child.morphTargetDictionary && child.morphTargetInfluences) {
        const channels = new Map<string, number>();
        for (const channel of FACIAL_CHANNELS) {
          const index = child.morphTargetDictionary[channel];
          if (index !== undefined) channels.set(channel, index);
        }
        if (channels.size) this.morphs.push({ influences: child.morphTargetInfluences, channels });
        morphs = Math.max(morphs, Object.keys(child.morphTargetDictionary).length);
      }
    });

    this.boneCount = bones;
    this.morphCount = morphs;
    this.rightHand = rightHand;
    this.rightGripBones = rightGripBones;
    for (const motion of Object.keys(CLIP_NAMES) as CharacterMotion[]) {
      const clip = THREE.AnimationClip.findByName(clips, CLIP_NAMES[motion]);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (LOOPING.has(motion)) {
        action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(motion, action);
    }
    this.setMotion('idle', 0);
  }

  setMotion(motion: CharacterMotion, fade = 0.18) {
    if (this.disposed || this.activeMotion === 'death') return;
    this.requestedMotion = motion;
    if (this.oneShotRemaining > 0 || motion === this.activeMotion) return;
    this.transitionTo(motion, fade);
  }

  playOnce(motion: Extract<CharacterMotion, 'slide' | 'reload' | 'jump' | 'fire' | 'hit' | 'death'>, fade = 0.08) {
    if (this.disposed || this.activeMotion === 'death') return;
    const action = this.actions.get(motion);
    if (!action) return;
    this.oneShotRemaining = Math.max(0.08, action.getClip().duration);
    this.transitionTo(motion, fade, true);
  }

  resetAnimation() {
    if (this.disposed) return;
    this.mixer.stopAllAction();
    this.activeAction = null;
    this.activeMotion = null;
    this.requestedMotion = 'idle';
    this.oneShotRemaining = 0;
    this.speakingRemaining = 0;
    this.speechSeed = 0;
    this.blinkPhase = 0;
    this.nextBlink = 1.2;
    this.transitionTo('idle', 0, true);
    this.mixer.update(0);
    this.updateFace(0, 0, 0);
    if (this.heldObject) this.applyGripPose();
  }

  speak(durationSeconds: number, seed = 0) {
    this.speakingRemaining = Math.max(this.speakingRemaining, durationSeconds);
    this.speechSeed = seed;
  }

  attachHeldObject(object: THREE.Object3D) {
    const playerRoot = this.object.parent;
    if (!this.rightHand || !playerRoot) return false;
    this.mixer.update(0);
    this.object.updateMatrixWorld(true);
    playerRoot.updateMatrixWorld(true);

    const handWorldPosition = this.rightHand.getWorldPosition(new THREE.Vector3());
    const handWorldQuaternion = this.rightHand.getWorldQuaternion(new THREE.Quaternion());
    const playerWorldQuaternion = playerRoot.getWorldQuaternion(new THREE.Quaternion());
    const weaponWorldQuaternion = playerWorldQuaternion
      .clone()
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)));
    const desiredWorldPosition = handWorldPosition
      .clone()
      .add(new THREE.Vector3(-0.025, -0.015, 0.065).applyQuaternion(playerWorldQuaternion));

    this.rightHand.add(object);
    this.heldObject = object;
    object.position.copy(this.rightHand.worldToLocal(desiredWorldPosition));
    object.quaternion.copy(handWorldQuaternion.invert().multiply(weaponWorldQuaternion));
    // Keep the weapon at ~0.8 world scale while letting the hand bone own the
    // socket. The hero root is normalized to HERO_CHARACTER_SCALE.
    object.scale.setScalar(0.8 / HERO_CHARACTER_SCALE);
    this.applyGripPose();
    object.updateMatrixWorld(true);
    return true;
  }

  setAimPitch(pitch: number) {
    this.aimPitchTarget = pitch;
  }

  private applyAimPitch(delta: number) {
    this.aimPitchCurrent = THREE.MathUtils.damp(this.aimPitchCurrent, this.aimPitchTarget, 9, delta);
    if (Math.abs(this.aimPitchCurrent) < 0.001 || !this.spineBones.length) return;
    // Positive camera pitch (looking up) leans the torso back: negative local
    // X on the spine chain, per the rig's rotation convention.
    const weights = [0.35, 0.45];
    this.spineBones.forEach((bone, index) => {
      bone.rotation.x += -this.aimPitchCurrent * (weights[index] ?? 0.3);
    });
  }

  update(delta: number, elapsed: number, combatIntensity: number, aimPitch = 0) {
    if (this.disposed) return;
    this.mixer.update(delta);
    this.aimPitchTarget = aimPitch;
    this.applyAimPitch(delta);
    if (this.heldObject) this.applyGripPose();
    if (this.oneShotRemaining > 0) {
      this.oneShotRemaining = Math.max(0, this.oneShotRemaining - delta);
      if (this.oneShotRemaining === 0 && this.activeMotion !== 'death') {
        this.transitionTo(this.requestedMotion, 0.14);
      }
    }
    this.updateFace(delta, elapsed, combatIntensity);
  }

  dispose() {
    this.disposed = true;
    const playerRoot = this.object.parent;
    if (this.heldObject && playerRoot && this.heldObject.parent !== playerRoot) {
      playerRoot.attach(this.heldObject);
    }
    this.heldObject = null;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    this.object.traverse((child) => {
      if (!isRenderableMesh(child)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
            texture?.dispose();
          }
        }
        material.dispose();
      });
    });
  }

  private transitionTo(motion: CharacterMotion, fade: number, restart = false) {
    const next = this.actions.get(motion);
    if (!next) return;
    const gaitTransition = !restart && this.activeAction
      && (this.activeMotion === 'walk' || this.activeMotion === 'run')
      && (motion === 'walk' || motion === 'run');
    const gaitPhase = gaitTransition
      ? (this.activeAction!.time / this.activeAction!.getClip().duration) % 1
      : null;
    if (this.activeAction && this.activeAction !== next) this.activeAction.fadeOut(fade);
    if (restart || !next.isRunning()) next.reset();
    if (gaitPhase !== null) next.time = gaitPhase * next.getClip().duration;
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    // A zero-duration fading interpolant starts at weight zero until time
    // advances. Hard resets must evaluate the idle pose in this same frame.
    if (fade > 0) next.fadeIn(fade);
    else next.stopFading();
    next.play();
    this.activeAction = next;
    this.activeMotion = motion;
  }

  private applyGripPose() {
    const fingerCurlAxis = new THREE.Vector3(1, 0, 0);
    for (const gripBone of this.rightGripBones) {
      const curl = new THREE.Quaternion().setFromAxisAngle(fingerCurlAxis, gripBone.curl);
      gripBone.bone.quaternion.copy(gripBone.bind).multiply(curl);
    }
  }

  private setMorph(channel: string, value: number) {
    for (const binding of this.morphs) {
      const index = binding.channels.get(channel);
      if (index !== undefined) binding.influences[index] = THREE.MathUtils.clamp(value, 0, 1);
    }
  }

  private updateFace(delta: number, elapsed: number, combatIntensity: number) {
    this.nextBlink -= delta;
    if (this.nextBlink <= 0 && this.blinkPhase <= 0) {
      this.blinkPhase = 0.16;
      this.nextBlink = 2.4 + ((Math.sin(elapsed * 1.731) + 1) * 0.5) * 3.2;
    }
    if (this.blinkPhase > 0) this.blinkPhase = Math.max(0, this.blinkPhase - delta);
    const blink = this.blinkPhase > 0 ? Math.sin((this.blinkPhase / 0.16) * Math.PI) : 0;
    this.setMorph('eyeBlinkLeft', blink);
    this.setMorph('eyeBlinkRight', Math.min(1, blink * 0.96));

    const tension = THREE.MathUtils.clamp(combatIntensity, 0, 1);
    this.setMorph('browDownLeft', tension * 0.18);
    this.setMorph('browDownRight', tension * 0.18);
    this.setMorph('mouthPressLeft', tension * 0.12);
    this.setMorph('mouthPressRight', tension * 0.12);

    this.speakingRemaining = Math.max(0, this.speakingRemaining - delta);
    const speaking = this.speakingRemaining > 0;
    const cadence = elapsed * 10.6 + this.speechSeed * 0.73;
    const envelope = speaking ? 0.16 + Math.abs(Math.sin(cadence)) * 0.38 : 0;
    const aa = envelope * Math.max(0, Math.sin(cadence * 0.91));
    const ee = envelope * Math.max(0, Math.sin(cadence * 1.17 + 2.1));
    const oh = envelope * Math.max(0, Math.sin(cadence * 0.77 + 4.2));
    this.setMorph('jawOpen', envelope * 0.42);
    this.setMorph('viseme_aa', aa);
    this.setMorph('viseme_E', ee);
    this.setMorph('viseme_O', oh);
    this.setMorph('viseme_PP', speaking ? Math.max(0, Math.sin(cadence * 1.37 + 1.2)) * 0.26 : 0);
    const restingSmile = tension < 0.1 ? 0.025 + Math.sin(elapsed * 0.23) * 0.012 : 0;
    this.setMorph('mouthSmileLeft', restingSmile);
    this.setMorph('mouthSmileRight', restingSmile * 0.94);
  }
}

export async function loadHeroCharacter(
  skin: CharacterSkin,
  anisotropy: number,
  onProgress?: (progress: number) => void,
) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const manifest = await loadCharacterManifest();
  const entry = manifest.characters.find((candidate) => candidate.id === skin);
  if (!entry) throw new Error(`No published hero asset exists for skin ${skin}`);
  const url = `/assets/characters/${entry.file}?v=${entry.sha256.slice(0, 12)}`;
  const bytes = await fetchCharacterBinary(url, entry.bytes, onProgress);
  const checksum = await sha256Hex(bytes);
  if (checksum && checksum !== entry.sha256) throw new Error(`SHA-256 mismatch for ${entry.file}`);
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
    loader.parse(bytes, '/assets/characters/', resolve, reject);
  });
  gltf.scene.name = `Aurel ${skin}`;
  const character = new HeroCharacter(gltf.scene, gltf.animations, anisotropy);
  const expectedActions = Object.values(CLIP_NAMES).sort();
  const actualActions = gltf.animations.map((clip) => clip.name).sort();
  const contractMatches = character.boneCount === entry.bones && character.morphCount === entry.morphTargets &&
    actualActions.length === entry.actions && JSON.stringify(actualActions) === JSON.stringify(expectedActions);
  if (!contractMatches) {
    character.dispose();
    throw new Error(`Runtime contract mismatch for ${entry.file}`);
  }
  onProgress?.(1);
  return character;
}
