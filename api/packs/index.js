// GET  /api/packs -> canonical + published packs in levelPacks/packs.json shape (game boot).
// POST /api/packs { name } -> create a pack owned by the signed-in account.
import { readJson, send, methodGuard, guard } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore, newId } from '../_lib/store.js';
import { packsIndex } from '../_lib/packs.js';
import { requireName, slugify } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();
  await store.init();

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return send(res, 200, await packsIndex());
  }

  const user = requireSession(req);
  const body = await readJson(req, 64 * 1024);
  const name = requireName(body.name, 'pack name');
  const pack = {
    id: newId('pack'),
    slug: slugify(name),
    name,
    ownerId: user.id,
    isCanonical: false,
    published: false,
    sort: (await store.listPacks()).length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.putPack(pack);
  return send(res, 201, pack);
});
