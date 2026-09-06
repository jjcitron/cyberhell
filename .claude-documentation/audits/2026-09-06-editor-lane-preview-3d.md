# Editor lane audit — preview-3d (2026-09-06)

## Scope

Owned file: `js/editor/preview3d.js`. Registers a `preview3d` panel on `window.CyberEditor`
and renders the live level JSON in its own `THREE.Scene`, matching `index.html`'s
floor/wall construction closely enough to look right, without touching the game's globals
or classes. Also added `tests/preview3d-harness.html` (standalone test page with a stub
`CyberEditor`) and `tests/preview3d-qa.mjs` (headless Chromium driver, not part of the repo's
node test suite — ad hoc, run manually).

`editor.html`/the rest of `js/editor/*` do not exist yet in this worktree (editor-core lane
runs in parallel) — the harness stubs the contract instead.

## What was built

- **Geometry**: floors/ceilings built per-sector from `sec.polys` via `THREE.ShapeGeometry`
  with holes (ported `shapesFromPolys` from `index.html`'s `CyberDoomEngine`, same
  ring-containment/parity-hole logic, same `(x,-z)` + `rotation.x = -PI/2` transform so
  world coordinates land exactly where the game puts them). Walls are quads built the same
  way `buildWall` does (length/angle/center from `p1`/`p2`, height from `bottomY`/`topY`/`h`).
- **Walls as one InstancedMesh**: all walls (up to 20,461 on the biggest level) go into a
  single `THREE.InstancedMesh`, one draw call, per-instance color via `setColorAt`. Doors
  tint toward cyan, switches toward yellow, everything else colored by texture family.
  Click-to-select uses the raycast `instanceId` directly.
- **Textures**: flat colors by texture-family substring match (`tech_floor`, `toxic_ooze`,
  `door_blast`, etc.), hash-color fallback for unknown names. `js/cyber-env.js`'s
  `TextureFactory` is canvas-painting logic tightly coupled to `index.html`'s engine class,
  not callable standalone — ponytail: flat colors now, port `TextureFactory` into a shared
  module later if the preview needs texture-level fidelity.
- **Entities**: billboarded `THREE.Sprite`s (billboarding is free — Sprites always face the
  camera), red circle for anything with `enemyType` set, green for everything else (pickups).
  Two cached `SpriteMaterial`s total, reused across every entity.
- **Player spawn**: `THREE.ArrowHelper`, blue, at `playerSpawn.pos`, oriented from `rot`
  (approximate — exact Doom-angle convention lives in the WAD converter, not needed for an
  at-a-glance facing indicator).
- **Lighting/atmosphere**: hemisphere + directional light from `ambientLight`/`sunLight`,
  `FogExp2` from `fogColor`/`fogDensity`, `scene.background` from `skyColor`. Fog is stashed
  as `state.levelFog` and only applied to `scene.fog` in perspective mode — a top-down ortho
  camera 500 units up reads ground-level fog density as a near-solid wall of fog otherwise
  (found and fixed during QA, see below).
- **Cameras**: perspective fly camera (WASD relative to look direction, right-drag to look,
  Q/E up/down, Shift = 4x speed) and an orthographic top-down toggle sized to the level's
  bounding box. "Jump to spawn" and "Frame selection" buttons. A brand-new level load
  (`level-loaded`) auto-frames the camera at spawn (or the whole map from an angle if there's
  no spawn); an incremental edit (`level-changed`) never moves the camera, so editing doesn't
  yank the view around.
- **Selection**: click-to-select raycasts against the wall InstancedMesh, sector meshes, and
  entity sprites, and calls `CyberEditor.select(kind, index)`. The current selection is
  drawn as a yellow wireframe outline (`LineLoop` around a sector's polygon, an `EdgesGeometry`
  box around a wall, a ring around an entity) in a dedicated `highlightGroup`, rebuilt on
  `selection-changed`.
- **Incremental rebuild**: `level-changed` is debounced 60ms then does a full rebuild
  (disposing old geometry/materials first); `level-loaded` rebuilds immediately. Sector
  floor/ceiling materials are cached by `(tex, side)` and shared across every sector using
  that texture — a megamap has thousands of sectors but only a handful of distinct textures,
  so this cuts material allocation from ~4,450 objects to a handful on the biggest level.
  Floor and ceiling share one `ShapeGeometry` per sector (rotation/position live on the mesh,
  not baked into vertex data) instead of cloning, halving geometry allocation.

## Bugs found and fixed during self-QA (not just "it ran")

1. **Blank default view.** The panel's default camera position had no relationship to the
   loaded level, so the very first render was empty/black until the user clicked "Jump to
   spawn." Fixed by auto-framing on `level-loaded` (see above). Confirmed via screenshot
   before/after — click-to-select also silently failed before this fix, since the camera
   wasn't looking at any geometry to raycast against.
