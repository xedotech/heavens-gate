import { mkdir, writeFile, rename, rm, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { validateScanManifest } from '../../app/game/scan-delivery.mjs';

// Catalog-driven CC0 surface importer. Downloads Poly Haven's verified file
// list at import time (md5 + byte size per map), re-encodes to WebP under the
// same delivery policy as the ground importer, and writes one manifest per
// material into public/assets/environment/<slug>/.
const catalog = [
  {
    slug: 'asphalt-02', asset: 'asphalt_02', label: 'Asphalt 02',
    source: 'https://polyhaven.com/a/asphalt_02', author: 'Poly Haven',
    tileMeters: 2.0, role: 'Road surfaces — worn asphalt read for all streets',
  },
  {
    slug: 'concrete-wall-008', asset: 'concrete_wall_008', label: 'Concrete Wall 008',
    source: 'https://polyhaven.com/a/concrete_wall_008', author: 'Poly Haven',
    tileMeters: 2.4, role: 'Facade relief — normal/roughness on towers, crowns, parapets, curbs',
  },
  {
    slug: 'stone-tiles-02', asset: 'stone_tiles_02', label: 'Stone Tiles 02',
    source: 'https://polyhaven.com/a/stone_tiles_02', author: 'Poly Haven',
    tileMeters: 1.6, role: 'Chapel interior floor and altar surfaces',
  },
  {
    slug: 'dark-brick-wall', asset: 'dark_brick_wall', label: 'Dark Brick Wall',
    source: 'https://polyhaven.com/a/dark_brick_wall', author: 'Poly Haven',
    tileMeters: 2.2, role: 'Chapel exterior walls and Old Spine masonry',
  },
];
const tiers = { '1k': 1024, '2k': 2048 };
const mapSuffix = { albedo: 'diff', normal: 'nor_gl', arm: 'arm' };
const baseDirectory = path.resolve('public/assets/environment');
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

for (const entry of catalog) {
  const api = await fetch(`https://api.polyhaven.com/files/${entry.asset}`, {
    headers: { 'User-Agent': 'Heavens-Gate-Local-Asset-Importer/0.2' },
    signal: AbortSignal.timeout(20000),
  });
  if (!api.ok) throw new Error(`${entry.slug}: file index HTTP ${api.status}`);
  const index = await api.json();
  const directory = path.join(baseDirectory, entry.slug);
  await mkdir(directory, { recursive: true });
  const maps = {};
  for (const [tier, resolution] of Object.entries(tiers)) {
    maps[tier] = {};
    for (const [role, suffix] of Object.entries(mapSuffix)) {
      const remote = index[{ albedo: 'Diffuse', normal: 'nor_gl', arm: 'arm' }[role]]?.[tier]?.jpg;
      if (!remote?.url) throw new Error(`${entry.slug} ${role}/${tier}: map not published`);
      const response = await fetch(remote.url, { headers: { 'User-Agent': 'Heavens-Gate-Local-Asset-Importer/0.2' }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`${entry.slug} ${role}/${tier}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== remote.size || digest('md5', bytes) !== remote.md5) {
        throw new Error(`${entry.slug} ${role}/${tier}: checksum mismatch — aborting rather than trusting a changed file`);
      }
      const metadata = await sharp(bytes).metadata();
      if (metadata.width !== resolution || metadata.height !== resolution) throw new Error(`${entry.slug} ${role}/${tier}: source dimensions differ`);
      // Normals/ARM prefer lossless; oversized 2k outputs degrade gracefully.
      let encoded = await sharp(bytes).webp(role === 'albedo' ? { quality: 88, effort: 6 } : { lossless: true, effort: 6 }).toBuffer();
      if (role !== 'albedo' && encoded.length > 8_000_000) encoded = await sharp(bytes).webp({ nearLossless: true, quality: 60, effort: 6 }).toBuffer();
      if (role !== 'albedo' && encoded.length > 8_000_000) encoded = await sharp(bytes).webp({ quality: 92, effort: 6 }).toBuffer();
      const sha256 = digest('sha256', encoded);
      const file = `${entry.slug}-${role}-${tier}-${sha256.slice(0, 12)}.webp`;
      await writeFile(path.join(directory, file), encoded);
      maps[tier][role] = { file, sha256, bytes: encoded.length, width: resolution, height: resolution, colorSpace: role === 'albedo' ? 'srgb' : 'linear', sourceUrl: remote.url, sourceMd5: remote.md5, sourceSha256: digest('sha256', bytes) };
      console.log(`${entry.slug} ${tier} ${role}: ${remote.size} -> ${encoded.length} bytes`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    id: entry.slug,
    label: entry.label,
    author: entry.author,
    source: entry.source,
    license: 'CC0-1.0',
    licenseUrl: 'https://polyhaven.com/license',
    sourceStandard: 'https://docs.polyhaven.com/en/technical-standards/textures',
    acquisition: 'Photo-based PBR material. Provider uses photogrammetry or photometric stereo; asset-specific capture method is not stated.',
    intendedUse: entry.role,
    tileMeters: entry.tileMeters,
    normalConvention: 'OpenGL',
    packedChannels: { r: 'occlusion', g: 'roughness', b: 'metalness' },
    maps,
  };
  validateScanManifest(manifest);
  const temporaryManifest = path.join(directory, `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryManifest, path.join(directory, 'manifest.json'));
  } finally {
    await rm(temporaryManifest, { force: true });
  }
  const referenced = new Set(Object.values(maps).flatMap((tier) => Object.values(tier).map((map) => map.file)));
  for (const file of await readdir(directory)) {
    if (file.endsWith('.webp') && !referenced.has(file)) await unlink(path.join(directory, file));
  }
  console.log(`${entry.slug}: imported — ${entry.role}`);
}
console.log('Imported', catalog.length, 'photo-based materials. All self-hosted, checksum-pinned, CC0.');
