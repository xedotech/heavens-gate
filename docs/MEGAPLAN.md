# Heaven's Gate — AAA Sprint Megaplan

One-sentence summary: take the playable Heaven's Gate vertical slice as far toward
AAA presentation and feel as one week allows, prioritizing everything that is visible
on screen in the first 30 seconds, while keeping every quality gate honest and every
test green.

## Honest scope statement

This plan does not promise GTA/COD/Sims parity or true photogrammetry — those need
hundreds of developers and physical scan pipelines. What it does promise: every
system that exists gets visibly deeper, the render path gets a real post stack and
image-based lighting, and the game runs and plays on PC, tablet (touch), and
gamepad with one codebase.

## Phase 0 — Foundation (DONE)

- [x] EffectComposer post stack: HDR render target, UnrealBloom, OutputPass,
      quality-gated, resize/context-loss/dispose safe, direct-render fallback.
- [x] City dressing: HDR emissive windows, neon strips, streetlamps, billboards.
- [x] Vehicles: wheel pivots, spin + steering visuals, body lean, brake lights,
      headlight cones + driven spotlight, ambient traffic with collision + panic.
- [x] Weapons: Morrow / Psalm / Vesper spec table, per-weapon ammo pools, swap
      keybind (X / D-pad down), three authored procedural gun meshes on one mount,
      distinct tracer colors, save/restore of equipped weapon + pools.
- [x] Mission cinematics: letterboxed flyover on mission start/complete/checkpoint,
      skips on reduced motion, interrupted by any movement/fire input.
- [x] Crowd + weather: 34 varied civilians, high-quality rain layer, gate light
      shafts, kill hit-stop.

## Phase 1 — Feel and animation (IN PROGRESS)

- [ ] Actor death animation: tip-over, fall-to-ground for drones, material fade,
      corpse settles then despawns — replaces the instant pop-out.
- [ ] Camera juice: walk-cycle head-bob, landing dip scaled by fall impact,
      sprint FOV kick (exists), hit-stop (exists).
- [ ] Locomotion states already drive the hero GLB (idle/walk/run/crouch/slide/
      aim/jump); verify transitions land cleanly in the browser.
- [ ] Impact polish: muzzle light exists; add spark bursts + decals-lite on
      world hits.

## Phase 2 — Lighting and materials

- [ ] Procedural IBL: PMREM from an authored night-city environment scene
      (gradient dome + emissive city glow cards) applied to scene.environment —
      lifts every metal/glass/wet surface with zero external assets.
- [ ] Verify bloom threshold/strength per quality preset; high-contrast a11y path.
- [ ] Wet-road sheen on high quality (env reflections do most of this once IBL is in).

## Phase 3 — Input completeness (PC / tablet / gamepad)

- [ ] Touch controls: left virtual stick (move), right-half drag (look), FIRE /
      AIM / JUMP / INTERACT / RELOAD / SWAP / VEIL / PULSE buttons, pause.
      Shown only on coarse-pointer devices; zero cost elsewhere.
- [ ] Keyboard remapping + gamepad already live; keep contracts stable.

## Phase 4 — Combat and world depth

- [ ] Directional damage indicator on HUD (arc toward attacker).
- [ ] Ammo/resonance drops from kills (small glowing pickups, walk-over collect).
- [ ] Traffic panic already spreads from gunfire near cars.

## Phase 5 — Audio

- [x] Per-weapon voices, swap, reload, empty, footsteps, adaptive score,
      spatial enemy fire, vehicle engine loop.
- [ ] Rain ambience layer tied to rain visibility (filtered noise bed).
- [ ] Landing thud + slide/dodge whoosh hooks if not already covered.

## Phase 6 — Verification and honesty

- [ ] typecheck / vitest / eslint / production build all green after each wave.
- [ ] Browser smoke at localhost:3000 — title, load, campaign, movement, ADS,
      all three weapons, vehicle drive, traffic, cinematic, pause, settings.
- [ ] Update README controls + PRODUCTION_CHECKPOINT; keep QUALITY_GATES
      evidence-honest (no gate marked closed without data).
- [ ] Commit work in logical checkpoints.

## Explicitly out of scope this week

- Photogrammetric scanned assets (requires physical scans, not code).
- Native console builds / certification — console browsers and gamepad-supported
  web play are the realistic target.
- Multiplayer/co-op networking.
- Full authored interiors for every building.
- 12+ mocap-authored NPC identities — hero GLBs are rigged/animated CC0 MPFB
  builds; crowd stays procedural-with-rigs until MPFB is installed in Blender.

## Machine notes

- Blender 5.2 LTS installed at `C:\Program Files\Blender Foundation\Blender 5.2\`.
- MPFB extension NOT installed → `tools/characters/build_characters.py` cannot run
  as-is; installing MPFB inside Blender would unlock recompilation and crowd GLBs.
- BlenderMCP addon present in Blender, but no MCP server configured for the agent.
