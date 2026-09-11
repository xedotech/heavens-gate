# Heaven's Gate

**The city remembers every choice. The sky remembers every name.**

Heaven's Gate is an original open-source celestial-noir action game built as a complete browser-playable vertical slice for PC and Mac. It includes a procedural 3D city, third-person combat, driveable vehicles, civilian and enemy simulation, six selectable hero skins, a wanted-response system, supernatural Veil powers, an eight-operation campaign, two endings, free roam, checkpoints, gamepad input, adaptive graphics, accessibility settings, and a fully synthesized Web Audio score.

This is an in-progress independent prototype, not a production-ready AAA release. The playable campaign exists, but animation, close-up characters, world content, performance and platform QA still have open gates. See `docs/PRODUCTION_CHECKPOINT.md` for the latest observed evidence and `docs/QUALITY_GATES.md` for the unfinished release criteria.

## Play

Owner-only hosted build: [heavens-gate-aethel.xedos.chatgpt.site](https://heavens-gate-aethel.xedos.chatgpt.site)

Run the development build:

```bash
npm ci
npm run dev
```

Open the local URL printed by the server. Use a current Chromium, Firefox, or Safari desktop browser with hardware acceleration enabled. The smallest supported desktop/windowed layout is 760 × 480; mobile-width surfaces remain gated because the game is built around keyboard, mouse, and gamepad input.

## Controls

| Action | Keyboard + mouse | Standard gamepad |
| --- | --- | --- |
| Move / steer | `WASD` | Left stick |
| Look | Mouse | Right stick |
| Fire | Left mouse | Right trigger |
| Jump | `Space` | A / Cross |
| Reload | `R` | X / Square |
| Swap weapon (Morrow / Psalm / Vesper) | `X` | D-pad down |
| Enter / exit vehicle, restore echo | `E` | Y / Triangle |
| Open / close Veil | `Q` | Left bumper |
| Resonance pulse | `F` | Right bumper |
| Sprint / overdrive | `Shift` | Left-stick click |
| Pause | `Escape` | Menu / Options |

Every keyboard action in the table can be remapped from Settings; conflicting
assignments are swapped automatically. HUD scale is adjustable from 80% to 130%
for distance and readability preferences.

Click the world once if the mouse is not captured. Gamepad play does not require pointer lock.

On touch devices (phones, tablets), a touch layer appears automatically during play: a left virtual stick for movement/steering, drag on the right half of the screen to look, and on-screen FIRE / AIM / JUMP / RUN / interact / reload / weapon-swap / Veil / pulse buttons with a pause shortcut.

## Campaign

1. **The Bell Below** — cross Crown District and reach the First Gate.
2. **No Saints in Crown** — break the Warden cordon.
3. **Borrowed Wings** — steal a Seraph interceptor.
4. **The Long Ascension** — breach Meridian Gate by vehicle.
5. **A City That Remembers** — use the Veil to recover three memory echoes.
6. **The False Archon** — defeat the machine saint at Crown Basilica.
7. **The Last Door** — choose whether to open or seal heaven.
8. **Afterlight** — continue in free roam with the chosen world state.

Checkpoints save locally after every operation and restored echo. Settings also persist locally.

## Systems

- **Procedural world:** deterministic city blocks, five districts, three landmarks, roads, gates, emissive windows, neon signage, streetlamps, billboards, ambient traffic with panic reactions, civilians, patrols, and airborne drones. High quality adds an instanced rain layer with its own ambience bed.
- **Rendering:** HDR post-processing (bloom, output tone-mapped pass) on medium/high, PMREM image-based lighting from an authored night-city environment, ACES tone mapping, day/night sun, and volumetric-style gate shafts.
- **Combat:** three weapons (Morrow sidearm, Psalm repeater, Vesper scattergun) with per-weapon ammo pools, critical hits, armor, reloading, enemy accuracy curves, close-range pulse, kill drops, hit-stop, directional damage indicators, civilian consequences, and a multi-phase boss encounter.
- **Vehicles:** enter/exit interaction, acceleration, reverse, steering, overdrive, handbrake, collision damage, chase camera, spinning/steering wheels, body lean, brake and head lights, and synthesized engine sound.
- **Presentation:** letterboxed mission flyovers, camera bob and landing dips, corpse tip-over and dissolve, muzzle light, tracer and spark impacts, and a touch-ready HUD.
- **Veil:** timed alternate-state rendering that reveals memory echoes and boosts situational awareness at a resonance cost.
- **Living response:** five Choir heat tiers, fleeing civilians, activated drone response, and heat decay after breaking contact.
- **Human rendering:** varied skin tones, facial proportions, eyes, hair silhouettes, layered clothing, equipment, body variation, critical-hit geometry, facial morph/viseme channels, weapon grip correction, gait/combat animation, and six live-switchable physically shaded Aurel outfits. The hero asset contract is 53 bones, 67 facial/body shapes, 9 meshes, and 11 authored actions per skin.
- **Audio:** procedural ambience, adaptive score pulses, weapon, movement, vehicle, gate, impact, UI, and damage sounds generated at runtime. There are no sampled songs or sound files.
- **Accessibility:** subtitles, reduced-motion menu/title behavior, high-contrast HUD, adjustable HUD scale (80–130%), sensitivity and volume, conflict-safe keyboard remapping, story difficulty, keyboard focus, and semantic controls.
- **Performance:** low/medium/high presets, capped device pixel ratio, shadow scaling, reduced particle counts, and automatic resolution reduction when frame rate drops.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run validate:characters
npm run validate:environment
npm run validate:release
npm run build
```

The test suite covers deterministic mechanics, navigation math, wanted tiers, difficulty scaling, objective progress, HUD formatting, keyboard-binding invariants, and campaign-data invariants.

## Project map

```text
app/
  components/GameShell.tsx  React menus, HUD, accessibility, saves, endings
  game/audio.ts             Web Audio synthesizer and adaptive score
  game/engine.ts            Three.js world, input, AI, combat, vehicles, missions
  game/keybinds.ts          Conflict-safe keyboard remapping and storage repair
  game/mechanics.ts         Pure deterministic mechanics
  game/types.ts             Campaign, save, settings, HUD, and callback contracts
  game/character.ts         Manifest-verified hero glTF loading, facial performance, and grip pose
  game/ai.ts                Deterministic perception, cover, squad radio, and combat state machine
  globals.css               Aurelian Void design system and all interface styling
tools/characters/            Deterministic Blender compiler, manifest publisher, and asset validator
public/assets/characters/    SHA-256-pinned hero glTF binaries and schema-2 delivery manifest
public/og.png               Original generated social-preview campaign art
docs/                       Design and technical reference
```

## Originality

### Photo-based ground material

The city ground uses **Concrete Pavement 03**, a CC0 photo-based PBR material by
Charlotte Baglioni / Poly Haven. All maps are self-hosted and hash-verified.
Low uses 1K; medium/high use 2K. This is a tiled surface material, not scanned
world geometry or photogrammetric characters. See `THIRD_PARTY_NOTICES.md`.

Reimport with `npm run import:environment`; this downloads six pinned source
images and uses the locked Sharp encoder. WebP reduces transfer/storage, not
GPU memory: three mipmapped RGBA maps occupy roughly 16 MiB at 1K or 64 MiB at
2K, with temporary overlap during a quality switch. The six delivery files
total 17,936,678 bytes; no GPU-compressed texture pipeline is implemented yet.

### Source ZIP

Extract the archive, open a terminal inside `heavens-gate`, install Node.js
22.13 or later, then run `npm ci` and `npm run dev`. This is source plus game
assets, not an executable. Intermediate Blender renders and calibration files
are excluded; historical documentation links to those files may not resolve
inside the ZIP. No console package or certification is included.

### Third-party game boundary

No Rockstar, GTA, Call of Duty, Free Guy, or other third-party game assets, characters, code, logos, locations, music, or UI are included. Public GTA VI material was used only as a general benchmark for density, authored characters, environmental variety, vehicles, and cinematic presentation; the world, story, art direction, mechanics, and code here are original.

## License

MIT. See [LICENSE](./LICENSE). Contributions are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).
