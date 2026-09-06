// GET    /api/levels/:id            -> level metadata + current version
// PUT    /api/levels/:id { json, note }        -> save a new version of this level
// PUT    /api/levels/:id?as=new { json, name } -> save-as: a new level in the same pack
// DELETE /api/levels/:id
import { readJson, send, methodGuard, guard, HttpError } from '../../_lib/json.js';
import { requireSession } from '../../_lib/session.js';
import { getStore } from '../../_lib/store.js';
import { assertCanEdit, writeVersion, createLevel } from '../../_lib/packs.js';
import { requireName, requireId, MAX_LEVEL_BYTES } from '../../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'PUT', 'DELETE'])) return;
  const store = getStore();
  await store.init();
  const id = requireId(req.query?.id, 'level id');

  const level = await store.getLevel(id);
  if (!level) throw new HttpError(404, 'Level not found');

  if (req.method === 'GET') {
    const versions = await store.listVersions(id);
    const current = versions.find((v) => v.id === level.currentVersionId) || versions[0] || null;
    return send(res, 200, { ...level, current, versionCount: versions.length });
  }

  const user = requireSession(req);
  assertCanEdit(await store.getPack(level.packId), user);

  if (req.method === 'DELETE') {
    await store.delLevel(id);
    return send(res, 200, { ok: true });
  }

  const body = await readJson(req, MAX_LEVEL_BYTES);
  if (!body.json) throw new HttpError(400, 'Missing level json.');

  if (String(req.query?.as || '') === 'new') {
    const name = requireName(body.name || `${level.name} copy`, 'level name');
    return send(res, 201, await createLevel({ packId: level.packId, name, json: body.json, user, note: body.note || 'save as' }));
  }

  const out = await writeVersion(level, body.json, user, body.note);
  return send(res, 200, { level: await store.getLevel(id), ...out });
});
