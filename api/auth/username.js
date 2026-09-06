// POST /api/auth/username { username } -> claim a unique username for the signed-in account.
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { validateUsername } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['POST'])) return;
  const user = requireSession(req);
  const store = getStore();
  await store.init();

  const { username } = await readJson(req, 4096);
  const name = String(username || '').trim();
  const fmtError = validateUsername(name);
  if (fmtError) throw new HttpError(400, fmtError);

  const lower = name.toLowerCase();
  const owner = await store.getUsernameOwner(lower);
  if (owner && owner !== user.id) throw new HttpError(409, 'That username is taken.');

  const prior = await store.getUser(user.id);
  if (prior?.username && prior.username.toLowerCase() !== lower) {
    await store.setUsernameOwner(prior.username.toLowerCase(), null);
  }
  await store.setUsernameOwner(lower, user.id);
  await store.putUser(user.id, { username: name, createdAt: prior?.createdAt || Date.now() });
  return send(res, 200, { ok: true, username: name });
});
