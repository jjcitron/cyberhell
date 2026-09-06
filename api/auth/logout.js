// POST /api/auth/logout -> clear the session cookie.
import { send, methodGuard, guard } from '../_lib/json.js';
import { clearCookie } from '../_lib/session.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['POST'])) return;
  res.setHeader('Set-Cookie', clearCookie());
  return send(res, 200, { ok: true });
});
