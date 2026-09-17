import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { planStreetDetail } from './props-detail';
import type { CableSpan, DetailSpot, StreetDetailInput, StreetDetailPlan } from './props-detail';

export { planStreetDetail, roadFace, wallPoint } from './props-detail';
export type {
  CableSpan,
  DetailBuilding,
  DetailSpot,
  StreetDetailInput,
  StreetDetailPlan,
} from './props-detail';

export interface PropEntry {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
  heightMeters?: number;
}

export interface VerifiedAssetEntry {
  id?: string;
  file: string;
  sha256: string;
  bytes: number;
  heightMeters?: number;
}

// Stem + extension only — blocks traversal without rejecting '_' or capitals.
const SAFE_ASSET_FILE = /^[\w-]+(\.[\w-]+)+$/;

// Bounded asset streams: at most a few fetches in flight so a critical-path
// request — hero manifest on boot, module graph on reload — always finds a
// socket quickly while the city streams its textures in the background.
const MAX_ASSET_STREAMS = 4;
let assetStreams = 0;
const assetStreamQueue: Array<() => void> = [];

export async function acquireAssetStream(parent?: AbortSignal) {
  if (assetStreams >= MAX_ASSET_STREAMS) {
    await new Promise<void>((resolve) => assetStreamQueue.push(resolve));
  }
  if (parent?.aborted) {
    // Hand the freed slot on — the queue must not stall behind an abort.
    assetStreamQueue.shift()?.();
    throw new Error('Asset fetch aborted');
  }
  assetStreams += 1;
}

export function releaseAssetStream() {
  assetStreams -= 1;
  assetStreamQueue.shift()?.();
}

export function assetEntryIsSafe(entry: VerifiedAssetEntry | undefined): entry is VerifiedAssetEntry {
  return Boolean(entry)
    && SAFE_ASSET_FILE.test(entry!.file)
    && /^[a-f0-9]{64}$/.test(entry!.sha256)
    && Number.isSafeInteger(entry!.bytes)
    && entry!.bytes > 0
    && entry!.bytes <= 64_000_000;
}

/** Fetches one pinned asset: byte length + SHA-256 must match the manifest entry. */
export async function fetchVerifiedBytes(baseUrl: string, entry: VerifiedAssetEntry): Promise<ArrayBuffer> {
  await acquireAssetStream();
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(`${baseUrl}${entry.file}?v=${entry.sha256.slice(0, 12)}`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Asset ${entry.file} HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  } finally {
    releaseAssetStream();
  }
  if (bytes.byteLength !== entry.bytes) throw new Error(`Asset ${entry.file} length mismatch`);
  if (!globalThis.crypto?.subtle) throw new Error('Asset verification requires a secure context');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== entry.sha256) throw new Error(`Asset ${entry.file} hash mismatch`);
  return bytes;
}

/** Manifest lookup + verified fetch for the derived-asset manifests (props/hdri/art/audio). */
export async function fetchVerifiedAsset(
  manifestUrl: string,
  listKey: string,
  match: string,
  baseUrl: string,
): Promise<{ entry: VerifiedAssetEntry; bytes: ArrayBuffer }> {
  await acquireAssetStream();
  let manifest: Record<string, VerifiedAssetEntry[] | undefined>;
  try {
    const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error(`Asset manifest HTTP ${manifestResponse.status}`);
    manifest = (await manifestResponse.json()) as Record<string, VerifiedAssetEntry[] | undefined>;
  } finally {
    releaseAssetStream();
  }
  const entry = manifest[listKey]?.find((candidate) => candidate.id === match || candidate.file === match);
  if (!assetEntryIsSafe(entry)) throw new Error(`No verified asset entry for ${match}`);
  return { entry, bytes: await fetchVerifiedBytes(baseUrl, entry) };
}

/** Loads a prop GLB from the self-hosted manifest with size + SHA-256 pinned. */
export async function loadVerifiedProp(id: string): Promise<THREE.Group> {
  const { entry, bytes } = await fetchVerifiedAsset('/assets/props/manifest.json', 'props', id, '/assets/props/');
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(bytes, '/assets/props/', resolve, reject);
  });
  if (entry.heightMeters) gltf.scene.userData.heightMeters = entry.heightMeters;
  return gltf.scene;
}

