# AAA gap audit — Heaven's Gate vs. genre leaders

Deep audit of the entire build against the top games in each of its categories.
Every item is a real gap in *this* codebase — not generic advice.

Reference set, per category:
- **Open world:** GTA V, Cyberpunk 2077, Watch Dogs 2, RDR2
- **TPS combat:** Gears 5, The Division 2, Uncharted 4, Mass Effect
- **Driving:** GTA V vehicle feel, Watch Dogs handling
- **Supernatural/stealth:** Dishonored (Veil analog), Control
- **Stylized sci-fi polish:** Warframe, Hi-Fi Rush
- **Accessibility/UI gold standard:** The Last of Us Part II, God of War Ragnarök

Severity tiers:
- **[S]** Breaks the core illusion or core feel — fix first
- **[A]** Expected by the genre — its absence is noticeable
- **[B]** Compounding polish — cheap wins and depth
- **[C]** Out of scope for a browser build — listed for honesty, not action

---

## Shipped since this audit (implementation pass)

The entire cheap-wins shortlist and the top [S]/[A] items are now live:

- ✅ Ambient city soundscape (rumble bed + honks + murmurs), pedestrian
  chatter blips (spatial), whisper bed + blips while Veil is open
- ✅ Civilian vignettes: talking pairs, wall-leaners, idle weight-shift;
  per-district archetypes (palette + halo/hood/scarf/pack props)
- ✅ Wind-blown litter instanced near roads, pushed by traffic slipstreams
- ✅ Contact shadows under actors/vehicles/props + baked footprint AO
- ✅ SMAA pass in the composer; facade procedural texture on all towers
- ✅ Player cover: auto-attach while crouched against walls/vehicles,
  tangent slide, cover damage reduction, HUD "cover" stance
- ✅ Torso aim layer: spine_01/02/03 pitch follows camera after mixer
- ✅ Persistent bullet decals (bounded instanced pool)
- ✅ Melee strike (V / D-pad up) + throwable resonance charge (G / D-pad left)
- ✅ Locational hit reactions: directional chest/head flinch, incl. idle NPCs
- ✅ Vehicle handbrake/drift/screech, crash audio, staged damage + smoke
- ✅ Traffic intersection discipline: yield to cross-traffic + follow distance
- ✅ Veil pass: lowpass muffle, chromatic HUD overlay, shimmer/scanlines
- ✅ Progression: marks currency on kills, 5 persisted Attunements in Pause
- ✅ Chapel of the Unburied — first enterable interior (real colliders,
  pews, altar, stained glass, candles, first-visit memory line)
- ✅ Pause map with legend, gamepad aim assist, large-subtitle option
- ✅ three.js vendor chunk split (game code ~164 kB vs ~900 kB combined)
- ✅ Actor-loop allocation cleanup (scratch vectors in the AI path)
- ✅ Cover peek/lean: aiming from cover slides the camera along the wall
  tangent and raises exposure to 62% instead of fully breaking cover
- ✅ Reload cancel: fire, reload re-press, or sprint-start all drop the
  reload; pooled brass shell casings arc, bounce, and rest
- ✅ Shoulder-swap camera (T / D-pad right), peek follows active shoulder
- ✅ Drive-by shooting: hip-fire from vehicles, heavy spread, no ADS
- ✅ Death cam: rising orbit before game over + "Slain by" kill recap
- ✅ Weapon draw/inspect flourish on every swap
- ✅ Enemy suppression model: per-shot burst bloom (cone +15%/shot, cap
  1.9x), hit/near-miss suppression (up to 2x cone, 1.5s recovery),
  ambush first-shot bonus; player near-misses graze-pulse underFire
- ✅ Near-miss whiz: spatialized supersonic snap on close enemy rounds
- ✅ Enemy tracer signatures: hot orange boss, cold blue drone
- ✅ GTAO pass on high quality (replaces RenderPass while enabled)
- ✅ Full gamepad button remapping (persisted overrides, capture UI,
  swap semantics, standard-layout labels)
- ✅ Veil sneak strikes: 1.7x damage on unaware targets, +3 marks on
  execution kills — Veil is now a stealth verb, not a palette swap
- ✅ Drive look-back (hold crouch/R3), wet-sheen roads, patrol-drone
  scan cones that brighten over civilians
- ✅ Kill-confirm reticle (red 45° flash) + low-health heartbeat and
  vignette pulse that quickens as HP drops
- ✅ Interior acoustics: slapback delay send + exterior dip inside the
  chapel zone
- ✅ **Gait fixed at the asset level**: all six GLBs regenerated with
  real knee flex (30-34° walk, 55-61° run), foot pitch channels added,
  loop seams intact — the "sliding walk" defect is closed
