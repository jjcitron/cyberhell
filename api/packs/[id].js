// GET    /api/packs/:id -> manifest.json shape, `file` pointing at /api/levels/:id/json
// PATCH  /api/packs/:id { name?, published?, sort?, levelOrder? }
// DELETE /api/packs/:id
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { manifestFor, assertCanEdit } from '../_lib/packs.js';
import { requireName, requireId, slugify } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'PATCH', 'DELETE'])) return;
  const store = getStore();
  await store.init();
  const id = requireId(req.query?.id, 'pack id');

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return send(res, 200, await manifestFor(id));
  }

  const user = requireSession(req);
  const pack = await store.getPack(id);
  assertCanEdit(pack, user);

  if (req.method === 'DELETE') {
    await store.delPack(id);
    return send(res, 200, { ok: true });
  }

  const body = await readJson(req, 256 * 1024);
  const next = { ...pack, updatedAt: Date.now() };
  if (body.name != null) { next.name = requireName(body.name, 'pack name'); next.slug = slugify(next.name); }
  if (body.published != null) next.published = !!body.published;
  if (Number.isFinite(body.sort)) next.sort = body.sort;
  await store.putPack(next);

  // levelOrder is the reorder path: an array of level ids in the order they should play.
  if (Array.isArray(body.levelOrder)) {
    const levels = await store.listLevels(id);
    const known = new Map(levels.map((l) => [l.id, l]));
    let sort = 0;
    for (const levelId of body.levelOrder) {
      const level = known.get(String(levelId));
      if (!level) throw new HttpError(400, `Unknown level in levelOrder: ${levelId}`);
      await store.putLevel({ ...level, sort: sort++, updatedAt: Date.now() });
      known.delete(level.id);
    }
    for (const level of known.values()) await store.putLevel({ ...level, sort: sort++, updatedAt: Date.now() });
  }
  return send(res, 200, await store.getPack(id));
});
