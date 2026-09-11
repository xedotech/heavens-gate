# Third-party notices

Heaven's Gate is MIT-licensed original game code. This file records the
external software and source assets used by the playable build and by the
reproducible asset pipeline.

## Runtime libraries

- Three.js — MIT License — https://github.com/mrdoob/three.js
- React and React DOM — MIT License — https://github.com/facebook/react
- Lucide — ISC License — https://github.com/lucide-icons/lucide
- meshoptimizer decoder — MIT License — https://github.com/zeux/meshoptimizer

The complete resolved JavaScript dependency tree and versions are pinned in
`package-lock.json`. License texts distributed by packages remain in their
respective `node_modules` packages when dependencies are installed.

## Character source assets

The generated character files under `public/assets/characters` use MakeHuman
Community system assets released under CC0 1.0. The source set includes the
human base mesh, skins, game-engine rig, eyes, eyebrows, eyelashes, teeth,
tongues, hair, garments, and footwear.

- MakeHuman Community system assets: https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
- MakeHuman asset license explanation: https://static.makehumancommunity.org/about/license.html
- CC0 1.0 legal code: https://creativecommons.org/publicdomain/zero/1.0/legalcode

The `.glb` files are derivative generated output of those CC0 assets. Their
per-file hashes, topology statistics, animation contract, and delivery
extensions are recorded in `public/assets/characters/manifest.json`.

## Asset build tools

## Photo-based environment material

`public/assets/environment` contains 1K and 2K derivative WebP maps from
**Concrete Pavement 03**, by Charlotte Baglioni / Poly Haven, released under
CC0 1.0. The maps cover albedo, OpenGL normals, and packed ambient occlusion /
roughness / metalness. The provider's asset and licensing sources are:

- https://polyhaven.com/a/concrete_pavement_03
- https://polyhaven.com/license
- https://docs.polyhaven.com/en/technical-standards/textures

Poly Haven describes its materials as photo-based, using photogrammetry or
photometric stereo; this asset's specific capture method is not stated. No
scanned geometry is included. `public/assets/environment/manifest.json` records
source URLs, provider MD5 checksums, source/output SHA-256 hashes, dimensions,
color spaces and physical tile size. The importer is in `tools/environment`.
Albedo is encoded at WebP quality 88; data maps are lossless WebP encodings of
the provider JPEG's decoded pixels. All player-time requests are local.

## Asset build tools (continued)

These tools are not shipped to players. They are used to reproduce or validate
generated game assets:

- Blender — GNU GPL v3 or later — https://www.blender.org/about/license/
- MPFB / MakeHuman Plugin for Blender — GNU AGPL v3 — https://github.com/makehumancommunity/mpfb2
- glTF Transform — MIT License — https://github.com/donmccurdy/glTF-Transform
- Khronos glTF Validator — Apache License 2.0 — https://github.com/KhronosGroup/glTF-Validator
- Sharp — Apache License 2.0 — https://github.com/lovell/sharp

MPFB's license applies to the tool, not to generated character output. The
asset compiler and exact source manifest live in `tools/characters`.

## Original content

The Heaven's Gate name treatment, setting, characters, missions, dialogue,
procedural world geometry, interface, sound synthesis, and game systems in this
repository are original project content. No Rockstar Games, Take-Two,
Activision, Free Guy, Call of Duty, Grand Theft Auto, or other third-party game
assets, code, dialogue, music, logos, trademarks, or leaked material are
included.
