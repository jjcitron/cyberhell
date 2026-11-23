// End-to-end Sumi cloud-save API coverage against the fs backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SUMI_API_TEST_PORT || 5315);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'sumi-level-test-secret';
process.env.SESSION_SECRET = SECRET;
const { signSession } = await import('../api/_lib/session.js');
const ownerCookie = `al_session=${signSession({ email: 'sumi-owner@example.com' })}`;
const otherCookie = `al_session=${signSession({ email: 'other-sumi@example.com' })}`;

let child;
let dataDir;
let output = '';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function req(method, pathname, body, cookie = ownerCookie) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, text };
}

function sampleLevel(overrides = {}) {
  return {
    format: 'sumi-cyberhell-grid@1',
    id: 'kurogane',
    title: 'TEST RIFT',
    theme: 'feudal',
    map: [
      '########',
      '#S.....#',
      '#......#',
      '#..a...#',
      '#......#',
      '#......#',
      '#.....R#',
      '########',
    ],
    ...overrides,
  };
}

function rectangularMap(rows, columns) {
  return Array.from({ length: rows }, (_, rowIndex) => {
    if (rowIndex === 0 || rowIndex === rows - 1) return '#'.repeat(columns);
    const marker = rowIndex === 1 ? 'S' : rowIndex === rows - 2 ? 'R' : '.';
    return `#${marker}${'.'.repeat(columns - 3)}#`;
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyberhell-sumi-api-'));
  child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev_api_server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      EDITOR_DATA_DIR: dataDir,
      EDITOR_STORE: 'fs',
      SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/packs`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await wait(100);
  }
  throw new Error(`dev server did not start:\n${output}`);
});

after(async () => {
  if (child) child.kill();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('Sumi endpoints require a signed-in user', async () => {
  assert.equal((await req('GET', '/api/sumi-levels', undefined, null)).status, 401);
  assert.equal((await req('POST', '/api/sumi-levels', { name: 'No session', level: sampleLevel() }, null)).status, 401);
});

let levelId;

test('create, list, get, update, and delete a Sumi level', async () => {
  const created = await req('POST', '/api/sumi-levels', { name: 'Kurogane edit', level: sampleLevel() });
  assert.equal(created.status, 201, created.text);
  levelId = created.json.id;
  assert.match(levelId, /^sumi_[a-f0-9]{16}$/);
  assert.equal(created.json.name, 'Kurogane edit');
  assert.equal(created.json.createdAt, created.json.updatedAt);
  const storedDb = JSON.parse(await fs.readFile(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(Object.values(storedDb.userApps).map((apps) => Object.keys(apps)), [['sumi']]);

  const listed = await req('GET', '/api/sumi-levels');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.length, 1);
  assert.deepEqual(Object.keys(listed.json[0]).sort(), ['bytes', 'createdAt', 'id', 'name', 'sourceLevelId', 'updatedAt']);
  assert.equal(listed.json[0].id, levelId);
  assert.equal(listed.json[0].sourceLevelId, 'kurogane');
  assert.ok(listed.json[0].bytes > 0);

  const got = await req('GET', `/api/sumi-levels/${levelId}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.level, sampleLevel());

  const edited = sampleLevel({ title: 'EDITED RIFT' });
  const updated = await req('PUT', `/api/sumi-levels/${levelId}`, { name: 'Renamed edit', level: edited });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.name, 'Renamed edit');
  assert.equal((await req('GET', `/api/sumi-levels/${levelId}`)).json.level.title, 'EDITED RIFT');
});

test('another user sees owner-scoped records as not found', async () => {
  assert.equal((await req('GET', `/api/sumi-levels/${levelId}`, undefined, otherCookie)).status, 404);
  assert.equal((await req('PUT', `/api/sumi-levels/${levelId}`, { level: sampleLevel() }, otherCookie)).status, 404);
  assert.equal((await req('DELETE', `/api/sumi-levels/${levelId}`, undefined, otherCookie)).status, 404);
  assert.deepEqual((await req('GET', '/api/sumi-levels', undefined, otherCookie)).json, []);
});

