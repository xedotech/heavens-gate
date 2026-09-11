# Production checkpoint — 2026-09-11

This is an in-progress checkpoint, not a release approval. Preserve all existing
changes. `QUALITY_GATES.md` remains authoritative; no failed gate is closed by
the work below.

## AAA sprint wave — latest edit session

- Added an HDR post stack (EffectComposer + RenderPass + UnrealBloomPass +
  OutputPass over a HalfFloat target) with a direct-render fallback, quality
  gating, resize handling, context-loss recovery, and disposal.
- City dressing pass: HDR-capable emissive window instances, neon strips,
  streetlamps, billboard signage, additive gate light shafts, and a
  high-quality instanced rain layer with a filtered-noise ambience bed.
- Vehicles gained wheel pivots (spin + steering visuals), body lean, brake
  lights, headlight cones plus a driven-vehicle spotlight, and five ambient
  traffic cars that update dynamic obstacle volumes, brake around the player,
  and panic when struck by gunfire.
- Combat now exposes three weapons — Morrow sidearm, Psalm repeater, Vesper
  scattergun — with a shared spec table (RPM, spread/recoil, falloff, pellets,
  reload, swap seconds, tracer color), per-weapon ammo pools persisted in
  checkpoints, swap on X / D-pad down, and three distinct procedural gun meshes
  on a shared mount that the hero GLB hand socket parents.
- Mission cinematics: letterboxed objective flyovers on campaign start,
  checkpoint retry, mission completion, and free-roam entry. Any movement or
  fire input interrupts; reduced-motion skips; HUD panels dim during playback.
- Feel pass: corpse tip-over + material fade (drones crash down first),
  hit-stop on kills, camera walk-bob and landing dip, directional damage arc,
  spark-burst impacts, kill drops (ammo cells / resonance shards), and a
  pickup collection loop.
- IBL: PMREM baked at init from an authored gradient-dome + emissive-card
  environment scene; assigned as scene.environment (intensity 0.5).
- Touch controls for coarse-pointer devices: left virtual stick, right-half
  drag look, FIRE/AIM/JUMP/RUN/E/R/SWP/VEIL/PLS buttons, pause shortcut; CSS
  media-gated so desktop rendering is untouched.
- Verified after these changes: `tsc --noEmit` clean, 162/162 tests across 19
  files, `eslint` clean, `vinext build` succeeded (known >650 kB chunk warning
  remains). Engine harness compatibility preserved via defensive access for
  Object.create test objects.
- Not closed by this wave: browser playthrough capture, sustained frame trace,
  any QUALITY_GATES score change, console/native builds, photogrammetry (no
  scan sources exist), multiplayer. MPFB is not installed in the local Blender
  5.2 so the character compiler cannot run here yet.

## Consolidated combat verification

### Locomotion audit and runtime follow-up

- Experimental compiler revision adds alternating stance/swing calf and thigh
  poses at the walk/run passing keys. A single Seraph build is running into
  `artifacts/characters/gait-probe-20260911`; public assets are untouched.
  These local-basis pose candidates are not accepted motion: exported knee
  direction, foot clearance, loop continuity, and visual review must precede
  any delivery. Ankle/toe roll and planted-foot solving remain unimplemented.

- Consolidated runtime build completed successfully after 161 passing tests,
  type-check and lint. Large client chunks remain a warning.
- Added `tools/characters/audit_gait.py` and ran it in background Blender against
  the current public Seraph GLB. It correctly failed the narrow articulation
  check: both knees varied by less than 0.00003 degrees in walk/run. Sampled leg
  loop matrices matched exactly at endpoints. This confirms stiffness in the
  exported asset, not merely source values. No asset was modified. This audit
  does not validate planted feet, skin intersections, or overall animation quality.

- Follow-up test now checks walk-to-run-to-walk phase with unequal clip durations.
  Full suite passed: 161 tests across 19 files. Consolidated type/lint/build is
  still running. The prior camera build completed successfully.
