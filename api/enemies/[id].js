// GET | PUT | DELETE /api/enemies/:id -- owner or admin only for writes.
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { requireName, requireId } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'PUT', 'DELETE'])) return;
  const store = getStore();
  await store.init();
  const id = requireId(req.query?.id, 'enemy id');
  const enemy = await store.getEnemy(id);
  if (!enemy) throw new HttpError(404, 'Enemy not found');

  if (req.method === 'GET') return send(res, 200, enemy);

  const user = requireSession(req);
  if (!user.isAdmin && enemy.ownerId !== user.id) throw new HttpError(403, 'That enemy belongs to someone else.');

  if (req.method === 'DELETE') {
    await store.delEnemy(id);
    return send(res, 200, { ok: true });
  }

  const body = await readJson(req, 512 * 1024);
  const next = { ...enemy, updatedAt: Date.now() };
  if (body.name != null) next.name = requireName(body.name, 'enemy name');
  if (body.baseType != null) next.baseType = String(body.baseType).slice(0, 64);
  if (body.def != null) {
    if (typeof body.def !== 'object') throw new HttpError(400, 'Enemy def must be an object.');
    next.def = body.def;
  }
  if (body.packId !== undefined) next.packId = body.packId ? requireId(body.packId, 'pack id') : null;
  return send(res, 200, await store.putEnemy(next));
});
