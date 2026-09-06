# Cyberhell

A static Three.js FPS. `index.html` is the whole game; `js/` holds the engine modules, `levelPacks/`
the converted level sets, `midi/` the music, `tests/` the QA harnesses. It deploys to Vercel with no
build step.

## Editor storage

The level/pack editor can run entirely in the browser (local drafts) or against a small API in
`api/`. **None of it is required for the game.** With nothing provisioned, `index.html` boots from
`levelPacks/packs.json` exactly as it always has, and the editor uses its local backend.

### How the pieces fit

| Piece | Where | Notes |
|---|---|---|
| Metadata | Neon Postgres (`db/schema.sql`) | users, packs, levels, versions, enemies, MIDI tracks |
| Payloads | Vercel Blob | level JSON by content hash, `.mid` files, migrated originals under `canonical/<pack>/` |
| Sessions | HMAC cookie, no storage | `SESSION_SECRET` signs it; magic links are the only sign-in |
| Local backend | `.editor-data/` | same API, no cloud, no `node_modules` |

`api/_lib/store.js` picks the backend from the environment: `blob+neon` when `DATABASE_URL` is set,
`fs` otherwise. Every endpoint is written against the one interface, so what you test locally is
what runs in production.

### Running it locally

```bash
node tools/dev_api_server.mjs          # http://localhost:5305, static game + /api/*
node --test tests/api.test.mjs         # end-to-end: auth, packs, levels, versions, publish
```

The dev server uses the `fs` store and **prints magic links to its console** instead of emailing
them. Paste the printed URL into the browser to sign in. `ADMIN_EMAIL=you@example.com` makes that
account an admin.

### Provisioning on Vercel

Everything below needs Joel's Vercel account; nothing here has been provisioned.

```bash
npm i -g vercel
vercel link                                  # pick the existing cyberhell project

# 1. Blob store for the payloads (or create one in the dashboard under Storage).
vercel blob store add cyberhell-levels       # injects BLOB_READ_WRITE_TOKEN

# 2. Neon Postgres for the metadata.
vercel integration add neon                  # injects DATABASE_URL

# 3. The secrets the API needs. SESSION_SECRET must be random and must never change
#    afterwards -- rotating it signs everyone out and orphans their email hashes.
vercel env add SESSION_SECRET production     # e.g. openssl rand -hex 32
vercel env add ADMIN_EMAIL production        # the one account allowed to edit canonical packs
vercel env add APP_URL production            # https://cyberhell.acidlemon.com

# 4. Optional: real magic-link emails. Without these the link is only logged, which is fine
#    for a single-admin setup but means nobody else can sign in.
vercel env add MAILGUN_API_KEY production
vercel env add MAILGUN_DOMAIN production
vercel env add MAILGUN_FROM production
# vercel env add MAILGUN_API_BASE production  # https://api.eu.mailgun.net for EU accounts

# 5. Pull them locally, seed the store from the repo's level sets, redeploy.
vercel env pull .env.local
node tools/migrate_levels_to_blob.mjs --dry-run    # report only
node tools/migrate_levels_to_blob.mjs              # 197 levels across 7 packs
vercel deploy --prod
```

The schema in `db/schema.sql` applies itself on the first request; there is no separate migration
step. Every statement is `IF NOT EXISTS`, so re-running is safe.

### What happens with none of it set

- The game boots from `levelPacks/packs.json`. It probes `/api/packs` first only on https or on the
  local dev server's port, so a plain static host is never asked for an endpoint it cannot have.
- The editor falls back to its local backend; sign-in is simply unavailable.
- `api/*` still deploys, but every write returns 401 and `GET /api/packs` serves the static list.

### Environment variables

| Name | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes, in the cloud | signs session cookies and hashes emails into user ids |
| `ADMIN_EMAIL` | yes | the only account that may edit canonical packs; unset means nobody is admin |
| `DATABASE_URL` | for the cloud store | Neon connection string; its absence selects the `fs` store |
| `BLOB_READ_WRITE_TOKEN` | for the cloud store | Vercel Blob, injected by the store integration |
| `APP_URL` | recommended | base URL used in magic links |
| `MAILGUN_API_KEY` / `_DOMAIN` / `_FROM` / `_API_BASE` | optional | magic-link delivery; without them links are logged |
| `EDITOR_DATA_DIR` | local only | where the `fs` store writes (default `.editor-data/`) |
| `EDITOR_STORE` | local only | force `fs` or `blob+neon` |

### API

All JSON, all under `api/`. Writes need a session cookie; a creator owns their own packs and
canonical packs are admin-only.

```
POST   /api/auth/request   {email}          magic link (logged when Mailgun is unset)
GET    /api/auth/verify?token=              one-time exchange for a session cookie
GET    /api/auth/me    POST /api/auth/logout    POST /api/auth/username {username}

GET    /api/packs                           canonical + published, in packs.json shape
GET    /api/packs/:id                       manifest shape; file -> /api/levels/:id/json
POST   /api/packs {name}
PATCH  /api/packs/:id {name?, published?, sort?, levelOrder?}
DELETE /api/packs/:id

GET    /api/levels?packId=
POST   /api/levels {packId, name, json, note}
GET    /api/levels/:id                      metadata + current version
GET    /api/levels/:id/json[?version=]      the raw level JSON the game loads
GET    /api/levels/:id/versions
PUT    /api/levels/:id {json, note}         new version
PUT    /api/levels/:id?as=new {json, name}  save-as
DELETE /api/levels/:id

GET    /api/enemies?packId=   POST /api/enemies   GET|PUT|DELETE /api/enemies/:id
GET    /api/midi?packId=      POST /api/midi {name, dataBase64, packId, bpm}   GET|DELETE /api/midi/:id
POST   /api/publish/:packId {published}
```

Levels are content-addressed: saving stores the JSON under its sha256 and records a version row, so
history is free and re-saving unchanged content costs nothing. `GET /api/packs/:id` returns the same
manifest shape the repo files use, which is why the game's loader needed no changes.

### Re-running the migration from the deployment

`BLOB_READ_WRITE_TOKEN` is a sensitive variable, so it cannot be pulled locally. The migration
therefore also runs inside the deployment:

```bash
curl -X POST -H "x-migrate-key: $MIGRATE_KEY" "https://cyberhell.acidlemon.com/api/admin/migrate?pack=pack1"
# ?dryRun=1 reports without writing; omit ?pack= to run every pack (watch the function timeout)
```

`MIGRATE_KEY` is a production env var set on 2026-09-06; rotate or remove it when the canonical
set is settled. The first run seeded 197 levels across 7 packs.
