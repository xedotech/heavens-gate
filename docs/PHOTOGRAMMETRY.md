# Photogrammetry pipeline

Real photos → textured GLB, fully local and headless.

## Toolchain

| Stage | Tool | Install |
| --- | --- | --- |
| Sparse SfM (features, matching, camera poses) | COLMAP 4.2.0 `nocuda` | `C:\tools\photogrammetry\colmap\bin\colmap.exe` |
| Dense cloud → mesh → texture | OpenMVS 2.4.0 | `C:\tools\photogrammetry\openmvs\vc17\x64\Release\` |
| OBJ → GLB, decimate to ≤30k tris | Blender 5.2 headless | `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` |

Overrides: `COLMAP_BIN`, `OPENMVS_BIN`, `BLENDER_BIN` env vars.

CPU-only by design — this machine has no CUDA GPU. `patch_match_stereo`
is skipped; OpenMVS `DensifyPointCloud` does CPU densification instead.

## Run

```
node tools/photogrammetry/reconstruct.mjs --photos <dir> --out <dir> --name <slug> [--refine]
```

Stages: feature extraction → exhaustive matching → sparse mapping →
undistort → InterfaceCOLMAP → DensifyPointCloud → ReconstructMesh →
(RefineMesh) → TextureMesh → OBJ→GLB via Blender.

## Capture spec — how to shoot so it actually works

- **Count**: 40–80 photos for a prop, 100+ for a building face/structure
- **Pattern**: two orbit rings — eye level every ~15°, elevated ~35–40°
  every ~25–30°. Every shot must overlap its neighbors by ≥60%.
- **Subject fills 60–80% of frame.** Include surrounding ground — static
  background features anchor the reconstruction.
- **Light**: overcast/diffuse only. Hard shadows bake into the texture
  permanently. No flash, no direct sun.
- **Camera**: fixed focus and exposure (lock AE/AF on phone). No digital
  zoom, no filters, no burst blur. Shoot a bit farther and crop later.
- **Surface**: matte/rough surfaces reconstruct best. Glass, chrome,
  mirrors, and wet-looking surfaces will fail — coat them if it matters.
- **Never move the subject** between shots. Move the camera instead.

## Self-test

`make_testset.py` renders a 36-shot synthetic orbit set of a speckled
obelisk — the same pipeline input contract real photos follow:

```
blender -b --python tools/photogrammetry/make_testset.py -- .scratch/photos
node tools/photogrammetry/reconstruct.mjs --photos .scratch/photos --out .scratch/obelisk --name obelisk
```

Synthetic renders are the pipeline's CI: if the obelisk reconstructs,
the toolchain works and any real photo set that fails is a capture problem,
not a tooling problem.

## Output

`<out>/<name>.glb` — textured mesh, ≤30k tris, origin-centered, Y-up.
Drop in `public/assets/environment/` (or `props/`) and instance in the city.

## Honest limits

- CPU densification is minutes-per-asset, not seconds. Fine for props and
  facades; a whole city block is days.
- GLB output is a statue — no rig, no interior, no LODs yet.
- Face scans: photos give geometry+albedo, but a game-ready face still
  needs retopology onto the existing 53-bone rig.
