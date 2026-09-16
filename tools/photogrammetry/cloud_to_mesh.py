"""Voxel-density marching-cubes reconstruction of a dense laser-scan cloud.

Reads a binary PLY (float xyz), splats points into a density grid, smooths,
extracts an isosurface, and writes a manifold PLY + OBJ for the GLB step.

usage: python cloud_to_mesh.py <in.ply> <out.ply> [--grid 384] [--sigma 1.2]
"""
import sys
import struct
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage import measure

def arg(name, fallback):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else fallback

src, dst = sys.argv[1], sys.argv[2]
grid = int(arg('--grid', '384'))
sigma = float(arg('--sigma', '1.4'))

# --- read binary_little_endian PLY (xyz float32 only) ---
with open(src, 'rb') as f:
    header = []
    while True:
        line = f.readline().decode('ascii').strip()
        header.append(line)
        if line == 'end_header':
            break
    n = int(next(h.split()[-1] for h in header if h.startswith('element vertex')))
    pts = np.frombuffer(f.read(n * 12), dtype='<f4').reshape(n, 3)
print(f'[mesh] {n} points, bbox {pts.min(0)} .. {pts.max(0)}')

# --- splat into density grid ---
lo, hi = pts.min(0), pts.max(0)
span = (hi - lo).max()
vox = (pts - lo) / span * (grid - 4) + 2  # 2-voxel margin
idx = np.floor(vox).astype(np.int32)
density = np.zeros((grid, grid, grid), dtype=np.float32)
np.add.at(density, (idx[:, 0], idx[:, 1], idx[:, 2]), 1.0)
density = gaussian_filter(density, sigma)

iso = np.percentile(density[density > 0], 35)
verts, faces, normals, _ = measure.marching_cubes(density, level=iso)
verts = verts / (grid - 4) * span + lo - 2 / (grid - 4) * span
print(f'[mesh] iso {iso:.3f} -> {len(verts)} verts {len(faces)} tris')

# --- keep largest connected component ---
import trimesh
m = trimesh.Trimesh(verts, faces, vertex_normals=normals, process=False)
comps = m.split(only_watertight=False)
m = max(comps, key=lambda c: len(c.faces)) if isinstance(comps, np.ndarray) is False else m
m = m if not isinstance(m, (list, np.ndarray)) else max(m, key=lambda c: len(c.faces))
print(f'[mesh] largest component: {len(m.faces)} tris')

# --- decimate to prop budget ---
budget = 60_000
if len(m.faces) > budget:
    m = m.simplify_quadric_decimation(face_count=budget)
    print(f'[mesh] decimated -> {len(m.faces)} tris')

m.export(dst)
m.export(dst.replace('.ply', '.obj'))
print(f'[mesh] wrote {dst}')
