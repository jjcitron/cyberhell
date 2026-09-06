// GET /api/midi/:id -> the .mid bytes (this is the url the level's `music` key points at).
// DELETE /api/midi/:id -> owner or admin.
import { send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore } from '../_lib/store.js';
import { requireId } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'DELETE'])) return;
  const store = getStore();
  await store.init();
  const id = requireId(req.query?.id, 'midi id');
  const rec = await store.getMidi(id);
  if (!rec) throw new HttpError(404, 'Track not found');

  if (req.method === 'DELETE') {
    const user = requireSession(req);
    if (!user.isAdmin && rec.ownerId !== user.id) throw new HttpError(403, 'That track belongs to someone else.');
    await store.delMidi(id);
    return send(res, 200, { ok: true });
  }

  const bytes = await store.getMidiBytes(id);
  if (!bytes) throw new HttpError(404, 'Track payload missing');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/midi');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(bytes);
});
