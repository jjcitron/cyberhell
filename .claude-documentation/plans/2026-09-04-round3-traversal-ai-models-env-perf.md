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

## Status

In progress.

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
