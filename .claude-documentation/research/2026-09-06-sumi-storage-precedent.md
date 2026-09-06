# Sumi community-editor/storage precedent (for Cyberhell level/pack editor)

Source repo: `C:\Dev\Personal\samurai-action-game-repo` ("Sumi — Ink and Steel"). Read-only research; nothing changed there.

## 1. Storage design (README.md lines 23-70)

No database — everything is Vercel **Blob** + **Edge Config**, both free-tier, both auto-linked to the project (`BLOB_READ_WRITE_TOKEN`, `EDGE_CONFIG` injected automatically).

- **Blob** holds every record as its own JSON/binary object at a deterministic path: level payloads, uploaded background images, user records, the username index, magic-link tokens, per-user ratings. Source of truth.
- **Edge Config** holds one key (`levels`) = a small summary array for the browse list. Rebuilt from Blob on every publish/rate (never the source of truth, always disposable/rebuildable). Reads are fast; writes go through the Vercel REST API and are infrequent.

Env vars: `SESSION_SECRET` (signs cookies + hashes emails), `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`, `MAILGUN_API_BASE` (EU override), `APP_URL`, `VERCEL_API_TOKEN` (writes Edge Config; app degrades gracefully without it — falls back to listing Blob directly), `EDGE_CONFIG_ID` (auto-derived from the `EDGE_CONFIG` connection string if unset), `VERCEL_TEAM_ID` (only for team projects), `ADMIN_EMAIL` (fail-closed: unset = nobody is admin).

Local dev: `/api` needs Vercel's runtime, so `npm run dev` → `vercel dev` (serves static game + api on localhost). Plain `python -m http.server` still works for the static game but `/api/*` 404s.

Admin vs. creator mode: `ADMIN_EMAIL` is the only account allowed to edit the shipped campaign in the editor; everyone else gets "creator mode" — build + publish their own level only. Check happens client-side via `isAdmin` from `GET /api/auth/me` (`api/auth/me.js`) and is fail-closed if the env var is unset.

## 2. `api/` — every serverless function

Shared helpers in `api/_lib/`:
- **`http.js`**: `readJson(req)`, `send(res,status,data)`, `methodGuard(req,res,allowed)` — tiny wrappers, no framework.
- **`session.js`**: stateless HMAC session cookie, zero storage. `signSession(payload)` → `base64url(json).base64url(hmac)`; `verifyToken(token)` constant-time compares; `readSession(req)` parses the `sumi_session` cookie; `sessionCookie(payload)` builds the `Set-Cookie` header (`HttpOnly; Secure; SameSite=Lax; Max-Age=30d`); `clearCookie()`.
- **`store.js`**: Blob helpers. `emailHash(email)` = HMAC-SHA256(email, SESSION_SECRET) truncated to 32 hex chars — raw emails never appear in object paths or public blobs. `putJson(pathname, data)` writes at an **exact path**, `addRandomSuffix:false, allowOverwrite:true, cacheControlMaxAge:0` (so overwrites aren't cached stale) — this exact-path convention is what makes concurrent writers safe (each record's path is deterministic, no collisions). `putBinary(pathname, buffer, contentType)` same pattern for images. `urlFor(pathname)` resolves a pathname to its CDN URL via `list({prefix, limit:1})` (Blob has no direct path→URL lookup). `getJson`/`fetchJson`/`listPrefix` (paginated)/`removeByPath`/`exists`.
- **`edge-index.js`**: `readIndex()` reads the `levels` key via `@vercel/edge-config`'s `get()`; returns `null` on failure (signal to fall back to Blob). `buildSummaries(extra=[])` lists every `levels/*/meta.json` blob, fetches them in parallel, merges in an `extra` array (so a just-published item shows before Blob's `list()` catches up — Blob listing is eventually consistent), sorts newest-first. `rebuildIndex(extra)` PATCHes the Edge Config item via the raw Vercel REST API (`https://api.vercel.com/v1/edge-config/{id}/items`) using `VERCEL_API_TOKEN`; no-ops with a console warning if the token or id is missing (never throws — publish/rate still succeeds, just without a fresh index).
- **`mailgun.js`**: `sendMagicLink(email, link)` — plain `fetch` POST to Mailgun's HTTP API, no SDK.
- **`validate.js`**: re-exports the shared validator from `js/shared/level_validate.js` so client and server enforce identical rules; adds `validateTitle`.

Endpoints:

