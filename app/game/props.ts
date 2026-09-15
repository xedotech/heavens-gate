import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