- Root independently confirmed compiler walk_a/walk_b calves remain at 0.08 and
  run inherits those values. Public assets are unchanged; no improved knee/foot
  fidelity is claimed. Next asset work requires authored passing/recovery poses
  and exported full-cycle inspection, including foot clearance and loop seams.

- Agent source audit found nearly fixed calf rotations in authored walk/run
  cycles, missing ankle/toe roll, stationary aim/crouch selection while moving,
  fixed playback rate, and unsynchronized walk/run phase. Asset reauthoring and
  moving aim/crouch remain required; none is visually approved.
- Reproduced walk/run phase reset with a real AnimationMixer test using unequal
  clip durations. Runtime now preserves normalized gait phase for walk/run
  transitions. Seven character tests pass; latest type-check is running.
- The ongoing camera verification build predates this runtime change and must
  not be treated as validation of the gait change if it completes.

- Camera follow-up: 160 tests across 19 files passed, including preservation of
  unobstructed smoothing, inspection-orbit clearance, and unchanged collider
  dimensions. Consolidated type/lint/build sequence remains running. A read-only
  agent is auditing locomotion stiffness for the next character-fidelity step.

- The consolidated combat production build finished successfully (large chunk
  warnings remain). A subsequent camera regression found interpolation leaving
  the camera behind a wall. Gameplay and inspection cameras now constrain the
  smoothed position against world boxes expanded by 0.25 units for clearance.
  Nine focused camera/sight tests passed. Latest camera type-check is running;
  full suite, build, and visual orbit/traversal QA for this change remain open.

- Full unit suite passed: 157 tests across 18 files, including player muzzle
  obstruction, enemy cover, collider ordering, and vehicle exit regressions.
- Type-checking for the player-shot revision and subsequent lint passed.
- Character validator passed all six assets; environment validator passed six
  maps totaling 17,936,678 bytes. Release metadata checker passed its four-file,
  license/version, and character-roster checks; it does not approve release QA.
- Production build is in progress at this checkpoint edit. Browser playthrough,
  current visual captures, sustained performance traces, and release gates remain
  outstanding. The source tree remains dirty and has not been published.

## Vehicle exit safety — 2026-09-11

### Height-aware sight follow-up

- The sight/enemy-cover production build completed successfully; type and lint
  also passed. Large client chunk warnings remain. Two further tests passed for
  collider order and overlapping cover.
- A subsequent player-shot regression reproduced camera/muzzle disagreement:
  the camera could see an actor while the muzzle path crossed a wall. Player
  damage now requires a clear muzzle path; tracer and impact stop at the cover.
  All eight focused sight/combat tests passed. Type-checking for this latest
  change is running; its fresh full suite/build/browser checks remain pending.

- Combat follow-up reproduced 18 damage events through intervening cover in a
  deterministic 20-shot test. Enemy shots now query the nearest world-box
  obstruction, end tracers there, and suppress covered hits. The regression also
  checks that removing cover restores damage. All 154 tests passed across 18
  files; current type/lint checks are pending. Prior sight-only lint passed.

- Reproduced three defects with real-engine tests: thin walls between sampled
  positions were missed, low barriers blocked sight above them, and vertical
  sight ignored overhead geometry.
- Replaced planar sampling with finite 3D ray/box intersection against existing
  collision boxes. AI perception and gunfire audio occlusion share this check.
  This is box-level occlusion, not mesh-accurate visibility or acoustic simulation.
- All 153 tests across 18 files passed. Type/lint verification was still running
  at this checkpoint edit. No browser scenario or fresh build for this change yet.

- Confirmed the agent audit with three failing real-engine regressions: both side
  exits blocked, every exit blocked, and heading-relative placement.
- Exit candidates now rotate with vehicle heading, remain inside world bounds,
  and validate destination plus sampled collision path before committing occupancy.
  A blocked exit preserves the hidden player and occupied vehicle with feedback.
  Successful exits clear stale player velocity.
- Full unit suite: 147 tests passed across 17 files; type-checking and lint
  completed successfully. No browser exit validation yet.
