import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { validateScanManifest } from '../../app/game/scan-delivery.mjs';

const directory = path.resolve('public/assets/environment');
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
validateScanManifest(manifest);
if (manifest.schemaVersion !== 1 || manifest.license !== 'CC0-1.0' || manifest.tileMeters !== 2.1 || manifest.normalConvention !== 'OpenGL') throw new Error('Material contract mismatch');
const results = [];
for (const tier of ['1k', '2k']) {
  for (const role of ['albedo', 'normal', 'arm']) {
    const entry = manifest.maps[tier][role];
    if (!/^concrete-pavement-03-[a-z]+-[12]k-[a-f0-9]{12}\.webp$/.test(entry.file)) throw new Error('Unsafe map file');
    const bytes = await readFile(path.join(directory, entry.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const metadata = await sharp(bytes).metadata();
    const resolution = tier === '1k' ? 1024 : 2048;
    if (sha256 !== entry.sha256 || bytes.length !== entry.bytes || metadata.width !== resolution || metadata.height !== resolution || metadata.format !== 'webp') throw new Error(`${tier}/${role}: map verification failed`);
    if (entry.colorSpace !== (role === 'albedo' ? 'srgb' : 'linear')) throw new Error(`${tier}/${role}: colorspace mismatch`);
    results.push({ tier, role, bytes: bytes.length, width: metadata.width, height: metadata.height });
  }
}
console.log(JSON.stringify({ assets: 1, maps: results.length, totalBytes: results.reduce((sum, result) => sum + result.bytes, 0), failures: [], results }, null, 2));
