// Cyberhell anonymous event beacon and POST /api/event.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { ALLOWED_NAMES, ALLOWED_PROP_KEYS, RECORD_KEYS, TYPE_MAP } from '../api/event.js';
import telemetry from '../js/cyber-telemetry.js';
import growthTag from '../js/growthTag.js';

const { createTelemetry, detectQaMute, EVENT_NAMES, ALLOWED_PROPS } = telemetry;
const { CANONICAL_HOSTS, detectInternal } = growthTag;

const PROD_HOST = 'cyberhell.acidlemon.com';
const CLEAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EXPECTED_TYPES = {
  session_start: 'session',
  level_start: 'level',
  death: 'death',
};

function fakeReq(method, body, opts = {}) {
  const raw = typeof body === 'string' ? body : (body !== undefined ? JSON.stringify(body) : undefined);
  const buf = raw !== undefined ? Buffer.from(raw, 'utf8') : null;
  let readOffset = 0;
  const req = {
    method,
    url: opts.url || '/api/event',
    headers: opts.headers || {},
    query: opts.query,
    async *[Symbol.asyncIterator]() {
      if (opts.stream === false) return;
      if (buf) yield buf;
    },
  };
  if ('parsedBody' in opts) req.body = opts.parsedBody;
  if ('rawBody' in opts) req.rawBody = opts.rawBody;
  if (opts.readRestored) {
    req.read = () => {
      if (!buf || readOffset >= buf.length) return null;
      const slice = buf.subarray(readOffset);
      readOffset = buf.length;
      return slice;
    };
  }
  return req;
}

// Mirrors @vercel/node addHelpers: missing Content-Type leaves req.body as ""
// with the stream intact; other types populate req.body and restore via read().
function vercelReq(method, body, opts = {}) {
  const raw = typeof body === 'string' ? body : (body !== undefined ? JSON.stringify(body) : '');
  const headers = { ...(opts.headers || {}) };
  const contentType = headers['content-type'];
  const type = contentType
    ? String(contentType).split(';')[0].trim().toLowerCase()
    : 'text/plain';
  let parsedBody;
  if (contentType === undefined) parsedBody = '';
  else if (type === 'application/json') parsedBody = raw ? JSON.parse(raw) : {};
  else if (type === 'text/plain') parsedBody = raw;
  else if (type === 'application/octet-stream') parsedBody = Buffer.from(raw);
  else parsedBody = undefined;
  return fakeReq(method, body, {
    ...opts,
    headers,
    parsedBody,
    stream: contentType === undefined,
    readRestored: contentType !== undefined,
  });
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(data) { this.ended = true; if (data) this.body = data; },
  };
}

async function call(method, body, opts = {}) {
  const res = fakeRes();
  const logged = [];
  const errors = [];
  const original = console.log;
  const originalErr = console.error;
  console.log = (line) => logged.push(typeof line === 'string' ? line : JSON.stringify(line));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const prevEnv = {};
  const env = opts.env || {};
  for (const key of Object.keys(env)) {
    prevEnv[key] = process.env[key];
    if (env[key] == null) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    const makeReq = opts.vercel ? vercelReq : fakeReq;
    await handler(makeReq(method, body, opts), res);
  } finally {
    console.log = original;
    console.error = originalErr;
    for (const key of Object.keys(env)) {
      if (prevEnv[key] == null) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  }
  return { res, logged, errors };
}

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
}

function pageEnv(overrides = {}) {
  const location = {
    protocol: 'https:',
    host: PROD_HOST,
    hostname: PROD_HOST,
    pathname: '/',
    search: '',
    ...(overrides.location || {}),
  };
  const same = {};
  return {
    location,
    navigator: { userAgent: CLEAN_UA, webdriver: false, ...(overrides.navigator || {}) },
    storage: overrides.storage || memStorage(),
    document: overrides.document !== undefined ? overrides.document : { cookie: '' },
    self: overrides.self !== undefined ? overrides.self : same,
    top: overrides.top !== undefined ? overrides.top : same,
  };
}