| Path | Method | Auth | Reads/writes | Notes |
|---|---|---|---|---|
| `api/auth/request.js` | POST `{email}` | none | writes `tokens/{token}.json` `{email,exp}`, `tokens/by-email/{hash}.json` `{issuedAt}` (rate-limit marker) | 15 min TTL, 60s resend cooldown per email; emails via Mailgun |
| `api/auth/verify.js` | GET `?token=` | none | reads/deletes the token blob, reads `users/{hash}.json` | one-time use; mints session cookie; redirects to `/?setup=1` (no username yet) or `/?welcome=1` |
| `api/auth/me.js` | GET | session cookie | reads `users/{hash}.json` | returns `{email, username, isAdmin}`; 401 if not signed in |
| `api/auth/username.js` | POST `{username}` | session cookie | reads/writes `usernames/{lower}.json` `{emailHash}` (uniqueness index), reads/writes `users/{hash}.json` `{username, createdAt}` | releases a prior username on change; format validated by shared `validateUsername` |
| `api/auth/logout.js` | POST | none | none | clears cookie |
| `api/levels/index.js` | GET | none | `readIndex()` → falls back to `buildSummaries()` | `Cache-Control: public, max-age=30, stale-while-revalidate=120` |
| `api/levels/publish.js` | POST `{snapshot,title,images}` | session cookie + must have username | writes `levels/{id}/bg/{i}.{ext}` for each data-URI image, `levels/{id}/level.json`, `levels/{id}/meta.json`; calls `rebuildIndex([meta])` | re-runs `validateSnapshot` server-side (never trusts client), decodes `data:` URIs, caps images at 4MB, rewrites relative `assets/...` src to absolute `APP_URL`, id = `slugify(title)-{6 hex}` |
| `api/levels/[id]/index.js` | GET | optional (for `yourRating`) | reads `levels/{id}/meta.json` + `level.json`; best-effort increments `plays` (skipped with `?preview=1`); reads `ratings/{id}/{hash}.json` if signed in | 404s cleanly if meta/snapshot missing |
| `api/levels/[id]/rate.js` | POST `{stars:1-5}` | session cookie | writes `ratings/{id}/{hash}.json` `{stars,ts}` (one object per user = one vote, overwrite to change); lists all `ratings/{id}/*` to recompute exact average; writes updated `meta.json`; `rebuildIndex([updated])` | forces the just-cast vote into the aggregate since `list()` is eventually consistent |

Rate limiting is minimal and Blob-based (one outstanding magic-link token per email per 60s); no general API rate limiting. Validation: `js/shared/level_validate.js` runs on both sides.

## 3. Client session/UI

- **`js/auth/session.js`** (35 lines): `window.SumiSession` — `current()` returns cached user sync; `refresh()` calls `GET /api/auth/me` and caches result (dedupes concurrent calls via `inflight` promise); `get()` returns cache or triggers refresh; `set(user)`; `logout()` POSTs `/api/auth/logout` and clears cache.
- **`js/auth/account_overlay.js`** (157 lines): `window.SumiAccount` — a DOM modal (not canvas — reliable text input/mobile keyboards) with screens: email entry → "check your inbox" → username claim → signed-in/sign-out. `open(opts)` shows the modal in whatever state matches the session. `ensureSignedIn(reason)` returns a Promise that resolves to the user only once they have a username, or `null` if they still need to complete the out-of-page magic-link redirect (caller must abort and ask them to retry — this is the function `publishLevel()` calls). `renderChip()` updates a menu chip (`◈ signed in as X` / `◈ Sign in`). `initFromUrl()` handles the `?setup=1/?welcome=1/?auth=invalid|expired` redirect landing states from `verify.js` and scrubs the query string.

## 4. Editor architecture

