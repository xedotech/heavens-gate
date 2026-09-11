# Heaven's Gate quality gates

Status date: 2026-09-03

This is the production scorecard for the requested 8/10–9/10 quality target.
Scores are not assigned from enthusiasm. A layer passes only when its evidence
column is complete in a production build on representative hardware.

## Reference boundary

The benchmark is limited to legally published material. Rockstar's official
site currently presents GTA VI as a PlayStation 5 / Xbox Series X|S title due
November 19, 2026, with an in-game “Extended Look,” two trailers, 70 official
screenshots, two leads, a supporting cast, and six named Leonida regions. Those
public signals establish the comparison categories: authored human performance,
regional identity, population density, vehicles, interiors, systemic activity,
cinematic continuity, and current-generation presentation.

Sources:

- https://www.rockstargames.com/VI
- https://www.rockstargames.com/VI/an-extended-look
- https://www.rockstargames.com/VI/media/screenshots
- https://www.rockstargames.com/VI/only-in-leonida/cal

No leaked build, stolen source, ripped asset, dialogue, map, brand, character,
or proprietary design may enter the repository.

## Pass criteria

| Layer | Required gate | Evidence needed | Current state |
| --- | --- | --- | --- |
| Hero humans | Distinct anatomy and materials; full eyes/teeth/tongue/hair/wardrobe; facial performance; weapon grip; no clipping in every authored clip | Turntable captures for all skins; animation matrix; zero visible intersections; GLB validation | Six regenerated hero assets pass the 53-bone / 67-morph / 9-mesh / 11-action contract, SHA-pinned manifest, and zero glTF errors; opaque skin/cloth, cutout hair, sparse bind-preserving tracks, and origin-helper removal are verified. Close-range fidelity, cloth/grip calibration, and the full clipping matrix remain open |
| Crowd humans | At least 12 visibly distinct identities, three LODs, varied silhouettes and schedules | Crowd contact sheet; LOD transition captures; CPU/GPU timings | Procedural placeholders; fail |
| Animation | Responsive locomotion, starts/stops, strafing, aim offsets, recoil, reload, hit/death, vehicle entry, IK and foot placement | State-transition tests plus 60 fps capture | Eleven authored clips and runtime state transitions exist; IK, foot placement, vehicle entry, and 60 fps capture remain open |
| Combat | ADS, hip fire, recoil recovery, spread, critical zones, reload stages, feedback, weapon swap, cover readability, controller response | Deterministic tests; input/frame traces; combat encounter playthrough | Basic hitscan and one sidearm; fail |
| Movement | Acceleration, sprint/stamina, crouch, slide/dodge, jump, vault, slopes, collision and camera occlusion | Traversal course pass on keyboard and gamepad | Walk/run/jump only; fail |
| AI | Sight/hearing, investigation, cover, flanking, squad roles, escalation, surrender/flee and traffic awareness | Scenario suite with state telemetry | Chase/fire/flee baseline; fail |
| Vehicles | Distinct handling, suspension/readable wheels, damage, enter/exit animation, collision feedback and traffic | Handling course, collision suite, gamepad capture | Arcade translation/steering baseline; fail |
| World | Strongly differentiated districts, multiple authored interiors, ambient traffic/crowds, weather/day cycle and meaningful activities | District tour; interior list; density and frame-time traces | Five visual districts in a compact procedural city; fail |
| Campaign | Complete beginning/middle/end, authored set pieces, staging, checkpoint recovery, two endings and post-game | Clean-save full playthrough with timing and save-resume matrix | Eight objective states and two endings exist; set-piece depth insufficient |
| Cinematics | Camera blocking, face performance, scene lighting, dialogue timing and seamless return to play | Capture of every scene; subtitle/audio timing checks | HUD dialogue only; fail |
| Audio | Layered weapons, foley, vehicles, ambience, music states, spatial attenuation, occlusion and mix accessibility | Loudness report; route matrix; headphone/controller playtest | Synthesized base mix; fail |
| Graphics | Stable PBR, shadows, atmosphere, post stack, scalable effects, material consistency, no major aliasing or clipping | Golden screenshots at low/medium/high; GPU frame captures | ACES/shadows/fog baseline; fail |
| Performance | 60 fps target; median frame <=16.7 ms and p95 <=25 ms at 1080p high on declared min-spec; no >100 ms traversal stalls | 10-minute automated trace on minimum and recommended PC; memory plateau | Adaptive pixel ratio plus a rolling 600-frame median/p95/max sampler and renderer counters are instrumented; no qualifying hardware trace yet |
| Input/platform | Keyboard/mouse and standard gamepad parity, remapping, deadzones, prompts, vibration where available; PC/Mac packaging path | Full input matrix on Windows/macOS and two controller layouts | Keyboard action remapping is persisted and conflict-safe; standard gamepad mapping, prompts, and vibration exist. Cross-platform/controller matrix and native packaging evidence remain open; fail |
| Accessibility | Subtitles, contrast, reduced motion, scalable text/HUD, color-independent signals, aim assists and difficulty controls | Keyboard-only audit, screen-reader menu audit, contrast report | Subtitles, reduced motion, high-contrast HUD, 80–130% HUD scaling, sensitivity, difficulty, semantic controls, and keyboard remapping are implemented and browser-smoke tested. Keyboard-only, screen-reader, contrast, and aim-assist evidence remain open; fail |
| Reliability | No blocker/critical defects, deterministic save migration, recovery from missing/corrupt asset, zero console errors | Unit/integration/browser suite; three clean production playthroughs | Basic unit/build/browser checks pass; full matrix absent |
| Licensing/deploy | Every binary traced, notices complete, reproducible build, production URL verified, cache/streaming policy documented | Manifest hashes, notices, clean build, deployed smoke test | CC0/MPFB notices and SHA-pinned schema-2 character manifest pass locally; clean production build and deployed smoke test remain open |

### Asset validator notes

Historical validation of the pre-material/pre-idle hero set with
`gltf-transform validate` reported zero errors for all six binaries. It also
reports nine `NODE_SKINNED_MESH_NON_ROOT` warnings per file because Blender's
armature scene node owns the skinned meshes, plus an unsupported-extension note
for `EXT_meshopt_compression` in that validator. These are tracked warnings, not
silently treated as a pass; the repository validator independently verifies the
contract, hashes, actions, material roles, and animation channel bounds.
The current material/idle-corrected binaries have passed that repository validator
and the Blender idle-pose audit. On 2026-09-09, direct Khronos gltf-validator
2.0.0-dev.3.10 validation of the current six public files reported zero errors
and nine warnings per file, plus unsupported-extension and unused-tangent notes.
Unsupported extension payloads remain outside that tool's validation coverage.
Do not transfer either report to future binaries without revalidation.

## Rating rule

- **Fail:** required behavior or evidence is absent.
- **6/10:** coherent prototype implementation, but obvious placeholders or
  missing production cases remain.
- **8/10:** all required behavior is present, repeatably tested, visually
  coherent, and free of major defects in the declared scope.
- **9/10:** the 8/10 gate plus exceptional human performance, material detail,
  animation continuity, and cinematic presentation validated at close range.
- **10/10 performance:** the declared frame and input budgets pass across the
  full test matrix with no traversal or shader-compilation spikes.

A larger feature count cannot compensate for a failed layer. The release may
be called deployable only after every row passes its stated evidence gate.
