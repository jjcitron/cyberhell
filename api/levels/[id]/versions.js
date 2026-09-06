// GET /api/levels/:id/versions -> version history, newest first.
import { send, guard, HttpError } from '../../_lib/json.js';
import { getStore } from '../../_lib/store.js';
import { requireId } from '../../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Method not allowed' }); }
  const store = getStore();
  await store.init();
  const id = requireId(req.query?.id, 'level id');
  const level = await store.getLevel(id);
  if (!level) throw new HttpError(404, 'Level not found');
  return send(res, 200, { levelId: id, currentVersionId: level.currentVersionId, versions: await store.listVersions(id) });
});
