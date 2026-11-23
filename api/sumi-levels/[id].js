// GET | PUT | DELETE /api/sumi-levels/:id -- deliberately returns 404 across owner boundaries.
import { readJson, send, methodGuard, guard } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore, sha256 } from '../_lib/store.js';
import { requireId } from '../_lib/validate.js';
import { MAX_SUMI_LEVEL_BYTES, requireSumiLevelName, validateSumiLevel } from '../_lib/sumi_validate.js';

const invalid = (res, errors) => send(res, 400, { error: 'Invalid Sumi level.', errors });

async function touchSumiMembership(store, user) {
  if (!await store.getUser(user.id)) await store.putUser(user.id, { username: null, createdAt: Date.now() });
  await store.putUserApp(user.id, 'sumi');
}

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'PUT', 'DELETE'])) return;
  const user = requireSession(req);
  const store = getStore();
  await store.init();
  await touchSumiMembership(store, user);
  const id = requireId(req.query?.id, 'Sumi level id');
  const existing = await store.getSumiLevel(id);
  if (!existing || existing.ownerId !== user.id) return send(res, 404, { error: 'Sumi level not found' });

  if (req.method === 'GET') return send(res, 200, {
    id: existing.id,
    name: existing.name,
    updatedAt: existing.updatedAt,
    createdAt: existing.createdAt,
    level: existing.level,
  });

  if (req.method === 'DELETE') {
    await store.deleteSumiLevel(id);
    return send(res, 200, { ok: true });
  }

  const body = await readJson(req);
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_SUMI_LEVEL_BYTES) {
    return invalid(res, [`Request payload must not exceed ${MAX_SUMI_LEVEL_BYTES} bytes.`]);
  }
  let name = existing.name;
  if (body.name !== undefined) {
    try { name = requireSumiLevelName(body.name); }
    catch (err) { return invalid(res, [err.message]); }
  }
  const checked = validateSumiLevel(body.level);
  if (!checked.ok) return invalid(res, checked.errors);

  const text = JSON.stringify(body.level);
  const level = await store.putSumiLevel({
    ...existing,
    name,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    updatedAt: Date.now(),
  }, text);
  return send(res, 200, { id: level.id, name: level.name, updatedAt: level.updatedAt });
});
