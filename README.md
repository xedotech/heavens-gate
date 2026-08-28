# Heaven's Gate

**The city remembers every choice. The sky remembers every name.**

Heaven's Gate is an original open-source celestial-noir action game built as a complete browser-playable vertical slice for PC and Mac. It includes a procedural 3D city, third-person combat, driveable vehicles, civilian and enemy simulation, six selectable hero skins, a wanted-response system, supernatural Veil powers, an eight-operation campaign, two endings, free roam, checkpoints, gamepad input, adaptive graphics, accessibility settings, and a fully synthesized Web Audio score.

This is a polished independent prototype—not a claim that one repository replaces the thousands of person-years behind a commercial AAA game. It is designed to be played now and extended in the open.

## Play

Owner-only hosted build: [heavens-gate-aethel.xedos.chatgpt.site](https://heavens-gate-aethel.xedos.chatgpt.site)

Run the development build:

```bash
npm install
npm run dev
```

Open the local URL printed by the server. Use a current Chromium, Firefox, or Safari desktop browser with hardware acceleration enabled. The game intentionally requires a window of at least 900 × 600.

## Controls

| Action | Keyboard + mouse | Standard gamepad |
| --- | --- | --- |
| Move / steer | `WASD` | Left stick |
| Look | Mouse | Right stick |
| Fire | Left mouse | Right trigger |
| Jump | `Space` | A / Cross |
| Reload | `R` | X / Square |
| Enter / exit vehicle, restore echo | `E` | Y / Triangle |
| Open / close Veil | `Q` | Left bumper |
| Resonance pulse | `F` | Right bumper |
| Sprint / overdrive | `Shift` | Left-stick click |
| Pause | `Escape` | Menu / Options |

Click the world once if the mouse is not captured. Gamepad play does not require pointer lock.

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

- **Procedural world:** deterministic city blocks, five districts, three landmarks, roads, gates, traffic props, civilians, patrols, and airborne drones.
- **Combat:** hitscan sidearm, critical hits, armor, reloading, enemy accuracy curves, close-range pulse, civilian consequences, and a multi-phase boss encounter.
- **Vehicles:** enter/exit interaction, acceleration, reverse, steering, overdrive, handbrake, collision damage, chase camera, and synthesized engine sound.
- **Veil:** timed alternate-state rendering that reveals memory echoes and boosts situational awareness at a resonance cost.
- **Living response:** five Choir heat tiers, fleeing civilians, activated drone response, and heat decay after breaking contact.
- **Human rendering:** varied skin tones, facial proportions, eyes, hair silhouettes, layered clothing, equipment, body variation, critical-hit geometry, gait animation, and six live-switchable physically shaded Aurel outfits.
- **Audio:** procedural ambience, adaptive score pulses, weapon, movement, vehicle, gate, impact, UI, and damage sounds generated at runtime. There are no sampled songs or sound files.
- **Accessibility:** subtitles, reduced-motion menu/title behavior, high-contrast HUD, adjustable sensitivity and volume, story difficulty, keyboard focus, and semantic controls.
- **Performance:** low/medium/high presets, capped device pixel ratio, shadow scaling, reduced particle counts, and automatic resolution reduction when frame rate drops.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

The test suite covers deterministic mechanics, navigation math, wanted tiers, difficulty scaling, objective progress, HUD formatting, and campaign-data invariants.

## Project map

```text
app/
  components/GameShell.tsx  React menus, HUD, accessibility, saves, endings
  game/audio.ts             Web Audio synthesizer and adaptive score
  game/engine.ts            Three.js world, input, AI, combat, vehicles, missions
  game/mechanics.ts         Pure deterministic mechanics
  game/types.ts             Campaign, save, settings, HUD, and callback contracts
  globals.css               Aurelian Void design system and all interface styling
public/og.png               Original generated social-preview campaign art
docs/                       Design and technical reference
```

## Originality

No Rockstar, GTA, Call of Duty, Free Guy, or other third-party game assets, characters, code, logos, locations, music, or UI are included. Public GTA VI material was used only as a general benchmark for density, authored characters, environmental variety, vehicles, and cinematic presentation; the world, story, art direction, mechanics, and code here are original.

## License

MIT. See [LICENSE](./LICENSE). Contributions are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).
