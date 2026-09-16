# Heaven's Gate — Architecture Blueprint

Companion to `docs/PRD.md`. This is the technical plan for (1) tightening the current web slice and (2) migrating design — not the Three.js engine — to Unity HDRP or Unreal.

Live collision rules: `docs/COLLAB.md`. Recheck Devin before editing anything under `app/game/engine.ts`, `tools/photogrammetry/`, or `public/assets/props/`.

---

## 1. Current architecture (web slice)

Runtime: Vinext/Next client component. Three.js owns the scene and rAF loop. React owns menus, HUD composition, persistence UI, endings, and accessibility. A callback interface (`EngineCallbacks` in `app/game/types.ts`) is the only legal crossing.

```text
app/components/GameShell.tsx     React shell, screens, HUD, pause map, settings
app/components/TouchControls.tsx Coarse-pointer virtual sticks/buttons
app/game/engine.ts               World, loop, combat integration, vehicles, missions, chapel
app/game/types.ts                Campaign, saves, HUD, missions, settings contracts
app/game/combat.ts               WeaponSpec table (Morrow / Psalm / Vesper)
app/game/mechanics.ts            Pure heat, difficulty, range, cordon cone
app/game/ai.ts                   Perception, cover, squad radio, combat SM
app/game/character.ts            Hero glTF load, visemes, grip, gait mixer
app/game/audio.ts                Web Audio buses, CC0 clips, synth fallback
app/game/spatial-audio.ts        Pan / distance / occlusion helpers
app/game/input.ts                Keyboard, pointer-lock fallback, gamepad, look
app/game/keybinds.ts             Conflict-safe remap + storage repair
app/game/movement.ts             Planar sweep, vault hooks
app/game/persistence.ts          Save v1 validate/migrate
app/game/upgrades.ts             Five Attunements + marks-for-kill
app/game/performance.ts          Frame sampler, quality adaptation
app/game/scene-lifecycle.ts      Dispose / context-loss helpers
app/game/props.ts                Verified prop GLB loader
app/game/props-detail.ts         Street-detail / curb dressing
app/game/scanned-materials.ts    Hash-pinned PBR surfaces
app/game/scan-contract.ts        Manifest + color-space contract
public/assets/characters/        Six SHA-pinned hero GLBs
public/assets/environment/       CC0 PBR + HDRIs
public/assets/props/             Dressing GLBs + manifest (Devin live)
public/assets/audio/             CC0 clips + audio manifest
tools/qa/                        Headless Chrome verifiers (Devin live)
tools/photogrammetry/            COLMAP/OpenMVS/mesh tools (Devin live)
tools/characters/                Blender MPFB compiler (MPFB not installed here)
```

`engine.ts` is the god-object: city build, actors, vehicles, chapel, mission machine, heat, Veil, boss, cinematics. New gameplay currently lands there. That is why this agent does not edit it while Devin is dirty on it.

World constants in engine: `WORLD_SIZE = 340`. District tests are axis-aligned regions, not streamed cells.

---

## 2. Target architecture

### 2a. Near-term (stay on this stack)

Do not split `engine.ts` in a drive-by refactor. Extract only when a system is stable and unowned:

