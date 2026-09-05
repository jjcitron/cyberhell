# Cyberhell round 3 — traversal, smarter AI, models, environments, performance

**Date:** 2026-09-04 · **Branch:** `feat/round3` (off `feat/collision-gore-progression`, which also carries
the converter wall-nudge + regenerated packs not yet shipped). Ship via `main`.

**Joel's report after playing round 2:** much better, but still (a) getting stuck in rooms with no
exit and going through some walls; (b) enemy AI feels like a dumb swarm; (c) upgrade the models;
(d) make the environments look better; (e) the game is getting heavy in the browser — do a code
and performance optimisation. Team leads each run their own sub-team; there are many levels and
many enemies.

## Diagnosis going in

- **Stuck rooms.** Round 2 made climbing honest (one Doom step, drops free). Doom maps get you out
  of pits and across gaps with **lifts, switch-opened remote doors and teleporters**, none of which
  the engine implements, so drop-only pockets are dead ends. Fix = implement the sector actions,
  add a **mantle** (jump + forward onto a ledge up to jump height), and a **safety net**: per-cell
  "can this position still reach the exit" from the directed model; if the player enters a cell
  that cannot, offer HOLD E to extract back to the last cell that can.
- **Residual clipping.** 6/197 maps still fall back to rectangles for a few sectors; thin-wall
  tunnelling at high speed; enemies vs. doors.
- **Dumb AI.** `updateEnemies` walks straight at the player; no sight test, no navigation, no
  roles, no pain, no coordination.
- **Heavy.** One mesh per wall and per sector (20k walls on the biggest maps), shadow map on
  everything, `TextureFactory` canvases, enemy animation every frame for every enemy, no
  culling budget.

## Teams (wave 1 in parallel; wave 2 after integration)

| # | team | lead model | owns (nothing else) |
|---|---|---|---|
| T1 | **Traversal & clipping** — sector specials (doors incl. tagged/remote, lifts, floor raise/lower, teleporters), mantle, dead-end safety net, residual polygon/tunnelling fixes, per-map playability sweep | opus | `convert_all_wads.py`, `patch_exit_switches.py`, `levelPacks/**`, `tests/**`, `index.html`: physics/collision/`getFloorAt`/`resolveWallCollisions` (~3100–3300), sector/wall **geometry & positions** in build (~1760–1900, geometry only), `interact()`/switch handling, door code, HUD hint text for the safety net |
| T2 | **Enemy AI** — nav grid from polygons, line of sight through walls, roles (rusher/ranged/tank/flyer), flanking & spacing, pain/stagger, alert propagation, attack budgets, leading projectiles, retreat when hurt | opus | new `js/cyber-ai.js`, `index.html`: `updateEnemies`/`moveEnemy`/`enemyAttack`/`separateEnemies` (~3417–3520 + enemy AI region), `js/cyber-enemies.js` **stats only** |
| T3 | **Models** — enemies and weapons more detailed and animated (attack/pain/death poses, weapon fire anims) | opus | `js/cyber-enemies.js` (except `stats`), `js/cyber-weapons.js`, `index.html` view-model region (~1443–1580) |
| T4 | **Environments** — texture variety per Doom flat/texture family, per-sector light levels → material/light, decorative props, sky/atmosphere per map theme, better neon | sonnet | `TextureFactory` (~1245–1442), **material/texture selection lines** in sector/wall build (~1760–1900; not geometry), new `js/cyber-env.js`, `loadLevel` light setup, particles for atmosphere |
| T5 | **Performance & code** (wave 2) — merged static geometry per material, instanced props, culling and animation budgets, shadow scoping, allocation hygiene, mobile budget, a `perf` test harness | opus | anything, after wave 1 lands; must keep every wave-1 test green |

### Shared rules
- Read the region table before editing; never edit another team's region. Hooks you need in another region: SendMessage the lead (name `team-lead`) with the exact line.
- No commits. Headless-only browsers via playwright-core (`C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core`), never the shared `bcl` daemon. Static-server ports: T1 8150–8159, T2 8160–8169, T3 8170–8179, T4 8180–8189, T5 8190–8199. Kill your own processes by PID only.
- Sub-agents: each lead may spawn workers with the Agent tool, **always passing `model`**: haiku for mechanical sweeps, sonnet for standard building, opus only for judgment-heavy pieces. Keep them in your region and make them report back to you.
- Every existing test must stay green: `check-exits` 198/198, `check-polys`, `check-clipping`, `qa-collision` 21/21.
- Report to the lead with SendMessage when done; do not go idle silently.

