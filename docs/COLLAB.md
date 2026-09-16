# Collaboration — Devin × this agent

Observed on the same Windows PC, workspace `heavens-gate`, branch `main`. No commits or pushes from this agent.

There is no Cursor computer-use MCP on this machine. Devin is a **desktop Electron app** (`Devin.exe`, window class `Chrome_WidgetWin_1`, pid 29096). Substitute used: window screenshot (PrintWindow) + UI title + git dirty files + Devin AppData logs.

## What the Devin app showed (2026-09-16 ~06:15–06:40)

- Window title: `heavens-gate - Devin - I can't determine whether that project is SWE 2 or free just from the path sh...`
- Mode: Agent + Editor split. Chat title truncated to the SWE-2/free question (billing/project-type, not a game system).
- Open editor tabs: `.gitignore`, `cloud_to_mesh.py` (dirty), `preview_glb.py` (dirty), `xyz_to_ply.mjs` (dirty). Earlier capture also had `verify-save-resume`.
- Agent activity:
  - First capture: running `python tools/photogrammetry/cloud_to_mesh.py` on `artifacts/photogrammetry/james-2012/arius_cloud_900k.ply` → `arius_statue.ply`; status **Reading shell for 280s**; mesh-decimate snippet visible.
  - Second capture: **Investigating.** Note: “Server's alive — CPU starvation from the matching pass made the boot slow. Retrying with patience.” Then `cd` into this repo.
- Git dirty while that ran:
  - `app/game/engine.ts` — +22 lines placing **Arius relic head** on the chapel altar via `loadVerifiedProp('arius-relic-head')`.
  - `public/assets/props/manifest.json` — new relic entry (and accidental UTF-8 mangling of em-dashes in existing provenance strings).
  - Untracked: `public/assets/props/arius-relic-head.glb`, `tools/photogrammetry/cloud_to_mesh.py`, `preview_glb.py`, `xyz_to_ply.mjs`, `nul`.

Overnight/this-morning commits on `main` (same machine, not this agent): lockdown clock, destructible player vehicles, boss phases, and a stack of `tools/qa/verify-*.mjs` files. `engine.ts` mtime was still moving at 06:33.

## Files Devin owns right now

Do not edit these until they are clean and the Devin window is not on them:

- `app/game/engine.ts`
- `public/assets/props/manifest.json`
- `public/assets/props/arius-relic-head.glb`
- `tools/photogrammetry/**`
- `artifacts/photogrammetry/**`
- `tools/qa/verify-*.mjs` (recently landed; Devin still running related shells)
- `.gitignore` (open tab)

## What this agent did instead

Created only new docs (no clobber, no engine, no commit):

- `docs/PRD.md` — product requirements, honest AA vs AAA path, Unity/Unreal decision.
- `docs/BLUEPRINT.md` — current/target architecture, portable combat/mission/vehicle tables, P0–P2, ownership map.
- `docs/COLLAB.md` — this file.

Did **not** start a native port, did not refactor `engine.ts`, did not add QA scripts that overlap Devin's verifiers.

## Suggested lane split

| Lane | Owner | Until |
| --- | --- | --- |
| Photogrammetry pipeline, relic GLB, chapel placement | Devin | Relic is committed and the mesh command has finished |
| `engine.ts` feel / missions / boss / vehicles | Devin | Working tree clean on that file |
| Headless play verifiers + frame traces | Devin | They stop opening new `tools/qa/verify-*` files |
| Product bible (PRD, blueprint, quality-gate interpretation) | This agent | Ongoing |
| `combat.ts` / `types.ts` / `mechanics.ts` numbers | Handshake | Either party announces in COLLAB before changing |
| Unity/Unreal project | Nobody | P2, after P0 evidence |

If Devin starts a PRD of their own, extend theirs rather than replacing these files. If they need `docs/PRD.md` / `docs/BLUEPRINT.md`, they own the next revision; this agent will stop editing those paths.
