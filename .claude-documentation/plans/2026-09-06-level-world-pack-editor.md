# Cyberhell — Level + World/Pack Editor

Requested by Joel 2026-09-05: "a level+ world/pack editor for cyber hell. edit + save as existing
levels, create net new, compose and add midi, create and edit enemies. full featured. will be a key
game feature and needed to manually fix and tweak the generated levels. we will need to have
storage and a db for this in vercel and we should move original level sets to blob storage too
(while keeping originals in repo for reference)."

Research: `.claude-documentation/research/2026-09-06-editor-data-reference.md` (level/pack/enemy/
MIDI schema, validators) and `2026-09-06-sumi-storage-precedent.md` (Sumi's Blob + magic-link
stack to lift).

## Decisions

- **Editor is a second page in the same static site**: `editor.html` + `js/editor/*.js` classic
  scripts, vendored `js/three.min.js` and `js/webaudio-tinysynth.js` reused. No bundler, no new
  client dependencies. A 2D top-down map is the primary surface (sector polygons, walls, entities,
  triggers), with a live Three.js 3D preview panel and a one-click **Test in game** that opens
  `index.html` on the draft.
- **Level JSON stays the engine's format** (see the data reference). The editor adds only optional
  keys the engine learns to read: `music` (explicit cue override), `customEnemies` (per-level or
  per-pack enemy definitions), `meta` (id, createdBy, version, notes). `walls[i]` ↔ `triggers[].i`
  positional pairing is preserved by construction (the editor keeps triggers attached to wall
  objects and re-indexes on export).
- **Enemies become data**: `js/cyber-enemies.js` STATS stay the base table; every builder takes a
  `look` object (colours, scale, part toggles, emissive) whose defaults are today's hard-coded
  values, so existing enemies render byte-identically. A custom enemy is `{ base: <thing id>,
  stats: {...overrides}, look: {...}, role: <cyber-ai role> }` referenced by
  `entities[].enemyType = "custom:<id>"`.
- **Music becomes assignable**: `js/cyber-midi-player.js` honours `level.music = { file | url,
  name }` before its pack/map heuristic. MIDI files can be authored in-editor (a dependency-free SMF
  writer in JS, ported from the pattern in Clash of Steel's `tools/compose_midi.py`, with a
  step-sequencer/piano-roll UI and GM instruments, previewed through tinysynth) or uploaded.
- **Storage**: a client `StorageAdapter` with two backends. `local`: IndexedDB drafts + JSON
  export/import + File System Access API "save into repo" for Joel's desktop. `cloud`: `api/*`
  serverless functions. Server side: **Vercel Blob** for payloads (level JSON by content hash, MIDI
  files, the migrated original level sets under `canonical/<pack>/<file>`), **Neon Postgres**
  (Vercel Marketplace) for metadata (users, sessions, packs, levels, level_versions, enemies,
  midi_tracks, publish state). The API also runs against a filesystem backend
  (`tools/dev_api_server.mjs`, `.editor-data/`) so everything is testable before provisioning.
- **Auth**: Sumi's magic-link + HMAC session cookie lifted from `api/_lib`. `ADMIN_EMAIL` (Joel)
  edits canonical packs; other accounts get creator mode (own packs only). Fail closed.
- **Game loading**: `index.html` boot fetches `/api/packs` when the API answers and falls back to
  the static `levelPacks/packs.json` otherwise, so the repo copies stay the reference and the game
  keeps working with no cloud at all.
- **Provisioning is Joel's call**: Blob store + `vercel integration add neon` need his account and
  the Vercel CLI (not installed). The round builds and tests everything on the filesystem backend
  and stops with exact steps.

## Data model (Neon)

```
users(id, email_hash, username, is_admin, created_at)
sessions(token_hash, user_id, expires_at)             -- magic-link tokens + sessions
packs(id, slug, name, owner_id, is_canonical, published, sort, created_at, updated_at)
levels(id, pack_id, slug, name, sort, current_version_id, created_at, updated_at)
level_versions(id, level_id, blob_url, sha256, bytes, sectors, walls, entities, author_id, note, created_at)
enemies(id, owner_id, pack_id NULL, name, base_type, def JSONB, updated_at)
midi_tracks(id, owner_id, pack_id NULL, name, blob_url, bytes, bpm, updated_at)
```

Blob layout: `canonical/<pack>/<file>.json` (migrated originals), `levels/<sha256>.json`,
`midi/<id>.mid`. Public access for game assets; private for nothing (no PII in payloads).

## API (all JSON, `api/*.js`, Node runtime, storage behind `api/_lib/store.js` with `blob+neon`
and `fs` implementations)

```
POST /api/auth/request  {email}          -> magic link (Mailgun; fs backend prints the link)
GET  /api/auth/verify?token=             -> sets session cookie
GET  /api/auth/me · POST /api/auth/logout · POST /api/auth/username
GET  /api/packs                          -> canonical + published packs (game boot shape = packs.json)
GET  /api/packs/:id                      -> manifest shape + levels
POST /api/packs  · PATCH /api/packs/:id  · DELETE (owner/admin)
GET  /api/levels/:id  · GET /api/levels/:id/versions
POST /api/levels        {packId, name, json}   -> new level (validates, stores version)
PUT  /api/levels/:id    {json, note}           -> new version (save); ?as=new for save-as
POST /api/enemies · PUT /api/enemies/:id · GET /api/enemies?packId=
POST /api/midi (multipart or base64) · GET /api/midi?packId=
POST /api/publish/:packId
```

