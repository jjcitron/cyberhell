// GET  /api/enemies?packId= -> custom enemy definitions visible to the caller
// POST /api/enemies { name, baseType, def, packId } -> create one
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore, newId } from '../_lib/store.js';
import { assertCanEdit } from '../_lib/packs.js';
import { requireName, requireId } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();
  await store.init();
  const packId = req.query?.packId ? requireId(req.query.packId, 'pack id') : null;

  if (req.method === 'GET') return send(res, 200, await store.listEnemies({ packId }));

  const user = requireSession(req);
  const body = await readJson(req, 512 * 1024);
  const name = requireName(body.name, 'enemy name');
  if (!body.def || typeof body.def !== 'object') throw new HttpError(400, 'Missing enemy def.');
  const targetPack = body.packId ? requireId(body.packId, 'pack id') : null;
  if (targetPack) assertCanEdit(await store.getPack(targetPack), user);

  const enemy = {
    id: newId('enemy'),
    ownerId: user.id,
    packId: targetPack,
    name,
    baseType: body.baseType ? String(body.baseType).slice(0, 64) : null,
    def: body.def,
    updatedAt: Date.now(),
  };
  await store.putEnemy(enemy);
  return send(res, 201, enemy);
});
