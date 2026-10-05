// Vercel serverless sink for anonymous Cyberhell game events.
// Logs one JSON line per accepted event and returns 204.
// Anonymous only: no accounts, no PII, no user agents, no IP logging.
// There is no store: counts are read from Vercel runtime logs.

const ALLOWED_TYPES = new Set([
  'session',
  'session_start',
  'play',
  'play_start'
]);

const ALLOWED_PROPS = new Set([
  'mode',
  'pack',
  'level',
  'action',
  'reason',
  'touch',
  'duration'
]);

const MAX_BODY_BYTES = 4096;

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
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const rawType = body?.type || body?.name;
    const type = typeof rawType === 'string' ? rawType.toLowerCase().trim() : '';

    if (!ALLOWED_TYPES.has(type)) {
      res.statusCode = 400;
      res.end('Invalid event type');
      return;
    }

    // Normalize to the canonical session / play names used by the scorecards.
    const canonicalType = type.startsWith('session') ? 'session' : 'play';

    const incoming = {
      ...body,
      ...(body.props && typeof body.props === 'object' ? body.props : {})
    };
    const props = {};
    for (const key of ALLOWED_PROPS) {
      const val = incoming[key];
      if (typeof val === 'string') props[key] = val.slice(0, 80);
      else if (typeof val === 'boolean' || Number.isFinite(val)) props[key] = val;
    }

    const record = {
      type: canonicalType,
      name: canonicalType,
      ts: Number(body.ts) || Date.now(),
      client_id: typeof body.client_id === 'string' ? body.client_id.slice(0, 80) : '',
      session_id: typeof body.session_id === 'string' ? body.session_id.slice(0, 80) : '',
      props
    };

    console.log(JSON.stringify(record));

    res.statusCode = 204;
    res.end();
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
  }
}

export { handler };

async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length']);
  if (declared > MAX_BODY_BYTES) throw new Error('payload too large');

  let parsed;
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_BODY_BYTES) throw new Error('payload too large');
    parsed = JSON.parse(req.body.toString('utf8') || '{}');
  } else if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw new Error('payload too large');
    parsed = JSON.parse(req.body || '{}');
  } else if (req.body && typeof req.body === 'object') {
    // Already parsed by the platform; re-measure so the cap still holds.
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw new Error('payload too large');
    parsed = req.body;
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('payload too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    parsed = text ? JSON.parse(text) : {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad body');
  return parsed;
}
