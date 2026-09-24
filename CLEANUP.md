# Cleanup round 1 — `chore/code-cleanup`

Behavior-preserving cleanup from artic Wave A tip `99311d4`. No file under `js/`, `index.html`,
`editor.html`, `api/` or `levelPacks/` was changed, so nothing the game or editor runs is
different. Reference for structure: Clash of Steel Blades (`jjcitron/clash-of-steel`).

## Inventory vs Clash

| Area | Clash | Cyberhell before | Cyberhell after |
|---|---|---|---|
| Build | Vite (`dev`/`build`/`preview`), ES modules under `src/` | No build step; classic `<script>` globals under `js/` | Unchanged, on purpose (see Deferred) |
| `package.json` scripts | `test`, `qa`, `profile`, `shots`, `tournament` | `dev:api`, `migrate`, `test:api` only | Adds `dev`, `test`, `check:levels`, `check:polys`, `qa:articulation`; `engines.node >=20` |
| Lockfile | `package-lock.json` tracked | Untracked | Tracked (`npm install` is clean, 23 packages) |
| Entry HTML | `index.html` → one `src/main.js` | `index.html` loads 9 `js/*.js` + ~5k lines inline; `editor.html` loads 20 | Unchanged; every `src` resolves to a tracked file |
| Tests | `test/*.test.js` via `npm test` | `tests/` mix of `node --test` `.mjs`, CommonJS checks, Playwright/puppeteer QA | Same files; unit + level checks now behind `npm test` |
| Tools | `tools/*.mjs`, `tools/compose_midi.py` | `tools/` had 2 Node scripts; WAD pipeline `.py` loose at repo root | Pipeline lives in `tools/` |
| Root clutter | README, config only | 5 `MAP0x.png`, 4 `.py`, `deus_vult.json`, 7 WADs | WADs only (source data the pipeline reads) |

## Cleaned

- **Deleted dead files** (all from the initial commit, referenced by nothing the game, editor, tests
  or tools load): `MAP01.png`–`MAP05.png`, `convert_pack1.py` and `build_dv_json.py` (both
  superseded by `convert_all_wads.py`, which converts `pack1.wad` and `DV.wad` itself), and
  `deus_vult.json` (only `build_dv_json.py` wrote it; the game reads `levelPacks/dv/`).
- **Moved** `convert_all_wads.py` and `patch_exit_switches.py` to `tools/`. Both use paths relative to
  the working directory, so run them from the repo root as before
  (`python tools/convert_all_wads.py`, then `python tools/patch_exit_switches.py`). Their "Run" hint
  lines were updated; name-only mentions in code comments still resolve.
- **`package.json` scripts** made coherent: `npm test` runs the four `node --test` suites plus
  `check-exits` and `editor-roundtrip` (all green at baseline); `check:levels` adds `check-clipping`;
  `check:polys` is split out because it fails at baseline (below). `dev` aliases `dev:api`.
- **Playwright path**: every Playwright QA script now honours `PLAYWRIGHT_PATH` (four of them had
  the `C:/Dev/Tools/browserclaw-cli` path hard-coded with no override; `qa-midi-composer.js` used a
  one-off `PW` env name, which still works).
- **`package-lock.json` tracked**, matching Clash, so Vercel and CI install the same versions.
- README points at the npm scripts and the new `tools/` location.

## Checked, nothing to fix

- `index.html` and `editor.html` script and link tags (29 scripts, 1 stylesheet, 1 manifest) all resolve to tracked files; load order is
  intentional (engine modules before the inline game, `three.min.js` before anything that uses it).
- Asset string refs (`js/`, `css/`, `levelPacks/`, `midi/`) across both entry pages and all of `js/`:
  none dangling (the one hit, `midi/x.mid`, is a format example in a comment).
- `require`/`import` in `tests/`, `tools/`, `api/`: all local refs resolve.
- `js/package.json` / `tests/package.json` (`"type": "commonjs"`) are deliberate scope overrides of
  the root `"type": "module"`; kept.

## Deferred (documented, not changed)

- **Enemy-in-wall clipping / collision gameplay** — out of scope for this pass; queued next.
- **Wave B** (player arms, sprint legs) — not started.
- **Hitch / perf** — owned by PR #7 `perf/hitch-quality-tiers`; untouched.
- **ES-module / Vite migration like Clash.** Cyberhell's engine is classic scripts sharing globals,
  plus a ~5k-line inline `<script>` in `index.html` that owns the game loop, renderer, physics and
  combat. Splitting it into modules would touch every system and risk gameplay feel; it is the
  biggest structural gap vs Clash and should be its own job with playtest.
- **`@vercel/blob` audit warnings.** `npm audit` reports 2 (1 moderate, 1 high) in `undici` via
  `@vercel/blob@0.27`. The fix is a major bump to 2.x with API changes in `api/_lib/store.js`;
  needs its own change and a live Blob test.
- **`tests/check-polys.js` fails at baseline**: 191/197 maps pass (e.g. `pack5/json27` has 4
  overlaps). Level data, pre-existing; belongs with the clipping pass.
- **`tests/check-floor-coverage.js`** does not finish within 200 s on this laptop (baseline too);
  not wired into any script.
- **`qa-music-pause.js`, `qa-automap-exit.js` need `puppeteer-core`**, which is not a dependency.
  Run them with `NODE_PATH` pointing at an install, or port them to Playwright like the rest.
- **Playwright is still an external install.** Default path is `C:/Dev/Tools/browserclaw-cli`;
  adding `playwright-core` as a devDependency would make QA portable but changes every harness
  default, so left for a follow-up.
- **Root WADs** (`pack1.wad` … `DV.wad`, `pack4-6.WAD` mixed-case) stay at the root because both
  pipeline scripts read them by bare filename; moving them means editing the pack tables.
- `vercel.json` redirect for `cyberhell-seven.vercel.app` is production routing — not touched.
