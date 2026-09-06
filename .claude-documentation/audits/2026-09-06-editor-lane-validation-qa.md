# Validation/QA lane audit — 2026-09-06

Branch `editor/validation-qa`, worktree `C:\Dev\Personal\_wt\ch-validation-qa`.
Scope: `js/shared/level_validate.js`, `js/editor/validate_panel.js`,
`tests/qa-editor.js`, `tests/level-validate.test.mjs`, plus research into
whether `check-exits.js`/`check-polys.js`/`check-floor-coverage.js` duplicate
logic worth consolidating.

## Delivered

- **`js/shared/level_validate.js`** — UMD module (`window.LevelValidate` in
  the browser, `module.exports` in node) exporting
  `validateLevel(level, {quick}) -> {errors, warnings, stats}`. Reuses
  `js/cyber-traversal.js`'s `Grid`/`flood`/`exitWalls` directly (not
  `tests/reachability.js`, which does an unconditional `require()` and is
  node-only) so the same file works as a plain `<script>` in the editor.
  Checks: schema/required-fields/types, sector polygon structure
  (open loops = error, self-intersection = warning), exit-switch presence,
  trigger-to-wall binding, enemyType resolution, music shape, and (full mode
  only) exit reachability + floor-coverage % via the shared walk graph.
- **`tests/level-validate.test.mjs`** (`node --test`) — 16 tests, all passing:
  every one of the 198 canonical levels (pack1-6, dv, hand-built MAP01)
  validates with 0 errors in full mode; a dedicated perf case on
  `levelPacks/dv/json2.json` (~20k walls, the largest level in the corpus);
  and one synthetic case per required defect class (open poly,
  self-intersection, no exit, two exits, unreachable exit, malformed trigger
  index, unknown enemyType, unresolved `custom:<id>`, plus schema/music
  checks).
