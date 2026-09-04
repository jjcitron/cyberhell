# Cyberhell refinement round (studio round with Clash of Steel)

**Date:** 2026-09-04 · **Branch:** `feat/refinement-round` (off `fix/map-exits-and-automap-tracking`, PR #4)
**Ask (Joel):** one studio, share across projects. Cyberhell gets: enemies as detailed as the
Clash of Steel fighters (intent per enemy is in the code comments of `buildCustomEnemyMesh`),
shadows and better lighting, animated enemy projectiles that cast light, a wider weapon set on
three ammo types (bullets / shells / energy) with a machine gun, a single-shot energy weapon, a
rapid energy weapon and a redesigned always-on energy chainsaw, and levels verified playable
start to finish with clear exits and no clipping. Clash of Steel gets MIDI music per arena in
the region's musical style, using Cyberhell's tinysynth player.

## Shared contracts (all agents)

- Everything lives in `index.html` (3.7k lines). Agents own **regions**, listed below, and must
  not edit outside them. New code goes in new `js/*.js` files loaded by `<script>` tags where
  possible.
- Entity names (converter ↔ engine): weapons `chainsaw, pistol, machinegun, shotgun,
  energy_rifle (single shot), energy_repeater (rapid)`; ammo `ammo_bullets, ammo_shells,
  ammo_energy`. Doom things: 2005→chainsaw, 2001/82→shotgun, 2002→machinegun,
  2004→energy_repeater, 2006→energy_rifle; 2007/2048→bullets, 2008/2049→shells,
  2047/17/2010/2046→energy.
- Projectile API (lighting agent publishes, weapons agent consumes):
  `engine.spawnProjectile({ from: Vector3, dir: Vector3, speed, kind, owner: 'enemy'|'player', damage, radius })`
  where `kind ∈ fireball | plasma | laser | energy_bolt | energy_burst`; each kind has an
  animated mesh, a pooled PointLight and an impact flash.
- Engine enemy types today: `soldier` (hitscan) and `monster` (fireball). Enemy work may add
  per-type stats but keeps those two attack paths (lighting agent owns the projectile path).

## Regions of `index.html`

| region | lines (approx) | owner |
|---|---|---|
| MAP01_DATA hand-built level | 725–965 | nobody |
| SoundEngine | 968–1244 | weapons (new weapon cues only) |
| TextureFactory | 1245–1442 | nobody |
| WeaponViewModels / buildWeapons / switchWeapon / weapon anim | 1443–1580 | weapons |
| Engine ctor, state (`ammo`, `hasX`) | 1666–1730 | weapons (state), lighting (renderer flags) |
| loadLevel lights / sector+wall build | 1735–1900 | lighting |
| pickups (`ent.type === 'weapon' / ammo`) | 1896–1935 | weapons |
| `buildCustomEnemyMesh` + hpMap | 1940–2140 | enemies → moves to `js/cyber-enemies.js` |
| input / weapon switching keys | 2145–2200 | weapons |
| firing / hitscan / damage | 2617–2833 | weapons |
| enemy AI / `enemyAttack` / projectiles | 3146–3265 | lighting (projectiles), enemies (AI stats) |
| movement / collision / floor containment | 2834–3087 | levels |
| level load / packs / exit | 3000–3100 | levels |

## Packages

| # | package | model | files |
|---|---|---|---|
| A | Clash of Steel MIDI: composer script → 12 `.mid`, tinysynth player module, Sound wiring, HUD toggle | sonnet | `weapon-fighting/**` |
| B | Enemies: 15 detailed models in `js/cyber-enemies.js` + per-type stats | opus | `js/cyber-enemies.js`, enemy region |
| C | Levels: step/ledge converter rule, engine step-up ≤24 / fall-down, reachability + clipping tests over all 198 maps | sonnet | `convert_all_wads.py`, `patch_*.py`, `levelPacks/**`, `tests/**`, movement region |
| D | Lighting: shadows, per-level lights, animated light-casting projectiles, impact flashes, `spawnProjectile` API | sonnet | lighting + projectile regions |
| E | Weapons: three ammo types, machine gun, energy rifle, energy repeater, energy chainsaw redesign, HUD slots, pickups, sounds | opus (after D) | weapon regions, `js/cyber-weapons.js` |
| F | QA: browser pass, perf, merge to master, push | lead | — |

## Status: Completed 2026-09-04

All packages delivered on `feat/refinement-round` and integrated by the lead (hit flash wired
into `damageEnemy`, Three.js r128 vendored to `js/three.min.js`, shadow/flash hooks called by
the region owners). Lead QA in an isolated headless Chromium (playwright-core, not the shared
`bcl` profile) against the integrated build: MAP01 starts with 24 enemies, all carrying stats
and limb rigs; shadow mapping on; 304 draw calls / 3.9k tris; all six weapons fire and drain
the right pool; every projectile kind spawns, travels, lights and damages; walking moves the
player along the floor; a converted map (pack1 MAP01) loads through the real UI with 24
enemies and one exit; zero page errors and zero console errors. Level tests: 198/198
finishable, median reachable floor 25.8% → 78.5%, spawn pockets 29 → 9 (all pre-existing).

Not delivered as specified: one-way ledges (block climbing >24 units) — removed because the
exit-placement model is direction-agnostic and it deadlocked 3 of 4 sampled maps; ledges are
tagged in the JSON for a future direction-aware pass. Cosmetic: Hell Knight/Baron are 12%
taller than the old boxes. Process note: the shared `bcl` daemon runs on a persistent Chrome
profile with extensions; agents were told to stay headless on their own ports, and the lead
QA used an isolated browser.

---

# Round 2 (same day): collision root cause, gore, level progression

**Joel's report after playing:** no blood on hits (wants copious blood *and oil* — cybernetic
enemies); still falling through floors, walking through walls, enemies coming through walls,
some enemies should be walking/flying; clearing a level should go to the next level in the
pack, not the menu.

