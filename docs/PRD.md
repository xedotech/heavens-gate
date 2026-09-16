# Heaven's Gate — Product Requirements

Status: living product bible for the playable web slice.  
Authority: this document sets product intent. `docs/QUALITY_GATES.md` still decides whether a layer is *proven*. `docs/GAME_DESIGN.md` remains the fiction/pillars shortform. Do not treat a shipped system as a closed gate.

This is a vertical slice, not AAA. Design and assets can move. The Three.js engine cannot.

---

## 1. Problem

Players who want a celestial-noir third-person city game today get either a years-long native production or a web toy that cannot carry combat, driving, and story in one district. Heaven's Gate exists to prove one complete loop — walk, fight, drive, choose — inside a 340 × 340 m city that feels authored, then keep that proof as the design bible for a later native product.

The user compared the ambition to GTA, Call of Duty, and The Sims. Those are reference *categories*, not ship targets for this repository.

## 2. Player

Primary: a single player on a desktop browser (keyboard + mouse or standard gamepad), with a secondary tablet/touch path already in the slice.

They want:

- A character who reads as a person, not a capsule.
- A city that answers violence and curiosity.
- Missions that change verbs (navigate → fight → drive → Veil → boss → moral choice).
- Controls that do not fight them.

They do not want a life-sim, a multiplayer lobby, or a claim that a browser map is Los Santos.

## 3. Fantasy

Aurel is a courier who may be a manufactured memory. Afterlife infrastructure in Aethel has started broadcasting their name. The Choir turned heaven into policy: identity is stored, edited, and denied. The player authors a verdict — open the gates, or seal them — and then walks the same streets in the world that verdict made.

Tone: Aurelian Void. Obsidian, ivory, one sacred-gold signal. Myth is a system, not flavor text. See `brand.md`.

## 4. Non-goals

Explicitly out of this product, including any later native port unless a future PRD replaces this one:

- The Sims: needs, jobs, relationships, housing, family, calendar life-sim.
- Call of Duty multiplayer: 6v6, loadout meta, seasonal live-service.
- GTA-scale city: kilometers of authored streets, interior density, ambient-crime sandbox.
- 1:1 conversion of the Three.js renderer, Rapier-less box physics, Web Audio graph, or React HUD into Unity/Unreal.
- Console certification from this web build.
- Licensed Rockstar / Activision / Maxis assets, maps, UI, or audio.
- Photogrammetric *humans*. Hero bodies are MakeHuman / MPFB, not scans.

## 5. Current slice vs target product

| Layer | Today (this repo) | Honest next product | Not this decade in-browser |
| --- | --- | --- | --- |
| Engine | Three.js + React/Vinext, one `HeavensGateEngine` | Stay on Three.js until the slice is evidence-complete | Native Unreal or Unity HDRP |
| Map | Deterministic ~340 × 340 m, 5 districts | Same district, denser dressing, 3–5 interiors | Open-world city |
| Campaign | 8 operations, 2 endings, free roam | Same arc, authored set pieces, captured playthrough | 20+ hour campaign |
| Combat | 3 guns, melee, throwables, cover, ADS | Feel + evidence (traces, capture) | Full Gears/Division suite |
| Driving | 7 player cars, 3 handling archetypes, 5 traffic | Handling course + damage readability | Full traffic sim |
| Humans | 6 hero skins; procedural crowd | 12 distinct crowd identities, 3 LODs | Photogrammetry crowds |
| Audio | 43 CC0 clips + synth fallback | Recorded gun/foley ceiling, loudness report | Licensed score / Atmos |
| Platform | Browser, gamepad, touch, local saves | PC/Mac packaged web or native wrapper | First-party console SKUs |

**Product recommendation**

1. Keep this repository as the playable design bible: missions, numbers, art direction, control map, quality bar.
2. Do not chase Sims systems or a GTA-sized web city.
3. Realistic next SKU: an **AA celestial-noir district** at Control / Dishonored scale (one dense borough, supernatural verbs, authored interiors), not an AAA open world.
4. Engine for that SKU: **Unreal Engine** if the ambition is cinematic AAA later; **Unity HDRP** if the goal is a shippable indie in a bounded team. Both require a rewrite of runtime systems. GLB/PBR, combat tables, mission scripts, and narrative port. Renderer, physics, UI, audio middleware, and city generation do not.

## 6. Pillars (product)

Carried from `docs/GAME_DESIGN.md`, restated as requirements:

1. **Movement is authorship.** Walk, sprint, crouch/cover, vault, drive, and Veil are different ways to read the same district.
2. **The world answers.** Heat, fleeing civilians, drones, traffic panic, and the ending's atmosphere are visible, not journal flags.
3. **Myth is a system.** Resonance, echoes, gates, sigils, and the Archon have verbs.
4. **Restraint creates scale.** HUD stays quiet. Landmarks, light, audio, and silhouettes carry spectacle. No empty “next-gen” claims.

## 7. Verbs

Must remain playable in the slice:

