#!/usr/bin/env node
/**
 * CYBERHELL DEAD-END NET (browser, headless)
 *
 * The safety net is the thing that guarantees nobody is ever stuck, so it
 * needs its own proof rather than "the sweep never triggered it".
 *
 *   DN-1  the net builds for a real map and marks part of it unreachable
 *   DN-2  standing in a cell the exit cannot be reached from raises the
 *         HUD prompt after ~1.5 s, and not before
 *   DN-3  standing somewhere the exit IS reachable from never raises it
 *   DN-4  holding [E] extracts the player to a cell that can reach the exit,
 *         and logs the map and position
 *
 * Usage:  node tests/qa-deadend-net.js       (QA_PORT default 8155)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8155);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const CANDIDATES = (process.env.QA_MAPS || [
  'levelPacks/pack1/json1.json', 'levelPacks/pack1/json9.json',
  'levelPacks/pack2/json5.json', 'levelPacks/pack3/json1.json'
].join(',')).split(',').filter(Boolean);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mid': 'audio/midi' };
function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/* Runs in the page: find a free cell the exit cannot be reached from, stand
   the player there, and drive real frames through updatePhysics. */
const PROBE = function () {
  const e = window.cyberEngine;
  const T = window.CyberTraversal;
  const net = T && T._rt.net;
  if (!net) return { err: 'net not built' };
  const g = net.grid;
  let stuckK = -1, freeCells = 0, reachCells = 0;
  for (let k = 0; k < g.free.length; k++) {
    if (!g.free[k]) continue;
    freeCells++;
    if (net.dist[k] >= 0) { reachCells++; continue; }
    if (stuckK < 0) stuckK = k;
  }
  if (stuckK < 0) return { err: 'no unreachable cell on this map', freeCells, reachCells };

  const put = (k) => {
    const i = k % g.w, x = g.wx(i), z = g.wz((k - i) / g.w);
    const f = e.getFloorAt(x, z);
    e.camera.position.set(x, (f.inside ? f.floorY : 0) + e.player.height, z);
    e.player.velocity.set(0, 0, 0);
    e.player.onGround = true;
    e.player.safePosition.copy(e.camera.position);
    e.player.teleGrace = 0;
    return [x, z];
  };

  // Drive the real path: updatePhysics calls checkStuck once a frame and
  // writes the HUD, so read the HUD rather than calling checkStuck directly
  // (a second call per frame with holdingUse=false would reset the hold).
  const hud = () => {
    const el = document.getElementById('hud-deadend');
    return el && el.style.opacity === '1' ? el.innerText : null;
  };
  const run = (frames, holdE) => {
    let last = null, firstAt = -1;
    e.keys['KeyE'] = !!holdE;
    for (let n = 0; n < frames; n++) {
      e.updatePhysics(1 / 60);
      last = hud();
      if (last && firstAt < 0) firstAt = n;
    }
    e.keys['KeyE'] = false;
    return { last, firstAt };
  };

  e.isRunning = true;
  e.keys = {};
  e._deadEndLog = [];
  T._rt.netTimer = 0; T._rt.holdTimer = 0;

  const stuckAt = put(stuckK);
  const early = run(60, false).last;                   // 1.0 s: too soon
  const warn = run(120, false);                        // ~2 s more: must warn
  const before = [e.camera.position.x, e.camera.position.z];
  const held = run(120, true);                         // hold [E]
  const after = [+e.camera.position.x.toFixed(2), +e.camera.position.z.toFixed(2)];
  const ai = g.cx(after[0]), aj = g.cz(after[1]);
  const landedReachable = ai >= 0 && aj >= 0 && ai < g.w && aj < g.h && net.dist[aj * g.w + ai] >= 0;

  // A cell that CAN reach the exit must never raise the prompt.
  T._rt.netTimer = 0; T._rt.holdTimer = 0;
  let okK = -1;
  let farK = -1, farD = -1;
  for (let k = 0; k < net.dist.length; k++) {
    if (net.dist[k] < 0) continue;
    if (okK < 0) okK = k;
    if (net.dist[k] > farD) { farD = net.dist[k]; farK = k; }
  }
  put(okK);
  const quiet = run(180, false);
  e.showDeadEndHint(null);

  // DN-5: somewhere the exit IS reachable from, but going nowhere. Stand on
  // the cell furthest from the exit and burn past the no-progress window
  // without ever getting closer.
  T._rt.netTimer = 0; T._rt.holdTimer = 0; T._rt.stallT = 0; T._rt.bestDist = Infinity;
  put(farK);
  e.keys = {};
  let stallPrompt = null, stallAt = -1;
  for (let n2 = 0; n2 < 70 * 60; n2++) {
    // No movement input at all, so distance-to-exit can never improve.
    e.player.velocity.set(0, 0, 0);
    e.updatePhysics(1 / 60);
    const h = hud();
    if (h && stallAt < 0) { stallAt = n2; stallPrompt = h; }
  }
  const stallSeconds = stallAt < 0 ? -1 : +(stallAt / 60).toFixed(1);
  e.showDeadEndHint(null);

  return {
    freeCells, reachCells, stuckAt: stuckAt.map(v => +v.toFixed(1)),
    early, warned: warn.last, warnFirstAt: warn.firstAt,
    moved: Math.hypot(after[0] - before[0], after[1] - before[1]) > 1,
    after, landedReachable, log: e._deadEndLog.length,
    quiet: quiet.last,
    stallPrompt, stallSeconds, farD
  };
};

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`); }

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 60000 });
    let settled = '';
    for (let i = 0; i < 40; i++) {
      const now = await page.evaluate(() => window.cyberEngine.levelData.name);
      if (now === settled) break;
      settled = now; await page.waitForTimeout(400);
    }

    let r = null, used = null;
    for (const f of CANDIDATES) {
      const want = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).name;
      await page.evaluate(x => window.cyberEngine.loadLevelFromFile(x, false), f);
      await page.waitForFunction(n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n, want, { timeout: 120000 });
      await page.waitForFunction(() => !!(window.CyberTraversal && window.CyberTraversal._rt.net), null, { timeout: 60000 });
      const out = await page.evaluate(fn => new Function('return ' + fn)()(), PROBE.toString());
      console.log(`  ${f}: ${JSON.stringify(out).slice(0, 200)}`);
      if (!out.err) { r = out; used = f; break; }
    }
    if (!r) {
      check('DN-1 net marks part of a map unreachable', false, 'no candidate map had an unreachable cell');
    } else {
      check('DN-1 net builds and marks part of the map unreachable', true,
        `${used}: ${r.reachCells}/${r.freeCells} free cells can still reach the exit`);
      check('DN-2 prompt appears only after the dwell time', !r.early && !!r.warned && r.warnFirstAt >= 0,
        `at 1.0s: ${JSON.stringify(r.early)}; after: ${JSON.stringify(r.warned)} (frame ${r.warnFirstAt}) from ${JSON.stringify(r.stuckAt)}`);
      check('DN-3 no prompt where the exit is reachable', !r.quiet, `${JSON.stringify(r.quiet)}`);
      check('DN-5 no progress toward the exit for 60 s raises the same prompt',
        r.stallSeconds >= 55 && r.stallSeconds <= 65 && /HOLD \[E\]/.test(r.stallPrompt || ''),
        `prompt after ${r.stallSeconds}s (want ~60) from the cell ${r.farD} steps out: ${JSON.stringify(r.stallPrompt)}`);
      check('DN-4 holding [E] extracts to a cell that can reach the exit',
        r.moved && r.landedReachable && r.log === 1,
        `moved=${r.moved} to ${JSON.stringify(r.after)} reachable=${r.landedReachable} logged=${r.log}`);
    }
    check('page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
