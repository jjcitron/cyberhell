# Editor lane audit — editor-core

Worktree `C:\Dev\Personal\_wt\ch-editor-core`, branch `editor/editor-core`, commit `680450b`.
Not pushed, not merged.

## What works, verified

Headless Chromium (isolated `playwright-core`, port 5301) drove the whole loop and every step
passed with zero page errors in both the editor and the game:

- `editor.html` boots, registers six tools (select, sector, wall, entity, trigger, spawn) and two
  panels (Properties, Packs).
- Opening `pack1` / `json1` from the canonical repo packs: 198 sectors, 854 walls, 13 triggers,
  103 entities, drawn on the 2D map with sector fills keyed to floor height and sector light,
  walls coloured by door / switch / exit-switch / ledge, trigger badges lettered by kind, entity
  glyphs by type, and the spawn arrow.
- Drawing a four-point sector with real pointer events: sectors 198 → 199, walls 854 → 858 (a
  sector without walls has no collision, so every edge gets one).
- `Ctrl+Z` returns to 198/854, `Ctrl+Y` returns to 199/858 — one undo step per gesture, including
  a whole drag.
- Placing an entity: 103 → 104.
- Save as into a local pack: created `local-my-pack`, level `qa-copy-map01`.
- Full page reload, then reopen from IndexedDB: the level comes back at 199/858. Canonical packs
  still list as `canonical`, the new one as `local`.
- Test in game: the popup lands on `index.html?draft=1`, the game builds 858 runtime walls, the
  overlay title reads the draft's level name and the subtitle is tagged `DRAFT`.

Gates: `node tests/editor-roundtrip.js` → **197/197 levels identical**, index invariants ok.
`node tests/check-exits.js` → **198/198 finishable**, unchanged (no level file was touched).
`node --check` clean on every file in `js/editor/` and `tests/editor-roundtrip.js`.

Screenshots (gitignored) in `prototype_artifacts/_editor_core_*.png`.

## Schema correction — every lane needs this

The research doc `2026-09-06-editor-data-reference.md` §2 says `triggers[].i` is an index into
`walls[]`. **It is not.** `triggers[].i` is a Doom **linedef** id. Checked against
`js/cyber-traversal.js` `init()`: it builds `byLine` keyed on `trigger.i`, then joins each wall
with `byLine.get(wall.ai)`. On `levelPacks/pack1/json1.json` all 13 triggers fail a positional
match against `walls[t.i]`, and trigger ids run up to 937 in a level with 854 walls.

Consequences that are already handled here and that other lanes must respect:

- **Never renumber `trigger.i` when splicing `walls[]`.** Doing so silently rewires every lift,
  door and teleporter. `EdModel.removeWall` leaves trigger ids alone; it only drops a trigger when
  the last wall carrying that `ai` is gone. `splitWall` gives both halves the same `ai`, which is
  what the engine wants (one linedef → one runtime trigger, so a one-shot still fires once).
- **`data.walls[i]` ↔ `engine.walls[i]` IS positional**, so wall *order* still must not be
  shuffled — the runtime objects are found by index.
- **Sector indices shift and live in four places**: `triggers[].act.secs`, the duplicate
  `walls[].act.secs`, `walls[].fs` and `walls[].bs`. `EdModel.removeSector` re-bases all four.
- Wall fields the doc got wrong or missed: the door flag is **`isDoor`** (plus `doorId`,
  `closed`), not `door`. Walls also carry `ledge` / `loFloor` / `hiFloor` / `stepUp`, `special`,
  `tag`, `isExit`, and the duplicate `act`.
