// POST /api/auth/request { email } -> mint a magic-link token and email it.
// With no Mailgun credentials the link is printed to the server console (dev + tests).
import crypto from 'node:crypto';
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { getStore, emailHash } from '../_lib/store.js';
import { sendMagicLink } from '../_lib/mail.js';
import { RESEND_COOLDOWN_MS, TOKEN_TTL_MS } from '../_lib/validate.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['POST'])) return;
  const store = getStore();
  await store.init();

  const { email } = await readJson(req, 4096);
  const clean = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new HttpError(400, 'Enter a valid email address.');

  const id = emailHash(clean);
  const recent = await store.getResend(id);
  if (recent?.issuedAt && Date.now() - recent.issuedAt < RESEND_COOLDOWN_MS) {
    throw new HttpError(429, 'A link was just sent. Check your inbox or try again shortly.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await store.putToken(token, { email: clean, exp: now + TOKEN_TTL_MS });
  await store.putResend(id, now);

  const base = process.env.APP_URL || `http://${req.headers.host}`;
  const link = `${base}/api/auth/verify?token=${token}`;
  const out = await sendMagicLink(clean, link);
  return send(res, 200, { ok: true, emailed: !!out.sent });
});
