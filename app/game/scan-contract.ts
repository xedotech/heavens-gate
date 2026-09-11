import type { Quality } from './types';

export type ScanTier = '1k' | '2k';
export type ScanMapRole = 'albedo' | 'normal' | 'arm';
export interface ScanMap {
  file: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  colorSpace: 'srgb' | 'linear';
}
export interface ScanManifest {
  schemaVersion: 1;
  id: 'concrete-pavement-03';
  license: 'CC0-1.0';
  tileMeters: number;
  normalConvention: 'OpenGL';
  maps: Record<ScanTier, Record<ScanMapRole, ScanMap>>;
}

export const scanTier = (quality: Quality): ScanTier => quality === 'low' ? '1k' : '2k';

export { validateScanManifest } from './scan-delivery.mjs';
