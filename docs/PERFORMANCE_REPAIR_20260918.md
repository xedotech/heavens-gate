# Performance repair — 2026-09-18

User reports the deployed https://xedotech.github.io/ build is slow, choppy,
and has broken character presentation. This is not resolved by previous unit
test passes. No deployment is authorized by this report alone.

## First local correction

The previous adaptive-resolution controller could resize every one-second
window, recovering above 56 FPS and reducing below 42 FPS. The engine recreates
postprocessing sizes during this operation. This is a plausible additional
stutter source, not yet a measured explanation of the entire complaint.

Added hysteresis: two consecutive overloaded windows before reducing resolution,
eight consecutive windows above 58 FPS before recovering. Alternating 30/60 FPS
test windows now cause no resizes. Sustained overload and recovery remain tested.
Both focused tests passed; type-check is in progress. Public deployment unchanged.

## Resize follow-up

Verified the installed EffectComposer.setPixelRatio implementation already calls
setSize. Removed the additional full viewport resize from resolution-only changes:
renderer and composer pixel-ratio setters now perform their respective updates
without a second composer setSize or redundant camera projection update. The
regression fixture throws if that extra viewport resize is reintroduced.
Full test/type/lint verification is running; no measured FPS improvement yet.

Follow-up verification: 185 tests, type-checking, and lint passed. A production
build was started. During that build, a hidden-tab guard was added to reset
adaptive-resolution timing windows instead of treating background throttling as
GPU overload. All three focused adaptive-resolution tests passed. Because that
edit overlapped the build, a subsequent stable-source build is still required.
The build process then exited 1 despite printing Build complete: Windows libuv
assertion `!(handle->flags & UV_HANDLE_CLOSING)` in `src/win/async.c:94`.
Do not count that run as a passing build; investigate the tooling shutdown failure.

## Required remaining evidence

Integrated verification after streaming and HDR lifecycle fixes: full unit suite
passed 195 tests across 23 files (session 2851); typecheck completed with exit 0
(session 41887). Reviewed the combined engine/stream-limiter diff. The existing
Windows build shutdown failure has not been resolved, and no foreground gameplay
performance or comparative visual-quality gate is established by these checks.

Asset-stream limiter repair: release previously decremented the active count
before waking a queued waiter, letting a new caller steal the slot before the
waiter's continuation incremented it. Slots now transfer directly to queued
waiters, including cancelled waiters handing them onward. Regression cases cover
the new-arrival race, queued cancellation and already-aborted acquisition.

Late-load guard: HDRs decoded after engine disposal are released without invoking
GPU conversion on the disposed renderer. Added conversion-error and disposed-engine
regressions checking source disposal, Blob URL revocation, shared processor cleanup,
and fallback preservation. This covers asynchronous cleanup, not visual fidelity.

HDR environment lifecycle repair: replaced early-reject Promise.all with
allSettled so shared PMREM processing survives until both loads finish, and
disposes fulfilled sibling textures when either load fails. Source HDR disposal
now runs in finally even when conversion throws. A fault-injection regression
(one rejected HDR, one delayed HDR) passed, verifying disposal ordering and
retention of the fallback environment. The startup sigma-blur warning was traced
to fromScene(env, 0.08), but its visual settings were not changed without a
render comparison. This lifecycle fix does not resolve that warning.

Local runtime profiling preparation: started vinext dev on port 3000 (session
62115). The same process progressed through dependency optimization to reporting
http://localhost:3000/ ready. Initial browser connection occurred before readiness;
the subsequent navigation timed out, so no FPS sample is available yet.
During startup Win32_OperatingSystem reported TotalVisibleMemorySize 8260824 KiB
and FreePhysicalMemory 382596 KiB (about 374 MiB free). This is a confounding
machine-memory constraint, not proof of the game's root cause. No unrelated
applications were closed and no quality settings were reduced.

Character hot-loop cleanup: right-hand grip evaluation allocated one Vector3 per
call and one Quaternion per finger per frame. Reused existing quaternion scratch
storage and a constant axis without changing the computed pose. Added a 120-update
regression with distinct finger curls and non-identity bind rotations; all eight
character tests passed. This removes those allocations, not proof that GC caused
the reported stutter or that foreground performance now meets its target.

Renderer accounting repair: installed Three resets renderer.info per render call
unless autoReset is false. The composer issues multiple calls; snapshots could
therefore describe only its final pass. Rendering now resets counters once before
the complete frame with autoReset disabled. Three regression tests cover all-pass
aggregation, no carry-over, low-tier direct rendering and missing-composer fallback.
Together with adaptive-resolution coverage, six focused tests passed. This makes
future draw-call measurements meaningful; it is not an FPS improvement claim.
Full regression run after this repair: 189 tests across 21 files passed.

Continuation evidence: the latest focused adaptive-resolution suite passed all
three tests. Character contract validation reported six characters and no
failures; environment validation reported 15 assets / 90 maps and no failures;
release metadata validation reported four required files and no failures.
These validators do not measure fidelity or gameplay smoothness.

Added type, unit, lint, character, environment and release-metadata checks to the
deployment job before building or publishing. Previously the separate quality
workflow could fail without preventing the independent deployment workflow.
This workflow edit is local only and has not run on GitHub.

Reproduced the build shutdown assertion with the already-installed Node 24.19.0
runtime as well as the previous Node 24.18.0. Session 42416 exited 1 after both
routes prerendered. A patch-level runtime substitution is therefore insufficient;
no dependencies were changed and no error status was suppressed.

Additional repair: animate now skips simulation, ambient updates and rendering
while document.hidden, refreshing lastFrameTime and resetting adaptation windows.
This avoids background GPU work; foreground FPS improvement remains unmeasured.
Deployed browser inspection reached the campaign pause screen after a click
timeout; captured error logs were empty. That is not a successful gameplay test.

Fresh stable-source verification: 186 tests, type-check and lint passed. The
second build also exited 1 with the same Windows libuv shutdown assertion after
prerendering completed. This remains a failed build, not release evidence.
HTTP retrieval of the deployed character manifest
showed all six SHA-256 entries matching the current local manifest. This compares
declared hashes only, not downloaded binary hashes or runtime animation quality.

- Compare deployed asset/build identity with this local checkout.
- Measure foreground frame timings, draw calls, resolution, GPU and quality tier.
- Inspect character animation, materials, clipping and fallback state in actual play.
- Profile CPU systems and GPU passes independently; do not equate lowering visual
  quality with resolving the whole performance complaint.
- Run full tests/build and repeat the same playable route before publishing fixes.
