// Owner-scoped cloud saves for the Sumi: Cyberhell grid editor.
import { readJson, send, methodGuard, guard } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore, newId, sha256 } from '../_lib/store.js';
import { MAX_SUMI_LEVEL_BYTES, requireSumiLevelName, validateSumiLevel } from '../_lib/sumi_validate.js';

const invalid = (res, errors) => send(res, 400, { error: 'Invalid Sumi level.', errors });

async function touchSumiMembership(store, user) {
  if (!await store.getUser(user.id)) await store.putUser(user.id, { username: null, createdAt: Date.now() });
  await store.putUserApp(user.id, 'sumi');
}

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const user = requireSession(req);
  const store = getStore();
  await store.init();
  await touchSumiMembership(store, user);

  if (req.method === 'GET') {
    const levels = await store.listSumiLevels(user.id);
    return send(res, 200, levels.map((level) => ({
      id: level.id,
      name: level.name,
      updatedAt: level.updatedAt,
      createdAt: level.createdAt,
      bytes: level.bytes,
      sourceLevelId: level.sourceLevelId ?? null,
    })));
  }

  const body = await readJson(req);
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_SUMI_LEVEL_BYTES) {
    return invalid(res, [`Request payload must not exceed ${MAX_SUMI_LEVEL_BYTES} bytes.`]);
  }
  let name;
  try { name = requireSumiLevelName(body.name); }
  catch (err) { return invalid(res, [err.message]); }
  const checked = validateSumiLevel(body.level);
  if (!checked.ok) return invalid(res, checked.errors);

  const text = JSON.stringify(body.level);
  const now = Date.now();
  const level = await store.putSumiLevel({
    id: newId('sumi'),
    ownerId: user.id,
    name,
    sourceLevelId: typeof body.level.id === 'string' && body.level.id ? body.level.id : null,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    createdAt: now,
    updatedAt: now,
  }, text);
  return send(res, 201, { id: level.id, name: level.name, updatedAt: level.updatedAt, createdAt: level.createdAt });
});
