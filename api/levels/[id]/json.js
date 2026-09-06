// GET /api/levels/:id/json[?version=] -> the raw level JSON, exactly as the game's loader wants it.
// This is the `file` value handed out by /api/packs/:id, so index.html needs no format changes.
import { send, guard } from '../../_lib/json.js';
import { getStore } from '../../_lib/store.js';
import { levelJson } from '../../_lib/packs.js';
import { requireId } from '../../_lib/validate.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Method not allowed' }); }
  await getStore().init();
  const id = requireId(req.query?.id, 'level id');
  const version = req.query?.version ? requireId(req.query.version, 'version id') : null;
  const { text } = await levelJson(id, version);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  // A version id names one content-addressed payload, so that form is immutable. The bare form
  // follows the level's current version and changes on every save -- caching it hands the editor
  // (and the game) a stale level right after a save, so it must revalidate every time.
  res.setHeader('Cache-Control', version ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.end(text);
});
