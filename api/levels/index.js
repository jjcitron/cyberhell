// GET  /api/levels?packId= -> level metadata list for the editor.
// POST /api/levels { packId, name, json, note } -> create a level and its first version.
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { assertCanEdit, createLevel } from '../_lib/packs.js';
import { requireName, requireId, MAX_LEVEL_BYTES } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();
  await store.init();

  if (req.method === 'GET') {
    const packId = req.query?.packId ? requireId(req.query.packId, 'pack id') : null;
    return send(res, 200, await store.listLevels(packId));
  }

  const user = requireSession(req);
  const body = await readJson(req, MAX_LEVEL_BYTES);
  const packId = requireId(body.packId, 'pack id');
  const name = requireName(body.name, 'level name');
  if (!body.json) throw new HttpError(400, 'Missing level json.');

  assertCanEdit(await store.getPack(packId), user);
  const out = await createLevel({ packId, name, json: body.json, user, sort: body.sort, note: body.note });
  return send(res, 201, out);
});
