// Anonymous event sink + client beacon: node --test tests/event.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import handler from '../api/event.js';

const require = createRequire(import.meta.url);
const telemetry = require('../js/cyber-telemetry.js');

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b || ''; };
  return res;
}

async function call(method, body, { raw } = {}) {
  const logs = [];
  const orig = console.log;
  console.log = (l) => logs.push(l);
  const res = mockRes();
  try {
    const req = raw !== undefined
      ? Object.assign(Readable.from([Buffer.from(raw)]), { method, headers: {} })
      : { method, headers: {}, body };
    await handler(req, res);
  } finally { console.log = orig; }
  return { res, logs };
}

test('session_start -> 204, normalized to session, anonymous fields only', async () => {
  const { res, logs } = await call('POST', {
    name: 'session_start', ts: 1, client_id: 'c'.repeat(200), session_id: 's',
    props: { mode: 'campaign', touch: false, email: 'x@y.z', ua: 'Mozilla' }, userAgent: 'Mozilla'
  });
  assert.equal(res.statusCode, 204);
  const rec = JSON.parse(logs[0]);
  assert.equal(rec.type, 'session');
  assert.equal(rec.name, 'session');
  assert.equal(rec.client_id.length, 80);
  assert.deepEqual(rec.props, { mode: 'campaign', touch: false });
  assert.ok(!logs[0].includes('Mozilla') && !logs[0].includes('x@y.z'));
});

test('play_start via type -> 204, normalized to play', async () => {
  const { res, logs } = await call('POST', { type: 'play_start', client_id: 'c', session_id: 's', props: { mode: 'draft' } });
  assert.equal(res.statusCode, 204);
  assert.equal(JSON.parse(logs[0]).name, 'play');
});

test('streamed raw body works', async () => {
  const { res } = await call('POST', undefined, { raw: '{"name":"session","props":{}}' });
  assert.equal(res.statusCode, 204);
});

test('disallowed names are 400 and not logged', async () => {
  for (const name of ['kill', 'death', 'fight', 'enemy_killed', '', undefined]) {
    const { res, logs } = await call('POST', { name });
    assert.equal(res.statusCode, 400, String(name));
    assert.equal(logs.length, 0);
  }
});

test('bad JSON, array body and oversized body are 400', async () => {
  assert.equal((await call('POST', undefined, { raw: '{nope' })).res.statusCode, 400);
  assert.equal((await call('POST', undefined, { raw: '[1]' })).res.statusCode, 400);
  assert.equal((await call('POST', undefined, { raw: JSON.stringify({ name: 'session', pad: 'x'.repeat(5000) }) })).res.statusCode, 400);
  assert.equal((await call('POST', { name: 'session', pad: 'x'.repeat(5000) })).res.statusCode, 400);
});

test('non-POST is 405, OPTIONS is 204 with CORS', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) assert.equal((await call(m)).res.statusCode, 405);
  const { res } = await call('OPTIONS');
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
});

test('client beacon: once-only, mutes, soft-fails', () => {
  const sent = [];
  const storage = new Map();
  const st = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const t = telemetry.create({ storage: st, transport: (p) => sent.push(p), muted: false });
  assert.equal(t.once('play', { mode: 'campaign', touch: true, secret: 'no' }), true);
  assert.equal(t.once('play', {}), false);
  assert.equal(t.track('kill'), false);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].props, { mode: 'campaign', touch: true });
  assert.equal(storage.get('cyberhell.cid'), t.getClientId());
  assert.equal(telemetry.create({ storage: st, muted: true, transport: () => assert.fail() }).track('session'), false);
  const boom = telemetry.create({ storage: null, muted: false, transport: () => { throw new Error('x'); } });
  assert.equal(boom.track('session'), false);
});
