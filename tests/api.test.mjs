// End-to-end API test against the fs store: node --test tests/api.test.mjs
// Boots tools/dev_api_server.mjs as a child process on port 5305 with a throwaway .editor-data,
// reads the magic link off its stdout, and drives the whole editor flow with fetch. No deps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.API_TEST_PORT || 5305);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'tester@example.com';

let child, dataDir, stdout = '', cookie = '';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path_, body, opts = {}) {
  const res = await fetch(BASE + path_, {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie && !opts.anon ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !opts.keepCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyberhell-api-'));
  child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev_api_server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), EDITOR_DATA_DIR: dataDir, ADMIN_EMAIL: EMAIL, SESSION_SECRET: 'test-secret-abc' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stdout += d.toString(); });

  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/packs`); if (r.ok) return; } catch { /* not up yet */ }
    await wait(100);
  }
  throw new Error(`dev server did not start:\n${stdout}`);
});

after(async () => {
  if (child) child.kill();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('GET /api/packs matches the static packs.json shape', async () => {
  const staticPacks = JSON.parse(await fs.readFile(path.join(ROOT, 'levelPacks', 'packs.json'), 'utf8'));
  const { status, json } = await req('GET', '/api/packs');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json) && json.length);
  // Empty store -> the static list, verbatim, so the game boots identically.
  assert.deepEqual(json, staticPacks);
  for (const p of json) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'levelCount', 'manifest', 'name']);
    assert.equal(typeof p.manifest, 'string');
  }
});

test('GET /api/packs/:id falls back to the static manifest', async () => {
  const { status, json } = await req('GET', '/api/packs/pack1');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json) && json.length === 32);
  assert.ok(json[0].file.endsWith('.json'));
});

test('protected endpoints are 401 while signed out', async () => {
  const { status } = await req('POST', '/api/packs', { name: 'Nope' }, { anon: true });
  assert.equal(status, 401);
});

test('magic-link sign-in: request -> link on stdout -> verify -> me', async () => {
  const mark = stdout.length;
  const asked = await req('POST', '/api/auth/request', { email: EMAIL });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.emailed, false);

  let link = null;
  for (let i = 0; i < 50 && !link; i++) {
    const m = stdout.slice(mark).match(/\[magic-link\][^\n]*?(http:\/\/\S+)/);
    if (m) link = m[1];
    else await wait(50);
  }
  assert.ok(link, `no magic link printed:\n${stdout.slice(mark)}`);

  const token = new URL(link).searchParams.get('token');
  const verified = await req('GET', `/api/auth/verify?token=${token}`);
  assert.equal(verified.status, 302);
  assert.match(cookie, /^ch_session=/);

  // One-time use.
  const replay = await req('GET', `/api/auth/verify?token=${token}`, undefined, { keepCookie: true });
  assert.equal(replay.status, 302);
  assert.match(replay.headers.get('location'), /auth=invalid/);

  const me = await req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.email, EMAIL);
  assert.equal(me.json.isAdmin, true, 'ADMIN_EMAIL match should grant admin');

  const named = await req('POST', '/api/auth/username', { username: 'tester' });
  assert.equal(named.status, 200);
  assert.equal((await req('GET', '/api/auth/me')).json.username, 'tester');
});

test('rate limit: a second link request inside the cooldown is 429', async () => {
  const again = await req('POST', '/api/auth/request', { email: EMAIL });
  assert.equal(again.status, 429);
});

let packId, levelId, sourceLevel;

test('create a pack', async () => {
  const created = await req('POST', '/api/packs', { name: 'Test Pack' });
  assert.equal(created.status, 201);
  packId = created.json.id;
  assert.equal(created.json.published, false);
  assert.equal(created.json.isCanonical, false);
});

test('create a level from levelPacks/pack1 level 1', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'levelPacks', 'pack1', 'manifest.json'), 'utf8'));
  sourceLevel = JSON.parse(await fs.readFile(path.join(ROOT, manifest[0].file), 'utf8'));

  const created = await req('POST', '/api/levels', { packId, name: 'Borrowed MAP01', json: sourceLevel });
  assert.equal(created.status, 201, created.text);
  levelId = created.json.level.id;
  assert.equal(created.json.version.sectors, sourceLevel.sectors.length);
  assert.equal(created.json.version.walls, sourceLevel.walls.length);

  // Round-trip: the payload comes back byte-identical to what the game would have loaded.
  const raw = await req('GET', `/api/levels/${levelId}/json`);
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.json, sourceLevel);
});

test('rejects junk level JSON without leaving an orphan level', async () => {
  const before = (await req('GET', `/api/levels?packId=${packId}`)).json.length;
  const bad = await req('POST', '/api/levels', { packId, name: 'Junk', json: { nope: true } });
  assert.equal(bad.status, 400);
  assert.equal((await req('GET', `/api/levels?packId=${packId}`)).json.length, before);
});

test('save a new version, and save-as a copy', async () => {
  const edited = structuredClone(sourceLevel);
  edited.meta = { note: 'edited by the api test' };

  const saved = await req('PUT', `/api/levels/${levelId}`, { json: edited, note: 'tweak' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await req('GET', `/api/levels/${levelId}/json`)).json.meta.note, 'edited by the api test');

  const versions = await req('GET', `/api/levels/${levelId}/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.json.versions.length, 2);
  assert.equal(versions.json.currentVersionId, versions.json.versions[0].id);

  // The old version is still fetchable by id.
  const old = versions.json.versions[1];
  assert.equal((await req('GET', `/api/levels/${levelId}/json?version=${old.id}`)).json.meta, undefined);

  const copy = await req('PUT', `/api/levels/${levelId}?as=new`, { json: edited, name: 'Borrowed MAP01 copy' });
  assert.equal(copy.status, 201, copy.text);
  assert.notEqual(copy.json.level.id, levelId);
  assert.equal(copy.json.level.packId, packId);
});