// ---------------------------------------------------------------------------
// Street detail layer — instanced facade clutter, sidewalk furniture, and
// overhead spans. Placement planning is pure (props-detail.ts); this side
// only turns a plan into InstancedMesh sets, following the same conventions
// as engine.ts' prop passes: shared materials, yaw+pitch composed matrices,
// instanceColor tints, castShadow off, and yaw-conservative AABB colliders
// for the few items bulky enough to block a player.
//
// Wire-in from a prop pass (e.g. the end of createRouteProps):
//
//   const detail = createStreetDetail({
//     buildings: buildingData,
//     lamps: this.streetLamps,
//     blocked: (x, z, r) => this.collides(x, z, r) || blocked(x, z, r),
//     blockedWall,
//     claim: take,
//     density: this.settings.quality === 'low' ? 0.45 : this.settings.quality === 'medium' ? 0.75 : 1,
//   }, { metal: this.propMetal, rust: this.propRust });
//   detail.meshes.forEach((mesh) => this.scene.add(mesh));
//   detail.colliders.forEach((box) => this.collisionBoxes.push(box));
// ---------------------------------------------------------------------------

export interface StreetDetailMaterials {
  /** Scanned painted metal (engine propMetal) — ACs, junction boxes, signs. */
  metal?: THREE.Material | null;
  /** Scanned rusty metal (engine propRust) — drainpipes. */
  rust?: THREE.Material | null;
}

export interface StreetDetailBuild {
  /** ≤8 instanced sets — one per layer, in plan order. */
  meshes: THREE.InstancedMesh[];
  /**
   * AABBs for spots carrying `solid` — push into the engine's collisionBoxes.
   * Everything else deliberately stays non-collidable (step-over clutter,
   * wall-mounted hardware, overhead runs).
   */
  colliders: THREE.Box3[];
}

/** Wall-mounted AC: body + fan grille + hub + feet, grille facing local +Z. */
function acUnitGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.74, 0.52, 0.46);
  const grille = new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12);
  grille.rotateX(Math.PI / 2);
  grille.translate(0, 0.03, 0.235);
  const hub = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 8);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0.03, 0.245);
  const footA = new THREE.BoxGeometry(0.09, 0.07, 0.34);
  footA.translate(-0.26, -0.295, 0.02);
  const footB = footA.clone();
  footB.translate(0.52, 0, 0);
  return mergeGeometries([body, grille, hub, footA, footB]) ?? body;
}

/** Unit-height corner pipe (scale.y = run length) with a gutter elbow. */
function drainpipeGeometry(): THREE.BufferGeometry {
  const pipe = new THREE.CylinderGeometry(0.05, 0.06, 1, 6);
  pipe.translate(0, 0.5, 0);
  const elbow = new THREE.CylinderGeometry(0.05, 0.05, 0.26, 6);
  elbow.rotateX(Math.PI / 2);
  // Local -Z is into the wall — the top kicks back to meet the gutter.
  elbow.translate(0, 0.98, -0.11);
  return mergeGeometries([pipe, elbow]) ?? pipe;
}

/** Utility box with a conduit stub dropping from its underside. */
function junctionBoxGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(0.36, 0.46, 0.16);
  const conduit = new THREE.CylinderGeometry(0.024, 0.024, 0.5, 5);
  conduit.translate(0.1, -0.44, -0.02);
  return mergeGeometries([box, conduit]) ?? box;
}

/**
 * Storefront shade: a sloped slab whose rear edge sits at the local origin
 * (mount point on the wall), dropping toward the street, plus a front
 * valance and two side struts.
 */
function awningGeometry(): THREE.BufferGeometry {
  const slope = 0.42;
  const slab = new THREE.BoxGeometry(2.3, 0.05, 1.05);
  slab.rotateX(slope);
  slab.translate(0, -Math.sin(slope) * 0.525, Math.cos(slope) * 0.525);
  const drop = Math.sin(slope) * 1.05;
  const run = Math.cos(slope) * 1.05;
  const valance = new THREE.BoxGeometry(2.3, 0.13, 0.04);
  valance.translate(0, -drop - 0.04, run - 0.02);
  const strutA = new THREE.BoxGeometry(0.05, 0.05, 0.95);
  strutA.rotateX(slope);
  strutA.translate(-1.08, -drop * 0.45, run * 0.45);
  const strutB = strutA.clone();
  strutB.translate(2.16, 0, 0);
  return mergeGeometries([slab, valance, strutA, strutB]) ?? slab;
}

