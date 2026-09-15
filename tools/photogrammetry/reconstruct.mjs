#!/usr/bin/env node
// Photogrammetry pipeline: photo directory -> textured GLB.
// COLMAP (CPU SfM) -> OpenMVS (dense cloud -> mesh -> texture) -> Blender (GLB).
// Usage: node tools/photogrammetry/reconstruct.mjs --photos <dir> --out <dir> [--name slug] [--refine]
//        [--max-image-size px] [--matcher exhaustive|sequential]
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const COLMAP = process.env.COLMAP_BIN ?? 'C:/tools/photogrammetry/colmap/bin/colmap.exe';
const OPENMVS = process.env.OPENMVS_BIN ?? 'C:/tools/photogrammetry/openmvs/vc17/x64/Release';
const BLENDER = process.env.BLENDER_BIN ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };

const photos = path.resolve(arg('photos', ''));
const out = path.resolve(arg('out', ''));
const name = arg('name', path.basename(out) || 'scan');
const refine = process.argv.includes('--refine');
const maxImageSize = Number(arg('max-image-size', '1600'));
const matcher = arg('matcher', 'exhaustive');
if (!photos || !out || !existsSync(photos)) {
  console.error('Usage: reconstruct.mjs --photos <dir> --out <dir> [--name slug] [--refine] [--max-image-size px] [--matcher exhaustive|sequential]');
  process.exit(1);
}
const images = readdirSync(photos).filter((f) => /\.(jpe?g|png|tiff?|webp)$/i.test(f) && statSync(path.join(photos, f)).size > 10_000);
if (images.length < 12) { console.error(`Need >=12 overlapping photos, found ${images.length} in ${photos}`); process.exit(1); }
console.log(`[reconstruct] ${images.length} photos -> ${out}`);

const work = path.join(out, 'work');
mkdirSync(work, { recursive: true });
const db = path.join(work, 'database.db');
const sparse = path.join(work, 'sparse');
const dense = path.join(work, 'dense');
mkdirSync(sparse, { recursive: true });
mkdirSync(dense, { recursive: true });

const run = (label, exe, args, cwd = work, done = null) => {
  if (done && existsSync(done)) { console.log(`[reconstruct] ${label} — cached, skipping`); return; }
  console.log(`[reconstruct] ${label}...`);
  const t0 = Date.now();
  const result = spawnSync(exe, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(`[reconstruct] ${label} FAILED (exit ${result.status})\n${(result.stderr ?? '').split('\n').slice(-15).join('\n')}`);
    process.exit(1);
  }
  console.log(`[reconstruct] ${label} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

run('feature extraction', COLMAP, ['feature_extractor', '--database_path', db, '--image_path', photos,
  '--ImageReader.single_camera', '1', '--FeatureExtraction.use_gpu', '0', '--FeatureExtraction.num_threads', '4',
  '--FeatureExtraction.max_image_size', String(maxImageSize)], work, db);
if (matcher === 'sequential') {
  run('sequential matching', COLMAP, ['sequential_matcher', '--database_path', db, '--FeatureMatching.use_gpu', '0',
    '--FeatureMatching.num_threads', '4', '--SequentialMatching.loop_detection', '1'], work, null);
} else {
  run('exhaustive matching', COLMAP, ['exhaustive_matcher', '--database_path', db, '--FeatureMatching.use_gpu', '0', '--FeatureMatching.num_threads', '4'], work, null);
}
run('sparse mapping', COLMAP, ['mapper', '--database_path', db, '--image_path', photos, '--output_path', sparse], work, path.join(sparse, '0', 'cameras.bin'));
if (!existsSync(path.join(sparse, '0', 'cameras.bin'))) { console.error('[reconstruct] no sparse model produced — photos may lack overlap'); process.exit(1); }
run('undistort', COLMAP, ['image_undistorter', '--image_path', photos, '--input_path', path.join(sparse, '0'), '--output_path', dense, '--output_type', 'COLMAP'], work, path.join(dense, 'run-colmap-geometric.sh'));

const omvs = (exe) => path.join(OPENMVS, `${exe}.exe`);
const sceneMvs = path.join(dense, 'scene.mvs');
const denseMvs = path.join(dense, 'scene_dense.mvs');
const meshPly = path.join(dense, 'scene_dense_mesh.ply');
run('COLMAP->MVS interface', omvs('InterfaceCOLMAP'), ['-i', dense, '-o', 'scene.mvs'], dense, sceneMvs);
run('dense point cloud', omvs('DensifyPointCloud'), ['scene.mvs', '--resolution-level', '1', '--max-threads', '4'], dense, denseMvs);
run('mesh reconstruction', omvs('ReconstructMesh'), [denseMvs, '-d', '3'], dense, meshPly);
const meshSrc = refine ? path.join(dense, 'scene_dense_mesh_refine.ply') : meshPly;
if (refine) run('mesh refine', omvs('RefineMesh'), [denseMvs, '-m', meshPly, '--resolution-level', '1'], dense, meshSrc);
const objExpected = path.join(dense, `${path.basename(meshSrc, '.ply')}_texture.obj`);
run('texturing', omvs('TextureMesh'), ['-i', denseMvs, '-m', meshSrc, '--export-type', 'obj'], dense, objExpected);
const obj = existsSync(objExpected)
  ? objExpected
  : readdirSync(dense).filter((f) => f.endsWith('.obj')).map((f) => path.join(dense, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!obj) { console.error('[reconstruct] textured OBJ missing'); process.exit(1); }
const glb = path.join(out, `${name}.glb`);
run('OBJ->GLB', BLENDER, ['-b', '--python', path.resolve('tools/photogrammetry/obj_to_glb.py'), '--', obj, glb], out);
console.log(`[reconstruct] DONE -> ${glb}`);
