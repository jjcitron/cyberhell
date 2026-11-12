// Vercel serverless sink for anonymous Cyberhell play events.
// Logs one JSON line per accepted event and returns 204. No database write.
// Anonymous only: no accounts, no PII, no user-agent or IP logging.
// Internal tagging stores reason codes only.
// A client internal:false cannot clear a server reason.
//
// Empty, missing, and unparseable bodies return 204 and write nothing (no
// console.error). application/json, text/plain (sendBeacon) and a missing
// Content-Type are all parsed. Counts are read from Vercel runtime logs:
//   vercel logs -p cyberhell ... -j
// See docs/EVENTS.md.

import growthTag from '../js/growthTag.js';

const {
  GAME,
  SCHEMA_V,
  headerValue,
  normalizeHost,
  serverInternalReasons,
  mergeInternal,
} = growthTag;

export const ALLOWED_NAMES = new Set([
  'session_start',
  'level_start',
  'death',
  'first_input',
  'load_error',
]);

// Raw name → canonical growth type.
const TYPE_MAP = Object.freeze({
  session_start: 'session',
  level_start: 'level',
  death: 'death',
  first_input: 'first_input',
  load_error: 'load_error',
});

export const ALLOWED_PROP_KEYS = Object.freeze([
  'level',
  'index',
  'difficulty',
  'cause',
  'ms_since_load',
  'error_kind',
]);

const ALLOWED_PROPS = new Set(ALLOWED_PROP_KEYS);

const MAX_BODY_BYTES = 4096;

const RECORD_KEYS = Object.freeze([
  'game',
  'name',
  'type',
  'ts',
  'client_id',
  'session_id',
  'props',
  'internal',
  'internal_reasons',
  'host',
  'env',
  'build',
  'schema_v',
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }

  try {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // Empty, missing, and non-JSON bodies are quiet. Oversized stays a 400.
      // Neither path logs the body or the error.
      if (err && err.code === 'PAYLOAD_TOO_LARGE') {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!isPlainObject(body)) {
      res.statusCode = 204;
      res.end();
      return;
    }

    const rawName = body.name || body.type;
    const name = typeof rawName === 'string' ? rawName.toLowerCase().trim() : '';

    // No event name is "no payload": 204, no log line, no error.
    if (!name) {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!ALLOWED_NAMES.has(name)) {
      res.statusCode = 400;
      res.end('Invalid event type');
      return;
    }

    const props = {};
    const propSource = body.props && typeof body.props === 'object' && !Array.isArray(body.props)
      ? body.props
      : {};
    // Top-level allowlisted keys are accepted too. internal/schema_v are not
    // allowlisted, so they cannot fall into props.
    const incoming = { ...propSource, ...body };

    for (const key of Object.keys(incoming)) {
      if (!ALLOWED_PROPS.has(key)) continue;
      const val = incoming[key];
      if (typeof val === 'string') props[key] = val.slice(0, 80);
      else if (typeof val === 'number' && Number.isFinite(val)) props[key] = val;
      else if (typeof val === 'boolean') props[key] = val;
    }

    const clientId = typeof body.client_id === 'string' ? body.client_id.slice(0, 80) : '';
    const sessionId = typeof body.session_id === 'string' ? body.session_id.slice(0, 80) : '';
    const host = requestHost(req);
    const envName = process.env.VERCEL_ENV || '';
    const serverReasons = serverInternalReasons({
      host,
      envName,
      url: req.url || '',
      headers: req.headers || {},
      query: req.query || null,
      sessionId,
    });
    // Client false cannot clear a server reason. The UA string is not copied.
    const merged = mergeInternal(body.internal === true, body.internal_reasons, serverReasons);

    const record = {
      game: GAME,
      name,
      type: TYPE_MAP[name],
      ts: Number(body.ts) || Date.now(),
      client_id: clientId,
      session_id: sessionId,
      props,
      internal: merged.internal,
      internal_reasons: merged.reasons,
      host,
      env: envName,
      build: String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
      schema_v: SCHEMA_V,
    };

    console.log(JSON.stringify(record));

    res.statusCode = 204;
    res.end();
  } catch {
    if (!res.ended) {
      res.statusCode = 400;
      res.end('Bad Request');
    }
  }
}

export { handler, RECORD_KEYS, TYPE_MAP };

function requestHost(req) {
  const headers = req.headers || {};
  const forwarded = headerValue(headers, 'x-forwarded-host');
  const host = headerValue(headers, 'host');
  return normalizeHost(forwarded || host);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
    && !ArrayBuffer.isView(value);
}

function tooLarge() {
  const err = new Error('payload too large');
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function valueToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  if (typeof ArrayBuffer === 'function' && value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('utf8');
  }
  return '';
}

async function readJsonBody(req) {
  // application/json is already an object. An empty {} is the Vercel helper's
  // stand-in for a body it did not parse (text/plain, missing Content-Type),
  // so keep looking for raw bytes in that case.
  if (isPlainObject(req.body) && Object.keys(req.body).length > 0) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw tooLarge();
    return req.body;
  }

  const text = await readBodyText(req);
  if (Buffer.byteLength(String(text || '')) > MAX_BODY_BYTES) throw tooLarge();
  const trimmed = String(text || '').trim();
  if (!trimmed) return isPlainObject(req.body) ? req.body : {};
  return JSON.parse(trimmed);
}

async function readBodyText(req) {
  const fromBody = valueToText(req && req.body);
  if (fromBody.trim()) return fromBody;
  const fromRaw = valueToText(req && req.rawBody);
  if (fromRaw.trim()) return fromRaw;
  return readRaw(req);
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;

  function push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(buf);
  }

  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) push(chunk);
  }

  // Vercel restoreBody rewires req.read / req.on but not the async iterator,
  // so a consumed iterator can still have bytes sitting on read().
  if (chunks.length === 0 && typeof req.read === 'function') {
    let chunk;
    while ((chunk = req.read()) != null) push(chunk);
  }

  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}