- ✅ Real scanned PBR surfaces (Poly Haven CC0, checksum-pinned,
  self-hosted): asphalt roads, concrete facades, chapel stone + brick,
  metal plate props, corrugated rooftop tanks — 6 materials, 2 tiers
- ✅ Working CPU photogrammetry pipeline (COLMAP + OpenMVS + Blender):
  photos → GLB, proven end-to-end on a synthetic 36-shot obelisk set,
  memorial placed in-world — real capture now unblocked for user photos
- ✅ Three vehicle archetypes (Seraph / Hauler / Vesper) with distinct
  handling, silhouettes, and enter-toasts
- ✅ Eight hidden sigils (persistent collectibles, +marks), pause-menu
  lifetime record panel, lifetime stat tracking
- ✅ Directional death falls (corpse tips along the shot), ambient
  runner civilians, scrolling storm-shelf cloud layer
- ✅ Turn-in-place walk shuffle, Veil dust motes, objective breadcrumb
  trail with a travelling pulse
- ✅ Hurt camera kick (directional, reduced-motion aware), traffic
  honks when blocked (with cooldowns), civilian idle glances,
  shockwave ground-scorch decals
- ✅ Street-level wall decals (posters / stencil sigils / spray tags),
  heat-tier searchlight cordon that tracks the player at tier 4,
  per-wheel suspension travel (road jitter + lean compression + impact)
- ✅ Minimap route line to objective, occlusion raycast for honks +
  chatter, adaptive music stems (combat kick at 0.55, hats at 0.78,
  calm shimmer below 0.18)

Still open: real-world photogrammetry source photos (pipeline ready,
needs captures), sustained hardware frame trace, browser playthrough
capture, foot IK, NPC facial morphs, landing-roll clip, mantle/climb
(no verticality yet), recorded foley, and the [C] honesty items below.

---

## 1. Third-person combat (vs. Gears / Division / Uncharted)

- [S] **No player cover system.** Enemies use cover; the player cannot snap,
  lean, or blind-fire. Every genre reference makes this the mechanical heart
  of TPS. Add contextual cover attach + peek + cover-exit variants.
- [S] **No upper-body aim layer on the character.** Weapon pitches, but the
  torso doesn't twist toward aim — reads wrong at camera distance. Add
  spine-bone aim offset driven by camera pitch/yaw.
- [S] **No locational enemy hit reactions.** Headshots kill, but limb hits
  don't stagger, spin, or drop the target's aim. Per-bone reaction impulses.
- [A] **No melee attack.** No close-range option; genre-standard.
- [A] **No throwables.** No grenade/pulse-charge equivalent.
- [A] **No hitmarker sound differentiation per hit zone** beyond crit ping.
- [A] **No reload cancel / sprint-cancel reload.**
- [A] **Enemies never miss-readjust** — accuracy is a fixed roll; no
  suppression, no aim-cone bloom under fire.
- [B] No weapon inspect animation.
- [B] No shoulder-swap camera while aiming.
- [B] No drive-by shooting from vehicles.
- [B] No tracers from enemies at long range variation / night-time only feel.
- [B] No death cam / kill recap.
- [B] Impact decals don't persist — bullet holes vanish in 0.2s. Add a small
  decal pool so firefights leave scars.
- [B] Shell casings don't eject.
- [C] Gore/dismemberment — out of tone and scope.

## 2. Open-world simulation (vs. GTA V / Cyberpunk / Watch Dogs)

The GTA-designer principle that applies hardest here: *illusion over
simulation* — moving litter, district-specific NPCs, and ambient chatter
matter more than deep AI.

- [S] **No ambient pedestrian life.** Civilians only wander or flee. No idle
  loops (standing, talking in pairs, phone-checking, leaning on walls), no
  group conversations, no sitting. This is the single biggest "alive city"
  gap and it is cheap to fake: 4–6 idle vignettes + spatial chatter blips.
