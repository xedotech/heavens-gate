import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTier, validateScanManifest } from './scan-contract';

const source = JSON.parse(readFileSync('public/assets/environment/manifest.json', 'utf8'));
const fixture = () => structuredClone(source);
const surfaceManifests = readdirSync('public/assets/environment', { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join('public/assets/environment', entry.name, 'manifest.json')))
  .map((entry) => JSON.parse(readFileSync(join('public/assets/environment', entry.name, 'manifest.json'), 'utf8')));

describe('photo-based material delivery contract', () => {
  it('accepts the delivered local manifest and maps quality tiers', () => {
    expect(validateScanManifest(source)).toBe(source);
    expect(['low', 'medium', 'high'].map((quality) => scanTier(quality as 'low' | 'medium' | 'high'))).toEqual(['1k', '2k', '2k']);
  });

  it('accepts every shipped surface manifest and rejects wrong-prefix files', () => {
    expect(surfaceManifests.length).toBeGreaterThanOrEqual(4);
    for (const manifest of surfaceManifests) {
      expect(validateScanManifest(manifest)).toBe(manifest);
      const renamed = structuredClone(manifest);
      renamed.maps['1k'].albedo.file = `other-${renamed.maps['1k'].albedo.file}`;
      expect(() => validateScanManifest(renamed)).toThrow('Invalid scanned-material albedo/1k');
    }
  });

  it.each([null, [], 'bad', {}, { ...source, license: 'unknown' }, { ...source, normalConvention: 'DirectX' }, { ...source, tileMeters: NaN }])('rejects unsupported metadata: %j', (value) => {
    expect(() => validateScanManifest(value)).toThrow('Unsupported scanned-material contract');
  });

  it.each([
    { file: '../outside.webp' }, { sha256: 123 }, { sha256: 'b'.repeat(64) },
    { bytes: 0 }, { bytes: 12_000_001 }, { bytes: 1.5 }, { width: 4096 },
    { height: 2048 }, { colorSpace: 'linear' },
  ])('rejects invalid albedo metadata: %j', (patch) => {
    const manifest = fixture();
    Object.assign(manifest.maps['1k'].albedo, patch);
    expect(() => validateScanManifest(manifest)).toThrow('Invalid scanned-material albedo/1k');
  });

  it('rejects missing tiers and swapped maps', () => {
    const missing = fixture();
    delete missing.maps['2k'];
    expect(() => validateScanManifest(missing)).toThrow();
    const swapped = fixture();
    swapped.maps['2k'].normal = swapped.maps['2k'].arm;
    expect(() => validateScanManifest(swapped)).toThrow();
  });
});