- The preceding revision completed its production build successfully, with large
  chunk warnings. That build does not validate this subsequent exit change.
- This is gameplay correctness work, not a visual-fidelity or release gate closure.

### Exit verification follow-up

- Fresh production build including the exit implementation completed successfully
  on 2026-09-11. Large (>650 kB) client chunk warnings remain.
- Added and passed two further real-engine cases: a clear exit endpoint behind
  a blocking wall is rejected, and an exit near the world edge chooses inward.
  All seven vehicle tests passed. The full-suite count above predates these two
  test-only additions; no claim of a new full-suite run is made here.
- Browser traversal/exit capture, representative hardware performance, and all
  outstanding production quality gates remain open.

### Local production preview recovery

- Browser inspection found a failed dynamic import of GameShell.tsx in the old
  development page. Clicking Restart renderer repeated the error; a reload
  reported connection refused. Port 3000 had no listening server.
- Started the existing production build bound to 127.0.0.1:3000. A direct local
  HTTP request returned 200 and the server process remained live.
- Browser recovery encountered a tool URL-policy block on the generated network
  error page. This was not bypassed. Production rendering and vehicle playthrough
  remain unverified; HTTP 200 alone is not a browser smoke-test pass.

## Previous update — 2026-09-10, collision response

### Vehicle sweep follow-up — 2026-09-11

- Follow-up regression test caught the sweep discarding tangential motion after
  first contact. It now continues the unblocked axis for the remaining substeps.
  Focused movement/vehicle tests passed 15/15. This is a sampled resolver, not
  mathematically continuous collision; obstacles narrower than the chosen step
  need an expanded collider or smaller sampling interval.

- Vehicle translation now uses the planar sweep with a 0.5-unit step and the
  existing 2.25-unit collision radius. On impact it retains a safe intermediate
  position instead of resetting to the frame's starting position. Existing damage,
  impact audio, and rebound behavior are retained.
- Two tests invoke the real engine vehicle-update method without constructing a
  renderer. Both passed: wall impact position/rebound/single feedback and free
  driving/player tracking. Combined tests and production build are in progress.
- Physical-controller handling, visual collision inspection, suspension, wheel
  motion, vehicle entry/exit animation, and damage modeling remain open gates.

### Latest consolidated runtime verification

- The post-sweep production build completed successfully in session 19966. It
  retains the known >650 kB chunk and plugin-timing warnings.
- Browser smoke test on the local app loaded the new character assets, continued
  a saved game, and rendered the corrected idle pose without a startup error.
  This is not a traversal, audio-listening, or hardware-performance pass.
- Current full unit count is 141/141 across 16 files; typecheck and lint passed
  after the sweep integration. No release or AAA gate is implied.

### Substepped planar collision follow-up

- Added a 0.1-unit substep sweep to player horizontal movement and integrated its
  safe endpoint/axis flags with wall sliding and vault handling. This closes the
  previously identified endpoint-only gap for normal player frame displacements;
  it is not a general 3D continuous collision solver.
- Added tests for thin obstacles crossed between endpoints and unobstructed
  high-speed travel. Focused movement suite passed 12/12 before integration;
  the full post-integration suite is running. Slopes, moving geometry, vehicle
  collision, and vault-height semantics remain open.

- Player collision now preserves the unobstructed horizontal component rather
  than cancelling all movement at wall contact. Outside-corner resolution chooses
  only one safe axis; inside corners stop both blocked components. Vault behavior
  remains unchanged and is not approved by this correction.
- Added regression coverage for free movement, both wall axes, outside corners,
  and inside corners. Full test/type/lint run is session 49055. Browser traversal
  and production-build verification for this change are pending.
- This remains endpoint collision resolution, not a continuous swept collision
  solver. Thin-obstacle tunneling, slopes, vault clearance, and controller feel
  remain part of the open movement gate.

## Prior verified updates — 2026-09-09

### Consolidated current-source QA