function prodCall(body, opts = {}) {
  return call('POST', body, {
    ...opts,
    headers: {
      host: PROD_HOST,
      'user-agent': CLEAN_UA,
      ...(opts.headers || {}),
    },
    env: {
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_SHA: 'abc1234deadbeef',
      ...(opts.env || {}),
    },
  });
}

function assertRecord(parsed, name) {
  assert.deepEqual(Object.keys(parsed).sort(), [...RECORD_KEYS].sort());
  assert.equal(parsed.game, 'cyberhell');
  assert.equal(parsed.name, name);
  assert.equal(parsed.type, EXPECTED_TYPES[name]);
  assert.equal(parsed.type, TYPE_MAP[name]);
  assert.equal(parsed.host, PROD_HOST);
  assert.equal(parsed.env, 'production');
  assert.equal(parsed.build, 'abc1234');
  assert.equal(parsed.schema_v, 1);
  assert.equal(typeof parsed.ts, 'number');
  assert.equal(typeof parsed.client_id, 'string');
  assert.equal(typeof parsed.session_id, 'string');
  assert.equal(typeof parsed.props, 'object');
  assert.equal(typeof parsed.internal, 'boolean');
  assert.ok(Array.isArray(parsed.internal_reasons));
}

test('client event names are exactly the names the server accepts', () => {
  assert.deepEqual([...EVENT_NAMES], ['session_start', 'level_start', 'death']);
  assert.deepEqual([...EVENT_NAMES].sort(), [...ALLOWED_NAMES].sort());
  for (const name of EVENT_NAMES) assert.equal(ALLOWED_NAMES.has(name), true, name);
  assert.deepEqual([...ALLOWED_PROPS], [...ALLOWED_PROP_KEYS]);
  assert.ok(CANONICAL_HOSTS.includes(PROD_HOST));
});

test('accepted events log one record and nothing else', async () => {
  for (const name of EVENT_NAMES) {
    const { res, logged, errors } = await prodCall({
      name,
      ts: 1700000000000,
      client_id: 'ch_player',
      session_id: 'ch_sess',
      props: { level: 'json1', index: 0, difficulty: 'normal', cause: name === 'death' ? 'hp' : undefined },
    });
    assert.equal(res.statusCode, 204, name);
    assert.equal(logged.length, 1, name);
    assert.equal(errors.length, 0, name);
    const parsed = JSON.parse(logged[0]);
    assertRecord(parsed, name);
    assert.equal(parsed.ts, 1700000000000);
    assert.equal(parsed.client_id, 'ch_player');
    assert.equal(parsed.session_id, 'ch_sess');
    assert.equal(parsed.internal, false);
    assert.deepEqual(parsed.internal_reasons, []);
    assert.equal(parsed.props.level, 'json1');
    assert.equal(parsed.props.index, 0);
    assert.equal(parsed.props.difficulty, 'normal');
    if (name === 'death') assert.equal(parsed.props.cause, 'hp');
    else assert.equal(parsed.props.cause, undefined);
  }
});

test('OPTIONS is 204 and non-POST is 405 with Allow POST', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const { res, logged, errors } = await call(method, { name: 'death' });
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(logged.length, 0);
    assert.equal(errors.length, 0);
  }
  const opt = await call('OPTIONS');
  assert.equal(opt.res.statusCode, 204);
  assert.equal(opt.logged.length, 0);
  assert.ok(opt.res.headers['access-control-allow-methods'].includes('POST'));
});

test('unknown names are 400 and empty or non-object bodies are a quiet 204', async () => {
  const bad = await call('POST', { name: 'play_start', props: { level: 'json1' } });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.logged.length, 0);
  assert.equal(bad.errors.length, 0);

  const cases = [undefined, '', '   ', '{not-json', 'null', '[]', '0', '"nope"'];
  for (const body of cases) {
    const { res, logged, errors } = await call('POST', body);
    assert.equal(res.statusCode, 204, `body ${JSON.stringify(body)}`);
    assert.equal(logged.length, 0, `body ${JSON.stringify(body)}`);
    assert.equal(errors.length, 0, `body ${JSON.stringify(body)}`);
  }
  const empty = await call('POST', {});
  assert.equal(empty.res.statusCode, 204);
  assert.equal(empty.logged.length, 0);
  assert.equal(empty.errors.length, 0);
});

