// Tiny request/response helpers for the Vercel Node functions (lifted from Sumi api/_lib/http.js).

export async function readJson(req, maxBytes = 16 * 1024 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new HttpError(413, 'Payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function methodGuard(req, res, allowed) {
  if (allowed.includes(req.method)) return false;
  res.setHeader('Allow', allowed.join(', '));
  send(res, 405, { error: 'Method not allowed' });
  return true;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Wrap a handler so thrown HttpErrors become clean JSON and anything else is a 500.
export function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message || 'Server error' });
    }
  };
}