- **`js/editor/validate_panel.js`** — waits for `window.CyberEditor` (via
  `cybereditor-ready` event or a 20s poll, since editor-core is a parallel
  lane and hadn't landed `editor.html` yet when this was built), registers a
  right-side "Validate" panel: quick-mode auto-run on `level-changed`
  (300ms debounce) and `level-loaded`, a "Full validate" button, a findings
  list grouped error-then-warning with click-to-`Editor.select(ref.kind,
  ref.index)`, a stats footer, and a status-bar badge via
  `Editor.setStatus` when present.
- **`tests/qa-editor.js`** — playwright-core, isolated headless Chromium
  (`--use-gl=swiftshader`), a plain node static server on port 5306 (see
  deviation note below). Runs unconditionally: loads `index.html`, injects
  `level_validate.js`, fetches a real level over HTTP, and asserts
  `window.LevelValidate.validateLevel` reports 0 errors with 0 page errors —
  proves the module works as a browser global independent of the editor
  shell. Feature-detects `editor.html`/`window.CyberEditor`/a level-loading
  method and SKIPs (not fails) those steps when the shell isn't there yet;
  currently `editor.html` doesn't exist, so those print SKIP as designed.
  Result today: 2 passed, 2 skipped, 0 failed.

## Deviation from the brief

- **`tests/qa-editor.js` serves the worktree with a plain `http.createServer`
  (same pattern as the existing `tests/qa-collision.js`), not
  `python -m http.server 5306`.** No subprocess to spawn/track/kill, matches
  the codebase's own established pattern for the other browser QA scripts,
  and gets the same isolated port/cleanup guarantee.
- **`tests/check-exits.js`, `check-polys.js`, `check-floor-coverage.js` were
  left untouched.** None of them actually duplicate logic that now lives in
  `level_validate.js` — `check-polys.js`'s job is WAD-area-deviation +
  overlap sampling (not open-loop/self-intersection structure), and
  `check-floor-coverage.js` calls `reachability.js`'s per-pocket
  `floorMetrics()` (a different algorithm than the single-flood
  reachable/total-free ratio `level_validate.js` computes for speed — see
  perf finding below). Editing them to "import the shared module" would have
  meant importing something that doesn't compute what they need, at real risk
  to the stated 198/198 exits invariant, for no actual de-duplication. Ran
  both read-only to confirm baselines: `check-exits.js` 198/198 (unchanged),
  `check-polys.js` 191/197 (pre-existing baseline, unchanged).
- **`check-floor-coverage.js` gate**: kicked off in the background early and
  was still running when this report was written (see perf finding — it was
  observed to take ~8 minutes on `dv/json2` alone in isolation). This is
  pre-existing behavior of an unmodified file, not something my changes
  caused; `node --check` passes on it and it wasn't touched.

## Findings worth other lanes' attention (also sent to team-lead)

1. **`trigger.i` is not `walls[]`'s array index.** The research doc's
   "`walls[i] <-> triggers[].i` pairing" is wrong. `js/cyber-traversal.js`
   (~line 452/467) matches `trigger.i` against each wall's own `.ai` field
   ("action id", present on ~3% of walls), not position. Verified: `t.i`
   values in real data exceed `walls.length`; `pack1/json1.json` (a passing
   canonical level) has a `trigger.i` with no matching `wall.ai` at all — a
   harmless engine no-op. Matters for whichever lane builds trigger-authoring
   UI (likely editor-core): a newly authored trigger needs to write/reuse a
   `wall.ai` value, not an array index.
2. **Three "hard invariants" in the plan/data-reference doc turned out to be
   soft in real data**, discovered by validating all 198 canonical levels
   before trusting the doc's phrasing:
   - "exactly one `sw_exit_game` wall" — false for 70/198 levels; the engine
     filters for *any* wall with that `switchId`, so multiple segments of one
     WAD exit linedef (or genuinely multiple exits) are both fine.
   - "closed non-self-intersecting polys" — two shipping levels have a small,
     genuinely self-crossing 4-point loop from the WAD's directed-edge
     chaining; `Grid.fillLoops`'s even-odd scanline fill degrades gracefully.
   - unknown numeric `enemyType` — `js/cyber-enemies.js` does
     `STATS[typeId] || DEFAULT_STATS` plus a `BUILDERS[0]` generic-mesh
     fallback; Doom Thing id 84 (Wolfenstein SS) has no `STATS` entry and
     appears in three shipping levels with no ill effect.

   All three are now warnings, not errors, in `level_validate.js`; the
   original hard/error behavior would have made the validator reject
   currently-working, shipping content. `TRIGGER_INVALID_INDEX` (malformed
   `.i`), `OPEN_POLY` (structurally broken loop), and unresolved `custom:<id>`
   (no engine fallback exists) remain hard errors — nothing in the real
   corpus hits them.
3. **Perf**: `tests/reachability.js`'s `floorMetrics()` allocates a fresh
   `Uint8Array(cells)` per disconnected floor component; on
   `levelPacks/dv/json2.json` (~20k walls, ~23M grid cells at the model's
   `CELL=0.25`) that's ~8 minutes for one level. `analyze()` alone (exit
   reachability) is ~0.9s on the same level — the per-pocket component scan
   is the entire cost. `level_validate.js` avoids this by computing
   reachable/total-free as a single flood + single linear scan instead of
   per-component flooding, and additionally scales the grid cell size up
   (only above a ~4M-cell budget, so every normal-sized level still uses the
   exact same `CELL=0.25` as `check-exits.js`) to keep even the largest map
   under the 2s budget (measured ~0.5–2.5s across runs on `dv/json2`,
   dependent on system load).

## Gates run

| Gate | Result |
|---|---|
| `node --check` over `js/shared/*.js`, `js/editor/*.js`, `tests/check-*.js` | all OK |
| `node --test tests/level-validate.test.mjs` | 16/16 pass |
| `node tests/check-exits.js` | 198/198 (unchanged) |
| `node tests/check-polys.js` | 191/197 (unchanged pre-existing baseline) |
| `node tests/check-floor-coverage.js` | started in background; still running at report time (see perf finding — pre-existing, unrelated to this lane's changes) |
| `node tests/qa-editor.js` | 2 passed, 2 skipped (editor.html not landed yet), 0 failed |

## Not done / left for integration

- `tests/qa-editor.js`'s editor-shell steps (QA-ED-1/2) are SKIP until
  editor-core lands `editor.html` + `window.CyberEditor`; the test
  feature-detects `loadLevel`/`openLevel`/`loadFile` as candidate level-load
  methods and will start asserting for real once one of those (or a similar
  API) exists — may need a one-line update if the actual method name differs.
- `check-floor-coverage.js`'s own multi-minute runtime on the `dv` pack is a
  pre-existing perf issue in `tests/reachability.js`, out of this lane's
  ownership; flagged to team-lead, not fixed here.
