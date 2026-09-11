import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { validateScanManifest } from '../../app/game/scan-delivery.mjs';

// One explicitly selected CC0 asset, not a site crawler. Source checksums and
// sizes were read from Poly Haven's public /files API on 2026-09-04.
const sources = {
  '1k': {
    albedo: ['diff', 'e2d4ca4fabe39cd510f78bda929bba53', 830452],
    normal: ['nor_gl', '87a68a3d2bf1131749ce6fe87670e580', 1017387],
    arm: ['arm', '1aad16a71cccc9303fd52cb331a50d93', 743316],
  },
  '2k': {
    albedo: ['diff', '7c9ada62d87b7cf410a432b146a142c3', 3872063],
    normal: ['nor_gl', '75bf54955ee3fadd912846e9086442fa', 4791871],
    arm: ['arm', '8be60f85cc0153fa9779b2baf5dcee19', 3277668],
  },
};
const directory = path.resolve('public/assets/environment');
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const maps = {};
await mkdir(directory, { recursive: true });
for (const [tier, entries] of Object.entries(sources)) {
  maps[tier] = {};
  for (const [role, [suffix, md5, expectedBytes]] of Object.entries(entries)) {
    const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${tier}/concrete_pavement_03/concrete_pavement_03_${suffix}_${tier}.jpg`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Heavens-Gate-Local-Asset-Importer/0.1' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${role}/${tier}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expectedBytes || digest('md5', bytes) !== md5) throw new Error(`${role}/${tier}: upstream source changed; review before importing`);
    const metadata = await sharp(bytes).metadata();
    const resolution = tier === '1k' ? 1024 : 2048;
    if (metadata.width !== resolution || metadata.height !== resolution) throw new Error(`${role}/${tier}: source dimensions differ`);
    // Lossless data-map encoding keeps the provider JPEG's decoded channel
    // values; only color uses a lossy delivery encode. No AI upscaling.
    const encoded = await sharp(bytes).webp(role === 'albedo' ? { quality: 88, effort: 6 } : { lossless: true, effort: 6 }).toBuffer();
    const sha256 = digest('sha256', encoded);
    const file = `concrete-pavement-03-${role}-${tier}-${sha256.slice(0, 12)}.webp`;
    await writeFile(path.join(directory, file), encoded);
    maps[tier][role] = { file, sha256, bytes: encoded.length, width: resolution, height: resolution, colorSpace: role === 'albedo' ? 'srgb' : 'linear', sourceUrl: url, sourceMd5: md5, sourceSha256: digest('sha256', bytes) };
    console.log(`${tier} ${role}: ${expectedBytes} -> ${encoded.length} bytes`);
  }
}
const manifest = {
  schemaVersion: 1,
  id: 'concrete-pavement-03',
  label: 'Concrete Pavement 03',
  author: 'Charlotte Baglioni',
  source: 'https://polyhaven.com/a/concrete_pavement_03',
  license: 'CC0-1.0',
  licenseUrl: 'https://polyhaven.com/license',
  sourceStandard: 'https://docs.polyhaven.com/en/technical-standards/textures',
  acquisition: 'Photo-based PBR material. Provider uses photogrammetry or photometric stereo; asset-specific capture method is not stated.',
  tileMeters: 2.1,
  normalConvention: 'OpenGL',
  packedChannels: { r: 'occlusion', g: 'roughness', b: 'metalness' },
  maps,
};
validateScanManifest(manifest);
// Keep the last usable catalog intact if generation or the final write fails.
const temporaryManifest = path.join(directory, `.manifest-${randomUUID()}.tmp`);
try {
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryManifest, path.join(directory, 'manifest.json'));
} finally {
  await rm(temporaryManifest, { force: true });
}
console.log('Imported one photo-based material. No runtime third-party requests or scanned geometry added.');