- 136/136 unit tests across 16 files, 2/2 publisher regression tests, typecheck,
  lint, repository character validation, six-map environment validation, release
  metadata checks, and diff whitespace checks passed. Production build completed
  successfully in session 26412 with existing bundle/plugin warnings.
- Current six public GLBs also passed Khronos gltf-validator 2.0.0-dev.3.10 with
  zero errors and nine warnings each. Report codes include UNSUPPORTED_EXTENSION,
  UNUSED_MESH_TANGENT, and NODE_SKINNED_MESH_NON_ROOT. These warnings/notes remain
  visible; unsupported extension payloads are not fully validated by that tool.
- No playthrough, hardware trace, console certification, photogrammetric-human,
  or AAA fidelity gate is closed by this consolidated check.

### Frame-time statistics correction

- Build including the statistics correction completed successfully (session 61446).
  Added render-buffer dimensions, CSS viewport dimensions, selected quality,
  game mode, and pause state to `getPerformanceSnapshot()` afterward. A focused
  engine snapshot test passed, preserving the distinction between a 1920x1080
  viewport and an adaptively reduced 1632x918 drawing buffer. These are fixture
  values, not measured hardware performance. Typecheck runs in session 2100.
- Snapshot is currently an engine API, not a visible performance UI or a durable
  ten-minute trace. The production performance gate remains unverified.

- Sampler now uses nearest-rank p95 and midpoint median for even windows. Invalid
  negative/non-finite readings are excluded rather than counted as zero-time frames.
  Recording remains allocation-free; summary allocates a bounded sorted copy.
- Four regression cases failed before the correction and pass afterward, covering
  small windows, invalid data, even medians, percentile ranks, and spike eviction.
  Combined suite passed 135/135 tests in 15 files. Type/lint run in session 33414.
- The preceding audio lifecycle build passed (session 84881). The new statistics
  change needs its own build verification. No qualifying hardware performance
  trace or 60-fps claim follows from these statistical tests.

### Enemy audio implementation

- Lifecycle follow-up: three mocked Web Audio tests reproduced and then verified
  fixes for mute-before-unlock and vehicle-oscillator recreation after disposal.
  Transient gunshot sources and route nodes disconnect after both layers end.
  Disposal now clears bus/source references and score state. Full suite passed
  133/133 tests across 15 files; type/lint are running in session 26516.
  These tests verify routing calls, not rendered waveforms or listening quality.
- Previous positional-audio build (session 56026) passed. A fresh build including
  these latest lifecycle corrections is still needed.

- Enemy firing now triggers a layered procedural report, camera-relative stereo
  placement, distance attenuation, and low-pass/level reduction when the existing
  world line-of-sight check reports obstruction. This is stereo panning, not HRTF.
- Added ended-event disconnection of transient tone/noise nodes and spatial route
  nodes. Audio-node lifetime instrumentation and headphone listening still needed.
- Three deterministic spatial-mix tests cover direction/camera rotation, distance
  and elevation attenuation, cutoff, and occlusion. Combined suite passed 130/130
  tests in 14 files. Browser/audio listening and production-build verification for
  this new audio implementation remain pending.
- Movement correction build (session 2741) completed successfully before this audio
  change; existing bundle/plugin warnings remain. No performance or AAA claim.

### Heading interpolation correction

- Replaced scalar player-heading damping with shortest-arc angle damping. This
  prevents a near-360-degree turn when atan2 targets cross the -pi/pi boundary.
- Two new movement tests cover both boundary directions, 30/60 Hz equivalence,
  and zero/negative time steps. Fresh combined suite passed 127/127 tests in 13
  files. Type/lint/build are running in session 2741 against this source.
- Before this movement edit, the stable-source build for the animation lifecycle
  correction completed successfully in session 49473. Prior lint/diff checks also
  completed successfully. Browser death/retry and directional-turn captures remain
  open; unit math checks are not substitutes for those gameplay checks.

### Character lifecycle correction