- [S] **All civilians share one procedural humanoid** with only a coat-color
  roll. Add hat/hair/accessory variants and per-district palette/archetype
  bias (GTA's district-archetype trick — businessmen downtown, etc.).
- [S] **No interiors.** Every building is a sealed box — the largest single
  gap vs. every reference. Even 3–5 enterable landmark interiors (station,
  basilica, a shop) would transform the city's believability.
- [A] **Traffic has no intersections behavior.** Cars follow loops; no
  stopping at crossings, no yielding, no lane discipline through junctions,
  no parked-car variety beyond the two Seraphs.
- [A] **No ambient soundscape.** No traffic hum, wind, distant horns, crowd
  murmur, neon buzz. The city is silent between gunshots — huge and cheap.
- [A] **No world reactivity to weather.** Civilians don't run for cover in
  rain; road surface doesn't visibly wet/dry.
- [A] **No random street events** — GTA's ambient crime/chases/arguments.
  Even 2–3 scripted ambient vignettes (a drone scanning a civilian, a warden
  checkpoint) would add life.
- [B] No wind-blown litter/debris in traffic slipstreams (the exact detail
  GTA's technical director credits for killing the "sterile" look — trivial
  to add as instanced quads).
- [B] No small life: no birds, drones-on-patrol (non-combat), flyers.
- [B] No day/night *ambience* shift — the sun orbits but NPC density,
  traffic, and audio don't respond to the clock.
- [B] No wanted-style escalation visuals — heat tier is a meter, not a
  visible cordon (roadblocks, searchlights, checkpoints).
- [B] No shop/vendor fronts with interaction.
- [B] No posters/graffiti/decal pass on walls — billboards only.
- [B] No puddle/wet-sheen reflection on roads (cheap: planar env-map tint or
  glossier road material keyed to rain).
- [C] Streaming a city miles deep — map is 340×340 by design; acceptable.

## 3. Driving (vs. GTA V / Watch Dogs)

- [A] **One vehicle archetype, one handling profile.** No second drivable
  class (heavy/civilian), no per-vehicle stats.
- [A] **No handbrake/drift.** Sprint doubles as boost; no slip-state.
- [A] **No staged damage progression** — wreck is binary. Genre standard is
  dent → smoke → fire → explosion.
- [A] **No crash audio** (impact thump/scrape/glass) and no tire-screech on
  hard cornering.
- [B] No camera look-back, no first-person/bonnet cam.
- [B] No suspension travel on wheels (lean exists, wheels don't travel).
- [B] No minimap route/waypoint line while driving to objective.
- [B] Traffic doesn't honk/react to collisions between NPCs.

## 4. Animation & character (vs. Uncharted / RDR2)

- ~~[S] **Documented stiff gait**~~ — **FIXED**: regenerated GLBs ship real
  knee articulation (30-34° walk, 55-61° run) plus foot pitch channels.
- [S] **No foot IK.** Feet float over curbs/slopes; the procedural city makes
  this frequent.
- [A] **No turn-in-place** — character pivots on a dime with no step anim.
- [A] **No aim pose blend** — see combat; torso should counter-rotate.
- [A] **No hit/hurt locomotion** — player takes damage with only a vignette;
  no flinch on the model.
- [A] **Enemy death = tip-over only.** No per-hit-location death variants,
  no ragdoll-lite collapse.
- [B] No holster/draw transition (weapon swap pops instantly).
- [B] No NPC facial animation (hero has morphs; civilians/wardens don't).
- [B] No landing-roll or fall-recovery anim; land dip is camera-only.
- [B] No climbing/vault/mantle — world has no verticality gameplay anyway.
- [B] No idle fidgets (weight shifts, look-arounds) on civilians or hero.
- [C] Full ragdoll physics, mocap-quality facial capture.

## 5. Supernatural systems — Veil & Pulse (vs. Dishonored / Control)

- [A] Veil is a palette swap + fog change. Dishonored's Void sells itself on
  *distortion*: add chromatic shift, muted/monochrome grade, inverted sky,
  whisper audio bed, and make echoes/actors render differently inside it.
- [A] No stealth verbs inside Veil — no sneak attack bonus, no detection
  meter. Currently it's a second map layer, not a mechanic.
- [B] Pulse shockwave is one ring — add ground crack decal + camera ripple.
- [B] No resonance economy depth — it's a stamina bar for two abilities; no
  spend sinks, upgrades, or capacity choices.

## 6. Audio (vs. genre standard — all references use recorded source)

- [S] **Everything is synthesized.** Layered voices now, but no recorded
  foley ceiling — footsteps on one surface, one material. Biggest perceived
  "cheapness" lever remaining. If any budget exists: a CC0/recorded SFX pack
  for gunshots, footsteps, impacts, UI.
- [A] No environmental acoustic zones (alley slapback, interior reverb,
  open-street tails) — one global dry mix.
- [A] No ambient city bed (see world section).
- [A] No voiced dialogue — subtitle text only. Even whispered Veil-voice
  noise loops would sell the fiction.
- [B] No adaptive combat music stems — intensity scalar exists, but no
  layered stems that enter/exit.
- [B] No audio occlusion behind buildings beyond enemy-shot lowpass.
- [B] No gamepad-speaker/PS5-style tricks — n/a for web; ignore.
- [C] Dolby Atmos, licensed soundtrack.

## 7. Rendering & presentation (vs. Cyberpunk / Spider-Man city read)

- [S] **No SSAO / contact shadows.** Objects float visually — feet, props,
  vehicle undersides. SSAO (or cheap blob shadows under actors/props) is the
  single biggest "doesn't look flat" fix left.
- [S] **Buildings are untextured flat-color boxes** with emissive windows.
  Facade detail is silhouette-only (crowns/parapets/strips). Options: a
  subtle procedural facade texture, or wire the built-but-unused scanned
  pavement pipeline + a matching wall material.
- [A] **No TAA/anti-aliasing on the composer path** — MSAA was cut for perf;
  edges shimmer on medium/high. Add FXAA or SMAA pass.
- [A] **No LOD system** — every building/prop renders at full detail from any
  distance; also a perf item (below).
- [A] **No persistent decals** — bullet scars, wreck scorch marks, tire marks.
- [B] No screen-space reflections / wet-road sheen pass.
- [B] No volumetric light shafts beyond gate cones (streetlamp cones exist —
  could add subtle volumetric dust in Veil).
- [B] No color-grade presets / photo-mode filters (inspection mode exists;
  filters would be cheap).
- [B] No cloud layer / sky detail — gradient dome + orb only.
- [B] Character materials are flat — no cloth sheen, no skin SSS fake.
- [C] Raytracing, photogrammetry sources, authored modular kits.

## 8. UI / UX / accessibility (vs. TLOU2 / Ragnarök standard)

- [A] No pause-screen **map** — only the corner minimap; no waypoint setting.
- [A] No remappable **gamepad** buttons (keybinds cover keyboard only).
- [A] No aim-assist toggle/strength for gamepad and touch.
- [A] No subtitle size/background controls (subtitles are on/off only).
- [A] No colorblind/high-contrast *palette* modes (a highContrast flag exists
  — verify it actually re-themes HUD accents).
- [B] No stats screen (accuracy, kills, time, distance driven).
- [B] No mission-select / replay after completion.
- [B] No collectible progress indicator (echoes count on map).
- [B] No objective waypoint routing (line/breadcrumbs).
- [B] No control-remap conflict detection UI.
- [B] No "are you sure" on campaign reset from pause? (verify)
- [C] Text-to-speech, full remapping suite, arachnophobia-style filters.

## 9. Systems depth & content (the "Sims" ambition)

- [A] **No progression economy.** Resonance is a regenerating meter, not a
  currency — nothing to earn/spend/unlock. Add upgrade sinks (weapon stats,
  ability capacity, suit tiers) or cosmetics.
- [A] **8 missions is a demo arc.** No side quests, contracts, or repeatable
  activities; free roam post-ending has nothing to do.
- [A] **No collectibles system** — echoes are mission-scoped; no open-world
  collectible layer (hidden sigils, lore pickups feeding the codex).
- [B] No choices outside the finale — one branch at the end only.
- [B] No NG+ / difficulty-scaled replay.
- [B] No character progression (HP/weapon damage is static across campaign).
- [B] Minimap doesn't rotate with camera (verify) — genre default is
  rotating with a north toggle.
- [C] Life-sim depth (relationships, needs, jobs) — genuinely out of scope;
  acknowledge as such.

## 10. Engineering & performance

- [B] **>650 kB client chunk** — code-split the engine from shell.
- [B] Per-actor-loop Vector3 allocations (~15/frame/actor) — scratch-vector
  pass in updateActors.
- [B] No occlusion culling — whole city renders every frame.
- [B] No frustum-fitted shadow cascade — one directional shadow for 340m.
- [B] No texture budget audit — check VRAM on integrated GPUs.
- [C] Native console ports, 120 Hz modes.

---

## The "illusion of life" cheap-wins shortlist (highest ROI)

Ordered by (perceived quality gain) / (hours):

1. **Ambient city soundscape loop** — one filtered-noise + honk/murmur bed.
2. **Civilian idle vignettes** — 4 poses, pairs talking, wall-leans.
3. **Wind-blown litter** — instanced paper quads pushed by car slipstreams.
4. **Blob/contact shadows** under actors, vehicles, props.
5. **FXAA/SMAA pass** on the composer.
6. **SSAO or cheap radial AO** — kills the "floating" look.
7. **Player cover attach + peek** — biggest TPS-feel gap.
8. **Torso aim layer** — character visibly aims with camera.
9. **Persistent bullet decals** — pooled quads on hit surfaces.
10. **Ambient pedestrian chatter blips** — spatial, subtitled, seeded.
11. **Facade texture/procedural detail** — or wire the scanned pavement kit.
12. **Interior landmark** — even one enterable space reframes the city.
13. **Vehicle damage stages** + crash audio + handbrake.
14. **Traffic intersection discipline** — stop/yield at junctions.
15. **Per-district civilian archetypes** — palette + accessory bias.

## Explicitly out of scope (honesty ledger)

- Photogrammetry (no scan sources; the pipeline exists for pavement only)
- Native console builds, multiplayer, mocap facial capture, licensed audio,
  authored modular building kits, raytracing, GTA-scale map.
