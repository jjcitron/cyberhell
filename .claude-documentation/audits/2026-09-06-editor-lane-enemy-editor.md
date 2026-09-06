# Editor round — enemy-editor lane

Worktree `C:\Dev\Personal\_wt\ch-enemy-editor`, branch `editor/enemy-editor`, 2026-09-06.
Scope from `.claude-documentation/plans/2026-09-06-level-world-pack-editor.md` ("Enemies become data").

## Outcome

All three deliverables are in and verified in a headless browser: the 15 stock rigs are
provably unchanged, a custom enemy defined in level JSON spawns in the real engine with its
overridden stats, colours, scale and AI role, and the editor panel edits and saves one.

## 1. `look` parameterisation

Builders were **not** rewritten. Their hard-coded colours stay where they are; the material
factories they already call (`M`/`metal`/`rough`/`flesh`/`rubber`/`E`, and the `vgrad` vertex
gradient) now assign every distinct `(kind, colour)` pair a slot name — `flesh1`, `metal3`,
`glow2`, `grad5` — while a build is running under `buildMesh()`. A `look` recolours a slot,
hides the meshes wearing it, scales the rig, or scales emissive intensity. Under the engine's
own `build()` no slot machinery is active and the factories run exactly the code they ran
before, which is why the parity proof is not a near-miss but an identity.

That choice is the one real trade: slots are derived from materials, not hand-named per body
part, so two parts sharing a colour share a knob. It buys a ~120-line diff instead of fifteen
rewritten builders, and a per-type name table can be layered on later without changing the
format. A `ponytail:` comment in `js/cyber-enemies.js` records it.

Exports on `window.CyberEnemies`: `buildMesh(id, look, ent, THREE)`, `getDefaultLook(id, THREE)`,
`listTypes()`, `roleOf(id)`, `registerCustom(...)`, `customDefs()`, `clearCustom()`, `isCustom()`,
plus `STATS`, `NAMES`, `DEFAULT_STATS`.

Two gaps the tests found and the code now closes:

- `vgrad()` whites out a mesh's material and bakes the gradient into vertex colours, so the
  material's slot rendered nowhere. Gradient endpoints are now slots of their own, and
  `getDefaultLook()` drops any slot no mesh actually wears — the panel never shows a colour
  picker that does nothing.
- The parity summary originally compared geometry parameters only, which called two different
  gradients identical. It now hashes the vertex-colour attribute too.

## 2. Custom enemy defs

`{ id, name, base, stats, look, role }` stored as `customEnemies: { id: def }` on a level and on
a pack; entities reference `enemyType: "custom:<id>"`. `CyberEnemies.stats()` merges the def's
overrides over the base's stat line; `build()` resolves the base builder plus the look, keeps
`userData.enemyTypeId` at the base thing id so LOD, hit flash and the walk cycle are unaffected,
and records `userData.customEnemyId`. `stats.scale` scales the rig relative to its base's own
scale. Roles register into `CyberAI.setRole()`, a new string-keyed override consulted ahead of
`ROLE_BY_ID`. An unregistered id warns once and builds the generic body.

Engine side, `index.html`'s `createEnemy` gained one region: it registers the pack table then the
level table (level wins) before building. Registration is idempotent and the tables hold a
handful of entries, so it lives there rather than threading a hook through `loadLevel`.

## 3. Enemy editor panel

`js/editor/enemy_editor.js` waits for `window.CyberEditor` (poll plus `cybereditor-ready`) and
registers one right-side panel: a picker over custom defs and all 15 base types, New from base,
name/role/attack/flies, slider-plus-number for every stat, mesh scale and glow multipliers, a
colour picker and visibility checkbox per look slot, Reset look, Save / Delete / Export / Import,
and "Use for selected" which writes `custom:<id>` onto the shell's selected entity. Saves and
deletes go through `CyberEditor.apply()` so the shell's undo owns them. The preview is its own
small `WebGLRenderer` on a turntable, driven through `CyberEnemies.animate()`, rebuilt whenever a
field changes.

The shell's selection API was not specified, so `selectedEntity()` probes
`getSelectedEntity()`, `selectedEntity`, and `selection` (object, `{entity}`, or array) and
toasts if it finds nothing. If the shell settles on something else, that one function changes.

## Verification

| Gate | Result |
|---|---|
| `node tests/qa-enemy-look.js` (port 5303) | 15/15 rigs identical, 17 checks pass |
| `node tests/qa-custom-enemy.js` (port 5304) | 13 checks pass on real pack-1 level 1 |
| `QA_PORT=8152 node tests/qa-collision.js` | 21/21 |
| `node --check` over `js/**`, both test scripts | clean |

`tests/qa-enemy-look.js` compares, per type, a full render summary of `build(id)` against
`buildMesh(id, null)` — node tree, transforms, visibility, shadow flags, geometry parameters,
vertex-colour hash, and material colour/emissive/intensity/metalness/roughness/opacity. All 15
hash identical. It then proves each look control bites (recolour, hide, scale, emissive x2),
sweeps every exposed slot on three types asserting none is a dead control, and drives the panel
against `tests/enemy-editor-harness.html` (a stub `CyberEditor`) through an edit, a Save, and a
Use-for-selected.

`tests/qa-custom-enemy.js` boots the real `index.html`, injects a `customEnemies` block into
pack-1 level 1, and asserts the spawned enemy carries hp 777 / speed 9 over the Imp's untouched
damage and range, renders 17 magenta meshes at scale 1.4, keeps thing id 3001, registers the
`rusher` role, honours a pack-level def, lets the level's def beat the pack's for the same id,
and survives an entity pointing at an id nobody defined.

Screenshots: `prototype_artifacts/_enemy_editor_panel.png` (Spider Mastermind preview),
`_enemy_editor_saved.png` (recoloured slot, def written to the level, log of the apply/toast
calls), `_enemy_editor_ingame.png` (clean engine boot).

## Not done / handoff

- The editor shell is another lane's; the panel is only exercised against the stub harness. The
  first integration item is the selection API named above.
- Slot names are generated (`metal2`), not human names (`pauldron`). Per-type name tables would
  drop into `getDefaultLook` without a format change.
- Custom enemies inherit their base's sounds and attack VFX; `attack` is editable as a stat but
  no new projectile kinds were added, and `PROJ_SPEED` in `js/cyber-ai.js` remains the mirrored
  copy the research doc flagged.
- Pack-level defs are read from `engine.campaign.customEnemies`. Today's pack manifest is a bare
  array, so nothing writes that yet — the cloud-api / editor-core lanes own the manifest shape.