- Regression tests reproduced death being overridden by subsequent movement/fire
  and the absence of an explicit animation reset on campaign retry.
- Death now rejects subsequent action requests until `resetAnimation()` is called.
  Campaign reset invokes it, clears pending one-shot/speech/blink state, and
  evaluates idle immediately. Zero-duration transitions no longer create a fade
  interpolant that holds zero weight until the next frame.
- Focused real-mixer and engine-reset tests passed 9/9 after the correction.
  Combined suite passed 125/125 tests across 13 files. Typecheck emitted no
  diagnostics; lint is still running in session 65178. Build session 68363
  completed successfully, but overlapped the final zero-fade edit, so repeat a
  clean build against the stable final source before treating it as definitive.
  Browser death/retry visual validation remains open. This does not close animation QA.

### Idle-pose integration — latest verified state

- Full cast build completed successfully. The CLI idle audit completed with
  `HG_IDLE_CAST_PASS=6`; all six staged character contracts/material checks passed.
- Integrated all six idle-corrected assets (23,702,940 bytes total). Previous seven
  public delivery files are hash-verified in `artifacts/characters/pre-idle-public-20260909`.
  Public character validation reports six characters and zero failures.
- Each of the six assets returned HTTP 200 from localhost:3000 and matched its
  manifest SHA-256. A fresh browser tab resumed the saved game and visibly showed
  Seraph with arms lowered beside the torso. This confirms in-game delivery of
  the idle correction, not full animation quality. Head posture, held-weapon grip,
  movement/action transitions, and all-character visual checks remain open.
- No full AAA, performance, console, or release gate is closed by this correction.

### Idle-pose development history — superseded by integration above

- Replaced guessed local-angle posing with an armature-space direction solve for
  Idle's four arm bones. The bind pose and other clips are unchanged.
- Seraph rebuilt successfully in `artifacts/characters/idle-stance-probe-20260909`
  (3,690,720 bytes; 53 bones / 67 morphs / 9 meshes / 11 actions).
- Blender MCP re-imported and rendered the actual candidate to
  `artifacts/progress-20260908/seraph-idle-export-corrected.png`. Arms are beside
  the torso instead of held out. Hair and skin limitations remain visible.
- `tools/characters/audit_idle_pose.py` passed both arms at start/middle/end:
  finite coordinates, downward upper arms, hands below elbows, no crossed hands.
  Negative control against current public Seraph failed all six arm-down checks,
  demonstrating that the audit detects this specific regression. It does not
  establish garment collision safety or full animation/transition quality.
- Full rebuild started in `artifacts/characters/idle-cast-20260909`; do not replace
  public assets until all six have completed and passed staged and pose checks.
  Public assets still contain the material-corrected cast, not this idle candidate.
- In-progress cast: Seraph and Relic exported and each passed the Blender
  start/middle/end idle-arm audit on re-import. Remaining identities are pending.
- Follow-up: Nocturne also passed and was rendered to
  `artifacts/progress-20260908/nocturne-idle-corrected.png`; Ash exported but is not
  yet pose-audited. The existing full-cast build remains live (session 20083).
  Four GLBs are present at 00:54 local time; do not restart merely for slow output.
- The pose audit now has a CLI entry point that preflights all six files and
  refuses an incomplete cast. Run Blender with `--background --python-exit-code 1
  --python tools/characters/audit_idle_pose.py -- --assets artifacts/characters/idle-cast-20260909`.
  The new full-cast CLI still needs execution after the rebuild finishes.
- Browser Continue resumed the saved game and displayed the material-corrected
  Seraph. Its old spread-arm pose remains visible as expected; no claim that the
  candidate idle update is served in gameplay yet. No performance trace captured.
- Added four tests using the real Three.js mixer through `HeroCharacter`: initial
  idle and walk blend, one-shot return to latest requested movement, repeated-fire
  restart, and holding death's final pose without an automatic idle return.
  These synthetic track tests establish runtime logic, not mesh visual quality.
  Fresh combined suite passed 123/123 tests across 13 files; typecheck and lint
  completed without diagnostics. No application runtime code changed in this pass.