2. **Top-down view washed out by fog.** `scene.fog` was always applied from level data; an
   orthographic camera 500 units above the map renders ground-level `FogExp2` density as a
   near-solid haze, making the whole top-down view nearly black. Fixed by keeping the level's
   fog as `state.levelFog` and only assigning it to `scene.fog` in perspective mode (see
   `setOrtho`). Confirmed via screenshot: the Deus Vult megamap top-down went from a
   barely-visible silhouette to a fully legible layout (city skyline, rooms, entity dots,
   spawn marker all readable).
3. **Test-driver false negative (not a preview3d.js bug).** My first QA pass reported two
   rebuilds as "never happened" (20s timeouts) and one frame as solid white. Root cause was
   in `tests/preview3d-qa.mjs`/environment, not the panel: (a) attaching a
   `window.addEventListener('preview3d-rebuilt', ...)` *after* clicking a button races the
   panel's 60ms debounce and can miss the event entirely — fixed by having the harness push
   every rebuild event onto a `window.__previewEvents` array from a listener registered at
   page load, and polling that array's length instead of racing a fresh listener; (b) a
   screenshot taken 300ms after a fresh headless-Chromium/swiftshader page load can be
   full-white even though the WebGL context is already rendering correctly — confirmed by
   reading a pixel back directly via `gl.readPixels()` (got the correct dark background
   color) while `page.screenshot()` at the same instant showed white; the same shot taken
   ~2.5s later matched the direct pixel readback. Fixed by giving the driver longer settle
   times, not by changing the panel.

## Numbers (see `prototype_artifacts/_preview3d_*.png`, six screenshots reviewed)

| level | sectors | walls | entities | rebuild time |
|---|---|---|---|---|
| pack1/json1 (small) | 198 | 854 | 103 | 18-45ms (jitter across runs) |
| pack1/json1, incremental edit (`level-changed`) | 198 | 854 | 103 | 9-26ms |
| dv/json2 (biggest level in the corpus) | 2,229 | 20,461 | 4,681 | 137-315ms across repeated runs, median ~180ms |

The plan's "under 150ms for a 20k-wall rebuild" target is met on faster runs and missed by
up to ~2x on slower ones, all measured in headless Chromium on the `--use-gl=swiftshader`
software renderer used for this sandboxed test — real GPU rendering (and a real browser
window) should do noticeably better. No further optimization attempted given the round's
time budget; the material-cache and shared-geometry changes above already roughly halved
the initial ~300ms baseline. Remaining cost is dominated by ~4,450 individual sector
floor/ceiling `Mesh` objects (unavoidable while keeping per-sector click-to-select — see
ponytail note below) plus `ShapeGeometry` triangulation itself.

`ponytail:` per-sector floor/ceiling meshes are not batched/instanced, unlike walls — batching
would sacrifice the ability to raycast-select an individual sector. Upgrade path if a bigger
level ever needs it: batch sectors above some size threshold into merged geometry keyed by
texture (losing click-select on batched sectors only), or maintain a separate lightweight
picking structure (e.g. a 2D point-in-polygon lookup from the raycast's XZ hit) instead of
one Mesh per sector.

`ponytail:` texture families are flat colors by name substring match, not the game's
canvas-painted `TextureFactory`. Upgrade path: extract `TextureFactory` from `index.html`
into a module both files import, if the preview ever needs 1:1 texture fidelity.

## Gates run

- `node --check js/editor/preview3d.js` — clean.
- Headless Chromium (isolated instance via `playwright-core`, `--use-gl=swiftshader`) against
  `tests/preview3d-harness.html`: zero page errors, zero failed requests, across the full
  small-level → click-select → top-down → jump-to-spawn → incremental-edit → biggest-level →
  top-down sequence, on the final run after the two bug fixes above.
- Did not run `node tests/check-exits.js` etc. — out of this lane's scope (no level data was
  touched; `levelPacks/**` is read-only from this file).

## Files

- `js/editor/preview3d.js` (owned, new)
- `tests/preview3d-harness.html` (new, standalone test page — not part of the shared editor
  shell, which doesn't exist yet in this worktree)
- `tests/preview3d-qa.mjs` (new, ad hoc headless QA driver — not part of the repo's node test
  suite, no npm dependency of its own; run manually with a `python -m http.server 5302`
  pointed at the worktree root)
- `prototype_artifacts/_preview3d_*.png` (six screenshots from the final QA pass)

## Integration notes for editor-core

- `CyberEditor.registerPanel({id, title, side, mount(el)})` is called exactly once, and this
  file handles both plausible return contracts (a synchronous `mount` call during
  `registerPanel`, or the panel being returned and mounted later) defensively.
- Only reads `CyberEditor.level`, `CyberEditor.selection`, `.on()`, `.select()` — never
  mutates level JSON, never touches `window` outside its own `__cyberPreview3D*` namespace
  and a `preview3d-rebuilt` CustomEvent on `window` (for tests/telemetry to hook into rebuild
  timing without reaching into internals).
- `selection.kind` values consumed: `'sector' | 'wall' | 'entity'`. If editor-core's selection
  model uses different kind strings, `updateHighlight()`/click-to-select need matching names.
