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