/**
 * Perpendicular hanging sign: wall arm, diagonal brace, hanger, and a panel
 * that reads along the street (thin on local X, facing ±X).
 */
function signBracketGeometry(): THREE.BufferGeometry {
  const arm = new THREE.BoxGeometry(0.05, 0.05, 0.8);
  arm.translate(0, 0.34, 0.42);
  const brace = new THREE.BoxGeometry(0.04, 0.04, 0.55);
  brace.rotateX(-0.62);
  brace.translate(0, 0.15, 0.3);
  const hanger = new THREE.BoxGeometry(0.035, 0.12, 0.035);
  hanger.translate(0, 0.28, 0.72);
  const panel = new THREE.BoxGeometry(0.05, 0.62, 0.44);
  panel.translate(0, 0.02, 0.72);
  return mergeGeometries([arm, brace, hanger, panel]) ?? arm;
}

/**
 * Ground-floor entry: threshold step, dark door leaf with a kick plate,
 * jambs and a header. Origin at floor center; local -Z into the wall, so
 * the shallow assembly reads as a recessed opening against the facade.
 */
function doorwayGeometry(): THREE.BufferGeometry {
  const step = new THREE.BoxGeometry(1.56, 0.1, 0.52);
  step.translate(0, 0.05, 0.2);
  const door = new THREE.BoxGeometry(1.14, 2.28, 0.1);
  door.translate(0, 1.22, 0.02);
  const kick = new THREE.BoxGeometry(1.14, 0.26, 0.05);
  kick.translate(0, 0.24, 0.08);
  const jambA = new THREE.BoxGeometry(0.1, 2.52, 0.2);
  jambA.translate(-0.66, 1.3, 0.04);
  const jambB = jambA.clone();
  jambB.translate(1.32, 0, 0);
  const header = new THREE.BoxGeometry(1.44, 0.16, 0.2);
  header.translate(0, 2.56, 0.04);
  return mergeGeometries([step, door, kick, jambA, jambB, header]) ?? door;
}

/** Lit transom bar over a doorway — one thin box, colored per instance. */
function doorwayLintelGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1.3, 0.09, 0.05);
}

/** Unit cable segment along +X — instances are aimed and stretched per span. */
function cableSegmentGeometry(): THREE.BufferGeometry {
  const segment = new THREE.CylinderGeometry(0.018, 0.018, 1, 4);
  segment.rotateZ(-Math.PI / 2);
  segment.translate(0.5, 0, 0);
  return segment;
}

/** Yaw-conservative AABB — the same footprint math instancedProp() uses. */
function spotCollider(spot: DetailSpot): THREE.Box3 | null {
  const solid = spot.solid;
  if (!solid) return null;
  const c = Math.abs(Math.cos(spot.yaw));
  const s = Math.abs(Math.sin(spot.yaw));
  const hx = (solid.w / 2) * c + (solid.d / 2) * s;
  const hz = (solid.w / 2) * s + (solid.d / 2) * c;
  return new THREE.Box3(
    new THREE.Vector3(spot.x - hx, spot.y - solid.h / 2, spot.z - hz),
    new THREE.Vector3(spot.x + hx, spot.y + solid.h / 2, spot.z + hz),
  );
}

/** Fills one InstancedMesh from a spot list; returns null when empty so no
 * phantom instance sits at the origin. */