const LEVEL_START = {
  name: 'level_start',
  ts: 1700000000000,
  client_id: 'ch_player',
  session_id: 'ch_sess',
  props: { level: 'json1', index: 2, difficulty: 'hard' },
};

test('application/json, text/plain, and a missing content-type all log the same record', async () => {
  const jsonHit = await prodCall(LEVEL_START, {
    headers: { 'content-type': 'application/json' },
    vercel: true,
  });
  assert.equal(jsonHit.res.statusCode, 204);
  assert.equal(jsonHit.logged.length, 1);
  assert.equal(jsonHit.errors.length, 0);
  const jsonRec = JSON.parse(jsonHit.logged[0]);
  assertRecord(jsonRec, 'level_start');
  assert.equal(jsonRec.props.index, 2);
  assert.equal(jsonRec.props.difficulty, 'hard');

  for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'text/plain; charset=utf-8']) {
    const hit = await prodCall(LEVEL_START, {
      headers: { 'content-type': contentType },
      vercel: true,
    });
    assert.equal(hit.res.statusCode, 204, contentType);
    assert.equal(hit.errors.length, 0, contentType);
    assert.equal(hit.logged.length, 1, contentType);
    assert.deepEqual(JSON.parse(hit.logged[0]), jsonRec);
  }

  const missing = await prodCall(LEVEL_START, { vercel: true });
  assert.equal(missing.res.statusCode, 204);
  assert.equal(missing.errors.length, 0);
  assert.equal(missing.logged.length, 1);
  assert.deepEqual(JSON.parse(missing.logged[0]), jsonRec);

  const asString = await prodCall(JSON.stringify(LEVEL_START), {
    headers: { 'content-type': 'text/plain' },
    parsedBody: JSON.stringify(LEVEL_START),
    stream: false,
  });
  assert.equal(asString.res.statusCode, 204);
  assert.equal(asString.logged.length, 1);
  assert.deepEqual(JSON.parse(asString.logged[0]), jsonRec);
});

test('props are allowlisted and truncated; unknown props are dropped', async () => {
  const longLevel = 'L'.repeat(200);
  const { res, logged } = await prodCall({
    name: 'death',
    ts: 1700000000000,
    client_id: 'c'.repeat(200),
    session_id: 's'.repeat(200),
    level: longLevel,
    index: 4,
    difficulty: 'nightmare',
    cause: 'hp',
    email: 'person@example.com',
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 UniqueFlatUA',
    internal: true,
    internal_reasons: ['opt_out'],
    schema_v: 9,
    props: { level: 'should-lose-to-top-level', note: 'free text note from the player' },
  });
  assert.equal(res.statusCode, 204);
  const line = logged[0];
  const parsed = JSON.parse(line);
  assert.equal(parsed.props.level.length, 80);
  assert.equal(parsed.props.level, 'L'.repeat(80));
  assert.equal(parsed.props.index, 4);
  assert.equal(parsed.props.difficulty, 'nightmare');
  assert.equal(parsed.props.cause, 'hp');
  assert.equal(parsed.props.note, undefined);
  assert.equal(parsed.props.email, undefined);
  assert.equal(parsed.props.internal, undefined);
  assert.equal(parsed.client_id.length, 80);
  assert.equal(parsed.session_id.length, 80);
  assert.equal(parsed.schema_v, 1);
  assert.equal(line.includes('person@example.com'), false);
  assert.equal(line.includes('203.0.113.5'), false);
  assert.equal(line.includes('UniqueFlatUA'), false);
  assert.equal(line.includes('free text note'), false);
});

