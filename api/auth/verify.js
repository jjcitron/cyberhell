// GET /api/auth/verify?token=... -> one-time token exchange for a session cookie, then redirect.
import { send, guard } from '../_lib/json.js';
import { getStore, emailHash } from '../_lib/store.js';
import { sessionCookie } from '../_lib/session.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Method not allowed' }); }
  const store = getStore();
  await store.init();

  const token = String(req.query?.token || '');
  const base = process.env.APP_URL || `http://${req.headers.host}`;
  const target = process.env.EDITOR_PATH || '/editor.html';
  const fail = (reason) => { res.writeHead(302, { Location: `${base}${target}?auth=${reason}` }); res.end(); };

  if (!token) return fail('invalid');
  const rec = await store.getToken(token);
  if (!rec) return fail('invalid');
  await store.delToken(token);
  if (Date.now() > rec.exp) return fail('expired');

  const id = emailHash(rec.email);
  const user = await store.getUser(id);
  if (!user) await store.putUser(id, { username: null, createdAt: Date.now() });

  res.writeHead(302, {
    'Set-Cookie': sessionCookie({ email: rec.email }),
    Location: `${base}${target}?auth=${user?.username ? 'welcome' : 'setup'}`,
  });
  res.end();
});
