// POST /api/admin/migrate[?pack=<id>&dryRun=1]
// Runs the canonical-level migration inside the deployment, where BLOB_READ_WRITE_TOKEN exists
// (the token is a sensitive env var and cannot be pulled locally). Guarded by a shared secret:
// the request must carry `x-migrate-key` equal to MIGRATE_KEY. Reads the corpus from the
// deployment's own origin because the function bundle does not carry levelPacks/.
import { getStore } from '../_lib/store.js';
import { migrateCorpus } from '../_lib/migrate.js';

function origin(req) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || req.headers.host;
  return `https://${host}`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'POST only' })); }
  const key = process.env.MIGRATE_KEY;
  if (!key || req.headers['x-migrate-key'] !== key) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }

  const url = new URL(req.url, 'http://x');
  const onlyPack = url.searchParams.get('pack');
  const dryRun = url.searchParams.get('dryRun') === '1';
  const base = origin(req);
  const lines = [];
  try {
    const store = getStore();
    const result = await migrateCorpus({
      store,
      dryRun,
      onlyPack,
      readText: async (rel) => {
        const r = await fetch(`${base}/${rel}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
        return r.text();
      },
      log: (line) => lines.push(line),
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ store: store.kind, ...result, log: lines }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err?.message || err), log: lines }));
  }
}