- **`editor.html`** + **`js/level_editor.js`** (433 lines) is the whole editor: a `project` object holding `levels` (each a room/level with `world`, `player_start`, `walkable_zones`, `platforms`, `waves`, `route_nodes`, `placed_items`, `background_segments`, `room_layout`, `room_links`), plus `config`, `enemies`, `elements`, `story`, `dialogue`. Two modes: `map` (room boxes + links, drag/connect) and `room` (paint one room's content).
- **`js/editor/paint.js`** (148), **`layers.js`** (50), **`quest_graph.js`** (258): supporting tool modules (not fully read in this pass — grep them directly if wiring layer/quest logic).
- **`js/editor/shell.js`** (112 lines): a **runtime DOM restructuring layer** that turns the existing tool buttons into a Photoshop-style icon rail with click-hold flyouts and a contextual right inspector — without touching `level_editor.js`'s logic or element IDs. Talks to the editor only through `window.ED` (exposed by `level_editor.js`) and a `window.ED.onSync` callback. Worth copying as a *pattern* (decouple shell chrome from editor logic via a small exposed API object) more than as literal code, since it's keyed to Sumi's specific DOM ids.
- **Save/export/import**: `saveDraft()` → `localStorage.setItem('sumiRoomEditorProject', ...)`, auto-restored on load. `exportJSON()` → downloads a `.json` blob of `projectSnapshot()`. `importJSON(file)` → parses and `mergeProject()`s it in. `saveFile()` is Sumi-specific (POSTs to a local `dev_server.py` at `/api/save-project` to write into game source files — only works on `127.0.0.1`/`localhost`; skip this for Cyberhell unless it has an equivalent local dev server).
- **Publish flow** (`js/level_editor.js:376-398`, `publishLevel()`): `SumiAccount.ensureSignedIn(reason)` → prompt for title → build a scoped snapshot (`communityScopedSnapshot()`, not shown here — trims the project down to just the published level's dependency closure) → client-side `window.SumiValidate.validateSnapshot(snap)` gate (blocks on errors, shows warnings) → `collectCommunityImages(snap)` pulls out every `data:` URI background into an `{src, dataUrl}` array → `POST /api/levels/publish` with `{snapshot, title, images}`.
- **How the game loads a community level**: `js/core/config.js:59` `GameData.loadCommunitySnapshot(snap)` — deep-merges `config`/`elements`/`enemies`(with `extends`-chain re-resolution)/`dialogue` into the live game data, merges `levels` in directly, and returns the entry room id (`snap.level_sequence.start` or the first level key). `community_scene.js` calls this after fetching `GET /api/levels/:id`, then calls `game.startNewGame(entry, {skipOpening:true})`.
- **Validation** (`js/shared/level_validate.js`, 106 lines, ESM, imported by both the browser editor and the Node API — genuinely shared, not duplicated): `MAX_SNAPSHOT_BYTES = 2MB`, `validateUsername` (regex `^[a-zA-Z0-9_]{3,20}$`), `slugify`, `platformReachable` (geometry check: a platform must overlap a walkable zone and be within `JUMP_REACH=140` px), `validateSnapshot(snapshot, opts)` → `{ok, errors[], warnings[]}` checking world dims, player_start, non-degenerate depth, non-empty walkable zones, platform reachability, and wave enemies referencing known types.

## 5. `js/engine/scenes/community_scene.js` (170 lines)

Canvas-drawn scene (`CommunityMapsScene`, matches the game's own UI style rather than DOM). `onEnter()` → `load()` → `GET /api/levels`. List navigation (↑/↓/Enter/R to rate/K to refresh). `play(level)` → `GET /api/levels/:id` → `loadCommunitySnapshot` → `startNewGame`. `startRating(level)` gates on `SumiSession.get()`/username via `SumiAccount.open()`, then POSTs `/api/levels/:id/rate` and updates the local row's `ratingAvg/ratingCount/yourRating` from the response (no full reload).

## 6. `vercel.json` + static/API coexistence

Minimal config — no `routes`/`functions` block; Vercel's default zero-config handling serves `/api/*.js` files as serverless functions and everything else as static, driven purely by file location under `/api`. Only customization: `cleanUrls`, `trailingSlash:false`, and two header rules — static assets get `Cache-Control: public, max-age=0, must-revalidate`, `/api/(.*)` gets `Cache-Control: no-store`. `package.json` deps: `@vercel/blob@^0.27.0`, `@vercel/edge-config@^1.4.0`. No mention of Blob store size limits or public/private blob split beyond what's in `store.js` (everything is written `access:'public'`; privacy comes from unguessable hashed/random path segments, not Blob ACLs).

## 7. What to copy verbatim vs. what is Sumi-specific

**Copy near-verbatim** (game-agnostic, small, well-isolated):
- `api/_lib/http.js`, `session.js`, `store.js`, `mailgun.js` — generic Vercel Blob + cookie-session + Mailgun plumbing.
- `api/_lib/edge-index.js`'s pattern: Edge Config as a rebuildable read cache over Blob, never as source of truth, with a `null`-on-failure / Blob-listing fallback.
- The auth endpoint set (`request`/`verify`/`me`/`username`/`logout`) and `account_overlay.js` + `session.js` client pair — magic-link + username claim is fully reusable.
- The Blob path convention: one JSON object per record at a deterministic path (`levels/{id}/meta.json`, `ratings/{id}/{hash}.json`, `usernames/{lower}.json`), `emailHash` to avoid PII in public paths, `addRandomSuffix:false`+`allowOverwrite:true` for overwrite-in-place records.
- `vercel.json`'s zero-config static+api split and the two cache-control header rules.
- The rating aggregation trick in `rate.js` (recompute the full average from listed blobs, then force-override with the just-cast vote to route around Blob list-eventual-consistency).

**Cyberhell-specific rework needed**:
- `js/shared/level_validate.js` — the geometry/schema rules (`platformReachable`, world/player_start/walkable_zone checks) are Sumi's 2.5D room format; Cyberhell needs its own validator with the same client+server-shared-module shape, not this file's content.
- The editor itself (`level_editor.js`, `editor/*.js`, `editor.html`) — architecture pattern (map mode + room mode, `project` snapshot object, `projectSnapshot()`/`exportJSON()`/`importJSON()`/`saveDraft()` localStorage round-trip) is worth mirroring, but the tool set, layers, and data model are Sumi's own and must be redesigned around Cyberhell's level format.
- `community_scene.js` — reuse the request/response contract (`/api/levels`, `/api/levels/:id`, `/api/levels/:id/rate`) and the browse/play/rate flow, but redraw the UI to match Cyberhell (this one is canvas-drawn to match Sumi's paper/ink theme).
- `publishLevel()`'s `communityScopedSnapshot()`/`collectCommunityImages()` — the *shape* (title prompt, client validation gate, collect embedded images, POST) is reusable; the snapshot-trimming and image-collection logic is tied to Sumi's data model.
- `ADMIN_EMAIL`/creator-mode split — reusable concept, but wire it to whatever "official campaign" the game has, if any.
- `saveFile()`'s local `dev_server.py` POST — skip unless Cyberhell has an equivalent local content server.
