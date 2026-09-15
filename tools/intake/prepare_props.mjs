#!/usr/bin/env node
// Prepare CC0 props for the browser: dedup → prune → weld → WebP textures at
// 1024 → simplify when over 40k tris. Registers every result in
// public/assets/props/manifest.json with sha256 + measured heightMeters.
// Loads gltf-transform/meshoptimizer/gltf-validator from the production
// toolkit (production-resources/Tools/gltf-toolkit) per the handoff pattern.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INPUT_ROOT = path.join(ROOT, 'production-resources', 'Prepared-GLB');
const OUTPUT_ROOT = path.join(ROOT, 'public', 'assets', 'props');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'manifest.json');
const TRIANGLE_BUDGET = 40_000;
const BYTE_WARN = 4 * 1024 * 1024;

const require = createRequire(path.join(ROOT, 'production-resources', 'Tools', 'gltf-toolkit', 'package.json'));
const { NodeIO, getBounds } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { dedup, prune, weld, textureCompress, simplify } = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');
const sharp = require('sharp');
const validator = require('gltf-validator');

const MODEL_IDS = [
  'street_lamp_01',
  'painted_wooden_bench',
  'water_manhole_cover',
  'concrete_road_barrier',
  'concrete_road_barrier_02',
  'modular_chainlink_fence',
  'fire_hydrant',
  'Barrel_01',
  'barrel_stove',
  'gothic_statue',
  'industrial_wall_lamp',
  'modular_industrial_pipes_01',
  'rollershutter_door',
  'large_castle_door',
  'rock_moss_set_01',
  'boulder_01',
];

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

function triangleCount(document) {
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : prim.getAttribute('POSITION').getCount();
      tris += Math.floor(count / 3);
    }
  }
  return tris;
}

async function validateGlb(bytes, id) {
  const report = await validator.validateBytes(new Uint8Array(bytes));
  const errors = (report.issues?.messages ?? []).filter((m) => m.severity === 0);
  if (errors.length > 0) {
    const detail = errors.slice(0, 5).map((m) => `${m.code}: ${m.message}`).join('\n  ');
    throw new Error(`${id}: gltf-validator reported ${errors.length} error(s)\n  ${detail}`);
  }
}

async function prepare(io, id) {
  const inputPath = path.join(INPUT_ROOT, `${id}-2k.glb`);
  if (!fs.existsSync(inputPath)) throw new Error(`missing input ${inputPath}`);
  const document = await io.read(inputPath);
  const inputTris = triangleCount(document);

  const transforms = [dedup(), prune(), weld(), textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [1024, 1024],
    quality: 82,
  })];
  if (inputTris > TRIANGLE_BUDGET) {
    transforms.push(simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.001 }));
  }
  await document.transform(...transforms);

  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const bounds = getBounds(scene);
  const heightMeters = Math.round((bounds.max[1] - bounds.min[1]) * 100) / 100;

  const bytes = await io.writeBinary(document);
  await validateGlb(bytes, id);
  const tris = triangleCount(document);

  const file = `${id}-1k.glb`;
  fs.writeFileSync(path.join(OUTPUT_ROOT, file), bytes);
  return {
    id,
    file,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    source: 'Poly Haven CC0 (production-resources intake)',
    provenance: `derived from ${id}-2k.glb — dedup/prune/weld, WebP 1024 textures${inputTris > TRIANGLE_BUDGET ? ', meshopt simplified 50%' : ''}`,
    heightMeters,
    tris,
    inputTris,
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { schemaVersion: 1, props: [] };
  manifest.schemaVersion = 1;
  manifest.props = manifest.props.filter((p) => !MODEL_IDS.includes(p.id));

  const rows = [];
  for (const id of MODEL_IDS) {
    const entry = await prepare(io, id);
    const { tris, inputTris, ...manifestEntry } = entry;
    manifest.props.push(manifestEntry);
    rows.push({ id, bytes: entry.bytes, tris, inputTris });
    if (entry.bytes > BYTE_WARN) {
      console.warn(`  WARN ${id}: ${(entry.bytes / 1048576).toFixed(2)} MB exceeds 4 MB budget`);
    }
  }

  const temp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temp, MANIFEST_PATH);

  console.log('prop'.padEnd(30) + 'input tris'.padStart(12) + 'tris'.padStart(10) + 'bytes'.padStart(12));
  for (const r of rows) {
    console.log(
      r.id.padEnd(30) +
      String(r.inputTris).padStart(12) +
      String(r.tris).padStart(10) +
      `${(r.bytes / 1024).toFixed(0)} KiB`.padStart(12),
    );
  }
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  console.log(`\nTotal: ${(total / 1048576).toFixed(2)} MB across ${rows.length} props`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
