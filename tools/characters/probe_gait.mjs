// Temporary probe: decode animation sampler data from the meshopt-compressed
// hero GLB and report per-bone rotation amplitude (degrees from bind pose).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const asset = path.resolve(process.argv[2] ?? 'public/assets/characters/aurel-seraph-hero.glb');
const bytes = await readFile(asset);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not GLB');
const jsonLength = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
// BIN chunk offset
const binOffset = 20 + jsonLength + 8;

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

async function decodedBufferView(index) {
  const bv = json.bufferViews[index];
  const ext = bv.extensions?.EXT_meshopt_compression;
  if (!ext) {
    const buf = json.buffers[bv.buffer];
    return { data: bytes.subarray(binOffset + (bv.byteOffset ?? 0), binOffset + (bv.byteOffset ?? 0) + bv.byteLength), byteStride: bv.byteStride ?? 0 };
  }
  const source = bytes.subarray(binOffset + (ext.byteOffset ?? 0), binOffset + (ext.byteOffset ?? 0) + ext.byteLength);
  const out = await MeshoptDecoder.decodeGltfBufferAsync(ext.count, ext.byteStride, source, ext.mode, ext.filter);
  return { data: out, byteStride: ext.byteStride };
}

async function readAccessor(index) {
  const acc = json.accessors[index];
  const { data, byteStride } = await decodedBufferView(acc.bufferView);
  const Type = COMPONENT[acc.componentType];
  const n = NCOMP[acc.type];
  const elemBytes = Type.BYTES_PER_ELEMENT * n;
  const stride = byteStride || elemBytes;
  const base = acc.byteOffset ?? 0;
  const out = new Float32Array(acc.count * n);
  const norm = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
  for (let i = 0; i < acc.count; i++) {
    const start = base + i * stride;
    const el = new Type(data.buffer, data.byteOffset + start, n);
    for (let c = 0; c < n; c++) {
      let v = el[c];
      if (acc.normalized) v = Math.max(v / norm[acc.componentType], -1);
      out[i * n + c] = v;
    }
  }
  return out;
}

const nodeName = (i) => json.nodes[i]?.name ?? `node${i}`;
const wanted = process.argv[3] ? process.argv[3].split(',') : ['HG_Walk', 'HG_Run'];

for (const anim of json.animations ?? []) {
  if (!wanted.includes(anim.name)) continue;
  console.log(`=== ${anim.name} (${anim.channels.length} channels) ===`);
  for (const ch of anim.channels) {
    const name = nodeName(ch.target.node);
    if (ch.target.path !== 'rotation') continue;
    const sampler = anim.samplers[ch.sampler];
    const times = await readAccessor(sampler.input);
    const quats = await readAccessor(sampler.output);
    let minAng = Infinity, maxAng = -Infinity;
    const rows = [];
    for (let i = 0; i < times.length; i++) {
      const [x, y, z, w] = [quats[i * 4], quats[i * 4 + 1], quats[i * 4 + 2], quats[i * 4 + 3]];
      const ang = 2 * Math.acos(Math.min(1, Math.abs(w))) * 180 / Math.PI;
      minAng = Math.min(minAng, ang); maxAng = Math.max(maxAng, ang);
      rows.push(`    t=${times[i].toFixed(3)} q=(${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)},${w.toFixed(4)}) ang=${ang.toFixed(2)}`);
    }
    console.log(`  ${name}.rotation keys=${times.length} angle[min..max]=${minAng.toFixed(2)}..${maxAng.toFixed(2)} deg`);
    if (/thigh|calf|foot|pelvis|spine/.test(name)) console.log(rows.join('\n'));
  }
}
