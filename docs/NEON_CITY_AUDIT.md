# Neon City prototype comparison

_Audit date: 2026-09-02_

This document records the release and migration decision for the separate
`neon-city` prototype. It is evidence for production planning, not a claim that
either build has reached AAA quality.

## Decision

- Keep this Three.js/TypeScript project as the only canonical Heaven's Gate
  production line.
- Preserve `neon-city` in a private repository for backup and history.
- Do not publish `neon-city` as the main game.
- A future public copy may be released as a clearly labelled legacy procedural
  prototype after its broken flows, claims, naming, and repository hygiene are
  corrected.
- Do not publicly tag this project as production-ready until the release gates
  in `QUALITY_GATES.md` pass. The first honest public milestone is a pre-alpha.

## Observed product scorecard

| Dimension | `neon-city` | Current project | Evidence-led interpretation |
| --- | ---: | ---: | --- |
| Onboarding | 5/10 | 4/10 | The legacy menu is immediate; the current branded loader is stronger but its latest clean-load run did not reach the title under heavy local contention. |
| Core experience | 6/10 | 5/10 | Legacy walking, driving, shooting, population, and wanted response work end-to-end. The current build has better combat and movement primitives but less verified breadth. |
| Error handling | 4/10 | 5/10 | Legacy has a visible error trap. Current has an error boundary, recovery UI, checkpoints, and guarded local saves, but failure-path tests are incomplete. |
| Information architecture | 5/10 | 7/10 | Current title, pause, settings, field manual, HUD, objectives, and semantic labelling are substantially clearer. |
| Visual polish | 3/10 | 5/10 | Legacy gameplay uses boxes and quads. Current uses a distinctive celestial-noir UI and rigged GLBs, but world, crowd, face, hair, cloth, and cinematic polish remain pre-alpha. |
| Performance | 7/10 | 3/10 | Legacy renders in seven draw calls and measured 54.0-58.1 FPS in the fresh audit. Current has adaptive controls but no qualifying frame-time certification yet. |
| Accessibility | 3/10 | 5/10 | Current includes subtitles, reduced motion, high contrast, difficulty, sensitivity, and volume. It still needs remapping, HUD scaling, input-matrix, and accessibility audits. |
| Feature completeness | 5/10 | 3/10 | Legacy is broader as a prototype. Current is the higher-fidelity production foundation but is not content-complete. |
| **Overall today** | **4.8/10** | **4.6/10** | Neither build is studio-production-ready. The legacy score reflects breadth, not production suitability or fidelity ceiling. |

## Verified legacy results

- API audit: clean.
- Primary path suite: all checks passed for boot, population, walking, vehicle
  entry/exit, acceleration, shooting, and console/page errors.
- Secondary path suite: failed apartment interaction and deterministic vehicle
  re-entry.
- The built-in 18-test self-test passed despite those two failures, proving that
  it does not cover important player paths.
- Fresh benchmark: 5.867 s boot, 54.0-58.1 FPS, seven draw calls, 12-16 MB heap;
  driving and shootout scenarios reduced render scale to 0.92.
- Those fresh results do not support the checked-in 2.310 s boot and locked
  60 FPS claims.

## Layer-by-layer production choice

| Layer | Preserve from `neon-city` | Build forward here |
| --- | --- | --- |
| Renderer | Pooling, instancing strategy, adaptive scale, crowd-density budgets, benchmark scenarios | PBR materials, shadows, skeletal animation, post-processing, streaming, visual LODs |
| World | Deterministic districts, collision hash, traffic graph, activity density | Authored landmarks, interiors, traversal routes, streaming cells, environmental storytelling |
| Characters | Cheap distant-crowd representation only | Rigged hero/NPC bodies, facial performance, skin/hair/cloth, IK, weapons, animation state graph, tiered crowd LODs |
| AI | Traffic lanes, civilian panic, police escalation, LOS evasion | Perception, cover, tactics, schedules, memory, investigation, group coordination, navigation and recovery |
| Combat | Wanted-response coupling | ADS/hip separation, recoil, spread, falloff, reload, hit reactions, damage model, aim assistance and latency budgets |
| Missions | Data-oriented step/state-machine pattern | Authored encounters, checkpoints, fail recovery, cinematics, dialogue, branching consequences, regression playthroughs |
| Audio | WebAudio buses, engines, sirens, weather ambience, generative radio | Authored music and ambience, spatial mixing, dialogue/voice pipeline, occlusion, loudness and accessibility passes |
| QA | CDP path tests and scenario benchmark shapes | Portable browser E2E, visual regression, controller matrix, save migration, asset failure, frame-time and memory certification |

## Public pre-alpha gate

Before publishing the canonical project publicly:

1. **Complete:** validate the six rebuilt hero binaries and generated schema-2
   manifest (`npm run validate:characters`).
2. Make a fresh idle-machine load reach the title repeatedly and instrument every
   engine initialization phase.
3. Complete lint, typecheck, unit tests, clean install, and production build.
4. Add CI, browser E2E smoke coverage, a known-issues document, and a real
   contributor workflow.
5. Include all source tooling, licenses, third-party notices, and asset
   provenance.
6. Establish honest 1080p frame-time, memory, input-latency, and minimum-spec
   baselines.
7. Publish only as `v0.1.0-prealpha`; do not use AAA, production-ready, or
   GTA-beating language.

## Legacy public-release cleanup

If the old prototype is ever published separately, it must first receive a
portable test runner, CI, `.gitignore`, contribution/security/release files,
correct benchmark copy, consistent naming, removal of borrowed GTA terms,
removal of unsupported mobile/rebinding claims, and a curated screenshot set.
