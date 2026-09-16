# Bake vertex colors onto the relic GLB from the dense OpenMVS point cloud.
# Streams scene_dense.ply through mmap (no 879MB RAM hit), collects points into
# chunked numpy arrays, then transfers color via voxel-hashed neighbors.
import hashlib
import json
import mmap
import os
import struct
import sys

import numpy as np
import trimesh

GLB = 'public/assets/props/arius-relic-head.glb'
PLY = 'artifacts/photogrammetry/james-2012/work/dense/scene_dense.ply'
OUT = 'public/assets/props/arius-relic-head.glb'
TOTAL = 11137585

mesh = trimesh.load(GLB, force='mesh')
verts = np.asarray(mesh.vertices, dtype=np.float32)
print(f'mesh: {len(verts)} verts', flush=True)

# Pass 1: stream all records through mmap; collect into staging chunks.
CHUNK = 1 << 20  # 1M rows per staging buffer
buf_p = np.empty((CHUNK, 3), dtype=np.float32)
buf_c = np.empty((CHUNK, 3), dtype=np.uint8)
n = 0
part_p, part_c = [], []
with open(PLY, 'rb') as f:
    while f.readline().strip() != b'end_header':
        pass
    off = f.tell()
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    for i in range(TOTAL):
        buf_p[n] = struct.unpack_from('<3f', mm, off)
        buf_c[n] = mm[off + 12], mm[off + 13], mm[off + 14]
        n += 1
        if n == CHUNK:
            part_p.append(buf_p.copy()); part_c.append(buf_c.copy())
            n = 0
        nv = mm[off + 27]
        o2 = off + 28 + nv * 4
        off = o2 + 1 + mm[o2] * 4
        if i % 3000000 == 0:
            print(f'  scanned {i} pts', flush=True)
    mm.close()
if n:
    part_p.append(buf_p[:n].copy()); part_c.append(buf_c[:n].copy())
pts = np.concatenate(part_p)
cols = np.concatenate(part_c)
print(f'loaded {len(pts)} cloud points', flush=True)

# Voxel hash sized so cells hold a few dozen points at cloud density.
extent = pts.max(0) - pts.min(0)
voxel = float(max(extent) / 320.0)
print(f'cloud extent {extent}, voxel {voxel:.4f}m', flush=True)
buckets: dict[tuple[int, int, int], list[int]] = {}
keys = np.floor(pts / voxel).astype(np.int32)
for idx in range(len(pts)):
    buckets.setdefault((int(keys[idx, 0]), int(keys[idx, 1]), int(keys[idx, 2])), []).append(idx)

def gather(vx, vy, vz, radius):
    found = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            for dz in range(-radius, radius + 1):
                found.extend(buckets.get((vx + dx, vy + dy, vz + dz), ()))
    return found

out = np.zeros((len(verts), 4), dtype=np.uint8)
misses = 0
vkeys = np.floor(verts / voxel).astype(np.int32)
for i in range(len(verts)):
    vx, vy, vz = int(vkeys[i, 0]), int(vkeys[i, 1]), int(vkeys[i, 2])
    near = gather(vx, vy, vz, 1) or gather(vx, vy, vz, 2) or gather(vx, vy, vz, 4)
    if not near:
        misses += 1
        out[i] = (154, 145, 126, 255)  # fallback stone tone
        continue
    near_arr = np.asarray(near)
    cand = pts[near_arr]
    d2 = np.sum((cand - verts[i]) ** 2, axis=1)
    take = np.argpartition(d2, min(8, len(d2) - 1))[:8]
    w = 1.0 / (d2[take] + 1e-9)
    rgb = np.sum(cols[near_arr][take].astype(np.float32) * w[:, None], axis=0) / w.sum()
    out[i, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[i, 3] = 255

print(f'colored {len(verts) - misses} verts, {misses} misses', flush=True)
if misses > len(verts) * 0.2:
    print('FATAL: >20% verts missed — transfer would be garbage', flush=True)
    sys.exit(1)

mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=out)
mesh.export(OUT, file_type='glb')
print(f'wrote {OUT}', flush=True)

manifest_path = 'public/assets/props/manifest.json'
manifest = json.load(open(manifest_path))
digest = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()
for entry in manifest['props']:
    if entry['id'] == 'arius-relic-head':
        entry['sha256'] = digest
        entry['bytes'] = os.path.getsize(OUT)
        entry['source'] += ' + vertex colors transferred from 11.1M-pt dense cloud'
json.dump(manifest, open(manifest_path, 'w'), indent=2)
print(f'manifest sha256 -> {digest[:16]}', flush=True)