- Entities carry `amount` and `name` beyond the doc's list; pickup types in the corpus are
  `soldier`, `monster`, `weapon`, `barrel`, `armor`, `health_stim`, `ammo_bullets`, `ammo_shells`
  (and `ammo_energy` in the engine's pickup builder).
- A trigger with no wall at all is normal, not corruption: `cyber-traversal.js` says walkover
  lines and teleporters emit no wall. `json1` has 1 such trigger out of 13 before any editing.

`js/editor/model.js` carries this in its header comment and `tests/editor-roundtrip.js` asserts
all of it, so a regression fails a gate rather than a playthrough.

## The contract, as implemented

`window.CyberEditor` is built by `js/editor/app.js`, which runs before any other lane's script
tag, so a lane can register immediately at script-eval time.

```
level, pack, packId, levelId, selection {kind,index}, multi[], lastSector, dirty, storage
on(evt, fn) / off(evt, fn) / emit(evt, payload)
    'level-loaded'      {level, packId, levelId}
    'level-changed'     {reason}          -- reason is the undo label, or 'undo:<label>' / 'redo:<label>'
    'selection-changed' {kind, index}
    'pack-changed'      {pack}
apply(mutator, label) -> bool             -- snapshots, runs mutator(level), emits level-changed
select(kind, index)                       -- kind: sector|wall|entity|trigger|spawn|null
registerPanel({id, title, side, mount}) -> element     (tab + body, mount optional)
registerTool({id, title, key, glyph, onActivate, onDeactivate, options(hostEl),
              onPointerDown(e, world, screen), onPointerMove, onPointerUp, onKey(k), draw(ctx, map)})
registerMenu({id, title, items:[{id, label, onClick}]})
worldToScreen(x,z) -> {x,y} · screenToWorld(px,py) -> {x,z} · requestRedraw() · toast(msg, kind)
setTool(id) · showPanel(id) · openLevel(packId, levelId) -> Promise
saveLevel() · saveLevelAs() · saveIntoRepo(packId) · newLevel() · importLevel()
testInGame() · undo() · redo() · deleteSelection() · customEnemies() -> []
map        -- the Map2D instance (view {cx,cz,scale}, grid, snap, show{}, pick, pickVertex, fit)
undoStack  -- EdUndoStack
```

Extras beyond the brief that lanes may want: `EdModel` (pure, also `require()`-able from node),
`EdTools.ENEMY_TYPES / PICKUPS / WEAPON_NAMES / TEX_FLOOR / TEX_WALL`, and
`EdModel.wallsForTrigger(level, tIdx)` / `EdModel.triggerFor(level, wallIdx)` /
`EdModel.nextLineId(level)` for the linedef join.

`StorageAdapter` (`js/editor/storage_local.js`, all async) implements the brief's interface
exactly: `listPacks, getPack, loadLevel, saveLevel, saveLevelAs, createPack, renamePack,
deletePack, reorderLevels, deleteLevel, listEnemies, saveEnemy, deleteEnemy, listMidi, saveMidi,
deleteMidi, exportLevel, importLevelFile, saveIntoRepo`, plus `putDraft` / `getDraft` for the game
bridge. `backend` is `'local'`; the cloud lane can swap `CyberEditor.storage.backend` or replace
the whole instance. Canonical packs come read-only from `fetch('levelPacks/packs.json')`; local
packs and level bodies live in IndexedDB `cyberhell-editor` (stores `drafts, packs, levels,
enemies, midi`).

`editor.html` loads, in order after the core: `js/shared/level_validate.js`,
`js/editor/preview3d.js`, `enemy_editor.js`, `midi_writer.js`, `midi_composer.js`,
`validate_panel.js`, `storage_cloud.js`, `auth_ui.js`. Missing files are a silent no-op.

The `index.html` change is one region inside the master pack loader: a `draft=1` check that reads
the IndexedDB draft, builds it with the same `resetLevelScene` / `loadLevel` / ledge-fixup /
`attachLevel` sequence `loadLevelFromFile` uses, writes the level name into the overlay, and
disables the pack and level selects. Nothing else in `index.html` was touched.

## What is left

- **Sector polygon editing is vertex-level only.** You can drag a vertex of the selected sector,
  but there is no insert-vertex, delete-vertex or hole (inner loop) authoring yet. Drawing a new
  sector produces a single outer loop.
- **Multi-select moves nothing.** Box select and shift-click populate `CyberEditor.multi`, the map
  highlights them and Properties shows the primary, but a drag still moves only the primary
  entity. Delete also acts on the primary only.
- **No validation on save.** That is the validation-qa lane's `level_validate.js`; the Properties
  panel only warns when no `sw_exit_game` wall exists.
- **New geometry is not run through the converter's `push_out_of_walls` nudge**, so an entity
  placed exactly on a wall can spawn stuck. Placement snaps to the grid and takes the sector's
  floorY, nothing more.
- **`saveIntoRepo` writes level files plus a manifest into a picked folder** but does not update
  `levelPacks/packs.json` — that stays a manual edit, and the API is Chromium-only.
- **Undo is full snapshots capped at 40 steps.** A 3 MB level therefore costs real memory; the
  ceiling is marked in `js/editor/undo.js` with the patch-delta upgrade path.
- The Pack panel's prompts use `window.prompt`. Fine headless, ugly in daily use.