| Verb | Input (default) | Notes |
| --- | --- | --- |
| Move / look | WASD + mouse, sticks | Pointer-lock with fallback |
| Sprint / overdrive | Shift / L3 | Stamina on foot |
| Crouch / cover attach | C | Peek/lean while aiming from cover |
| Dodge / slide | Alt | Existing movement contract |
| Jump / vault | Space | Clearance-checked vault |
| Fire / ADS | LMB / hold aim | Three weapons |
| Reload (cancelable) | R | Cancel on fire, re-press, or sprint |
| Swap weapon | X / wheel | Morrow → Psalm → Vesper |
| Melee | V | Close range |
| Throw resonance charge | G | Ballistic + AoE |
| Enter / exit vehicle | E | Heading-aware exits |
| Drive-by hip-fire | Fire in vehicle | No ADS, heavy spread |
| Veil | Q | Timed alternate-state + sneak bonus |
| Resonance pulse | F | Spends the same resource as Veil |
| Interact | E | Vehicles, shrine, delivery, gates |
| Shoulder swap | T | Peek follows shoulder |

## 8. Campaign and world scope

Campaign data lives in `app/game/types.ts` (`MISSIONS`). Do not inflate the map to fake scale.

**World:** Aethel, 340 m on a side. Five districts — Crown District, Old Spine, Gilded Docks, Ash Gardens, Meridian. One enterable interior today: Chapel of the Unburied. Landmarks and gates, not a continent.

**Operations (8 / 2 endings)**

1. The Bell Below — reach the First Gate (Sena delivery + cordon beats).
2. No Saints in Crown — break the Warden cordon (eliminate 5).
3. Borrowed Wings — take a Seraph interceptor.
4. The Long Ascension — drive Meridian Gate under a lockdown clock.
5. A City That Remembers — Veil, three memory echoes.
6. The False Archon — multi-phase boss at Crown Basilica.
7. The Last Door — open or seal.
8. Afterlight — free roam in the chosen world state.

Checkpoints are device-local, versioned `SaveState` v1. Two endings persist into Afterlight. NG+ tightens enemy cadence. Eight sigils and five Attunements are the only meta-economy.

This is Dishonored's Dunwall district / Control's Oldest House wing, not Leonida.

## 9. Requirements by layer

Priority: **Must** = slice cannot be called complete without it. **Should** = next content/feel pass on this engine. **Later** = native product or post-slice.

`QUALITY_GATES.md` (status date 2026-09-03) is stricter than the current code: several rows still say “fail” because *evidence* is missing even where systems now exist. The tables below name product intent. The scorecard still wins on proof.

### World

| Pri | Requirement |
| --- | --- |
| Must | Five readable districts in the 340 m city; roads, traffic, weather, heat cordon; Chapel interior with real colliders. |
| Must | District tour capture + frame-time trace before calling the world “done.” |
| Should | 3–5 authored interiors (station, basilica, one shop/apartment). Wet-road response, 2–3 ambient street events. |
| Later | Streamed native district; modular kits; day/night population shift. Never a GTA-scale web map. |

### Combat

| Pri | Requirement |
| --- | --- |
| Must | Three weapons with the published spec table (`combat.ts`), ADS, cover peek, melee, throwables, drive-by, multi-phase Archon, civilian-heat cost. |
| Must | Combat encounter playthrough + input/frame traces. Gates still fail without those. |
| Should | Locational hit reactions, hitmarker-by-zone, more enemy miss/readjust beyond suppression. |
| Later | Full weapon sandbox, dismemberment (out of tone — do not add). |

### Driving

| Pri | Requirement |
| --- | --- |
| Must | Seven player spawns, three archetypes (Seraph / Morrow hauler / Choir interceptor), five traffic actors, enter/exit, damage/wreck, handbrake. |
| Must | Handling course + collision suite + gamepad capture. |
| Should | Readable suspension, more traffic variety, parked-car dressing. |
| Later | Native vehicle physics. Not a full traffic sim on the web engine. |

### Characters

| Pri | Requirement |
| --- | --- |
| Must | Six hero skins on the 53-bone / 67-morph / 9-mesh / 11-action contract; wardens/sentinels/stalkers/drones/boss present. |
| Must | Close-range hero turntables; crowd contact sheet of ≥12 identities with 3 LODs. Crowd currently fails this gate. |
| Should | Foot IK on the live city (partially in engine — evidence still open), NPC faces, vehicle entry clips. |
| Later | Mocap, scanned humans, full ragdoll. |

### Audio

| Pri | Requirement |
| --- | --- |
| Must | Keep CC0 recorded bed + synth fallback; spatial occlusion; adaptive combat stems; interior chapel acoustics. |
| Must | Loudness report + headphone/controller playtest. Scorecard still fails. |
| Should | Recorded gun/foley ceiling; voiced critical lines (even whispered). |
| Later | Licensed score, middleware (Wwise/FMOD) on the native SKU. |

### Cinematics

