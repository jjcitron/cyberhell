// POST /api/publish/:packId { published? } -> list a creator pack on the game's pack menu.
// A pack with no levels cannot be published; publishing is idempotent.
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { assertCanEdit } from '../_lib/packs.js';
import { requireId } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['POST'])) return;
  const store = getStore();
  await store.init();
  const user = requireSession(req);
  const packId = requireId(req.query?.packId, 'pack id');

  const pack = await store.getPack(packId);
  assertCanEdit(pack, user);

  const body = await readJson(req, 16 * 1024);
  const published = body.published === undefined ? true : !!body.published;
  if (published && !(await store.listLevels(packId)).length) {
    throw new HttpError(400, 'Add at least one level before publishing.');
  }

  const me = await store.getUser(user.id);
  if (published && !me?.username) throw new HttpError(400, 'Claim a username before publishing.');

  await store.putPack({ ...pack, published, updatedAt: Date.now() });
  return send(res, 200, await store.getPack(packId));
});
