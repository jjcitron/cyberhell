// GET /api/auth/me -> { email, username, isAdmin } from the session cookie, or 401.
import { send, guard } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';

export default guard(async function handler(req, res) {
  const user = requireSession(req);
  const store = getStore();
  await store.init();
  const rec = await store.getUser(user.id);
  return send(res, 200, { email: user.email, username: rec?.username || null, isAdmin: user.isAdmin });
});