| Pri | Requirement |
| --- | --- |
| Must | Existing letterboxed flyovers / boss intro remain skippable and reduced-motion safe. |
| Must | Capture of every scene with subtitle/audio timing. HUD dialogue is not a pass. |
| Should | Face performance on Sena / Nia / Archon beats; lighting keys per scene. |
| Later | Sequencer-quality native cinematics. |

### Platform

| Pri | Requirement |
| --- | --- |
| Must | Keyboard+mouse, standard gamepad, touch layer; remapping; 760×480 minimum desktop layout. |
| Must | Full input matrix on Windows (and macOS when available); 60 fps evidence at 1080p high on declared min-spec. |
| Should | Packaged PC/Mac build of the *same* web slice. |
| Later | Unreal/Unity SKU; console storefront. A browser Gamepad API is not certification. |

## 10. Engine decision

### Stay on Three.js for this slice

The web engine is the only playable proof. Porting now would freeze a slice that still fails production evidence (60 fps cert, playthrough capture, crowd identities, cinematics). Finish the bible here.

### What ports vs what rewrites

| Ports (data / design) | Must rewrite |
| --- | --- |
| glTF/GLB heroes, props, chapel dressing | Renderer (Three.js composer, GTAO, SMAA, PMREM) |
| PBR maps + HDRIs (CC0, hash-pinned) | Physics (box sweeps, not PhysX/Chaos) |
| Mission table, spawn points, endings | Input + UI (React HUD → UMG / UI Toolkit) |
| Weapon / vehicle / upgrade / heat numbers | Audio graph (Web Audio → Wwise/FMOD/MetaSounds) |
| Narrative lines, beat flags, save schema intent | Procedural city generator |
| Control map and accessibility policy | Animation runtime (Three mixer → native AnimBP) |
| Brand tokens, quality-tier *policy* | Streaming, packaging, platform SDKs |

### Unity vs Unreal for the next product

| | Unreal | Unity HDRP |
| --- | --- | --- |
| Choose when | AAA cinematic ambition, Nanite/Lumen-scale interiors later | Bounded AA district, faster solo/small-team ship |
| Fit | Control / Dishonored / cinematic TPS | Same fiction, tighter production |
| Cost | Heavier content pipeline, sequencer, Chaos | HDRP + Cinemachine + Input System is enough for this fiction |
| Do not choose | Because “AAA means Unreal” as a slogan | Because the Three.js scene graph looks like Unity |

Recommendation: **Unreal if the studio commits to a native cinematic product; Unity HDRP if the next SKU must ship as indie AA.** Either way this repo stays the design bible. There is no automated Three.js → native converter that preserves feel.

## 11. Success metrics (mapped to quality gates)

A layer is successful only when `docs/QUALITY_GATES.md` evidence exists. Scores are not assigned from enthusiasm.

| Gate layer | Product success looks like | Evidence still required (scorecard) |
| --- | --- | --- |
| Hero humans | Six distinct, gripped, performing heroes | Close-range fidelity + clipping matrix |
| Crowd humans | 12 identities, 3 LODs, schedules | Contact sheet + LOD + timings — **fail** |
| Animation | Locomotion, aim, reload, vault, vehicle entry | 60 fps capture — **open** |
| Combat | Spec table + cover + three guns + boss phases | Encounter playthrough + traces |
| Movement | Accel, crouch, slide, vault, slopes | Traversal course, kb + pad |
| AI | Sight, cover, squad, heat, traffic awareness | Scenario telemetry |
| Vehicles | Three archetypes, damage, traffic | Handling/collision/gamepad capture |
| World | Five districts + chapel, not a fake metropolis | District tour + interiors list + traces |
| Campaign | 8 ops, 2 endings, checkpoints | Clean-save full playthrough |
| Cinematics | Blocking + faces + return to play | Capture of every scene — **fail** |
| Audio | Recorded + synth, occlusion, stems | Loudness + playtest — **fail** |
| Graphics | PBR, GTAO/SMAA, quality tiers | Golden shots + GPU captures |
| Performance | 60 fps target, p50 ≤ 16.7 ms, p95 ≤ 25 ms @ 1080p high | 10-minute min-spec trace — **fail** |
| Input/platform | kb/mouse + pad + touch parity | Full matrix + packaging path |
| Accessibility | Subtitles, contrast, HUD scale, remaps, difficulty | Keyboard-only, SR, contrast, aim-assist reports |
| Reliability | No blocker defects, save migration | Three clean production playthroughs |
| Licensing/deploy | Every binary traced, notices, reproducible build | Production URL smoke |

Do not mark a QUALITY_GATES row closed because a feature exists in `engine.ts`. Devin's live QA verifiers (`tools/qa/verify-*.mjs`) are evidence *generators*, not passes, until their artifacts are attached to the scorecard.

## 12. What we will not build

- Sims needs, relationships, jobs, housing, or social calendar.
- Multiplayer Call of Duty.
- A Los Santos / Leonida analogue in the browser.
- “AAA” marketing copy, 10/10 self-scores, or console badges without certification.
- A 1:1 Three.js port.
- Gore systems out of tone.
- Third-party game IP.

If a request conflicts with this section, this PRD wins until the owner revises it.