## Status: Completed 2026-09-05

Wave 1 (T1–T4) shipped as b01e6a0; wave 2 (T5 performance) shipped with this commit. Lead QA on the integrated tree: exits 198/198, qa-collision 21/21, qa-deadend-net 6/6, qa-ai 11/11, lead harness (gore, progression, floor walk) clean. Harness fact for the record: teammates could not spawn sub-agents ("roster is flat"), so each lead built its package directly.

### T1 (traversal & clipping) — delivered

**Converter** (`convert_all_wads.py`). A `LINE_SPECIALS` table classifies 101 Doom linedef
specials into lifts, floor raise/lower, teleporters and doors; sector adjacency gives the
neighbour-height queries Doom's targets are defined against. Each sector now carries a floor
**envelope** `loY`/`hiY` — the lowest and highest its floor can ever be given every action that
targets it — and each acted linedef is exported twice: as `act` on its wall (so `[E]` works on a
switch panel) and in a new top-level **`triggers`** array. The triggers array is the load-bearing
part: most lifts and *every* teleporter sit on a two-sided line with no floor step, which the wall
loop skips, so wall-only export lost 5,616 teleport lines and most lift lines.

**Engine** (`js/cyber-traversal.js`, new; hooks in `index.html`). Sector floors animate, carrying
the player and any enemy standing on them, and the floor mesh, its cached height, its world matrix
and the neighbouring riser meshes all follow. Teleporters move the player with a flash and a
one-second grace so landing pads cannot ping-pong. Trigger lines fire on walkover, on touch and on
`[E]`. An **assist** pass (4 Hz) fires a lift the player is standing next to but cannot climb: the
offline model treats a floor that *can* move as passable, so the engine has to agree or the player
waits at the foot of a lift that never comes.

**Mantle.** One line: horizontal velocity is no longer zeroed when a ledge refuses the step
*while airborne*. The climb gate was already measured from the feet, so keeping the momentum lets
the jump's 1.28 units of lift buy the reach — an effective 2.4-unit mantle.

**Safety net.** The walk model moved into `js/cyber-traversal.js` and is now shared verbatim by
`tests/reachability.js` and by the engine, so the offline model and the game cannot drift. Its
one rule covers stairs, lifts and raising floors at once: a step is legal when the destination
floor *can come* within one auto-climb of the floor you stand on (`lo[to] - hi[from] <= 1.2`),
plus one-way teleport edges. At load the engine builds a coarse grid and reverse-floods from the
exit; standing 1.5 s in a cell the exit is unreachable from shows `DEAD END — HOLD [E] TO EXTRACT`
and logs the map and position. `patch_exit_switches.py` carries the same envelope and teleport
rules so its Python model agrees.

**Numbers.** 18,659 actions exported across 198 maps (6,556 door markers, 5,616 teleporters,
3,351 floor movers, 3,136 lifts); 3,340 sectors whose floor can move; 15 teleport lines dropped
for want of a landing spot; 32 unknown specials left, all Boom/MBF. `levelPacks` 55.1 MB -> 58.7 MB.
Median reachable floor, measured on identical data with and without the new actions:
**55.0% -> 82.3%** (mean 50.0% -> 73.2%). `check-exits` 198/198. `check-clipping` 227/296,628
orphan wall endpoints (0.1%). `check-polys` 191/197, the same six maps as before this round.
`qa-collision` 21/21. New `tests/qa-deadend-net.js` 5/5.

**198-map browser sweep** (`tests/qa-traversal-sweep.js`, new). Every converted map is loaded in a
real headless engine and the offline route is walked through `updatePhysics`, the lift code and
the teleporters. Result: **165/197 walked to the exit**, **zero off-floor frames**, **zero
dead-end-net triggers**, and every wall penetration in the whole run on a single map where the
bot triggered a teleporter the route had not planned and then marched at a stale waypoint. Two
follow-up fixes landed after that run and were verified on the affected maps: teleport landings
now push out of walls the way a movement step does (Deus Vult MAP05 penetrations 403 -> 3), and
the engine's teleport touch radius was tightened to exactly the offline model's teleport-edge
radius so it cannot fire a teleporter the route did not plan (MAP23 166 -> 45).