| Extract later (after Devin's current wave) | Stays in engine until then |
| --- | --- |
| City generation → `city.ts` | Frame loop, composer, quality switch |
| Vehicle sim → `vehicles.ts` | Chapel/prop placement Devin is wiring |
| Mission runner → `missions.ts` | Boss / lockdown / relic hooks in flight |
| Heat / wanted → already almost in `mechanics.ts` | Actor pooling, decals, weather |

Rules for the web target:

- Keep React off the hot path. HUD remains throttled (~11 Hz).
- No per-frame allocations in LOS / camera / player / vehicle (already a gate).
- Quality tiers stay four: low / medium / high / ultra.
- Saves stay `SaveState` version 1 with additive optional fields only.
- New content prefers data tables (`combat.ts`, `types.ts` MISSIONS, `upgrades.ts`) over new engine branches.

### 2b. Native product (Unity HDRP or Unreal)

One district, same fiction. New project. This repo is the bible, not a submodule that “runs inside Unreal.”

```text
Design bible (this repo)          Native runtime (new repo)
─────────────────────────         ─────────────────────────
GLB / PBR / HDRI                  Static meshes + native materials
MISSIONS / WEAPONS / VEHICLE_SPECS DataTables / ScriptableObjects / DataAssets
SaveState intent                  Native save + cloud later
Control map / a11y policy         Enhanced Input / Unreal Input
Quality-tier policy               Scalability groups
Narrative lines                   Dialogue assets + Sequencer/Timeline
Brand tokens                      UI theme
                                  Chaos / PhysX
                                  AnimBP / Mecanim
                                  UMG / UI Toolkit
                                  Wwise / FMOD / MetaSounds
                                  World partition / Addressables
```

City generation is a **content** problem on native: replace the procedural tower field with an authored modular kit of the same 340 m (or a modest expansion). Do not reimplement the JS instancer.

---

## 3. Data that ports

Source of truth today. Copy numbers; do not “improve” them during a port unless design revises this table.

### Weapons (`app/game/combat.ts`)

| | Morrow | Psalm | Vesper |
| --- | --- | --- | --- |
| HUD | 9mm smart | repeater coil | choir breaker |
| Mag / reserve | 18 / 126 | 32 / 160 | 6 / 30 |
| RPM | 500 | 790 | 96 |
| Reload s | 1.28 | 1.62 | 2.05 |
| Damage | 38 | 21 | 12.5 × 8 pellets |
| Falloff m | 24–112 | 30–120 | 7–36 |
| Min scale | 0.54 | 0.50 | 0.16 |
| Crit × | 1.72 | 1.60 | 1.45 |
| Boss scale | 0.52 | 0.50 | 0.60 |
| Hip / ADS spread ° | 1.35 / 0.22 | 1.85 / 0.50 | 4.4 / 3.1 |
| Swap s | 0.32 | 0.38 | 0.44 |
| Tracer | `0xe8c96f` | `0x9fd6ff` | `0xffa35c` |

### Vehicles (engine `VEHICLE_SPECS`)

| Id | Name | Top | Boost | Accel | Steer | Damage scale |
| --- | --- | --- | --- | --- | --- | --- |
| seraph | Seraph sedan | 38 | 48 | 2.7 | 1.42 | 1.00 |
| morrow | Morrow hauler | 30 | 38 | 1.8 | 1.02 | 0.60 |
| choir | Choir interceptor | 45 | 58 | 3.6 | 1.75 | 1.35 |

Player spawns: seraph-01/02/03, morrow-01/02, choir-01/02 (seven). Ambient traffic: five actors (README).

### Heat (`mechanics.ts`)

| Heat | Tier |
| --- | --- |
| < 8 | 0 |
| ≥ 8 | 1 |
| ≥ 24 | 2 |
| ≥ 42 | 3 |
| ≥ 60 | 4 |
| ≥ 80 | 5 |

Difficulty incoming damage: story 0.62, normal 1.00, ascendant 1.45.

### Attunements (`upgrades.ts`)

| Id | Name | Effect | Cost (marks) |
| --- | --- | --- | --- |
| vitals | Vitality lattice | HP 100 → 130 | 30 |
| aegis | Aegis weave | Armor 50 → 90 + regen | 35 |
| coil | Coil tensioning | +20% weapon damage | 45 |
| flow | Flow channel | Resonance regen +50% | 35 |
| plating | Seraph plating | Incoming −22% | 40 |

Marks: civilian 0, warden 6, sentinel/stalker 10, reinforce 12, drone 2, boss 60.

### Campaign (`types.ts` MISSIONS)

| i | Id | Kind | Target / count |
| --- | --- | --- | --- |
| 0 | bell-below | reach | `[0,0,-54]` r=10 |
| 1 | no-saints | eliminate | 5 wardens |
| 2 | borrowed-wings | vehicle | `[26,0,-32]` r=8 |
| 3 | long-ascension | drive | `[92,0,76]` r=13, ~110 s lockdown |
| 4 | city-remembers | echoes | 3 |
| 5 | false-archon | boss | `[0,0,-54]` r=18 |
| 6 | last-door | choice | open / seal |
| 7 | afterlight | complete | free roam |

Spawns: `[0,34]`, `[0,-34]`, `[16,-28]`, `[28,-30]`, `[-68,48]`, `[0,-38]`, `[0,-44]`, `[0,-40]` (xz, y=0).

Sena lamp: `{ x: 0, z: -35.6 }` — outside the gate radius so the delivery plays first.

### Districts (engine `DISTRICTS`)

| Name | Test |
| --- | --- |
| Crown District | `|x| < 58 && z < 36` |
| Old Spine | `x < -42 && z ≥ 12` |
| Gilded Docks | `x ≥ 48 && z ≥ 12` |
| Ash Gardens | `x < -28 && z < -42` |
| Meridian | `x ≥ 32 && z < -24` |
| else | The Outer Choir |

### Heroes

Skins: seraph, relic, nocturne, ash, meridian, voidborn. Contract: 53 bones, 67 shapes, 9 meshes, 11 actions. SHA-pinned in `public/assets/characters/`.

### Save v1 fields to preserve

`missionIndex`, vitals, ammo per weapon, resonance, echoes, sigils, replays, elapsed, ending, `narrative` beat flags (Sena, cordon, vox, chapel witness, …). Additive optional keys only.

---

## 4. Systems that must be rewritten on a native SKU

| System | Why it cannot port 1:1 |
| --- | --- |
| Renderer | EffectComposer, GTAOPass, UnrealBloomPass, SMAA, PMREM, dynamic pixel ratio |
| Physics | Substepped box sweeps + radius queries; no PhysX/Chaos scenes |
| City gen | Seeded instanced boxes + facade materials; native wants authored meshes |
| Characters | Three.js AnimationMixer + morphs; native wants AnimBP/Mecanim + retarget |
| AI | JS state machine on rAF; native wants EQS / behavior trees talking to the same numbers |
| UI | React + CSS (`globals.css` Aurelian Void); native UMG/UI Toolkit |
| Audio | Web Audio graph + clip manifest; middleware + native spatial |
| Input | Pointer lock, Gamepad API, touch overlay; Enhanced Input / native gamepad |
| Persistence | `localStorage` v1; native save slots |
| Cinematics | Letterbox camera lerp; Sequencer / Timeline |
| Photogrammetry delivery | glTF in `public/`; native Datasmith / glTF importer, not the JS loader |

Photogrammetry **assets** (GLB, PBR) port. The Node/Python pipeline stays a content tool.

---

## 5. Phased roadmap

### P0 — Tighten the slice (this repo, evidence first)

Highest leverage is proof, not new verbs. Devin is already generating verifiers and scanned chapel dressing; do not duplicate that.

| ID | Work | Owner (proposed) | Gate |
| --- | --- | --- | --- |
| P0-1 | Attach existing `tools/qa/verify-*.mjs` artifacts to QUALITY_GATES evidence columns | whoever is not mid-engine | Campaign / combat / save rows |
| P0-2 | 10-minute 1080p high frame trace on declared min-spec | Devin or a dedicated QA pass | Performance |
| P0-3 | Clean-save full playthrough capture (8 ops, both endings) | Devin QA lane | Campaign / cinematics |
| P0-4 | Crowd contact sheet: 12 identities, 3 LODs | characters tools (needs MPFB) | Crowd humans |
| P0-5 | Golden screenshots low/medium/high + GPU notes | QA | Graphics |
| P0-6 | Loudness / headphone pass on the CC0+synth mix | audio.ts owner when idle | Audio |
| P0-7 | Keep engine/photogrammetry integration stable (relic, chapel) | **Devin (live)** | World |
| P0-8 | Keep PRD/blueprint honest as systems land | **this agent** | Product |

P0 does **not** include a Unity/Unreal project, engine.ts rewrites, or Sims systems.

### P1 — Content and feel (still web)

- Two to four more interiors (station, basilica, one civilian space).
- Locational hit reactions; recorded gun ceiling if CC0 sources exist.
- Face performance on Sena / Nia / Archon.
- Foot IK evidence on the live city (code may exist; capture does not).
- District-tour video used as the native art bible.

### P2 — Engine migration (new repo)

1. Freeze bible: export GLBs, this blueprint's tables, control map, brand.
2. Choose Unreal (cinematic AAA path) or Unity HDRP (shippable indie AA) per PRD §10.
3. Rebuild district as authored content at the same 340 m (optional modest grow).
4. Reimplement verbs against the portable numbers.
5. Recertify QUALITY_GATES on the native target. Web evidence does not transfer.

---

## 6. File / module ownership map

Observed 2026-09-16 from the Devin desktop app + git (see `docs/COLLAB.md`).

| Path | Owner now | Notes |
| --- | --- | --- |
| `app/game/engine.ts` | **Devin** | Dirty: chapel Arius relic spawn. Also recent commits: lockdown clock, vehicle destroy, boss phases. |
| `tools/photogrammetry/**` | **Devin** | Open + running `cloud_to_mesh.py` on James-2012 Arius cloud. Untracked py/mjs. |
| `public/assets/props/**` | **Devin** | Dirty manifest + new `arius-relic-head.glb`. |
| `tools/qa/verify-*.mjs` | **Devin** | Today's commits: save-resume, systems, death, campaign, witness, cordon, IK. |
| `.gitignore` | **Devin** (open tab) | Do not touch. |
| `app/game/character.ts`, `props*.ts` | Devin recent | Overnight IK / street-detail. Handshake before edit. |
| `docs/PHOTOGRAMMETRY.md` | Devin-adjacent | Leave unless asked. |
| `docs/PRD.md` | **this agent** | New. |
| `docs/BLUEPRINT.md` | **this agent** | This file. |
| `docs/COLLAB.md` | **this agent** | Lane split. |
| `docs/GAME_DESIGN.md`, `TECHNICAL.md`, `QUALITY_GATES.md` | shared / frozen | Do not clobber; extend via PRD. |
| `app/game/combat.ts`, `mechanics.ts`, `upgrades.ts`, `types.ts` | shared data | Prefer additive fields; tell Devin before rewriting numbers. |
| `app/components/GameShell.tsx` | idle | Touch only with handshake. |
| Native Unity/Unreal tree | nobody yet | P2 only. |

**Lane split (until Devin's photogrammetry/chapel wave ends)**

- Devin: engine, props, photogrammetry, live QA captures.
- This agent: product docs, portable tables, collab notes. No `engine.ts`. No prop hashes. No photogrammetry CLI.

If this agent implements code later, pick a file that is clean in git, not open in Devin, and not under `tools/photogrammetry/` or `tools/qa/`.