test('the pack lists both levels in manifest shape', async () => {
  const manifest = await req('GET', `/api/packs/${packId}`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.length, 2);
  for (const item of manifest.json) {
    assert.deepEqual(Object.keys(item).sort(), ['entities', 'file', 'id', 'name', 'sectors', 'walls']);
    assert.match(item.file, /^\/api\/levels\/.+\/json$/);
  }
  // Reorder, then confirm the order stuck.
  const reversed = manifest.json.map((l) => l.id).reverse();
  assert.equal((await req('PATCH', `/api/packs/${packId}`, { levelOrder: reversed })).status, 200);
  assert.deepEqual((await req('GET', `/api/packs/${packId}`)).json.map((l) => l.id), reversed);
});

test('enemies and midi round-trip', async () => {
  const enemy = await req('POST', '/api/enemies', { name: 'Chrome Imp', baseType: 'imp', packId, def: { stats: { hp: 90 }, look: { body: '#0ff' } } });
  assert.equal(enemy.status, 201, enemy.text);
  assert.equal((await req('GET', `/api/enemies?packId=${packId}`)).json.length, 1);
  assert.equal((await req('PUT', `/api/enemies/${enemy.json.id}`, { name: 'Chrome Imp II' })).json.name, 'Chrome Imp II');

  // Smallest valid SMF: an MThd header plus one empty track.
  const mid = Buffer.concat([
    Buffer.from('MThd'), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, 0, 96]),
    Buffer.from('MTrk'), Buffer.from([0, 0, 0, 4, 0, 0xff, 0x2f, 0x00]),
  ]);
  const up = await req('POST', '/api/midi', { name: 'Test Cue', dataBase64: mid.toString('base64'), packId, bpm: 140 });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.json.bytes, mid.length);

  const back = await fetch(`${BASE}/api/midi/${up.json.id}`);
  assert.equal(back.status, 200);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), mid);

  const notMidi = await req('POST', '/api/midi', { name: 'Bogus', dataBase64: Buffer.from('hello').toString('base64') });
  assert.equal(notMidi.status, 400);
});

test('publish puts the pack on the boot list without disturbing the canonical entries', async () => {
  const staticPacks = JSON.parse(await fs.readFile(path.join(ROOT, 'levelPacks', 'packs.json'), 'utf8'));
  const published = await req('POST', `/api/publish/${packId}`, {});
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.published, true);

  const list = await req('GET', '/api/packs');
  assert.equal(list.json.length, staticPacks.length + 1);
  assert.deepEqual(list.json.slice(0, staticPacks.length), staticPacks);
  const mine = list.json[list.json.length - 1];
  assert.deepEqual(Object.keys(mine).sort(), ['id', 'levelCount', 'manifest', 'name']);
  assert.equal(mine.levelCount, 2);
  assert.equal(mine.manifest, `/api/packs/${packId}`);

  // And the game's loader can walk it: packs -> manifest -> level JSON.
  const manifest = await (await fetch(BASE + mine.manifest)).json();
  const level = await (await fetch(BASE + manifest[0].file)).json();
  assert.ok(Array.isArray(level.sectors) && Array.isArray(level.walls));
});

test('canonical packs stay admin-only for non-admins', async () => {
  // Sign in as a second, non-admin account.
  const adminCookie = cookie;
  const mark = stdout.length;
  cookie = '';
  await req('POST', '/api/auth/request', { email: 'other@example.com' }, { anon: true });
  let link = null;
  for (let i = 0; i < 50 && !link; i++) {
    const m = stdout.slice(mark).match(/\[magic-link\] other@example\.com -> (\S+)/);
    if (m) link = m[1]; else await wait(50);
  }
  assert.ok(link, 'no second magic link');
  await req('GET', `/api/auth/verify?token=${new URL(link).searchParams.get('token')}`);
  assert.equal((await req('GET', '/api/auth/me')).json.isAdmin, false);

  // Someone else's pack is off limits.
  assert.equal((await req('PATCH', `/api/packs/${packId}`, { name: 'Hijacked' })).status, 403);
  assert.equal((await req('DELETE', `/api/levels/${levelId}`)).status, 403);
  cookie = adminCookie;
});

test('delete the pack', async () => {
  assert.equal((await req('DELETE', `/api/packs/${packId}`)).status, 200);
  assert.equal((await req('GET', `/api/packs/${packId}`)).status, 404);
  const staticPacks = JSON.parse(await fs.readFile(path.join(ROOT, 'levelPacks', 'packs.json'), 'utf8'));
  assert.deepEqual((await req('GET', '/api/packs')).json, staticPacks);
});
