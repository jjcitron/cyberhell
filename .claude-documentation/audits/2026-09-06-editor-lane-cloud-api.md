# Cloud-API lane — Cyberhell level/pack editor

Branch `editor/cloud-api`, worktree `C:\Dev\Personal\_wt\ch-cloud-api`. Not pushed, not merged,
nothing provisioned on Vercel.

## Outcome

The API in the plan's API section is built, runs locally with no cloud account, and is covered by
an end-to-end test. The game boots unchanged when none of it exists.

Gates, all green on this branch:

| Gate | Result |
|---|---|
| `node --check` over `api/**`, `tools/*.mjs`, `js/editor/*.js`, `tests/api.test.mjs` | clean |
| `node --test tests/api.test.mjs` | 14/14 |
| `node tests/check-exits.js` | 198/198 finishable |
| `QA_PORT=8152 node tests/qa-collision.js` | 21/21 |
| `QA_PORT=8153 node tests/qa-mobile-start.js` | ALL PASS |
| `node tools/migrate_levels_to_blob.mjs --dry-run` | 197 levels across 7 packs |
| migrate `--store=fs` then re-run | 32 created, then 32 unchanged (idempotent) |

## What was built

**`api/_lib/store.js`** is the whole design decision: one interface, two implementations, selected
by `DATABASE_URL`. The `fs` backend keeps a single `db.json` plus files under `.editor-data/blob/`
and pulls in no dependencies at all, so the dev server and the test suite run on a clean checkout.
The `blob+neon` backend imports `@vercel/blob` and `@neondatabase/serverless` lazily and applies
`db/schema.sql` on first use, which removes a migration step from the provisioning list. Level
payloads are content-addressed by sha256, so version history costs nothing and a re-save of
unchanged content is a no-op.

**Auth** is Sumi's magic-link flow, lifted nearly verbatim: HMAC-signed stateless session cookie,
emails hashed into opaque user ids so no raw address reaches the store, one outstanding link per
address per 60 seconds, 15-minute one-time tokens. Mailgun is optional — with no API key the link
goes to the server console, which is what the dev server and the tests read. `ADMIN_EMAIL` is the
only admin and it fails closed when unset.

**Endpoints** are exactly the plan's list. Authorization is one helper: admin edits anything, a
creator edits only packs they own, canonical packs are admin-only.

**Response shapes are the existing file formats.** `GET /api/packs` returns `packs.json` shape and
`GET /api/packs/:id` returns `manifest.json` shape with `file` pointing at `/api/levels/:id/json`,
so the game's loader was not touched beyond the pack-list fetch itself. When the store holds no
canonical packs the endpoint serves the static list verbatim; the test asserts byte-equality with
`levelPacks/packs.json`.

**`tools/dev_api_server.mjs`** serves the static repo and routes `/api/*` through the same handler
modules Vercel would run, adapting `req.query` and `res.status`. Port 5305.

**`tools/migrate_levels_to_blob.mjs`** seeds canonical packs from `levelPacks/`, with `--dry-run`,
`--store=fs`, and `--pack=<id>`. Level ids are deterministic (`<pack>__<level>`), so a re-run
updates rather than duplicates, and a level whose payload hash already matches is skipped.

**Client**: `js/editor/storage_cloud.js` implements the StorageAdapter method set against the API
and registers itself on `window.CyberEditor.storage.backends.cloud`; `js/editor/auth_ui.js` is a DOM
sign-in overlay that switches the editor to the cloud backend once `/api/auth/me` answers. Both are
classic scripts that poll or wait for `cybereditor-ready`, so load order with the editor-core lane
does not matter.

## Bugs found and fixed during the round

**Orphan level rows on a rejected payload.** `createLevel` wrote the level row before validating the
JSON, so a malformed level left a level with no version behind and inflated `levelCount`. Caught by
the pack-manifest test counting 3 levels where 2 were expected. Fixed by hoisting shape, size and
validator checks into `prepareLevel`, which now runs before anything is written. The test asserts
the level count is unchanged after a rejected create.

**`package.json` reclassified the whole repo as ESM.** Adding `"type": "module"` for the API
functions turned every `.js` file into an ES module, which broke `tests/qa-mobile-start.js`
(`require is not defined`) and then, more quietly, `tests/check-exits.js`, which went from 198/198
to 0/198 with `Grid is not a constructor` because `require('../js/cyber-traversal.js')` returned an
empty namespace. Fixed with two small scoping files, `tests/package.json` and `js/package.json`,
both `{"type": "commonjs"}`. **Other lanes should know these exist**: any new Node-executed script
under `tests/` is CommonJS, anything under `api/` or `tools/` is ESM.

**A `/api/packs` probe costs a console error on a static host.** The first version probed the API on
every boot, which is a 404 on the QA harness's static server and failed `qa-mobile-start`'s
"no page errors" check. The probe now runs only where an API can exist: `https:` (the Vercel
deployment) or port 5305 (the dev server). A plain static host is never asked for an endpoint it
could not have. The trade-off is that an http deployment other than the dev server would not see
cloud packs; Cyberhell is https in production.

## Deliberate simplifications

- **No sessions table.** Sessions are stateless HMAC cookies, as in Sumi, so only the short-lived
  magic-link tokens are stored. `db/schema.sql` says so where the plan's data model listed one.
- **The `fs` store rewrites one JSON file per mutation with no locking.** Marked with a `ponytail:`
  comment. It is a single-process dev backend; concurrency is the `blob+neon` backend's job.
- **Rate limiting is only the magic-link cooldown.** Every other endpoint requires a session cookie,
  which is the same posture Sumi shipped with.
- **`vercel.json` gained only a `functions` block** (`maxDuration`, `memory`). The `runtime` key was
  deliberately left out: it expects a versioned builder package and setting `nodejs20.x` there
  breaks the build. The existing host redirect is untouched.

## Open dependencies

- `js/shared/level_validate.js` belongs to the validation-qa lane. `api/_lib/validate.js` imports it
  defensively and skips geometry validation when it is absent, so the API works today and tightens
  automatically once that module lands. Only the structural check (sectors/walls arrays, size cap)
  runs right now.
- The editor-core lane owns `window.CyberEditor`. The two client files here attach to whatever it
  exposes (`storage.backends`, `registerPanel`, the `cybereditor-ready` event) and degrade to doing
  nothing if the shapes differ.
- `npm install` was not run; no `node_modules` and no lockfile exist in this worktree. The `fs`
  path needs neither. The two cloud dependencies are declared in `package.json` and Vercel installs
  them at deploy time.

## Files

Owned and added: `api/_lib/{store,session,json,mail,validate,packs}.js`,
`api/auth/{request,verify,me,logout,username}.js`, `api/packs/{index,[id]}.js`,
`api/levels/index.js`, `api/levels/[id]/{index,json,versions}.js`,
`api/enemies/{index,[id]}.js`, `api/midi/{index,[id]}.js`, `api/publish/[packId].js`,
`db/schema.sql`, `tools/{dev_api_server,migrate_levels_to_blob}.mjs`,
`js/editor/{storage_cloud,auth_ui}.js`, `tests/api.test.mjs`, `package.json`, `README.md`.

Shared files touched: `index.html` (the pack-list fetch only), `vercel.json` (added `functions`),
`.gitignore` (`node_modules/`, `.editor-data/`, `.vercel/`, `.env*.local`), and the two
`{"type":"commonjs"}` scoping files noted above.
