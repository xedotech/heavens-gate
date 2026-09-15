#!/usr/bin/env node
// Import CC0 surface scans from production-resources/Materials/<src>/4k into
// public/assets/environment/<slug>/ at 2K + 1K WebP with a validated manifest.
// Local-file counterpart to tools/environment/import_surfaces.mjs — same output
// contract (file naming, sha256 pinning, byte caps, stale-file cleanup).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { validateScanManifest } from '../../app/game/scan-delivery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MATERIALS_ROOT = path.join(ROOT, 'production-resources', 'Materials');
const SOURCES_ROOT = path.join(ROOT, 'production-resources', 'Sources');
const OUTPUT_ROOT = path.join(ROOT, 'public', 'assets', 'environment');
const MAX_BYTES_PER_MAP = 12_000_000;
const MAX_LOSSLESS_BYTES = 8 * 1024 * 1024;

const SURFACES = [
  'cobblestone_floor_001',
  'church_bricks_03',
  'chipped_concrete',
  'blue_plaster_weathered',
  'brick_wall_001',
  'concrete_floor_02',
  'wood_planks',
  'rusty_metal_02',
];

const ROLES = [
  { role: 'albedo', suffixes: ['diff_4k', 'diffuse_4k', 'diff_2k'], label: 'PBR albedo' },
  { role: 'normal', suffixes: ['nor_gl_4k', 'nor_gl_2k'], label: 'OpenGL normal' },
  { role: 'arm', suffixes: ['arm_4k', 'arm_2k'], label: 'AO/rough/metal' },
];

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function encode(buffer, role, size) {
  const base = sharp(buffer).resize(size, size, { kernel: 'lanczos3' });
  if (role === 'albedo') {
    const out = await base.webp({ quality: 88, effort: 6 }).toBuffer();
    return { out, options: { quality: 88 } };
  }
  let out = await base.webp({ lossless: true, effort: 6 }).toBuffer();
  let options = { lossless: true };
  if (out.length > MAX_LOSSLESS_BYTES) {
    out = await base.webp({ quality: 70, effort: 6 }).toBuffer();
    options = { quality: 70 };
  }
  return { out, options };
}

function tileMetersFor(src) {
  const metaPath = path.join(SOURCES_ROOT, `${src}-metadata.json`);
  if (!fs.existsSync(metaPath)) return 2;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const size =
      meta.physical_size_m ??
      meta.physicalSize ??
      meta.attributes?.physical_size_m ??
      meta.scan?.physical_size_m;
    if (typeof size === 'number' && size > 0 && size <= 20) return Math.round(size * 100) / 100;
  } catch { /* fall through */ }
  return 2;
}

function sourcePathFor(src, role) {
  const dir = path.join(MATERIALS_ROOT, src, '4k');
  for (const spec of ROLES) {
    if (spec.role !== role) continue;
    for (const suffix of spec.suffixes) {
      const p = path.join(dir, `${src}_${suffix}.png`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function processSurface(src) {
  const slug = src.replaceAll('_', '-');
  const outDir = path.join(OUTPUT_ROOT, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const tileMeters = tileMetersFor(src);
  const manifest = {
    schemaVersion: 1,
    id: slug,
    label: src.replaceAll('_', ' '),
    author: 'Poly Haven',
    source: 'Poly Haven CC0 (production-resources intake)',
    license: 'CC0-1.0',
    licenseUrl: 'https://polyhaven.com/license',
    tileMeters,
    normalConvention: 'OpenGL',
    packedChannels: { r: 'occlusion', g: 'roughness', b: 'metalness' },
    maps: {},
  };

  const emitted = [];
  const rows = [];
  for (const roleSpec of ROLES) {
    const srcPath = sourcePathFor(src, roleSpec.role);
    if (!srcPath) throw new Error(`${src}: missing ${roleSpec.role} source under 4k/`);
    const source = fs.readFileSync(srcPath);
    for (const tier of ['2k', '1k']) {
      const size = tier === '2k' ? 2048 : 1024;
      const { out, options } = await encode(source, roleSpec.role, size);
      if (out.length > MAX_BYTES_PER_MAP) {
        throw new Error(`${slug} ${roleSpec.role} ${tier} exceeds ${MAX_BYTES_PER_MAP} bytes`);
      }
      const hash12 = sha256Hex(out).slice(0, 12);
      const filename = `${slug}-${roleSpec.role}-${tier}-${hash12}.webp`;
      fs.writeFileSync(path.join(outDir, filename), out);
      emitted.push(filename);
      manifest.maps[tier] ??= {};
      manifest.maps[tier][roleSpec.role] = {
        file: filename,
        sha256: sha256Hex(out),
        bytes: out.length,
        width: size,
        height: size,
        colorSpace: roleSpec.role === 'albedo' ? 'srgb' : 'linear',
        compression: options,
      };
      rows.push({ tier, role: roleSpec.role, bytes: out.length });
    }
  }

  validateScanManifest(manifest);

  const manifestPath = path.join(outDir, 'manifest.json');
  const tempPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tempPath, manifestPath);

  for (const entry of fs.readdirSync(outDir)) {
    if (!entry.endsWith('.webp')) continue;
    if (!emitted.includes(entry)) fs.rmSync(path.join(outDir, entry));
  }
  return { slug, tileMeters, rows };
}

const fmt = (n) => `${(n / 1024).toFixed(0).padStart(6)} KiB`;
const allRows = [];
for (const src of SURFACES) {
  const { slug, tileMeters, rows } = await processSurface(src);
  console.log(`${slug}  (tile ${tileMeters} m)`);
  for (const r of rows) console.log(`  ${r.tier} ${r.role.padEnd(6)} ${fmt(r.bytes)}`);
  allRows.push(...rows);
}
for (const tier of ['2k', '1k']) {
  const total = allRows.filter((r) => r.tier === tier).reduce((s, r) => s + r.bytes, 0);
  console.log(`\n${tier} total: ${fmt(total)}`);
}
console.log('\nDone. Run `npm run validate:environment` to check every manifest.');
