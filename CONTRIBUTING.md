# Contributing

Heaven's Gate welcomes focused, original contributions.

## Before opening a change

1. Keep all art, sound, story, and code original or clearly compatible with the MIT release.
2. Do not add assets, names, characters, layouts, or mechanics copied from an existing commercial game.
3. Preserve keyboard and standard-gamepad parity for every required gameplay action.
4. Preserve reduced-motion and high-contrast behavior for interface changes.
5. Keep browser performance in budget: a medium-quality build should target 60 fps on a recent integrated GPU and remain playable at 30 fps.

## Development loop

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
```

Add tests for pure mechanics and campaign data. For render or input work, include a short manual verification note covering desktop resolution, pointer lock, and gamepad behavior.

## Design rules

- The world is maximal; the HUD is restrained.
- Sacred gold is the one non-semantic accent.
- Gameplay feedback outranks decoration.
- Enter motion decelerates, exit motion accelerates, and reduced motion is instant.
- The city should tell the story before a text box does.
