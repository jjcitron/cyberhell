-- Cyberhell editor metadata (Neon Postgres). Payloads live in Vercel Blob; this holds only
-- metadata and pointers. users + user_apps are the shared Acidlemon identity spine, not a
-- Cyberhell-only login: ids are the HMAC email hash from api/_lib/store.js (so raw emails are
-- never stored) and every Acidlemon title hashes with the same key, so the same player is the
-- same row everywhere. Sessions are stateless HMAC cookies, so there is no sessions table --
-- only the short-lived magic-link tokens below.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- emailHash(email)
  username    TEXT UNIQUE,
  created_at  BIGINT NOT NULL
);

-- Per-title membership on the shared Acidlemon identity spine (job 20260903-0836). One row
-- per (player, game). Deliberately NOT a users.app column: a player who edits a Cyberhell pack
-- and also plays Sumi is one user with two rows, not two users.
CREATE TABLE IF NOT EXISTS user_apps (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app         TEXT NOT NULL,                 -- 'cyberhell', 'sumi', 'spacerunner', 'clash'
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, app)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token       TEXT PRIMARY KEY,              -- random 32-byte hex, one-time use
  email       TEXT NOT NULL,
  exp         BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_resend (
  user_id     TEXT PRIMARY KEY,
  issued_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS packs (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  owner_id     TEXT REFERENCES users(id),
  is_canonical BOOLEAN NOT NULL DEFAULT FALSE,
  published    BOOLEAN NOT NULL DEFAULT FALSE,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS levels (
  id                 TEXT PRIMARY KEY,
  pack_id            TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  sort               INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS levels_pack_idx ON levels (pack_id, sort);

CREATE TABLE IF NOT EXISTS level_versions (
  id         TEXT PRIMARY KEY,
  level_id   TEXT NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  blob_url   TEXT,
  sha256     TEXT NOT NULL,                  -- content address of the level JSON
  bytes      INTEGER NOT NULL,
  sectors    INTEGER NOT NULL DEFAULT 0,
  walls      INTEGER NOT NULL DEFAULT 0,
  entities   INTEGER NOT NULL DEFAULT 0,
  author_id  TEXT,
  note       TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS level_versions_level_idx ON level_versions (level_id, created_at DESC);

CREATE TABLE IF NOT EXISTS enemies (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  pack_id    TEXT,
  name       TEXT NOT NULL,
  base_type  TEXT,
  def        JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS midi_tracks (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  pack_id    TEXT,
  name       TEXT NOT NULL,
  blob_url   TEXT,
  bytes      INTEGER NOT NULL,
  bpm        INTEGER,
  updated_at BIGINT NOT NULL
);
