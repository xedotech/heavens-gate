# Technical reference

## Runtime

The game runs as a client component inside a Vinext/Next application. Three.js owns the real-time scene and animation loop. React owns menus, persistence, settings, accessible controls, campaign endings, HUD composition, and recovery states. A narrow callback interface prevents the renderer from mutating React state directly.

Characters are assembled from deterministic articulated rigs with physically based materials. The player exposes six live-swappable material sets; civilian seeds vary facial proportions, skin tone, eyes, hair, clothing, accessories, height, and gait without external model downloads. Wardens reuse the animation contract with armored head and body variants.

## Engine lifecycle

1. Create the renderer and event listeners.
2. Construct atmosphere, city, actors, vehicles, gates, and HUD marker across animation frames while reporting load progress.
3. Enter attract mode behind the title screen.
4. On a user gesture, unlock Web Audio and start or restore the campaign.
5. Throttle HUD and map snapshots to roughly 11 updates per second while rendering at display refresh rate.
6. Dispose geometry, materials, audio nodes, animation frames, timers, and listeners on unmount.

## Performance budget

- Repeated buildings and windows use instancing.
- Render pixel ratio is capped per preset.
- High quality enables filtered shadows; low quality disables them and reduces particles.
- Delta time is capped at 50 ms to prevent tunneling and unstable AI after background stalls.
- HUD updates are throttled independently of the render loop.
- High quality automatically lowers internal pixel ratio if measured frame rate remains below 36 fps.

## Save compatibility

Saves are versioned and device-local. Version 1 stores mission index, health, armor, ammunition, resonance, Warden progress, activated echo IDs, elapsed play time, ending, and update time. Future migrations should be explicit and never silently discard a valid save.

## Console path

The current release supports the standard browser Gamepad API and console-style controls. Shipping through a closed console storefront still requires an approved platform wrapper, certification, platform SDK integration, performance profiling on target hardware, and compliance testing; a web deployment alone cannot bypass those requirements.