- Next: finish and audit the idle cast; inspect transitions into walk/run/aim,
  whose existing poses have NOT been corrected by this Idle-only change.

### Integrated material correction and prior checks

- The active objective still covers the entire game. No AAA, photogrammetric-human,
  console-certification, parity, or release-readiness gate has been closed.
- Compiler corrections remove cloth clearcoat, preserve eye-overlay alpha, and
  bake clothing occlusion while asserting preservation of all 67 facial morphs.
  Runtime cloth/eye tuning and uncapped frame-time sampling are implemented.
- Full six-character build finished successfully in `artifacts/characters/material-cast-20260909`.
  Staged and public manifest validation both report six characters and no failures,
  including cloth clearcoat 0, eye alpha, hashes, and the 53:67:9:11 contract.
  The matched set is integrated in `public/assets/characters`. All seven previous
  delivery files were copied and hash-verified in
  `artifacts/characters/pre-material-public-20260909` before replacement.
- Blender MCP rendered the rebuilt Seraph to
  `artifacts/progress-20260908/seraph-material-rebuild.png`. Visual inspection
  confirms the glossy cloth patches are removed. Hair, skin detail, stiff pose,
  and close-range expression/animation fidelity remain below the requested target.
  This is an offline asset render, not a browser gameplay or performance proof.
- Fresh unit suite: 119/119 tests, 12/12 files passed. Typecheck and lint emitted
  no diagnostics; production build passed with existing large-chunk and plugin-timing
  warnings. Two additional Node publisher regression tests passed: a missing later
  report and an invalid later skeleton both preserve existing assets and manifest.
  Run these with `node --test tools/characters/publish_manifest.test.mjs`.
- Environment validation (six maps), release metadata validation (four files),
  and `git diff --check` passed. These checks are not release approval.
- Character validator now resolves assets beside the selected manifest and checks
  six unique identities, cloth coating, and eye alpha. The publisher now preflights
  every character before copying any binary; this is not an atomic filesystem
  transaction and a backup is still required before integration.
- Preview tooling now selects each import's own Idle action. Compiler warnings
  about modifier order, four-weight truncation, and texture samplers remain for
  follow-up review. Full-cast deformation and browser visual QA remain open.
- Next: browser-check the integrated cast, inspect every skin and animation,
  then correct the visibly stiff stance and deficient hair/skin presentation.
  World, gameplay, audio, accessibility, packaging, and platform gates remain open.

## Previous verified update — 2026-09-04 (historical)

- All six helper-corrected characters are now delivered in `public/assets/characters`:
  24,829,464 bytes total, 53 bones / 67 morphs / 9 meshes / 11 actions each.
  Previous public files are backed up in `artifacts/characters/pre-helper-public-20260904`.
- Two isolated compiler probes matched byte-for-byte, but full-cast export still
  changed animation-channel serialization order. Decoded animation values match;
  cross-invocation bitwise reproducibility is NOT yet established.
- Photo-based Poly Haven CC0 pavement maps are imported and wired into the engine:
  six local maps totaling 17,936,678 bytes, 1K low / 2K medium-high, shared browser
  and offline contract validation. These are surface maps, not scanned geometry.
- Fixed stale boss ray targets/resource disposal on reset, inspection surviving a
  reset, and storage retry overwriting untouched recoverable preferences.
- Fresh typecheck, lint, 119/119 tests across 12 files, character/environment
  validators and release-metadata validator passed. Production build passed with
  the existing >650 kB chunk and plugin-timing warnings. These metadata checks
  do not constitute release approval.
- Local HTTP returned 200; title and continued gameplay were observed in the
  browser with the corrected character. Full visual/settings/performance QA is
  still ongoing. No physical-controller, Mac, console or qualifying 1080p trace.
- Desktop source ZIP excludes dependencies, build caches, and intermediate
  renders; install with `npm ci`, then `npm run dev`. It is not a packaged executable.

