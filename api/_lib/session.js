// Stateless session tokens: HMAC-signed JSON in an httpOnly cookie. No storage, no deps.
// Lifted from Sumi api/_lib/session.js, then folded onto the shared Acidlemon identity spine
// (job 20260903-0836): one cookie on .acidlemon.com, one users table, per-title membership in
// user_apps. Cyberhell is a consumer of that spine, not a login of its own.
import crypto from 'node:crypto';
import { HttpError } from './json.js';
import { emailHash } from './store.js';

// Shared across every Acidlemon title. Must match whatever the other titles set; changing it
// here alone silently signs everyone out of this one. ch_session is the pre-spine Cyberhell
// name, still read so the fold does not log existing editors out.
const COOKIE = 'al_session';
const LEGACY_COOKIE = 'ch_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Which title this deployment is. The row this writes into user_apps is what makes one account
// span Cyberhell, Sumi, Space Runner and Clash instead of four disconnected accounts.
export const APP_ID = process.env.APP_ID || 'cyberhell';

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

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function readSession(req) {
  const token = readCookie(req, COOKIE) || readCookie(req, LEGACY_COOKIE);
  return token ? verifyToken(token) : null;
}

// The cookie is only scoped to .acidlemon.com on an acidlemon.com host. Vercel preview
// deployments live on *.vercel.app, where a browser drops a Domain it does not own -- scoping
// unconditionally would break sign-in on every preview.
export function cookieDomain(req) {
  const explicit = process.env.COOKIE_DOMAIN;
  if (explicit) return explicit === 'none' ? null : explicit;
  const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
  return host === 'acidlemon.com' || host.endsWith('.acidlemon.com') ? '.acidlemon.com' : null;
}

export function sessionCookie(payload, req) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(signSession(payload))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE}`,
  ];
  if (process.env.CH_DEV !== '1') attrs.splice(2, 0, 'Secure');
  const domain = cookieDomain(req);
  if (domain) attrs.push(`Domain=${domain}`);
  return attrs.join('; ');
}

// Clears both names, and clears the shared one on both scopes: a cookie set with a Domain is a
// different cookie from one set without, so signing out has to name both or one survives.
export function clearCookie(req) {
  const domain = cookieDomain(req);
  const kill = (name, dom) =>
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${dom ? `; Domain=${dom}` : ''}`;
  const out = [kill(COOKIE, null), kill(LEGACY_COOKIE, null)];
  if (domain) out.push(kill(COOKIE, domain));
  return out;
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
