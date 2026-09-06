// GET  /api/packs -> canonical + published packs in levelPacks/packs.json shape (game boot).
// POST /api/packs { name } -> create a pack owned by the signed-in account.
import { readJson, send, methodGuard, guard } from '../_lib/json.js';
import { requireSession, readSession } from '../_lib/session.js';
import { emailHash } from '../_lib/store.js';
import { getStore, newId } from '../_lib/store.js';
import { packsIndex } from '../_lib/packs.js';
import { requireName, slugify } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();
  await store.init();

  if (req.method === 'GET') {
    // ?mine=1 is the editor's view: it adds the caller's unpublished packs, so it is per-user
    // and must not be cached. Without it the body is the game's public boot list.
    const sess = req.query?.mine ? readSession(req) : null;
    if (sess?.email) return send(res, 200, await packsIndex(emailHash(sess.email)));
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