test('a body over 4096 bytes is 400 and an exact 4096 byte body is accepted', async () => {
  const prefix = '{"name":"session_start","props":{"level":"';
  const suffix = '"}}';
  const fit = 4096 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const exact = prefix + 'a'.repeat(fit) + suffix;
  assert.equal(Buffer.byteLength(exact), 4096);
  const ok = await prodCall(exact);
  assert.equal(ok.res.statusCode, 204);
  assert.equal(ok.logged.length, 1);
  assert.equal(ok.errors.length, 0);
  assert.equal(JSON.parse(ok.logged[0]).props.level.length, 80);

  const huge = await call('POST', exact + 'Z');
  assert.equal(Buffer.byteLength(exact + 'Z'), 4097);
  assert.equal(huge.res.statusCode, 400);
  assert.equal(huge.logged.length, 0);
  assert.equal(huge.errors.length, 0);

  const hugePlain = await call('POST', exact + 'Z', {
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    vercel: true,
  });
  assert.equal(hugePlain.res.statusCode, 400);
  assert.equal(hugePlain.logged.length, 0);
  assert.equal(hugePlain.errors.length, 0);
});

test('client internal false cannot clear a server reason, and the UA is not logged', async () => {
  const ua = 'Mozilla/5.0 HeadlessChrome/121 UniqueClearCheck';
  const hit = await prodCall({
    name: 'death',
    ts: 1700000000000,
    client_id: 'ch_player',
    session_id: 'ch_sess',
    internal: false,
    internal_reasons: [],
    props: { level: 'json1', index: 0, difficulty: 'normal', cause: 'hp', userAgent: ua },
  }, {
    headers: { 'user-agent': ua },
  });
  assert.equal(hit.res.statusCode, 204);
  assert.equal(hit.errors.length, 0);
  assert.equal(hit.logged.length, 1);
  const line = hit.logged[0];
  const parsed = JSON.parse(line);
  assert.equal(parsed.internal, true);
  assert.deepEqual(parsed.internal_reasons, ['automation_ua']);
  assert.equal(parsed.props.userAgent, undefined);
  assert.equal(line.includes('UniqueClearCheck'), false);
  assert.equal(line.includes('HeadlessChrome'), false);

  const preview = await prodCall(
    { name: 'session_start', client_id: 'c', session_id: 'ch_s', internal: false, internal_reasons: [] },
    { headers: { 'x-forwarded-host': 'cyberhell-git.vercel.app', host: PROD_HOST } },
  );
  const previewRec = JSON.parse(preview.logged[0]);
  assert.equal(previewRec.internal, true);
  assert.ok(previewRec.internal_reasons.includes('vercel_app'));
  assert.ok(previewRec.internal_reasons.includes('preview_host'));
  assert.equal(previewRec.host, 'cyberhell-git.vercel.app');

  const queryTest = await prodCall(
    { name: 'level_start', client_id: 'c', session_id: 'ch_s', internal: false, props: { level: 'json1', index: 1, difficulty: 'easy' } },
    { url: '/api/event?test=1' },
  );
  assert.deepEqual(JSON.parse(queryTest.logged[0]).internal_reasons, ['test_param']);
  assert.equal(JSON.parse(queryTest.logged[0]).props.level, 'json1');
});

test('client kit sends each event once-guarded, allowlisted, and the server accepts the payload', async () => {
  const emitted = [];
  const tel = createTelemetry({
    ...pageEnv(),
    qaMute: false,
    now: () => 1700000000000,
    transport: (payload) => emitted.push(payload),
    randomId: (() => {
      let n = 0;
      return () => `ch_id_${++n}`;
    })(),
  });
  assert.equal(tel.once('session_start', { email: 'person@example.com' }), true);
  assert.equal(tel.once('session_start', {}), false);
  assert.equal(tel.track('level_start', {
    level: 'json1',
    index: 0,
    difficulty: 'normal',
    internal: true,
    note: 'typed title should not leave the client',
  }), true);
  assert.equal(tel.track('death', { level: 'json1', index: 0, difficulty: 'normal', cause: 'hp' }), true);
  assert.equal(tel.track('play'), false);
  assert.equal(emitted.length, 3);
  assert.deepEqual(emitted.map((row) => row.name), [...EVENT_NAMES]);

  const level = emitted[1];
  assert.equal(level.props.level, 'json1');
  assert.equal(level.props.index, 0);
  assert.equal(level.props.difficulty, 'normal');
  assert.equal(level.props.note, undefined);
  assert.equal(level.props.email, undefined);
  assert.equal(level.internal, false);
  assert.deepEqual(level.internal_reasons, []);
  assert.equal(level.schema_v, 1);
  assert.equal(level.ts, 1700000000000);
  assert.ok(tel.getClientId().startsWith('ch_'));

  for (const payload of emitted) {
    const { res, logged, errors } = await prodCall(payload);
    assert.equal(res.statusCode, 204, payload.name);
    assert.equal(errors.length, 0, payload.name);
    assert.equal(logged.length, 1, payload.name);
    const rec = JSON.parse(logged[0]);
    assertRecord(rec, payload.name);
    assert.equal(rec.internal, false);
  }
});

