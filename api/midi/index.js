// GET  /api/midi?packId= -> MIDI track list
// POST /api/midi { name, dataBase64, packId, bpm } -> upload a .mid (base64 JSON body, 2 MB cap)
import { readJson, send, methodGuard, guard, HttpError } from '../_lib/json.js';
import { requireSession } from '../_lib/session.js';
import { getStore, newId } from '../_lib/store.js';
import { assertCanEdit } from '../_lib/packs.js';
import { requireName, requireId, MAX_MIDI_BYTES } from '../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();
  await store.init();
  const packId = req.query?.packId ? requireId(req.query.packId, 'pack id') : null;

  if (req.method === 'GET') return send(res, 200, await store.listMidi({ packId }));

  const user = requireSession(req);
  // base64 inflates by 4/3; cap the request body a little above the decoded limit.
  const body = await readJson(req, Math.ceil(MAX_MIDI_BYTES * 1.4));
  const name = requireName(body.name, 'track name');
  const b64 = String(body.dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw new HttpError(400, 'Missing dataBase64.');

  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new HttpError(400, 'dataBase64 did not decode.');
  if (buffer.length > MAX_MIDI_BYTES) throw new HttpError(413, 'MIDI files are capped at 2 MB.');
  if (buffer.subarray(0, 4).toString('ascii') !== 'MThd') throw new HttpError(400, 'Not a standard MIDI file (no MThd header).');

  const targetPack = body.packId ? requireId(body.packId, 'pack id') : null;
  if (targetPack) assertCanEdit(await store.getPack(targetPack), user);

  const rec = {
    id: newId('midi'),
    ownerId: user.id,
    packId: targetPack,
    name,
    bytes: buffer.length,
    bpm: Number.isFinite(body.bpm) ? Math.round(body.bpm) : null,
    updatedAt: Date.now(),
  };
  return send(res, 201, await store.putMidi(rec, buffer));
});
