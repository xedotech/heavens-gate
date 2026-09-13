# Character compiler

This directory turns the documented CC0 MakeHuman asset set into deterministic,
game-ready glTF binaries. It is source tooling: generated binaries are validated
before they are copied into `public/assets/characters`.

The hero profile contains a 53-bone game rig, eleven locomotion/combat actions,
52 ARKit-compatible facial units, 15 Meta/Oculus visemes, separate eyes, brows,
lashes, teeth, tongue, hair, clothing, and skin textures. The generated schema-2
manifest records byte size, source-spec hash, asset SHA-256, and the `53:67:9:11`
runtime contract. The crowd profile uses the same rig and animation contract
without facial morph targets.

The source files use MPFB's 0.1 metre unit scale. The runtime normalizes hero
roots to `2.35`, which puts the generated bodies at approximately 1.8 metres
and keeps the camera, collision radius, and held-weapon socket in the same world
coordinate system. Opaque skin/cloth/eye/teeth/tongue surfaces export as
`OPAQUE`; only hair, brows, and lashes retain alpha cutouts. This avoids the
black depth-sorted face mask produced by MPFB's default `BLEND` materials.

Animation tracks are intentionally sparse. Each clip keys only its authored
bones so unkeyed limbs retain the verified bind pose. The validator enforces
per-action track floors (`HG_Idle` 3, `HG_Walk` 11, `HG_Run` 12, and the
combat/locomotion floors in `validate_characters.mjs`) rather than requiring a
zero rotation key on every bone.

Clip authoring lives in `animation_library.py`, shared by the full compile and
by `rebuild_animations.py`, which re-authors the eleven `HG_*` actions inside
already-published GLBs without MPFB (use it when only the clips changed):

```powershell
& $BlenderExe --background --python-exit-code 1 `
  --python tools/characters/rebuild_animations.py -- `
  --manifest tools/characters/characters.json `
  --input public/assets/characters `
  --output artifacts/characters
```

`audit_gait.py` measures the exported knee-articulation range and loop seam on
a built GLB (`HG_Walk`/`HG_Run` must exceed ten degrees of knee travel).

Asset license: CC0 1.0. MPFB itself is AGPL/GPL tooling; its generated output is
unrestricted. See `THIRD_PARTY_NOTICES.md` at the repository root.

Example (PowerShell):

```powershell
& $BlenderExe --background --python-exit-code 1 `
  --python tools/characters/build_characters.py -- `
  --manifest tools/characters/characters.json `
  --output artifacts/characters `
  --character aurel-seraph --lod hero

node tools/characters/publish_manifest.mjs
node tools/characters/validate_characters.mjs
```