**Root cause of the clipping family:** `convert_all_wads.py` stores every Doom sector as ONE
axis-aligned bounding rectangle (`x, z, width, depth`). Doom sectors are arbitrary polygons
(often concave, with holes), so neighbouring rectangles overlap heavily; `getFloorAt` returns
the first rectangle containing the point, so a lower sector's box can win inside a higher
room (fall-through), floor meshes are drawn as rectangles that do not match the walls
(visual clipping, 32% "orphan" wall endpoints), and the player can stand where there is no
real floor. Enemies have no collision code at all and none fly.

| # | package | model | owns |
|---|---|---|---|
| G | Collision: converter emits sector polygon loops; engine builds floor/ceiling meshes from triangulated polygons (holes included), `getFloorAt` = point-in-polygon; walls from every blocking linedef; enemy wall + floor collision; flying enemies hover; tests | opus | `convert_all_wads.py`, `patch_exit_switches.py`, `levelPacks/**`, `tests/**`, `index.html` sector/wall build (~1760–1900), physics/collision (~3100–3300), `updateEnemies` movement (~3417–3470), `js/cyber-enemies.js` stats (`fly`) |
| H | Gore: blood + oil sprays scaled by damage, death bursts, persistent floor/wall decals, sparks | sonnet | `js/cyber-gore.js` (new), `spawnBlood` (~3000–3015), particle loop (~3760–3775), gore calls in `damageEnemy`/`killEnemy` |
| I | Progression: exit → LEVEL CLEARED → NEXT LEVEL loads the next map in the current pack (MAP01 → pack 1 level 1; end of pack → next pack / menu), keep weapons and ammo between levels, restore health partially | sonnet | `triggerVictory` (~3850–3865), pack/manifest loading (~2380–2440), `loadLevelFromFile`, overlay button wiring |

## Round 2 status: Completed 2026-09-04

- **Collision (G).** Four defects, not one: bounding-rectangle sectors; every wall mesh forced ≥ 8 units tall (knee-high risers drew as non-solid slabs = "walking through walls"); climbing ungated (cliffs teleported you up); and `2.0 - 0.8 > 1.2` float rejection of Doom's 24-unit stair. Now: real sector polygons from the WAD (54,038/54,038), `ShapeGeometry` floors/ceilings with holes, point-in-polygon `getFloorAt` with spatial buckets, walls at true height, climb gated at one step measured from the feet (drops free), enemy wall/floor collision + separation, Cacodemon/Revenant fly. Orphan wall endpoints 32.6% → 0.1%; exits 198/198; `tests/qa-collision.js` 21/21. Median reachable floor is now 60.8% (was a false 78.5% with overlapping rectangles): the remainder needs Doom lifts, remote doors and teleporters, which the engine does not implement — a content/engine follow-up, not collision.
- **Gore (H).** `js/cyber-gore.js`: instanced blood + oil droplets, streaks, hit splash, floor decals with satellites, growing death pool, chunks, mist; enemy body paint; ~0.25 ms/frame worst case.
- **Progression (I).** Campaign tracking, LEVEL CLEARED → NEXT LEVEL / PACK COMPLETE → NEXT PACK / CAMPAIGN COMPLETE, arsenal carried over, health floored at 50, Enter/Space continues.
- Follow-ups: lifts/remote doors/teleporters for full map coverage; wall splats; `tests/qa-automap-exit.js` needs puppeteer-core (its walk is reproduced in qa-collision).