## Previous checkpoint (historical, retained for continuity)

## Integrated source, latest observed checks

- Input agent added browser-independent `GameInputState`, physical-key release,
  keybind validation/repair, controller sprint/brake/inspection, disconnect and
  focus clearing, and frame-time-scaled controller look. Input/keyboard tests
  now total 30. Physical controller validation remains open.
- Root added validated settings and v1 saves, backup checkpoint recovery,
  protected newer-version saves, quota/access failure handling, visible local
  storage notices and retry, and explicit two-key erase handling.
- Ending persistence uses `createCheckpoint`; legacy epilogues missing a choice
  return to the final decision rather than inventing an ending. Reset clears
  combat timers and prior gate lighting; leaving Veil restores the ending world.
- Observed 94/94 tests across 9 files, typecheck, and lint passed after the input
  and persistence integration. The newer scan-material files require a fresh
  combined build/browser pass. No production-build claim for these new changes.

## Character correction

The fidelity review found MakeHuman authoring helper shells exported as visible
geometry. The compiler now removes semantic helper groups after fitting and
facial interpolation, with topology/morph-preservation assertions.

- Root inspected `artifacts/characters/helper-fix-probe/turntables/aurel-seraph-hero.png`.
  The face and separate trouser legs are visible instead of the helper mask/skirt.
- Seraph report: Blender 5.2.1 LTS; 5,778 helper vertices removed; zero helper
  vertices remain; 13,380 body vertices and 67 morphs preserved; 53 bones,
  9 meshes, 11 actions. Candidate size 3,907,804 bytes.
- Garment intersections, rest-stance arms, close-up skin maps, and expression
  shading remain visible or unverified. These are not photogrammetric humans.
- The character agent is rebuilding all six into
  `artifacts/characters/helper-fixed-cast`; inspect its reports and captures.
  Public assets and manifest have NOT been replaced with this candidate set.
- Next: verify all reports/contracts, inspect turntables, stage the delivery
  manifest, then integrate the six as a matched set and run asset/browser QA.

## Photo-based environment work — NOT yet integrated

User explicitly requested photogrammetry. Added (but not yet executed/wired):

- `tools/environment/import_pavement.mjs`: one selected Poly Haven CC0 material,
  pinned provider URLs/MD5/byte sizes, SHA-256 provenance, 1K/2K WebP delivery.
  Albedo uses quality 88; normal/packed ARM use lossless WebP from provider JPGs.
- `app/game/scan-contract.ts` and `scanned-materials.ts`: local manifest/hash
  validation, real-world tiling, correct map color spaces, quality-tier swapping,
  timeout/fallback and disposal. Not yet referenced by the engine.
- `tools/environment/validate_environment.mjs`: local map hash/dimension checks.

Next steps: declare/pin Sharp (0.35.2 is currently installed transitively), run
the importer, test the scan contract, wire ground material lifecycle/quality
changes in the engine, add provenance to notices and docs, and perform fresh
asset/type/test/lint/build/browser checks. No scan assets have been downloaded
by this importer yet. No runtime third-party API calls are intended.

Sources verified 2026-09-04:

- https://polyhaven.com/a/concrete_pavement_03
- https://polyhaven.com/license
- https://docs.polyhaven.com/en/technical-standards/textures
- https://raw.githubusercontent.com/Poly-Haven/Public-API/master/ToS.md

Provider describes its materials as photo-based (photogrammetry or photometric
stereo); this asset's exact acquisition method is not stated. A tiled material
is NOT scanned world geometry. Do not describe this milestone as a complete
photogrammetry game or as evidence of AAA readiness.

## Continuation and boundaries

The saved goal flag remains `usageLimited` even when live account allowance is
available. Check actual usage limits before deciding a heartbeat cannot work;
do not redeem resets without explicit authorization. Two agents were interrupted
by usage earlier; their completed local source/candidate artifacts survived.
The full studio-production goal is unfinished. No public repo, deployment,
purchase, credential operation, or console submission has been authorized here.
