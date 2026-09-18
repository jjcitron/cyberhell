# Hitch budget and quality tiers — 2026-09-17

Job `20260908-1150-cyberhell-hitch-perf`, round 3, worked on `box` from `origin/master` @ `4e2abd3`.
Branch `perf/hitch-quality-tiers`. Not pushed, not deployed.

The complaint this answers is the playtester's, relayed by Joel on 2026-09-08: the game "rocks but
edge lagsssss", and hangs for about a second at a time on a 64 GB / RTX 4070 laptop. Average frame
rate was never the problem and R3 T5 had already done the draw-call work. This cut is about the
stalls, and about a Low preset that is honest on hardware nobody would call a gaming laptop.

## What got measured, and how

`js/cyber-perf.js` (`window.CyberPerf`) records, per frame:

- frame time **rAF to rAF**, so a stall that happens outside the game loop — a rebuild in a fetch
  callback, a first-hit shader compile — still lands on a frame instead of disappearing between two
- the rAF callback's own time, with and without `renderer.render()`
- rolling p95/p99 for both, running maxima
- a **cause tag** on every frame over ~33 ms, built from exclusive section time, plus notes for
  level changes and for frames where `renderer.info.programs` grew (a shader compiled)

`tests/hitch.js` drives the page's own loop through a scripted **enter → fight → exit** on four maps
under two profiles (mid: no throttle, High; low: 4× CPU throttle, Low). `tests/hitch-probe.js`
isolates one level change: program count before and after, and the first render versus the second.
`tests/qa-quality.js` checks the tier policy.

**The metric the budget is judged on is `engBlock`** — the longest stretch of main-thread work the
engine itself is responsible for: the rAF callback minus `renderer.render()`, plus the level-build
slice on a frame that carried one. `renderer.render()` is excluded because headless runs through
SwiftShader, where that call *is* the rasteriser. The evidence that this is the right cut: with the
shadow pass off, the same first-frame-after-a-level-change render costs 105 ms instead of 390 ms,
and the program count does not move across it. That is raster and resource allocation, not the
game. Whole-callback time, the browser's long-task record and frame time are all still reported.

## What the measurement found

Ranked by how much time they took, not by hypothesis:

1. **Every level change recompiled the world's shaders.** `resetLevelScene` disposed every material,
   and three drops a `WebGLProgram` when its last material reference goes. The next level's first
   rendered frame paid a full first-hit compile: 340–880 ms of `render()` on the transition frame,
   on every map.
2. **Every volley recompiled the projectile shaders.** `spawnProjectile` built geometry and
   materials per shot and `_releaseProjectile` disposed them, so the last fireball of a volley took
   its program with it. Measured at 610 ms of `render()` inside one fight frame, tagged
   `shaderCompile+13`. This is the "hangs for a second in a fight" class.
3. **The level build ran in one synchronous block** — up to 2.2 s on the medium maps, dominated by
   `load.entities` and `load.sectors`.
4. **The shadow pass compiles its own depth programs** at the first shadow render, which
   `renderer.compile()` does not cover, so warming the colour pass alone left an 800 ms render on a
   level change.
5. **The pooled dynamic lights toggled `.visible`.** three bakes the count of visible lights of each
   type into every program, so a projectile spawning changed the count and invalidated the cache.
6. **The HUD face repainted** forty `fillRect`s every frame for a picture that changes twice a
   second: 297 ms in one throttled frame.

And one defect found on the way: gore went silent after the first level change. The pools are built
once per page, but the level teardown was removing their meshes from the scene, leaving `clear()`
resetting bookkeeping for meshes nothing would ever draw again.

## What changed

Materials that outlive a level are cached and flagged `_shared`; scene objects that outlive a level
are flagged `_persist`; `disposeObject3D` and `resetLevelScene` honour both. That covers the merged
world chunks (`levelMaterial`), the bestiary's own `matCache`, the projectile assets, the gore pools
and the trail/flash sprite pools.

`loadLevel` keeps its contract for every existing caller and now drains a generator. `loadLevelFromFile`
drives the same generator a quality-tier slice per frame behind a loading card, with a build-sequence
guard so two loads cannot interleave.

The warm-up renders one representative object per **program signature** — the shader family plus the
defines a material and its geometry imply, which is what three actually keys a program on. A
converted map carries thousands of materials and about fifteen programs; warming per material was
warming the same program hundreds of times. Colour is scissored to one pixel. Boot puts a set of
tiny probe meshes through the same pass so the world-material programs compile on the title screen.

The whole light rig — ambient, hemisphere, sun, neon accents, projectile and impact pools — is built
once for the page and re-aimed per level, at intensity 0 when idle. The count never moves, so the
program cache is never invalidated by it, and the sun's 2048² depth target is allocated once instead
of once per level.

`js/cyber-quality.js` owns Low / Medium / High. See the README section for the table and the policy.

## Numbers

Headless, SwiftShader, 256×144, contention-normalised against the `CALIB_REF = 20.4` this repo
already uses. `engBlock` in ms, worst over enter/fight/exit.

| profile | map | walls | enemies | budget | before | after |
|---|---|---|---|---|---|---|
| mid | MAP01 | 854 | 24 | 500 | 134 | 226 |
| mid | pack3/json29 | 91 | 1 | 500 | 1281 | 13 |
| mid | pack5/json23 | 1581 | 130 | 500 | 364 | 22 |
| mid | pack1/json12 | 8717 | 269 | 500 | 380 | 27 |
| low | MAP01 | 64 | 12 | 250 | 55 | 151 |
| low | pack3/json29 | 91 | 1 | 250 | 417 | 42 |
| low | pack5/json23 | 1581 | 130 | 250 | 1565 | 67 |
| low | pack1/json12 | 8717 | 269 | 250 | 1489 | 58 |

Two rows go up, both on MAP01, and the reason is worth stating rather than hiding: the warm-up moved
compile work *into* a bucket this metric counts (the build slice) out of one it excludes (`render`).
The player gets it behind the loading card instead of in the first frame they can see, and both
numbers are inside budget. It is the first level transition of a session that pays it; subsequent
ones cost 9–22 ms.

Per-level-change warm cost on the large map, from `tests/hitch-probe.js`:

| warming strategy | first change | later changes |
|---|---|---|
| per material | 601–785 ms | 601–785 ms |
| per signature | 238 ms | 9–20 ms |

## What this cannot settle

Everything above is a software rasteriser's opinion of a GPU's job. `engBlock` is the part that
transfers; frame time here is not a frame-rate claim, and the GPU-side half of a level change —
texture and buffer upload, the first shadow atlas — is measured in hundreds of milliseconds by
SwiftShader and in single-digit milliseconds by a driver. The confirming run is Joel's laptop with
the same scripted path, not a headless box.
