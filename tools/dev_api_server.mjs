// Local stand-in for `vercel dev`: serves the static repo AND routes /api/* to the same handler
// modules Vercel would run, adapting its (req, res) contract (req.query, res.status). Uses the
// fs store, so no Blob, no Neon, no node_modules needed. Magic links print to this console.
//
//   node tools/dev_api_server.mjs            # http://localhost:5305
//   PORT=5399 EDITOR_DATA_DIR=/tmp/x node tools/dev_api_server.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5305);

process.chdir(ROOT); // store paths and levelPacks reads are cwd-relative
process.env.CH_DEV = '1';
process.env.EDITOR_STORE = process.env.EDITOR_STORE || 'fs';
if (!process.env.APP_URL) process.env.APP_URL = `http://localhost:${PORT}`;

// path pattern -> handler module. `:name` segments become req.query[name]. Longest match wins,
// which is why the more specific level routes are listed before /api/levels/:id.
const ROUTES = [
  ['/api/auth/request', 'api/auth/request.js'],
  ['/api/auth/verify', 'api/auth/verify.js'],
  ['/api/auth/me', 'api/auth/me.js'],
  ['/api/auth/logout', 'api/auth/logout.js'],
  ['/api/auth/username', 'api/auth/username.js'],
  ['/api/packs', 'api/packs/index.js'],
  ['/api/packs/:id', 'api/packs/[id].js'],
  ['/api/levels', 'api/levels/index.js'],
  ['/api/levels/:id/json', 'api/levels/[id]/json.js'],
  ['/api/levels/:id/versions', 'api/levels/[id]/versions.js'],
  ['/api/levels/:id', 'api/levels/[id]/index.js'],
  ['/api/enemies', 'api/enemies/index.js'],
  ['/api/enemies/:id', 'api/enemies/[id].js'],
  ['/api/midi', 'api/midi/index.js'],
  ['/api/midi/:id', 'api/midi/[id].js'],
  ['/api/publish/:packId', 'api/publish/[packId].js'],
];

function match(pathname) {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  for (const [pattern, mod] of ROUTES) {
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { mod, params };
  }
  return null;
}

const handlers = new Map();
async function loadHandler(mod) {
  if (!handlers.has(mod)) {
    const m = await import(pathToFileURL(path.join(ROOT, mod)).href);
    handlers.set(mod, m.default);
  }
  return handlers.get(mod);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mid': 'audio/midi', '.wad': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.join(ROOT, rel);
  // Never serve outside the repo, and never serve the local data dir.
  if (!full.startsWith(ROOT) || full.includes('.editor-data')) { res.statusCode = 403; return res.end('Forbidden'); }
  const body = await fs.readFile(full).catch(() => null);
  if (!body) { res.statusCode = 404; return res.end('Not found'); }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// Vercel's Node functions get req.query and res.status(); node:http gives neither.
function adapt(req, res, url, params) {
  req.query = { ...Object.fromEntries(url.searchParams), ...params };
  res.status = (code) => { res.statusCode = code; return res; };
  return { req, res };
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const route = url.pathname.startsWith('/api/') ? match(url.pathname) : null;
    if (route) {
      adapt(req, res, url, route.params);
      const handler = await loadHandler(route.mod);
      return void await handler(req, res);
    }
    if (url.pathname.startsWith('/api/')) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"No such endpoint"}'); }
    return void await serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: String(err.message || err) })); }
  }
});

// Only listen when run directly, so tests can import { server } and pick their own port.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(PORT, () => {
    console.log(`Cyberhell dev server  http://localhost:${PORT}`);
    console.log(`  static: ${ROOT}`);
    console.log(`  store:  fs (${process.env.EDITOR_DATA_DIR || path.join(process.cwd(), '.editor-data')})`);
    console.log('  magic links print here instead of being emailed.');
  });
}
