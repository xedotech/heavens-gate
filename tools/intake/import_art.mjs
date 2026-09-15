#!/usr/bin/env node
// Encode generated art into public/assets/art as WebP with a sha256 manifest.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INPUT_ROOT = path.join(ROOT, 'production-resources', 'Generated');
const OUTPUT_ROOT = path.join(ROOT, 'public', 'assets', 'art');

const ART = [
  { src: 'chapel-memory-window.png', out: 'chapel-memory-window.webp', width: 1024, height: 1536, quality: 88 },
  { src: 'memory-office-poster.png', out: 'memory-office-poster.webp', width: 1024, height: 1536, quality: 85 },
];

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
const manifest = { schemaVersion: 1, art: [] };
for (const item of ART) {
  const src = path.join(INPUT_ROOT, item.src);
  const buffer = await sharp(src)
    .resize(item.width, item.height, { kernel: 'lanczos3' })
    .webp({ quality: item.quality, effort: 6 })
    .toBuffer();
  fs.writeFileSync(path.join(OUTPUT_ROOT, item.out), buffer);
  manifest.art.push({
    id: item.out.replace(/\.webp$/, ''),
    file: item.out,
    sha256: sha256Hex(buffer),
    bytes: buffer.length,
    width: item.width,
    height: item.height,
    source: 'generated art (production-resources intake)',
  });
  console.log(`${item.out}  ${(buffer.length / 1024).toFixed(0)} KiB`);
}
const temp = path.join(OUTPUT_ROOT, 'manifest.json.tmp');
fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(temp, path.join(OUTPUT_ROOT, 'manifest.json'));
