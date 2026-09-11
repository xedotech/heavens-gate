# Aurel hero turntable evidence

These deterministic Blender renders are an offline QA artifact for the
six schema-2 hero binaries. They use the same 2.35 gameplay scale normalization
as `app/game/character.ts` and a neutral three-point light rig. Opaque skin and
cloth are exported without MPFB's default alpha blend; hair/brows/lashes keep
their cutout surfaces so the face does not render as a depth-sorted black mask.
The checked-in `turntables/` set is a fast textured Workbench pass; the
`turntables-eevee/` Seraph render is the close-range lit-material regression
probe. They are evidence of asset presence, silhouette separation, material
assignment, and full-body coverage—not a claim of AAA fidelity or a substitute
for the in-engine animation/clipping matrix.

For skeletal motion probes, `render_motion.py` renders one action frame with a
deterministic workbench scene. The sparse animation contract is intentional:
unkeyed bones preserve the bind pose while authored track and duration floors
are checked by `validate_characters.mjs`. The checked-in
`animation-probes/seraph-hit-4.png` captures the mid-impact pose after the
explicit pre-impact/recovery key fix.

| Skin | Render |
| --- | --- |
| Seraph | [aurel-seraph-hero.png](../artifacts/characters/turntables/aurel-seraph-hero.png) |
| Relic | [aurel-relic-hero.png](../artifacts/characters/turntables/aurel-relic-hero.png) |
| Nocturne | [aurel-nocturne-hero.png](../artifacts/characters/turntables/aurel-nocturne-hero.png) |
| Ash | [aurel-ash-hero.png](../artifacts/characters/turntables/aurel-ash-hero.png) |
| Meridian | [aurel-meridian-hero.png](../artifacts/characters/turntables/aurel-meridian-hero.png) |
| Voidborn | [aurel-voidborn-hero.png](../artifacts/characters/turntables/aurel-voidborn-hero.png) |

Regenerate with:

```powershell
& $BlenderExe --background --python-exit-code 1 `
  --python tools/characters/render_turntables.py -- `
  --assets public/assets/characters `
  --output artifacts/characters/turntables
```

For a quick six-cast contact sheet, append `--resolution 320 400
--fast-workbench`. For a lit material regression probe, render one skin without
`--fast-workbench` and keep `--opaque-materials` enabled.

```powershell
& $BlenderExe --background --python-exit-code 1 `
  --python tools/characters/render_motion.py -- `
  --input public/assets/characters/aurel-seraph-hero.glb `
  --output artifacts/characters/animation-probes/seraph-idle.png `
  --action HG_Idle --frame 1
```
