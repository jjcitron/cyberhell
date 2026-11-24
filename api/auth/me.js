// GET /api/auth/me -> { email, username, isAdmin, apps } from the session cookie, or 401.
// `apps` is the shared-spine membership list: which Acidlemon titles this one account has
// signed in to. Cyberhell is always in it by the time this resolves.
import { send, guard } from '../_lib/json.js';
import { requireSession, APP_ID } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';

export default guard(async function handler(req, res) {
  const user = requireSession(req);
  const store = getStore();
  await store.init();
  // A session minted before the spine landed has no user_apps row yet; backfill on first read
  // so an existing editor does not have to sign out and back in to join the shared spine.
  // The user row is created first because user_apps.user_id is a foreign key onto it.
  let rec = await store.getUser(user.id);
  if (!rec) rec = await store.putUser(user.id, { username: null, createdAt: Date.now() });
  let apps = await store.listUserApps(user.id);
  if (!apps.includes(APP_ID)) {
    await store.putUserApp(user.id, APP_ID);
    apps = await store.listUserApps(user.id);
  }
  return send(res, 200, { email: user.email, username: rec?.username || null, isAdmin: user.isAdmin, apps });
});