test('Save As creates a distinct id', async () => {
  const copy = await req('POST', '/api/sumi-levels', { name: 'Kurogane copy', level: sampleLevel() });
  assert.equal(copy.status, 201, copy.text);
  assert.notEqual(copy.json.id, levelId);
  assert.equal((await req('GET', '/api/sumi-levels')).json.length, 2);
});

test('Sumi save names accept built-in titles and reject unsafe or out-of-range names', async () => {
  const accepted = [
    'I · KUROGANE SHRINE',
    'XII · NEON RIFT · UNDERCITY — Part 2: PART 2 · UNDERCITY 2090',
    'XIV · KABUKI-CHŌ 2090',
  ];
  for (const name of accepted) {
    const response = await req('POST', '/api/sumi-levels', { name, level: sampleLevel() });
    assert.equal(response.status, 201, `${name}: ${response.text}`);
    assert.equal(response.json.name, name);
    assert.equal((await req('DELETE', `/api/sumi-levels/${response.json.id}`)).status, 200);
  }

  const rejected = ['<script>', 'bad\u0007name', '', 'x'.repeat(97)];
  for (const name of rejected) {
    const response = await req('POST', '/api/sumi-levels', { name, level: sampleLevel() });
    assert.equal(response.status, 400, `${JSON.stringify(name)}: ${response.text}`);
    assert.deepEqual(response.json.errors, ['Invalid level name.']);
  }
});

test('validator accepts real Sumi map dimensions and enforces the row bounds', async () => {
  const accepted = await req('POST', '/api/sumi-levels', {
    name: 'Ash Rivers dimensions',
    level: sampleLevel({ map: rectangularMap(162, 124) }),
  });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal((await req('DELETE', `/api/sumi-levels/${accepted.json.id}`)).status, 200);

  for (const [rows, expectedError] of [
    [257, 'Level map must have 8 to 256 rows.'],
    [7, 'Level map must have 8 to 256 rows.'],
  ]) {
    const response = await req('POST', '/api/sumi-levels', {
      name: `${rows} row map`,
      level: sampleLevel({ map: rectangularMap(rows, 124) }),
    });
    assert.equal(response.status, 400, response.text);
    assert.ok(response.json.errors.includes(expectedError), response.text);
  }
});

test('validator rejects bad format, ragged rows, bad glyphs, missing endpoints, and oversize payloads', async () => {
  const badName = await req('POST', '/api/sumi-levels', { name: ' invalid', level: sampleLevel() });
  assert.equal(badName.status, 400);
  assert.ok(Array.isArray(badName.json.errors) && badName.json.errors.length);

  const cases = [
    sampleLevel({ format: 'not-sumi' }),
    sampleLevel({ map: [...sampleLevel().map.slice(0, 7), '#######'] }),
    sampleLevel({ map: sampleLevel().map.map((row, index) => index === 3 ? '#..Q...#' : row) }),
    sampleLevel({ map: sampleLevel().map.map((row) => row.replace('S', '.')) }),
    sampleLevel({ map: sampleLevel().map.map((row) => row.replace('R', '.')) }),
    sampleLevel({ notes: 'x'.repeat(513 * 1024) }),
  ];

  for (const [index, level] of cases.entries()) {
    const response = await req('POST', '/api/sumi-levels', { name: `Invalid ${index}`, level });
    assert.equal(response.status, 400, `case ${index}: ${response.text}`);
    assert.equal(response.json.error, 'Invalid Sumi level.');
    assert.ok(Array.isArray(response.json.errors) && response.json.errors.length, `case ${index} has errors`);
  }
});

test('delete removes only the requested owner record', async () => {
  assert.equal((await req('DELETE', `/api/sumi-levels/${levelId}`)).status, 200);
  assert.equal((await req('GET', `/api/sumi-levels/${levelId}`)).status, 404);
  assert.equal((await req('GET', '/api/sumi-levels')).json.length, 1);
});