Validation shared by browser and API: `js/shared/level_validate.js` (ported from
`tests/check-polys.js`, `check-floor-coverage.js`, `check-exits.js`: closed non-self-intersecting
polys, no sealed pockets, exit reachable from spawn, one `sw_exit_game`, trigger/wall pairing).

## Fleet (worktrees `C:\Dev\Personal\_wt\ch-<lane>`, branches `editor/<lane>`)

| Lane | Model | Owns | Delivers |
|---|---|---|---|
| editor-core | Opus | `editor.html`, `js/editor/{app,map2d,tools,model,undo,panels,storage_local,bridge}.js`, `css/editor.css`, `index.html` **editor-bridge region only** (load a draft from IndexedDB/`?draft=` at boot) | 2D map editor: pan/zoom/grid/snap, select/move/insert/delete vertices, draw sector polygons with floor/ceil/light/tex, wall tool with door/switch/ledge flags and exit switch, entity placement with type picker, trigger editor (lift/floor/tele/door, use/walk/gun), player spawn, level properties (sky/fog/ambient/sun); undo/redo; round-trip import/export of any existing level with zero diff on untouched fields; pack manager (new pack, order, rename, save, save-as, duplicate, delete) on the local backend; Test in game |
| preview-3d | Sonnet | `js/editor/preview3d.js` | Three.js panel: floors/ceilings from polys (ShapeGeometry with holes), walls, doors, entity markers, fly camera, click-to-select synced with the 2D map, live updates on edit |
| enemy-editor | Opus | `js/cyber-enemies.js`, `js/cyber-ai.js` (role lookup for custom ids), `js/editor/enemy_editor.js`, `index.html` **createEnemy custom-resolution region only** | `look` parameterisation of every builder with byte-identical defaults; STATS/role/look editable; custom enemy defs (`customEnemies` in level and pack JSON, `custom:<id>` references) resolved by the engine; enemy editor panel with live mesh preview, stat sliders, colour pickers, role picker, duplicate-from-base, test-spawn in the 3D preview |
| midi-composer | Opus | `js/editor/midi_writer.js`, `js/editor/midi_composer.js`, `js/cyber-midi-player.js` (music override + custom track list) | SMF type-1 writer; composer UI: tempo, 4-8 tracks with GM program, piano-roll/step grid, patterns and song order, regional/genre presets in the spirit of Clash of Steel's `compose_midi.py`; play/stop through tinysynth; export .mid; assign to level/pack (`music` key); upload existing .mid |
| cloud-api | Opus | `api/**`, `package.json`, `tools/dev_api_server.mjs`, `tools/migrate_levels_to_blob.mjs`, `db/schema.sql`, `js/editor/storage_cloud.js`, `js/editor/auth_ui.js`, `index.html` **boot packs fetch region only** (`/api/packs` with static fallback), `vercel.json` (functions config only) | The API above on `api/_lib/store.js` with `fs` and `blob+neon` implementations; magic-link auth lifted from Sumi; migration script (dry-run on fs backend); game boot from API with fallback; cloud backend in the editor's StorageAdapter; README section with the exact provisioning steps |
| validation-qa | Sonnet | `js/shared/level_validate.js`, `js/editor/validate_panel.js`, `tests/qa-editor.js`, `tests/api.test.mjs`, `tests/check-*.js` (only to import the shared module) | Shared validator; editor Validate panel with clickable findings; playwright test: new level → draw → save → Test in game boots and reaches the exit; API tests against the fs dev server; all existing tests still green |

Rules: leads build directly; prefix every shell command with `cd <own worktree> &&` (the shell cwd is
shared across agents); private ports 5301-5306; kill servers by PID; no client dependencies; server
dependencies limited to `@vercel/blob` and `@neondatabase/serverless`; never touch a WAD or
`levelPacks/**` contents; commit trailers as usual; do not push.

## Gates

`node --check` over `js/**`, `api/**`, `tools/*.mjs`; `node tests/check-exits.js` 198/198;
`QA_PORT=8152 node tests/qa-collision.js` 21/21; `QA_PORT=8153 node tests/qa-mobile-start.js`;
new `tests/qa-editor.js` and `tests/api.test.mjs`; a full round-trip of every canonical level
through the editor model yields identical JSON.

## Sequence

1. Plan + research (done). 2. Six lanes, 45 min. 3. Merge, gates, integration fixes.
4. Fresh-context evaluator uses the editor end to end (create pack, edit a converted level, custom
   enemy, MIDI, save-as, test in game) and grades it. 5. Push `main`, Vercel READY.
6. Stop: ask Joel to provision Blob + Neon; then run the migration and flip the game boot to the API.

## Status log

- 2026-09-06 05:10 EDT — all six lanes merged on `master` (df043dd): editor shell + 2D map + local
  storage + test-in-game (197/197 zero-diff round trip, field census gate), 3D preview (one
  InstancedMesh for 20k walls), enemy editor (15/15 rigs byte-identical under the look layer,
  custom enemies resolved by the engine), MIDI composer (SMF writer/reader, 5 presets, level.music
  override, cue table unchanged for all 197 levels), validator (198/198 canonical clean, 16 unit
  tests), cloud API on fs + blob/neon stores (14/14 API tests, migration dry-run idempotent).
  Integration fixes: fs store writes under /tmp on Vercel; static pack list fetched from the
  deployment origin when not bundled. Open: editor-core pass 2 (vertex insert/delete, holes,
  multi-drag, entity nudge, packs.json in save-into-repo, panel visibility bug), validation pass 2
  (e2e against the real shell). Provisioning of Blob + Neon awaits Joel.
