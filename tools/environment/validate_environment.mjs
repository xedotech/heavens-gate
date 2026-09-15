import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { validateScanManifest } from '../../app/game/scan-delivery.mjs';

const root = path.resolve('public/assets/environment');
const manifestDirs = [root];
for (const entry of await readdir(root, { withFileTypes: true })) {
  const manifestPath = path.join(root, entry.name, 'manifest.json');
  if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
  const candidate = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (candidate?.maps) manifestDirs.push(path.join(root, entry.name));
}
const results = [];
let assets = 0;
for (const directory of manifestDirs) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  validateScanManifest(manifest);
  if (manifest.license !== 'CC0-1.0' || manifest.normalConvention !== 'OpenGL') throw new Error(`${manifest.id}: contract mismatch`);
  const filePattern = new RegExp(`^${manifest.id}-[a-z]+-[12]k-[a-f0-9]{12}\\.webp$`);
  for (const tier of ['1k', '2k']) {
    for (const role of ['albedo', 'normal', 'arm']) {
      const entry = manifest.maps[tier][role];
      if (!filePattern.test(entry.file)) throw new Error(`${manifest.id} ${tier}/${role}: unsafe map file`);
      const bytes = await readFile(path.join(directory, entry.file));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const metadata = await sharp(bytes).metadata();
      const resolution = tier === '1k' ? 1024 : 2048;
      if (sha256 !== entry.sha256 || bytes.length !== entry.bytes || metadata.width !== resolution || metadata.height !== resolution || metadata.format !== 'webp') throw new Error(`${manifest.id} ${tier}/${role}: map verification failed`);
      if (entry.colorSpace !== (role === 'albedo' ? 'srgb' : 'linear')) throw new Error(`${manifest.id} ${tier}/${role}: colorspace mismatch`);
      results.push({ asset: manifest.id, tier, role, bytes: bytes.length, width: metadata.width, height: metadata.height });
    }
  }
  assets += 1;
}
console.log(JSON.stringify({ assets, maps: results.length, totalBytes: results.reduce((sum, result) => sum + result.bytes, 0), failures: [], results }, null, 2));
