// Arius_xyz.txt (tab-separated X Y Z) -> binary PLY point cloud.
// Streams the 275MB reference cloud, decimates to a mesh-friendly budget,
// recenters on the footprint centroid, and writes little-endian binary PLY.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const src = path.resolve(arg('src', ''));
const dst = path.resolve(arg('dst', ''));
const target = Number(arg('points', '3000000'));
const units = Number(arg('scale', '0.01')); // raw units -> metres (laser cloud is cm)

if (!src || !dst) { console.error('usage: node xyz_to_ply.mjs --src <txt> --dst <ply> [--points N] [--scale m]'); process.exit(1); }

const rl = createInterface({ input: createReadStream(src, { encoding: 'utf8' }), crlfDelay: Infinity });
let rows = 0;
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
const pass1 = [];
for await (const line of rl) {
  if (!line) continue;
  const p = line.split('\t');
  if (p.length < 3) continue;
  const x = +p[0], y = +p[1], z = +p[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
  pass1.push(x, y, z);
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
  if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  rows++;
}
const stride = Math.max(1, Math.floor(rows / target));
const cx = (minX + maxX) / 2, cy = minY, cz = (minZ + maxZ) / 2;
const kept = Math.floor(rows / stride);
console.log(`[xyz_to_ply] ${rows} pts, bbox ${(maxX - minX).toFixed(1)}x${(maxY - minY).toFixed(1)}x${(maxZ - minZ).toFixed(1)}, stride ${stride} -> ${kept} pts`);

const header = Buffer.from([
  'ply',
  'format binary_little_endian 1.0',
  `element vertex ${kept}`,
  'property float x', 'property float y', 'property float z',
  'end_header',
  '',
].join('\n'), 'ascii');
const body = Buffer.alloc(kept * 12);
let w = 0;
for (let i = 0; i < rows * 3 && w < kept; i += stride * 3) {
  body.writeFloatLE((pass1[i] - cx) * units, w * 12);
  body.writeFloatLE((pass1[i + 1] - cy) * units, w * 12 + 4);
  body.writeFloatLE((pass1[i + 2] - cz) * units, w * 12 + 8);
  w++;
}
writeFileSync(dst, Buffer.concat([header, body]));
console.log(`[xyz_to_ply] wrote ${dst} (${(header.length + body.length) / 1e6} MB, ${w} pts, recentered)`);