function fillSpots(
  spots: ReadonlyArray<DetailSpot>,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  colliders: THREE.Box3[],
  surfaceKind?: 'metal' | 'generic',
): THREE.InstancedMesh | null {
  if (!spots.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const color = new THREE.Color();
  spots.forEach((spot, index) => {
    // Euler 'YXZ' = yaw about +Y, then pitch about the yawed local X.
    euler.set(spot.pitch ?? 0, spot.yaw, 0, 'YXZ');
    quaternion.setFromEuler(euler);
    position.set(spot.x, spot.y, spot.z);
    const spotScale = spot.scale;
    scale.set(spotScale?.x ?? 1, spotScale?.y ?? 1, spotScale?.z ?? 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    if (spot.color !== undefined) mesh.setColorAt(index, color.setHex(spot.color));
    const collider = spotCollider(spot);
    if (collider) colliders.push(collider);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  if (surfaceKind) mesh.userData.surfaceKind = surfaceKind;
  return mesh;
}

/**
 * Slack runs as instanced tube segments — three straight pieces per span
 * approximating a catenary, so cable thickness stays constant at any span
 * length (a baked sag curve would fatten when scaled). One draw call total.
 */
function fillCables(
  spans: ReadonlyArray<CableSpan>,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.InstancedMesh | null {
  if (!spans.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, spans.length * 3);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  let index = 0;
  spans.forEach((span) => {
    start.set(span.from.x, span.from.y, span.from.z);
    end.set(span.to.x, span.to.y, span.to.z);
    const length = start.distanceTo(end);
    if (length < 0.5) return;
    const sag = Math.min(1.6, Math.max(0.35, length * 0.045));
    const midA = start.clone().lerp(end, 1 / 3);
    midA.y -= sag * 0.82;
    const midB = start.clone().lerp(end, 2 / 3);
    midB.y -= sag;
    const points = [start, midA, midB, end];
    for (let k = 0; k < 3; k += 1) {
      direction.subVectors(points[k + 1], points[k]);
      const segmentLength = direction.length();
      quaternion.setFromUnitVectors(xAxis, direction.normalize());
      scale.set(segmentLength, 1, 1);
      matrix.compose(points[k], quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      index += 1;
    }
  });
  mesh.count = index;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.surfaceKind = 'metal';
  return index ? mesh : null;
}

/**
 * Turns a StreetDetailPlan into the instanced sets. Geometries are created
 * per call (matching the engine's per-build prop passes) and empty layers
 * are skipped rather than instanced at count 1, so the layer adds at most
 * ten draw calls: acUnits, drainpipes, junctionBoxes, awnings,
 * signBrackets, doorways, doorwayLintels, clutterBoxes, trashBags, cables.
 */
export function buildStreetDetail(
  plan: StreetDetailPlan,
  materials: StreetDetailMaterials = {},
): StreetDetailBuild {
  const metal = materials.metal
    ?? new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.46, metalness: 0.5 });
  const rust = materials.rust
    ?? new THREE.MeshStandardMaterial({ color: 0x4c3a2c, roughness: 0.7, metalness: 0.34 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x171b1e, roughness: 0.55, metalness: 0.55 });
  const fabric = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const clutter = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.74, metalness: 0.14 });
  const bagMaterial = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.5, metalness: 0.1 });

  const colliders: THREE.Box3[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  const push = (mesh: THREE.InstancedMesh | null) => {
    if (mesh) meshes.push(mesh);
  };

  push(fillSpots(plan.acUnits, acUnitGeometry(), metal, colliders, 'metal'));
  push(fillSpots(plan.drainpipes, drainpipeGeometry(), rust, colliders, 'metal'));
  push(fillSpots(plan.junctionBoxes, junctionBoxGeometry(), metal, colliders, 'metal'));
  push(fillSpots(plan.awnings, awningGeometry(), fabric, colliders));
  push(fillSpots(plan.signBrackets, signBracketGeometry(), dark, colliders, 'metal'));
  const entry = new THREE.MeshStandardMaterial({ color: 0x101317, roughness: 0.86, metalness: 0.14 });
  push(fillSpots(plan.doorways, doorwayGeometry(), entry, colliders, 'metal'));
  const lintelGlow = new THREE.MeshBasicMaterial({ color: 0xffffff });
  push(fillSpots(plan.doorwayLintels, doorwayLintelGeometry(), lintelGlow, colliders));
  push(fillSpots(plan.clutterBoxes, new THREE.BoxGeometry(1, 1, 1), clutter, colliders));
  push(fillSpots(plan.trashBags, new THREE.SphereGeometry(0.36, 7, 6), bagMaterial, colliders));
  push(fillCables(plan.cables, cableSegmentGeometry(), dark));
  return { meshes, colliders };
}

/** plan + build in one call — the single entry point prop passes use. */
export function createStreetDetail(
  input: StreetDetailInput,
  materials: StreetDetailMaterials = {},
): StreetDetailBuild {
  return buildStreetDetail(planStreetDetail(input), materials);
}
