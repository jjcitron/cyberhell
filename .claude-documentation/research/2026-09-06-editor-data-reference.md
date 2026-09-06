# Editor data reference — Cyberhell levels, enemies, MIDI

Source: single-file Three.js FPS. Engine in `index.html`, classic scripts in `js/cyber-*.js`,
levels converted from Doom WADs by `convert_all_wads.py` into `levelPacks/<pack>/manifest.json`
+ per-level JSON. Static site, no server logic.

## 1. packs.json and pack manifest.json

`levelPacks/packs.json` — array of pack descriptors:
```json
{ "id": "pack1", "name": "Pack 1 (Doom II)", "manifest": "levelPacks/pack1/manifest.json", "levelCount": 32 }
```
`id`/`name`/`manifest` (path)/`levelCount` (int, informational only — not read for logic).

`levelPacks/<pack>/manifest.json` — array of level descriptors:
```json
{ "id": "json1", "name": "Pack 1 (Doom II) - Level 1 (MAP01)", "file": "levelPacks/pack1/json1.json",
  "sectors": 198, "walls": 854, "entities": 103 }
```
`sectors`/`walls`/`entities` counts are cosmetic metadata, not validated against the file.
`name`'s trailing `(MAP01)`/`(E1M1)` token is load-bearing: `cyber-midi-player.js` parses it via regex
to pick music (see §4) — an editor must keep that token in the name if it changes a level's slot.

Loading (`index.html` around line 3004, `loadPackManifest(manifestUrl, isInitialLoad, preferFile)`):
1. Fetches `manifestUrl`, sets `this.campaign = { packManifestUrl, packName, levels: manifest, index }`.
2. Picks the entry to open: `preferFile` match, else `manifest[0]`; sets `campaign.index` to that entry's array index.
3. Calls `loadLevelFromFile(entry.file, ...)`.
4. On boot, tries `localStorage['cyberhell.lastLevel']` (`{manifest, file}`) to resume where the player left off, else opens `packs[0]`.

`loadLevelFromFile(filePath, notify=true)` (line 4235): fetches the level JSON, calls the main level builder, persists `{manifest: campaign.packManifestUrl, file: filePath}` to `localStorage.cyberhell.lastLevel`, and (if `campaign`) updates `campaign.index` via `campaign.levels.findIndex(l => l.file === filePath)`. Advancing to the next level (`startCampaignLevel`, ~line 4979/4988) just increments `campaign.index` and re-runs `loadLevelFromFile`; running off the end of `campaign.levels` moves to the next pack in `packs.json`.

## 2. Level file schema