The 32 remaining failures are the walk bot failing to steer rather than the engine refusing a
legal move: re-running the earlier failure set with a bot that strafes round an obstacle instead
of grinding into it converted nine of them immediately, and a human has strafe, reverse and jump
that the bot only partly has.

**Not done, deliberately.** Tagged door sectors are still never sealed — the engine has always let
you walk through a closed door sector, and sealing them can only create new stuck rooms, which is
the bug being fixed. Doors therefore animate nothing; local doors keep the existing auto-open.
Crushers, stair builders and perpetual-platform *stops* are exported as diagnostics only.

### T5 (performance & code) — delivered

**Harness first.** `tests/perf.js` is the repeatable command: it serves the tree on its own port,
drives a real headless engine over MAP01 plus six converted maps spanning 91 to 20,461 walls, and
for each one reports level load time and its build phases, draw calls and triangles at spawn and
across a scripted 20-second walk-and-fight, scene light count, live geometry/texture counts, JS
simulation cost (median and p95, contention-normalised against the same fixed arithmetic loop
`tests/qa-ai.js` uses), and the per-module split (AI brains, enemy rigs, gore, environment,
traversal) from new counters on the engine (`engine.perfStats()`). It then loads three maps back
to back three times as a leak check, runs a geometry sanity pass, and finally repeats a short run
in an 851x393 touch context. Usage: `node tests/perf.js [--maps a,b,c] [--seconds N]`, `QA_PORT`
to move the port.

**Where the cost actually was.** The baseline said the biggest map spent 14.85 ms a frame inside
`CyberTraversal.update` — nothing to do with rendering. Every frame a lift was moving, the module
re-derived `getFloorAt` for all 4,161 enemies to catch the handful standing on it. It now collects
the plan-view boxes of the floors that actually moved and only re-seats bodies inside one. That
one change is 14.85 ms -> 0.24 ms.

