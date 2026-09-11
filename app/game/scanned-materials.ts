import * as THREE from 'three';
import { scanTier, validateScanManifest, type ScanMap, type ScanTier } from './scan-contract';
import type { Quality } from './types';

/** Owns one shared material and its maps. All downloads are self-hosted. */
export class ScannedGroundMaterial {
  readonly material = new THREE.MeshStandardMaterial({ color: 0x0c1113, roughness: 0.88, metalness: 0 });
  private controller: AbortController | null = null;
  private currentTier: ScanTier | null = null;
  private textures: THREE.Texture[] = [];
  private disposed = false;

  constructor(private readonly worldMeters: number, private readonly anisotropy: number, private readonly onUnavailable: () => void) {}

  setQuality(quality: Quality) {
    const tier = scanTier(quality);
    if (this.disposed || tier === this.currentTier) return;
    this.currentTier = tier;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    void this.load(tier, controller);
  }

  private async load(tier: ScanTier, controller: AbortController) {
    const pending: THREE.Texture[] = [];
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('/assets/environment/manifest.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Material manifest HTTP ${response.status}`);
      const manifest = validateScanManifest(await response.json());
      // Sequential decode limits transient memory while changing quality tiers.
      for (const role of ['albedo', 'normal', 'arm'] as const) {
        pending.push(await this.texture(manifest.maps[tier][role], manifest.tileMeters, controller.signal));
      }
      if (this.disposed || controller.signal.aborted || this.controller !== controller) throw new Error('Material load superseded');
      const [albedo, normal, arm] = pending;
      this.material.map = albedo;
      this.material.normalMap = normal;
      this.material.aoMap = arm;
      this.material.roughnessMap = arm;
      this.material.metalnessMap = arm;
      this.material.color.setHex(0xcccccc);
      this.material.roughness = 1;
      this.material.metalness = 1;
      this.material.aoMapIntensity = 0.65;
      this.material.needsUpdate = true;
      this.textures.forEach((texture) => this.releaseTexture(texture));
      this.textures = pending;
    } catch {
      pending.forEach((texture) => this.releaseTexture(texture));
      if (!this.disposed && this.controller === controller) {
        this.currentTier = null;
        this.onUnavailable();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async texture(entry: ScanMap, tileMeters: number, signal: AbortSignal) {
    const response = await fetch(`/assets/environment/${entry.file}`, { cache: 'force-cache', signal });
    if (!response.ok) throw new Error(`Material map HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== entry.bytes) throw new Error('Material map length mismatch');
    if (!globalThis.crypto?.subtle) throw new Error('Material verification requires a secure context');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== entry.sha256) throw new Error('Material map hash mismatch');
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { imageOrientation: 'flipY', colorSpaceConversion: 'none' });
    if (signal.aborted || this.disposed) { bitmap.close(); throw new Error('Material decode cancelled'); }
    if (bitmap.width !== entry.width || bitmap.height !== entry.height) { bitmap.close(); throw new Error('Material dimensions mismatch'); }
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = entry.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.worldMeters / tileMeters, this.worldMeters / tileMeters);
    texture.anisotropy = Math.min(8, this.anisotropy);
    texture.needsUpdate = true;
    return texture;
  }

  private releaseTexture(texture: THREE.Texture) {
    texture.dispose();
    (texture.image as ImageBitmap | undefined)?.close?.();
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.textures.forEach((texture) => this.releaseTexture(texture));
    this.textures = [];
    this.material.dispose();
  }
}
