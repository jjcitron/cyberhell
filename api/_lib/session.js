// Stateless session tokens: HMAC-signed JSON in an httpOnly cookie. No storage, no deps.
// Lifted from Sumi api/_lib/session.js.
import crypto from 'node:crypto';
import { HttpError } from './json.js';
import { emailHash } from './store.js';

const COOKIE = 'ch_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Fail closed in the cloud: a missing secret is only tolerated in the local fs dev server,
// which sets CH_DEV=1 and has no real users to protect.
export function secret() {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.CH_DEV === '1') return 'cyberhell-dev-secret';
  throw new Error('SESSION_SECRET is not set');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(payload) {
  const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

export function readSession(req) {
  const raw = req.headers?.cookie || '';
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  return verifyToken(decodeURIComponent(match.slice(COOKIE.length + 1)));
}

export function sessionCookie(payload) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(signSession(payload))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE}`,
  ];
  if (process.env.CH_DEV !== '1') attrs.splice(2, 0, 'Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isAdminEmail(email) {
  const admin = process.env.ADMIN_EMAIL;
  return !!admin && !!email && email.toLowerCase() === admin.toLowerCase();
}

// Throws 401 unless a valid session cookie is present. `id` is the HMAC email hash used as the
// user's primary key everywhere else, so raw emails never reach the store.
export function requireSession(req) {
  const sess = readSession(req);
  if (!sess?.email) throw new HttpError(401, 'Not signed in');
  return { email: sess.email, id: emailHash(sess.email), isAdmin: isAdminEmail(sess.email) };
}