**Static geometry batching.** Walls, floors and ceilings are collected during the build and merged
per material per 32-unit tile (`batchGeo` / `batchSurface` / `flushBatches`, with a `mergeGeos`
helper because three r128's core build does not ship `BufferGeometryUtils`). Sector light was
baked into `material.color`, which is what forced one material per surface; it rides in a vertex
colour now and the merged material keeps colour white, so the shading is unchanged. Three things
deliberately keep their own mesh: doors (they slide), switch panels (they repaint), and anything
adjacent to a sector a trigger can move (traversal rescales those risers every frame). The movable
set is built from `data.triggers[].act.secs`, which is exactly the set `CyberTraversal.fire` will
ever move. Horizontal surfaces are keyed by height as well as material so a merged mesh still
carries `userData.floorY` / `userData.ceilY`.

**Enemy rig LOD.** After batching, the megamap's static world was 394 draw calls and its monsters
were 5,187: a rig is 50-60 separate meshes. Beyond 22 units only the parts over 20 cm across are
drawn; beyond 95 units, where the map's own fog has a body at a fifth of its colour, the body is
not drawn at all. Behaviour is untouched — an enemy the player cannot see still thinks, moves and
shoots. The pass strides an eighth of the roster per frame and settles fully at level load.

**Level teardown.** `resetLevelScene` now frees the GPU resources behind the objects it drops,
including a shadow-casting light's render target. Textures the page caches for its whole life
(the level texture cache, the sky/dust/skyline canvases in `CyberEnv`, the gore sprites, the glow
sprite) carry a `_shared` flag so the teardown leaves them alone. Measured over three rounds of
three level loads: live geometries were 998 -> 1,657 -> 2,316 and climbing, now flat at 61.

**Culling, budgets and allocation.** Enemy rig animation gets a frustum test on top of the AI's
existing distance gate. Player projectiles used to test every enemy on the map once per projectile
per frame and now test one candidate list gathered per frame. Hitscan, melee, the barrel blast and
the pickup spin all reject by squared distance before touching an array. `wallsNear` dedups with a
per-query stamp into a scratch array instead of a quadratic `indexOf`; `getSegDist` was a closure
rebuilt inside `resolveWallCollisions` on every call and is now a module function writing into one
scratch record; projectile trails recycle their history vectors; the movement basis vectors are
scratch; barrels share one cylinder and one material (each used to build its own, plus a 256x256
`toxic_ooze` canvas that was painted and never attached to anything). `interact()` raycast an array
of all 20,461 wall meshes it rebuilt on every keypress; it now picks the wall the crosshair is on
out of the collision grid.

**Mobile.** Pixel ratio caps at 1.5 on a coarse pointer (shadows were already off there), prop and
particle budgets drop to a third, and the shadow map halves on machines reporting four cores or
fewer. Verified at 851x393 with touch flags: starts, plays, 227 draw calls at spawn and 1,057
walking, 0.5 ms median simulation, no page errors.

**Numbers**, contention-normalised, JS only:

| map | walls | calls @spawn | calls walking | sim p95 ms | load ms |
|---|---|---|---|---|---|
| MAP01 | 64 | 353 -> 243 | 148 -> 123 | 0.5 -> 0.6 | 46 -> 29 |
| pack3/json29 | 91 | 161 -> 156 | 198 -> 155 | 0.2 -> 0.3 | 448 -> 534 |
| pack3/json4 | 776 | 388 -> 317 | 2,430 -> 1,221 | 4.1 -> 3.2 | 534 -> 633 |
| pack5/json23 | 1,581 | 5,403 -> 1,304 | 2,821 -> 881 | 1.2 -> 1.1 | 2,758 -> 1,981 |
| dv/json1 | 6,641 | 88 -> 64 | 5,789 -> 896 | 3.8 -> 1.1 | 2,831 -> 1,597 |
| pack1/json12 | 8,717 | 10,308 -> 2,262 | 8,220 -> 2,022 | 3.2 -> 3.0 | 3,991 -> 2,280 |
| dv/json2 | 20,461 | 6,277 -> 512 | 11,855 -> 1,603 | 39.5 -> 2.8 | 11,886 -> 7,000 |

The two small maps' load times are inside the noise of fetching over a local server on a contended
box; the maps where load time mattered are all roughly halved. `dv/json2`'s remaining 7 s is mostly
fetch and `JSON.parse` of a 4.4 MB file — the in-page build is 2.0 s of it, and 1.35 s of that is
constructing 4,161 enemy rigs.

**Not done, deliberately.** Incremental chunk building across frames was measured and skipped: the
in-page build on the biggest map is 2.0 s behind a loading overlay and every other map is under
0.5 s, so the complexity buys a window nobody sees. Shadow caster ring-scoping was skipped for the
same reason — merging turned 20,461 caster meshes into a few hundred chunks, and three's own
shadow-frustum cull already discards the ones outside the sun's tight ortho box. Throttling gore
and environment particle updates was skipped on measurement: both cost 0.01-0.02 ms a frame.
`index.html` was not split into modules, per the round's instruction.

**Also fixed.** `killEnemy` snapped every corpse to `rotation.x = PI/2` and `y = 0.2`, which fought
the death poses `js/cyber-enemies.js` drives off `state === 'DEAD'` and, because 0.2 is a world
height, dropped corpses killed on a raised floor through it. The 172-line `buildBoxEnemyMesh`
fallback, dead in any build where `js/cyber-enemies.js` loads, is now a single box. Module load
order was audited: none of `js/cyber-*.js` touches `THREE` at load time, so loading them before
`js/three.min.js` is safe.

**Tests.** `check-exits` 198/198, `check-polys` 191/197 (the same six maps), `check-clipping`
227/296,628 orphan endpoints, `qa-collision` 21/21, `qa-deadend-net` 6/6 (DN-5, the 60-second
no-progress rule, already existed and stays green), `qa-ai` 11/11, `tests/perf.js` geometry sanity
0 of 621 sampled surfaces drawn away from where the level data puts them. That geometry check is new and
earned its keep immediately: it caught a ceiling being transformed twice by the batcher, which
nothing else in the suite would have noticed. The 198-map `qa-traversal-sweep` was re-run as a
breadth check on the collision changes: 169/197 walked to the exit (wave one was 165/197), zero
off-floor frames, zero dead-end-net fires, and 46 wall penetrations against wave one's 48 — 45 of
them on one map where the bot takes an unplanned teleport and then marches at a stale waypoint,
the same single-map profile wave one reported.
