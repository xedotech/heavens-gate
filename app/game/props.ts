import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface PropEntry {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
  heightMeters?: number;
}

/** Loads a prop GLB from the self-hosted manifest with size + SHA-256 pinned. */
export async function loadVerifiedProp(id: string): Promise<THREE.Group> {
  const manifestResponse = await fetch('/assets/props/manifest.json', { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error(`Props manifest HTTP ${manifestResponse.status}`);
  const manifest = (await manifestResponse.json()) as { props?: PropEntry[] };
  const entry = manifest.props?.find((prop) => prop.id === id);
  if (!entry || !/^[a-z0-9-]+\.glb$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 64_000_000) {
    throw new Error(`No verified prop entry for ${id}`);
  }
  const response = await fetch(`/assets/props/${entry.file}?v=${entry.sha256.slice(0, 12)}`, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Prop ${id} HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.bytes) throw new Error(`Prop ${id} length mismatch`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== entry.sha256) throw new Error(`Prop ${id} hash mismatch`);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(bytes, '/assets/props/', resolve, reject);
  });
  return gltf.scene;
}