Top level keys (all present on every converted level):
```
name, skyColor, fogColor, fogDensity, ambientLight, sunLight, playerSpawn, sectors, walls, triggers, entities
```
- `skyColor`/`fogColor`/`ambientLight`: **decimal ints**, not hex strings (e.g. `526613` = `0x080895`). `sunLight`: `{ color:int, intensity:float, pos:[x,y,z] }`. `fogDensity`: float, ~0.01–0.02 typical.
- `playerSpawn`: `{ pos:[x,y,z], rot:radians }`. Units are Doom map units / 3.2 (converter's `scale`), so 1 engine unit ≈ 32 Doom units. Y is up; X/Z is the ground plane.

**sectors[]** (a Doom sector, floor+ceiling pair over one or more polygon loops):
```json
{ "id":"sec_0", "polys":[[[x,z],...]], "area":133.76, "floorY":0.0, "ceilY":6.4,
  "floorTex":"tech_floor", "ceilTex":"tech_panel", "light":0.56, "isSky":false,
  "x":-6.4, "z":4.8, "width":9.6, "depth":16.0 }
```
- `polys`: array of closed loops of `[x,z]` pairs — the real boundary (outer + any inner holes). This is the collision/rendering authority for converted levels.
- `x/z/width/depth`: an axis-aligned bounding rectangle also stored on every sector; used as a fallback/legacy path (hand-built MAP01 has no `polys`, only rectangles — see `check-polys.js` comment). `resolvedFloors`/`sec.floors` (rectangle lists) are an alternate legacy shape `getFloorAt` also checks.
- `floorY`/`ceilY`: world-space heights (converter units). `light`: 0–1 brightness multiplier, drives lightmap/material intensity. `isSky`: true → ceiling renders as sky instead of a texture. `floorTex`/`ceilTex`: string keys into a texture-family lookup (`tech_floor`, `tech_panel`, etc.) — no free-form texture paths, must be a known family name.
- `_bb` is computed at load time from `polys` (cached bbox for `getFloorAt`) — do not need to author it.

**walls[]** (one per Doom linedef side that has a solid face):
```json
{ "p1":[x,z], "p2":[x,z], "bottomY":0.0, "topY":6.4, "h":6.4, "tex":"cyber_rust", "solid":true }
```
Extended fields added by the converter for interactive geometry:
- `door: true`, `doorId: "door_<tag|idx>"` — sector opens on approach (index.html builds `this.doors[doorId] = wallObj`); doors are never physically sealed even without a working action, so a missing doorId is a soft failure, not a lockout.
- `isSwitch: true`, `switchId: "sw_<tag|idx>"` or the reserved `"sw_exit_game"` — `sw_exit_game` is the only id the engine recognizes as the level-exit trigger (`this.exitWalls = walls.filter(w => w.isSwitch && w.switchId === 'sw_exit_game')`); any other `sw_*` id is wired to `triggers[]` action logic by index.
- `ledge: true`, `hiFloor: <y>` — non-solid wall (`solid:false`) representing a climbable step/ledge rather than a barrier; `hiFloor` is the elevated floor height on the far side. Riser is not solid — `solid` is false for ledges by design; traversal allows walking over it.
- `tex` conventions the converter emits: `door_blast` for doors, `switch_off` for switches — an editor should keep these or supply another known family.

Order matters: `data.walls[i]` corresponds 1:1 with `this.walls[i]` built at runtime (comment in `index.html` ~line 2209) — `CyberTraversal.init(this, data)` relies on that positional pairing to attach trigger behavior, so **do not reorder walls relative to the source data the triggers reference.**

**triggers[]** — indexes into `walls` by array position (`i`) plus the two wall endpoints and an `act` descriptor:
```json
{ "i": 480, "p1":[51.2,-28.8], "p2":[57.6,-28.8],
  "act": { "kind":"lift", "trig":"use", "rep":true, "wait":1.75, "speed":8.0, "secs":[114] } }
```
- `i`: index into `walls[]` this trigger is bound to (the switch/walkover wall).
- `act.kind`: one of `lift | floor | tele | door` (see `convert_all_wads.py` `_lift/_floor/_tele/_door` builders).
  - `lift`: `{kind:'lift', trig, rep, wait, speed, secs:[sectorIndices]}` — raises/lowers listed sectors, waits `wait` seconds, `speed` units/sec.
  - `floor`: `{kind:'floor', trig, rep, to, direction, amt, fast, secs}` — moves floor `to` a target height or by `amt` in `direction`.
  - `tele`: `{kind:'tele', trig, rep}` — teleports the player; destination resolved elsewhere (paired sector/thing).
  - `door`: `{kind:'door', trig, rep, local}` — `local:true` doors are markers only (engine already treats door sectors as always-passable — see §5 "Doors are markers only" comment); non-local ones get a real switch action.
- `trig`: `"use"` (E/switch-activated) | `"walk"` (walkover) | `"gun"` (shoot-activated). `rep`: repeatable boolean.

**entities[]**:
```json
{ "type":"soldier", "enemyType":3004, "pos":[x,y,z], "rot":radians }
```
- `type`: category string (`soldier`, presumably also pickup/decoration types — enemy spawns are the ones with `enemyType`).
- `enemyType`: **Doom Thing type number** (see §3 table) — this is the sole key that selects both stats and mesh builder. No other per-entity override fields observed (no per-instance hp/speed override in the data — all stat variation is central to `cyber-enemies.js`).
- `pos`: `[x,y,z]`, y is spawn height (usually matches local floor). `rot`: radians, 0 = ... (converter maps Doom's angle convention; see `push_out_of_walls` for the position-nudge the converter applies so a spawned entity's radius doesn't intersect a solid wall).

Reader entry points to trace for an editor:
- `index.html` `loadLevel`/level-build routine (buildWall ~line 2558, wall building loop, `spawnEntity`, `getFloorAt` ~line 4158) — these are the fields actually consumed at runtime; anything not read there is inert metadata.
- `js/cyber-traversal.js` — consumes `triggers[]` + the 1:1 `walls` pairing to wire lifts/doors/teleporters.
- `js/cyber-env.js` — reads `sectors`/`entities` post-hoc to place decorative props (crates, pipes, cables, signs) anchored near pickups; purely cosmetic, doesn't affect gameplay validity.

## 3. Enemy definitions — `js/cyber-enemies.js` + `js/cyber-ai.js`

Per-type stat table (`js/cyber-enemies.js` ~line 1254, keyed by Doom Thing type id):
```js
var STATS = {
  3004: { hp:30,  speed:3.5, attack:'hitscan',  range:22, cooldown:1.6, damage:6,  scale:1.0 },  // Zombieman
  9:    { hp:40,  speed:3.4, attack:'hitscan',  range:20, cooldown:1.8, damage:12, scale:1.0 },  // Shotgun Guy
  65:   { hp:70,  speed:3.0, attack:'hitscan',  range:24, cooldown:1.1, damage:9,  scale:1.0 },  // Chaingunner
  3001: { hp:60,  speed:3.6, attack:'fireball', range:20, cooldown:2.2, damage:12, scale:1.0 },  // Imp
  3002: { hp:120, speed:4.6, attack:'melee',    range:2.2, cooldown:1.2, damage:18, scale:1.0 },  // Demon
  58:   { hp:120, speed:5.0, attack:'melee',    range:2.4, cooldown:1.1, damage:16, scale:1.0 },  // Spectre
  3005: { hp:150, speed:3.2, attack:'laser',    range:26, cooldown:1.8, damage:15, scale:1.0, fly:true }, // Cacodemon
  69:   { hp:300, speed:3.4, attack:'fireball', range:24, cooldown:2.0, damage:22, scale:1.0 },  // Hell Knight
  3003: { hp:500, speed:3.2, attack:'fireball', range:26, cooldown:1.8, damage:28, scale:1.25 }, // Baron of Hell
  66:   { hp:220, speed:4.2, attack:'fireball', range:28, cooldown:2.0, damage:20, scale:1.0, fly:true }, // Revenant
  67:   { hp:400, speed:2.4, attack:'fireball', range:22, cooldown:1.6, damage:24, scale:1.0 },  // Mancubus
  68:   { hp:350, speed:3.0, attack:'fireball', range:24, cooldown:1.0, damage:14, scale:1.0 },  // Arachnotron
  64:   { hp:450, speed:3.8, attack:'fireball', range:26, cooldown:2.6, damage:30, scale:1.0 },  // Archvile
  16:   { hp:1000,speed:2.5, attack:'fireball', range:30, cooldown:1.6, damage:40, scale:1.0 },  // Cyberdemon
  7:    { hp:1200,speed:2.5, attack:'hitscan',  range:30, cooldown:0.9, damage:14, scale:1.0 }   // Spider Mastermind
};
var DEFAULT_STATS = { hp:50, speed:3.5, attack:'melee', range:2.5, cooldown:1.6, damage:10, scale:1.0 };
```
Fields: `hp` (int), `speed` (units/s), `attack` (`hitscan|fireball|melee|laser` — selects damage/projectile logic), `range` (engagement distance, units), `cooldown` (seconds between attacks), `damage` (per hit/projectile), `scale` (mesh scale multiplier), `fly` (optional bool — hovers, crosses ledges, ignores floor height but still blocked by walls; only Cacodemon/Revenant use it; the converter never spawns Lost Souls 3006 or Pain Elementals 71).

Mesh selection: `build(typeId, ent, THREE)` looks up `BUILDERS[id]` — one hand-authored per-type mesh-builder function per Doom id (procedural Three.js primitives, not model files) — falling back to `BUILDERS[0]` (a generic humanoid) if `id` is unknown, or `3004` if `ent.type === 'soldier'`. Each builder returns `{ base, ...bodyParts }` and populates an animation-state object `A` (bob/sway/spin/pulse/blink/flame/slide lists, `eyeMeshes`, optional `attackFn` for type-specific attack VFX like the Cyberdemon's rotating chin-guns). `root.userData.enemyTypeId` records the id for later lookups (AI, hit detection).

Roles (`js/cyber-ai.js` ~line 102, `ROLE_BY_ID`) — a second, independent classification layered over stats, driving combat *behavior* (not damage):
```js
skirmisher: Zombieman(3004), Shotgun Guy(9), Chaingunner(65)
caster:     Imp(3001), Cacodemon(3005,fly), Revenant(66,fly), Arachnotron(68), Archvile(64)
rusher:     Demon(3002), Spectre(58)
bruiser:    Hell Knight(69), Baron(3003), Mancubus(67), Cyberdemon(16), Spider Mastermind(7)
```
`ROLE_BAND` table gives each role a `hold` (stand-off distance as a fraction of the type's `range`), `min` (closest allowed approach fraction), `backOff` (bool, gives ground when player closes), `strafes` (bool). Unlisted ids fall back to `roleFor(stats, typeId)` heuristics (melee/low-range → rusher, hp≥300 → bruiser, hitscan → skirmisher, else caster). `PROJ_SPEED = {fireball:12, plasma:16, laser:42}` is a **duplicated** constant mirrored from `PROJECTILE_KINDS` in `index.html` so casters can lead shots — a data-driven editor must keep both in sync or centralize it.

**What would need to be data-driven for an in-game enemy editor**: the `STATS` map (hp/speed/attack/range/cooldown/damage/scale/fly), the `ROLE_BY_ID` mapping (or accept the heuristic fallback), and `PROJ_SPEED` per attack kind. Mesh/color/size are currently baked into per-type builder *functions* (procedural geometry + hardcoded materials/colors), not data — exposing color/size to an editor would require either parameterizing each builder (color overrides, a shared "kit" of primitives) or restricting the editor to reusing existing type ids rather than authoring wholly new visual types. Sounds are not visible in these two files — likely referenced elsewhere (not confirmed in this pass; grep `js/cyber-weapons.js` / index.html audio maps if sound-per-type mapping is needed).

## 4. MIDI — `js/cyber-midi-player.js`

Public API on `CyberMidiPlayer`:
- `attachLevel(file, name)` — called by the engine every time a level's geometry loads. Computes a deterministic `assignmentFor(file, name)` and, if already in `'level'` mode, immediately sets the desired playing track.
- `enterLevel()` — mission-start / "ENTER THE ABYSS" button. Switches `mode` from `'title'` to `'level'`, unlocks audio (must run inside a user gesture), starts the level's lead track. If already in level mode, delegates to `resumeForGame()` (this button is reused as PAUSE menu's RESUME).
- `resumeForGame()` — the sole resume path out of the pause gate; reconciles the sequencer to `desiredIndex` without double-starting.
- `pauseForGame()` — stops the sequencer and suspends the AudioContext (needed to clear the browser tab's speaker indicator).
- `selectTrack(index)` / `stepTrack(delta)` — pause-menu track picker; remembers the player's per-level choice in `this.levelChoice[levelKey]` so RESUME doesn't undo it.
- `armTitleTheme()` — attract-screen theme.

Track list `CYBER_TRACKS` (26 entries) lives inline in the file, each: `{ id:'ch-01', file:'midi/ch-01-ground-zero.mid', title, mood, bpm, signal, map01?:true }`. `.mid` files live at repo-root `midi/*.mid` (referenced as `midi/<name>.mid`, resolved relative to wherever the player is mounted — confirmed present at `./midi/ch-01-ground-zero.mid` etc.).

Level → music resolution (`assignmentFor(file, name)`):
1. `packIdFromFile(file)`: regex-extracts the pack id from the path `levelPacks/<id>/...` (or `'builtin'` for the boot level).
2. `slotFromName(name)`: regex-extracts the trailing `MAP\d\d` or `E\dM\d` token from the manifest entry's display `name` — **this is why manifest level names must retain that token**.
3. Looks up `PACK_RULES[packId]` (style `'map'` or `'episode'`, optional `lead`/`extra` cue, optional `except` slot list withholding lead/extra), then `MAP_SLOT_THEMES`/`EPISODE_SLOT_THEMES[slot]` for the base track(s); falls back to `FALLBACK_THEME = ['ch-01','ch-14']` if nothing matches.
4. `CONTEXTUAL_CUES = ['ch-06','ch-23','ch-24','ch-25','ch-26']` and `TITLE_CUE='ch-19'` are excluded from level auto-assignment (stings/attract theme only, never auto-picked for a level).

Resolution is purely a function of `(file, name)` — deterministic, no state — so a level editor just needs to place new levels under a pack id already in `PACK_RULES` (or add a new pack id + rule) and keep the `MAP##`/`E#M#` token in the name for slot-based music to apply; otherwise it silently gets `FALLBACK_THEME`.

Synth: `new WebAudioTinySynth({ quality:1, useReverb:1 })` from `js/webaudio-tinysynth.js`; playback via `synth.loadMIDI(buf)` (raw SMF bytes fetched from the `.mid` file) then the synth's own sequencer (`locateMIDI`, `stopMIDI`, etc.) — no soundfont assets beyond tinysynth's built-in GM instrument set.

**Clash of Steel's MIDI composer** (`C:\Dev\Personal\weapon-fighting\tools\compose_midi.py`, header only, different game/repo): a dependency-free hand-rolled Standard MIDI File writer (`TPB=480`, writes header+MTrk chunks, varlen deltas, meta/channel events, no external MIDI libs). Outputs to `<repo>/public/audio/midi/`. Composes via a reusable toolkit of section-builders (pad/strum/riff/arpeggio/parallel-fifth harmony, bass-pattern + percussion-pattern players, scale-degree random-walk melody) parameterized per-arena by scale, GM program numbers (0-indexed, named via a `GM` dict), and GM percussion note numbers (`PERC` dict, channel 10) — one toolkit reused across all pieces rather than 13 bespoke scores. Not directly reusable by Cyberhell's player (different repo/game), but the same "toolkit + per-cue parameter table" pattern is the template if Cyberhell ever needs a bulk MIDI-generation tool of its own.

## 5. convert_all_wads.py / patch_exit_switches.py

`convert_all_wads.py` (`convert_wad(wad_filename, pack_id, pack_title)`, ~line 366) walks Doom's linedef/sidedef/sector structures and emits the JSON schema in §2. Key round-tripping notes for an editor:
- `sector_directed_edges` + `chain_loops` reconstruct real polygon boundaries (`polys`) from the WAD's directed linedef graph — required because a hand-edited level must supply loops in the same closed, non-self-intersecting form or `check-polys.js` will fail it (area-vs-`sector.area` mismatch check, overlap check).
- `LINE_SPECIALS` table maps Doom linedef special numbers to `{kind, trig, rep, ...}` action dicts (`_lift`/`_floor`/`_tele`/`_door` builders) — this is the authoritative mapping from Doom semantics to the `triggers[].act` shape in §2; an editor authoring new triggers should reuse these `kind`/`trig`/`rep` vocabularies rather than inventing new ones, since only `js/cyber-traversal.js` implements these four kinds.
- Exit specials: linedef specials `11`/`51` are switch exits, `52`/`124` are walkover exits; `is_switch = is_exit or special in [9,14,18,42,63,103]`. **The engine only ends a level for `switchId === "sw_exit_game"`** — anything else tagged `sw_*` is just a generic switch action, not a working exit. This is why `patch_exit_switches.py` exists (see below) — an editor must ensure exactly one wall carries `switchId: "sw_exit_game"` and `isSwitch: true`, reachable from spawn.
- Doors (`is_door`) get `door:true` + `doorId`; a two-sided linedef with a floor-height delta ≥32 units and no door/switch special becomes a full-height `solid:true` wall (this was the historical bug `check-floor-coverage.js` guards against — sealed-off stairs/lifts).
- `push_out_of_walls(x, z, walls, r=0.6, iters=3)` nudges spawned Thing positions out of any solid wall they'd otherwise spawn inside — an editor placing entities manually should apply the same nudge or entities can spawn stuck in geometry.
- `patch_exit_switches.py` is a post-process, not part of conversion proper: because the raw conversion left 0/197 levels finishable (either the true exit lacked the reserved id, or boss maps have no exit linedef at all — they originally ended on monster death), it re-tags an existing reachable wall (preferring a real exit linedef if walkable, else the reachable wall furthest from spawn by walking distance) as `sw_exit_game`. It invents no new geometry. Run order: `convert_all_wads.py` → `patch_exit_switches.py` → `node tests/check-exits.js` to confirm.

## 6. Level-validating tests (client-side invariants an editor should re-run)

All in `tests/`, run via `node tests/<name>.js [--json]`, all read `levelPacks/packs.json` + each pack's manifest + level JSON directly (no browser needed) via the shared `tests/reachability.js` analyzer:
- **`check-exits.js`**: for every level, can the player walk from `playerSpawn` to a `switchId === "sw_exit_game"` wall? Uses `reachability.js`'s `analyze(level)`. Reports per-pack finishable counts and failure reasons.
- **`check-floor-coverage.js`**: reachable-floor-fraction and pocket-detection. Guards against sealed-off stairs/lifts (the historical ≥32-unit-delta-wall bug). Thresholds: reachable area ≥200 sq units at spawn always; reachable fraction ≥60% unless total floor area is small (<300 sq units) in which case only the exit+area checks apply.
- **`check-polys.js`**: sector polygon integrity — every sector with area has ≥1 closed loop of ≥3 points; chained-loop area matches the converter's independently-computed `sector.area` (within `AREA_TOLERANCE=0.20`); 2000 deterministically-sampled random points per map must land in at most one sector (Doom sectors never overlap in plan).
- **`check-clipping.js`**, **`qa-collision.js`**, **`qa-traversal-sweep.js`**, **`qa-deadend-net.js`**, **`reachability.js`** (shared module, not a standalone check), **`qa-ai.js`**, **`qa-automap-exit.js`**, **`qa-mobile-start.js`**, **`qa-music-pause.js`**, **`perf.js`** — present but not read in this pass; same `node tests/<file>.js` pattern applies. An editor validating a hand-authored or hand-edited level should at minimum re-run `check-exits.js`, `check-floor-coverage.js`, and `check-polys.js` against the new JSON before shipping it, since together they cover reachability, sealed pockets, and malformed polygons — the three defect classes the codebase has already hit once.

## 7. Deployment and corpus size

`vercel.json`: static site only — no `api/` folder, no server functions found. Its one rule is a host-based redirect (`cyberhell-seven.vercel.app/*` → `https://cyberhell.acidlemon.com/*`, non-permanent). Everything else (the whole game, all level JSON, all MIDI) is served as static files.

Level corpus size (file count / on-disk size per pack):
| pack | levels | size |
|---|---|---|
| pack1 (Doom II) | 33 files | 11 MB |
| pack2 (Ultimate Doom) | 37 files | 13 MB |
| pack3 (Final Doom TNT) | 34 files | 4.8 MB |
| pack4 (Final Doom Plutonia) | 28 files | 3.8 MB |
| pack5 (Master Levels) | 33 files | 9.2 MB |
| pack6 (Custom Campaign) | 33 files | 6.5 MB |
| dv (Deus Vult Megamap) | 6 files | 8.8 MB |
| **total** | **204 files** | **57 MB** |

(File counts include each pack's `manifest.json`, so per-pack level counts are one less than shown, matching `packs.json`'s `levelCount` fields.)

## Correction (2026-09-06, validation lane)

Trigger binding is by value, not position: `triggers[].i` is matched against a wall's `.ai`
(action id, present only on interactive walls), see `js/cyber-traversal.js` ~452/467. Wall array
ORDER still matters because sector `fs`/`bs` attachment walks `data.walls` and `engine.walls` in
lockstep by index. `tests/reachability.js` `floorMetrics()` takes ~8 min on `dv/json2` (23M
cells at CELL=0.25); `analyze()` alone is ~0.9 s.

Editor-core lead adds: sector indices appear in four places (`triggers[].act.secs`,
`walls[].act.secs`, `walls[].fs`, `walls[].bs`); the door flag is `isDoor` (+`doorId`, `closed`);
walls also carry `ledge/loFloor/hiFloor/stepUp`, `special`, `tag`, `isExit`, `act`. A trigger
without a wall is normal for walkover lines.
