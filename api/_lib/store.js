// One Store interface, two implementations, chosen by env:
//   fs        (default when DATABASE_URL is unset) - JSON under .editor-data/, files under
//             .editor-data/blob/. No SQL, no network, no node_modules. This is what
//             tools/dev_api_server.mjs and tests/api.test.mjs run against.
//   blob+neon (when DATABASE_URL is set) - @vercel/blob for payloads, @neondatabase/serverless
//             for the metadata in db/schema.sql.
// Both deps are imported lazily so the fs backend works with an empty node_modules.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function emailHash(email) {
  const norm = String(email || '').trim().toLowerCase();
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'cyberhell-dev-secret')
    .update(norm).digest('hex').slice(0, 32);
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

// ---------------------------------------------------------------- fs backend

// On Vercel the deployment filesystem is read-only; /tmp is the only writable place, so an
// unprovisioned deployment still answers (read-only canonical list) instead of throwing EROFS.
const DATA_DIR = () => process.env.EDITOR_DATA_DIR
  || (process.env.VERCEL ? path.join('/tmp', 'cyberhell-editor-data') : path.join(process.cwd(), '.editor-data'));
const EMPTY_DB = { users: {}, usernames: {}, tokens: {}, resend: {}, packs: {}, levels: {}, versions: {}, enemies: {}, midi: {} };