test('?test=1 tags internal and still sends; hard mutes send nothing', () => {
  const tagged = [];
  const on = createTelemetry({
    ...pageEnv({ location: { search: '?test=1' } }),
    transport: (payload) => tagged.push(payload),
  });
  assert.equal(detectQaMute(pageEnv({ location: { search: '?test=1' } })), false);
  assert.equal(on.isQaMuted(), false);
  assert.equal(on.track('level_start', { level: 'map01', difficulty: 'easy' }), true);
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].internal, true);
  assert.ok(tagged[0].internal_reasons.includes('test_param'));
  assert.equal(detectInternal(pageEnv()).internal, false);

  const frame = { id: 'frame' };
  const top = { id: 'top' };
  const cases = [
    { location: { search: '?telemetry=0' } },
    { location: { search: '?dev=1' } },
    { location: { pathname: '/qa-runner/index.html' } },
    { self: frame, top },
    { location: { search: '?dev=1&test=1' } },
  ];
  for (const overrides of cases) {
    const emitted = [];
    const tel = createTelemetry({
      ...pageEnv(overrides),
      transport: (payload) => emitted.push(payload),
    });
    assert.equal(tel.isQaMuted(), true);
    assert.equal(detectQaMute(pageEnv(overrides)), true);
    assert.equal(tel.once('session_start', {}), false);
    assert.equal(tel.track('level_start', { level: 'json1' }), false);
    assert.equal(tel.track('death', { cause: 'hp' }), false);
    assert.equal(emitted.length, 0);
  }
});

test('a throwing transport does not escape track', () => {
  const tel = createTelemetry({
    ...pageEnv(),
    qaMute: false,
    transport() { throw new Error('beacon down'); },
  });
  assert.equal(tel.track('death', { level: 'json1', cause: 'hp' }), true);
  assert.equal(tel.isEnabled(), true);
});

test('default transport uses text/plain sendBeacon and falls back when it returns false', () => {
  const calls = [];
  let beaconResult = true;
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: CLEAN_UA,
      webdriver: false,
      sendBeacon(url, blob) { calls.push({ url, blob, kind: 'beacon' }); return beaconResult; },
    },
  });
  globalThis.fetch = (url, init) => {
    calls.push({ url, init, kind: 'fetch' });
    return Promise.reject(new Error('offline'));
  };
  try {
    const tel = createTelemetry({
      ...pageEnv(),
      navigator: { userAgent: CLEAN_UA, webdriver: false },
      qaMute: false,
      now: () => 1700000000000,
    });
    assert.equal(tel.track('death', { level: 'json1', index: 0, difficulty: 'normal', cause: 'hp' }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'beacon');
    assert.equal(calls[0].url, '/api/event');
    assert.equal(String(calls[0].blob.type).toLowerCase(), 'text/plain;charset=utf-8');

    beaconResult = false;
    calls.length = 0;
    const again = createTelemetry({
      ...pageEnv(),
      navigator: { userAgent: CLEAN_UA, webdriver: false },
      qaMute: false,
    });
    assert.equal(again.track('session_start', {}), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].kind, 'fetch');
    assert.equal(calls[1].init.headers['content-type'], 'text/plain;charset=UTF-8');
    assert.equal(calls[1].init.method, 'POST');
  } finally {
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav);
    else delete globalThis.navigator;
    globalThis.fetch = prevFetch;
  }
});
