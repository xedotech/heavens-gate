import * as THREE from 'three';
import { scanTier, validateScanManifest, type ScanMap, type ScanTier } from './scan-contract';
import type { Quality } from './types';

export interface ScannedSurfaceOptions {
  /** Explicit UV repeat — overrides worldMeters/tileMeters when set. */
  repeat?: [number, number];
  /** Which loaded maps to apply. Defaults to all three. */
  apply?: { albedo?: boolean; normal?: boolean; arm?: boolean; metalnessMap?: boolean };
  /** Material look once maps land. */
  tint?: number;
  metalness?: number;
  aoIntensity?: number;
  normalScale?: number;
  /** Fallback appearance while unloaded / if fetch fails. */
  fallback?: { color: number; roughness: number; metalness?: number; envMapIntensity?: number };
  /** Called each time maps land — copy texture refs onto shared materials. */
  onApplied?: (material: THREE.MeshStandardMaterial) => void;
}

/** Owns one shared material and its maps. All downloads are self-hosted. */
export class ScannedSurfaceMaterial {
  readonly material: THREE.MeshStandardMaterial;
  private controller: AbortController | null = null;
  private currentTier: ScanTier | null = null;
  private textures: THREE.Texture[] = [];
  private disposed = false;

  constructor(
    private readonly manifestUrl: string,
    private readonly worldMeters: number,
    private readonly anisotropy: number,
    private readonly onUnavailable: () => void,
    private readonly options: ScannedSurfaceOptions = {},
  ) {
    const fallback = options.fallback ?? { color: 0x0c1113, roughness: 0.88, metalness: 0 };
    this.material = new THREE.MeshStandardMaterial({
      color: fallback.color,
      roughness: fallback.roughness,
      metalness: fallback.metalness ?? 0,
      envMapIntensity: fallback.envMapIntensity ?? 1,
    });
  }

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
    const apply = this.options.apply ?? {};
    const roles = (['albedo', 'normal', 'arm'] as const).filter((role) => apply[role] !== false);
    try {
      const response = await fetch(this.manifestUrl, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Material manifest HTTP ${response.status}`);
      const manifest = validateScanManifest(await response.json());
      // Sequential decode limits transient memory while changing quality tiers.
      for (const role of roles) {
        pending.push(await this.texture(manifest.maps[tier][role], manifest.tileMeters, controller.signal));
      }
      if (this.disposed || controller.signal.aborted || this.controller !== controller) throw new Error('Material load superseded');
      const maps = Object.fromEntries(roles.map((role, i) => [role, pending[i]]));
      const m = this.material;
      if (maps.albedo) { m.map = maps.albedo; m.color.setHex(this.options.tint ?? 0xcccccc); }
      if (maps.normal) {
        m.normalMap = maps.normal;
        if (this.options.normalScale) m.normalScale.setScalar(this.options.normalScale);
      }
      if (maps.arm) {
        m.aoMap = maps.arm;
        m.roughnessMap = maps.arm;
        m.roughness = 1;
        m.aoMapIntensity = this.options.aoIntensity ?? 0.65;
        if (apply.metalnessMap !== false) { m.metalnessMap = maps.arm; m.metalness = 1; }
        else m.metalness = this.options.metalness ?? m.metalness;
      }
      m.needsUpdate = true;
      this.options.onApplied?.(m);
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
    const base = this.manifestUrl.slice(0, this.manifestUrl.lastIndexOf('/') + 1);
    const response = await fetch(`${base}${entry.file}`, { cache: 'force-cache', signal });
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
    const [rx, ry] = this.options.repeat ?? [this.worldMeters / tileMeters, this.worldMeters / tileMeters];
    texture.repeat.set(rx, ry);
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

export { ScannedSurfaceMaterial as ScannedGroundMaterial };