function fsStore() {
  const dbPath = () => path.join(DATA_DIR(), 'db.json');
  const blobPath = (p) => path.join(DATA_DIR(), 'blob', p);
  let cache = null;

  // ponytail: whole-file read-modify-write with no locking. Single-process dev server only;
  // the blob+neon backend is what handles real concurrency.
  async function read() {
    if (cache) return cache;
    try {
      cache = { ...structuredClone(EMPTY_DB), ...JSON.parse(await fs.readFile(dbPath(), 'utf8')) };
    } catch { cache = structuredClone(EMPTY_DB); }
    return cache;
  }
  async function write(db) {
    cache = db;
    await fs.mkdir(DATA_DIR(), { recursive: true });
    await fs.writeFile(dbPath(), JSON.stringify(db, null, 2));
  }
  const mutate = async (fn) => { const db = await read(); const out = await fn(db); await write(db); return out; };

  async function putFile(p, data, contentType) {
    const full = blobPath(p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return { url: `/api/blob/${p}`, pathname: p, contentType };
  }
  const getFile = (p) => fs.readFile(blobPath(p)).catch(() => null);

  return {
    kind: 'fs',
    async init() { await fs.mkdir(DATA_DIR(), { recursive: true }); },

    async getUser(id) { return (await read()).users[id] || null; },
    async putUser(id, rec) { return mutate((db) => { db.users[id] = { id, ...db.users[id], ...rec }; return db.users[id]; }); },
    async getUsernameOwner(lower) { return (await read()).usernames[lower] || null; },
    async setUsernameOwner(lower, userId) { return mutate((db) => { if (userId) db.usernames[lower] = userId; else delete db.usernames[lower]; }); },

    async putToken(token, rec) { return mutate((db) => { db.tokens[token] = rec; }); },
    async getToken(token) { return (await read()).tokens[token] || null; },
    async delToken(token) { return mutate((db) => { delete db.tokens[token]; }); },
    async getResend(id) { return (await read()).resend[id] || null; },
    async putResend(id, issuedAt) { return mutate((db) => { db.resend[id] = { issuedAt }; }); },

    async listPacks() { return Object.values((await read()).packs); },
    async getPack(id) { return (await read()).packs[id] || null; },
    async putPack(pack) { return mutate((db) => { db.packs[pack.id] = { ...db.packs[pack.id], ...pack }; return db.packs[pack.id]; }); },
    async delPack(id) {
      return mutate((db) => {
        delete db.packs[id];
        for (const [lid, lv] of Object.entries(db.levels)) {
          if (lv.packId !== id) continue;
          delete db.levels[lid];
          for (const [vid, v] of Object.entries(db.versions)) if (v.levelId === lid) delete db.versions[vid];
        }
      });
    },

    async listLevels(packId) {
      return Object.values((await read()).levels)
        .filter((l) => !packId || l.packId === packId)
        .sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));
    },
    async getLevel(id) { return (await read()).levels[id] || null; },
    async putLevel(level) { return mutate((db) => { db.levels[level.id] = { ...db.levels[level.id], ...level }; return db.levels[level.id]; }); },
    async delLevel(id) { return mutate((db) => { delete db.levels[id]; for (const [vid, v] of Object.entries(db.versions)) if (v.levelId === id) delete db.versions[vid]; }); },

    async listVersions(levelId) {
      return Object.values((await read()).versions).filter((v) => v.levelId === levelId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async putVersion(v) { return mutate((db) => { db.versions[v.id] = v; return v; }); },

    async putPayload(sha, text) { return putFile(`levels/${sha}.json`, text, 'application/json'); },
    async getPayload(sha) { const b = await getFile(`levels/${sha}.json`); return b ? b.toString('utf8') : null; },
    async putCanonical(pathname, text) { return putFile(pathname, text, 'application/json'); },

    async listEnemies(f = {}) {
      return Object.values((await read()).enemies).filter((e) =>
        (!f.ownerId || e.ownerId === f.ownerId) && (!f.packId || e.packId === f.packId));
    },
    async getEnemy(id) { return (await read()).enemies[id] || null; },
    async putEnemy(e) { return mutate((db) => { db.enemies[e.id] = { ...db.enemies[e.id], ...e }; return db.enemies[e.id]; }); },
    async delEnemy(id) { return mutate((db) => { delete db.enemies[id]; }); },

    async listMidi(f = {}) {
      return Object.values((await read()).midi).filter((m) =>
        (!f.ownerId || m.ownerId === f.ownerId) && (!f.packId || m.packId === f.packId));
    },
    async getMidi(id) { return (await read()).midi[id] || null; },
    async putMidi(rec, buffer) {
      if (buffer) await putFile(`midi/${rec.id}.mid`, buffer, 'audio/midi');
      return mutate((db) => { db.midi[rec.id] = { ...db.midi[rec.id], ...rec, url: `/api/midi/${rec.id}` }; return db.midi[rec.id]; });
    },
    async getMidiBytes(id) { return getFile(`midi/${id}.mid`); },
    async delMidi(id) { return mutate((db) => { delete db.midi[id]; }); },
  };
}

// --------------------------------------------------------- blob+neon backend

function neonStore() {
  let sqlP, blobP, ready;
  const sql = async () => (sqlP ||= import('@neondatabase/serverless').then(({ neon }) => neon(process.env.DATABASE_URL)));
  const blob = async () => (blobP ||= import('@vercel/blob'));
  const token = () => process.env.BLOB_READ_WRITE_TOKEN || process.env.PUBLIC_READ_WRITE_TOKEN;

  // Lazy one-shot schema apply. Every statement is IF NOT EXISTS, so this is cheap and it
  // removes a provisioning step from Joel's list.
  function init() {
    if (ready) return ready;
    ready = (async () => {
      const q = await sql();
      const text = await fs.readFile(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8');
      const statements = text
        .split(';')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean);
      for (const stmt of statements) await q.query(stmt);
    })();
    return ready;
  }
  const q = async (text, params = []) => { await init(); return (await sql()).query(text, params); };
  const rows = async (text, params) => { const r = await q(text, params); return r.rows || r; };
  const one = async (text, params) => (await rows(text, params))[0] || null;

  const packOut = (r) => r && ({ id: r.id, slug: r.slug, name: r.name, ownerId: r.owner_id, isCanonical: r.is_canonical, published: r.published, sort: r.sort, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
  const levelOut = (r) => r && ({ id: r.id, packId: r.pack_id, slug: r.slug, name: r.name, sort: r.sort, currentVersionId: r.current_version_id, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
  const verOut = (r) => r && ({ id: r.id, levelId: r.level_id, blobUrl: r.blob_url, sha256: r.sha256, bytes: r.bytes, sectors: r.sectors, walls: r.walls, entities: r.entities, authorId: r.author_id, note: r.note, createdAt: Number(r.created_at) });
  const enemyOut = (e) => e && ({ id: e.id, ownerId: e.owner_id, packId: e.pack_id, name: e.name, baseType: e.base_type, def: e.def, updatedAt: Number(e.updated_at) });
  const midiOut = (m) => m && ({ id: m.id, ownerId: m.owner_id, packId: m.pack_id, name: m.name, url: m.blob_url, bytes: m.bytes, bpm: m.bpm, updatedAt: Number(m.updated_at) });

  async function putBlob(pathname, data, contentType) {
    const { put } = await blob();
    return put(pathname, data, { access: 'public', contentType, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0, token: token() });
  }
  async function blobUrl(pathname) {
    const { list } = await blob();
    const page = await list({ prefix: pathname, limit: 1000, token: token() }).catch(() => null);
    return page?.blobs.find((b) => b.pathname === pathname)?.url || null;
  }
  async function getBlob(pathname) {
    const url = await blobUrl(pathname);
    if (!url) return null;
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }

  return {
    kind: 'blob+neon',
    init,

    async getUser(id) { const r = await one('SELECT * FROM users WHERE id=$1', [id]); return r && { id: r.id, username: r.username, createdAt: Number(r.created_at) }; },
    async putUser(id, rec) {
      await q('INSERT INTO users (id, username, created_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username',
        [id, rec.username ?? null, rec.createdAt || Date.now()]);
      return this.getUser(id);
    },
    async getUsernameOwner(lower) { const r = await one('SELECT id FROM users WHERE lower(username)=$1', [lower]); return r?.id || null; },
    async setUsernameOwner(lower, userId) { if (!userId) await q('UPDATE users SET username=NULL WHERE lower(username)=$1', [lower]); },

    async putToken(tok, rec) { await q('INSERT INTO auth_tokens (token,email,exp) VALUES ($1,$2,$3) ON CONFLICT (token) DO NOTHING', [tok, rec.email, rec.exp]); },
    async getToken(tok) { const r = await one('SELECT * FROM auth_tokens WHERE token=$1', [tok]); return r && { email: r.email, exp: Number(r.exp) }; },
    async delToken(tok) { await q('DELETE FROM auth_tokens WHERE token=$1', [tok]); },
    async getResend(id) { const r = await one('SELECT * FROM auth_resend WHERE user_id=$1', [id]); return r && { issuedAt: Number(r.issued_at) }; },
    async putResend(id, issuedAt) { await q('INSERT INTO auth_resend (user_id,issued_at) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET issued_at=EXCLUDED.issued_at', [id, issuedAt]); },

    async listPacks() { return (await rows('SELECT * FROM packs ORDER BY sort, created_at')).map(packOut); },
    async getPack(id) { return packOut(await one('SELECT * FROM packs WHERE id=$1', [id])); },
    async putPack(p) {
      await q(`INSERT INTO packs (id,slug,name,owner_id,is_canonical,published,sort,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, name=EXCLUDED.name,
                 published=EXCLUDED.published, sort=EXCLUDED.sort, updated_at=EXCLUDED.updated_at`,
        [p.id, p.slug, p.name, p.ownerId ?? null, !!p.isCanonical, !!p.published, p.sort ?? 0, p.createdAt || Date.now(), p.updatedAt || Date.now()]);
      return this.getPack(p.id);
    },
    async delPack(id) { await q('DELETE FROM packs WHERE id=$1', [id]); },

    async listLevels(packId) {
      const r = packId
        ? await rows('SELECT * FROM levels WHERE pack_id=$1 ORDER BY sort, created_at', [packId])
        : await rows('SELECT * FROM levels ORDER BY pack_id, sort');
      return r.map(levelOut);
    },
    async getLevel(id) { return levelOut(await one('SELECT * FROM levels WHERE id=$1', [id])); },
    async putLevel(l) {
      await q(`INSERT INTO levels (id,pack_id,slug,name,sort,current_version_id,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, slug=EXCLUDED.slug, sort=EXCLUDED.sort,
                 current_version_id=EXCLUDED.current_version_id, updated_at=EXCLUDED.updated_at`,
        [l.id, l.packId, l.slug, l.name, l.sort ?? 0, l.currentVersionId ?? null, l.createdAt || Date.now(), l.updatedAt || Date.now()]);
      return this.getLevel(l.id);
    },
    async delLevel(id) { await q('DELETE FROM levels WHERE id=$1', [id]); },

    async listVersions(levelId) { return (await rows('SELECT * FROM level_versions WHERE level_id=$1 ORDER BY created_at DESC', [levelId])).map(verOut); },
    async putVersion(v) {
      await q(`INSERT INTO level_versions (id,level_id,blob_url,sha256,bytes,sectors,walls,entities,author_id,note,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.levelId, v.blobUrl ?? null, v.sha256, v.bytes, v.sectors || 0, v.walls || 0, v.entities || 0, v.authorId ?? null, v.note ?? null, v.createdAt]);
      return v;
    },

    async putPayload(sha, text) { return putBlob(`levels/${sha}.json`, text, 'application/json'); },
    async getPayload(sha) { const b = await getBlob(`levels/${sha}.json`); return b ? b.toString('utf8') : null; },
    async putCanonical(pathname, text) { return putBlob(pathname, text, 'application/json'); },

    async listEnemies(f = {}) {
      const r = await rows('SELECT * FROM enemies WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR pack_id=$2) ORDER BY updated_at DESC', [f.ownerId ?? null, f.packId ?? null]);
      return r.map(enemyOut);
    },
    async getEnemy(id) { return enemyOut(await one('SELECT * FROM enemies WHERE id=$1', [id])); },
    async putEnemy(e) {
      await q(`INSERT INTO enemies (id,owner_id,pack_id,name,base_type,def,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, base_type=EXCLUDED.base_type, def=EXCLUDED.def,
                 pack_id=EXCLUDED.pack_id, updated_at=EXCLUDED.updated_at`,
        [e.id, e.ownerId ?? null, e.packId ?? null, e.name, e.baseType ?? null, JSON.stringify(e.def || {}), e.updatedAt || Date.now()]);
      return this.getEnemy(e.id);
    },
    async delEnemy(id) { await q('DELETE FROM enemies WHERE id=$1', [id]); },

    async listMidi(f = {}) {
      const r = await rows('SELECT * FROM midi_tracks WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR pack_id=$2) ORDER BY updated_at DESC', [f.ownerId ?? null, f.packId ?? null]);
      return r.map(midiOut);
    },
    async getMidi(id) { return midiOut(await one('SELECT * FROM midi_tracks WHERE id=$1', [id])); },
    async putMidi(rec, buffer) {
      let url = rec.url || null;
      if (buffer) url = (await putBlob(`midi/${rec.id}.mid`, buffer, 'audio/midi')).url;
      await q(`INSERT INTO midi_tracks (id,owner_id,pack_id,name,blob_url,bytes,bpm,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, blob_url=EXCLUDED.blob_url, bytes=EXCLUDED.bytes,
                 bpm=EXCLUDED.bpm, pack_id=EXCLUDED.pack_id, updated_at=EXCLUDED.updated_at`,
        [rec.id, rec.ownerId ?? null, rec.packId ?? null, rec.name, url, rec.bytes || 0, rec.bpm ?? null, rec.updatedAt || Date.now()]);
      return this.getMidi(rec.id);
    },
    async getMidiBytes(id) { return getBlob(`midi/${id}.mid`); },
    async delMidi(id) { await q('DELETE FROM midi_tracks WHERE id=$1', [id]); },
  };
}

let instance;
export function getStore() {
  if (!instance) {
    const wanted = process.env.EDITOR_STORE || (process.env.DATABASE_URL ? 'blob+neon' : 'fs');
    instance = wanted === 'blob+neon' ? neonStore() : fsStore();
  }
  return instance;
}

// The migration script and the tests switch backends between runs.
export function resetStore() { instance = null; }
