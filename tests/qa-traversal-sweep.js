#!/usr/bin/env node
/**
 * CYBERHELL TRAVERSAL SWEEP (browser, headless, all 198 maps)
 *
 * For every converted map: take the route the offline walk model produces
 * (js/cyber-traversal.js, the same file the engine loads for its dead-end
 * net) and walk it in the REAL engine, through updatePhysics /
 * resolveWallCollisions / getFloorAt / the lift, teleporter and switch code.
 *
 * Per map it asserts:
 *   TS-1  the offline model finds a route to the exit at all
 *   TS-2  the engine actually arrives within use range of the exit switch
 *   TS-3  zero frames off floor geometry during the walk
 *   TS-4  zero wall penetrations (standing inside a solid wall that spans
 *         the player's body) during the walk
 *   TS-5  the dead-end safety net never had to fire
 *
 * This is a long run. Redirect it and read the log as it lands:
 *   node tests/qa-traversal-sweep.js > sweep.log 2>&1
 * Options (env):
 *   QA_PORT   static server port (default 8151)
 *   QA_LIMIT  only sweep the first N maps
 *   QA_PACKS  comma-separated pack ids to include (default: all)
 *   QA_ONLY   comma-separated pack/id pairs, e.g. pack1/json10,pack2/json5
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToExit } = require('./reachability.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8151);
const LIMIT = Number(process.env.QA_LIMIT || 0);
const ONLY = (process.env.QA_PACKS || '').split(',').filter(Boolean);
// QA_ONLY=pack1/json10,pack2/json5 re-runs an exact set, which is how you
// re-check the maps a previous sweep failed without waiting for all 198.
const ONLY_MAPS = (process.env.QA_ONLY || '').split(',').filter(Boolean);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

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

function allMaps() {
  const packs = JSON.parse(fs.readFileSync(path.join(ROOT, 'levelPacks', 'packs.json'), 'utf8'));
  const out = [];
  for (const p of packs) {
    if (ONLY.length && !ONLY.includes(p.id)) continue;
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, p.manifest), 'utf8'));
    for (const lv of man) out.push({ pack: p.id, id: lv.id, file: lv.file, name: lv.name });
  }
  const picked = ONLY_MAPS.length ? out.filter(m => ONLY_MAPS.includes(`${m.pack}/${m.id}`)) : out;
  return LIMIT ? picked.slice(0, LIMIT) : picked;
}

/* ---------------------------------------------------------------------------
   Runs inside the page. Steers by writing velocity so movement still goes
   through the engine's own physics, and samples the invariants as it goes.
   A waypoint tagged 'tp' is the far side of a teleporter: we do not walk to
   it, the engine puts us there when we touch the trigger.
   --------------------------------------------------------------------------- */
const WALK = function (route) {
  const e = window.cyberEngine;
  e.isRunning = true;
  e.keys = {};
  let offFloor = 0, inWall = 0, frames = 0, reached = 0, teleports = 0;
  let firstMiss = null;
  const R = 0.55, H = e.player.height;
  const example = [];

  const penetrating = () => {
    const p = e.camera.position, feet = p.y - H, head = p.y;
    for (const w of e.wallsNear(p.x, p.z, R)) {
      if (!w.solid) continue;
      if (w.topY !== undefined && w.topY <= feet + 0.05) continue;
      if (w.bottomY !== undefined && w.bottomY >= head) continue;
      const ax = w.p1.x, az = w.p1.z, bx = w.p2.x, bz = w.p2.z;
      const vx = bx - ax, vz = bz - az;
      const c2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.z - az) * vz) / c2));
      if (Math.hypot(p.x - (ax + t * vx), p.z - (az + t * vz)) < R - 0.08) return true;
    }
    return false;
  };

  const step = () => {
    e.updatePhysics(1 / 60);
    frames++;
    if (frames % 4 === 0) {
      if (!e.getFloorAt(e.camera.position.x, e.camera.position.z).inside) {
        offFloor++;
        if (example.length < 3) example.push(['offFloor', +e.camera.position.x.toFixed(1), +e.camera.position.z.toFixed(1)]);
      } else if (penetrating()) {
        inWall++;
        if (example.length < 3) example.push(['inWall', +e.camera.position.x.toFixed(1), +e.camera.position.z.toFixed(1)]);
      }
    }
  };

  for (let n = 0; n < route.length; n++) {
    const wp = route[n];
    const tx = wp[0], tz = wp[1];
    if (wp[2] === 'tp') {
      // The previous waypoint stood on the trigger. Give the engine a few
      // frames to notice, then accept wherever it dropped us.
      for (let g = 0; g < 30 && Math.hypot(tx - e.camera.position.x, tz - e.camera.position.z) > 3; g++) step();
      if (Math.hypot(tx - e.camera.position.x, tz - e.camera.position.z) <= 3) { reached++; teleports++; continue; }
      // No teleport happened: fall through and try to walk there, which will
      // fail loudly rather than silently skipping the hop.
    }
    let guard = 0, best = Infinity, stale = 0;
    while (guard++ < 2400) {
      const dx = tx - e.camera.position.x, dz = tz - e.camera.position.z;
      const L = Math.hypot(dx, dz);
      if (L < 0.15) break;
      // Be patient while a lift is actually in motion: a real player waits
      // for it instead of concluding the route is impossible.
      const moving = !!(window.CyberTraversal && window.CyberTraversal._rt.active.length);
      if (L < best - 0.01) { best = L; stale = 0; }
      else if (++stale > (moving ? 600 : 240)) break;
      // Stuck? Jump. The mantle (a jump plus the auto-climb measured from the
      // feet) is how a player gets onto a ledge, so a harness that never
      // jumps tests half the movement code. The obstacle is often a riser
      // between here and the waypoint rather than at the waypoint itself, so
      // do not condition this on the target's own floor height.
      if (stale > 40 && stale % 25 === 0) e.jump();
      // Walking straight at the waypoint grinds on corners in a way no
      // player does. When progress stalls, slide along the obstacle: a
      // perpendicular component that flips direction every so often is the
      // cheapest stand-in for a human strafing round a pillar.
      let vx = dx / L, vz = dz / L;
      if (stale > 20) {
        const sgn = (Math.floor(stale / 60) % 2) ? 1 : -1;
        vx += -vz * sgn * 0.9; vz += (dx / L) * sgn * 0.9;
        const m = Math.hypot(vx, vz) || 1;
        vx /= m; vz /= m;
      }
      e.player.velocity.x = vx * 6;
      e.player.velocity.z = vz * 6;
      step();
    }
    if (Math.hypot(tx - e.camera.position.x, tz - e.camera.position.z) < 0.4) reached++;
    else if (!firstMiss) firstMiss = {
      i: n, want: [tx, tz],
      at: [+e.camera.position.x.toFixed(2), +e.camera.position.z.toFixed(2)],
      y: +e.camera.position.y.toFixed(2),
      floor: e.getFloorAt(e.camera.position.x, e.camera.position.z),
      wantFloor: e.getFloorAt(tx, tz)
    };
  }

  let toExit = Infinity;
  for (const w of (e.exitWalls || [])) {
    const vx = w.p2.x - w.p1.x, vz = w.p2.z - w.p1.z;
    const t = Math.max(0, Math.min(1, ((e.camera.position.x - w.p1.x) * vx + (e.camera.position.z - w.p1.z) * vz) / (vx * vx + vz * vz || 1)));
    toExit = Math.min(toExit, Math.hypot(e.camera.position.x - (w.p1.x + t * vx), e.camera.position.z - (w.p1.z + t * vz)));
  }
  return {
    atExit: toExit <= 4.5, toExit: +toExit.toFixed(2),
    reached, total: route.length, frames, offFloor, inWall, teleports, example, firstMiss,
    at: [+e.camera.position.x.toFixed(2), +e.camera.position.z.toFixed(2)],
    deadEnds: (e._deadEndLog || []).length
  };
};

/* ------------------------------------------------------------------------- */
(async () => {
  const maps = allMaps();
  console.log(`sweeping ${maps.length} maps on port ${PORT}\n`);
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  const rows = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 60000 });
    // The page boots MAP01 then fetches the first pack level over it; let that
    // settle before we start loading maps ourselves.
    let settled = '';
    for (let i = 0; i < 40; i++) {
      const now = await page.evaluate(() => window.cyberEngine.levelData.name);
      if (now === settled) break;
      settled = now;
      await page.waitForTimeout(400);
    }

    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      const tag = `${m.pack}/${m.id}`;
      const errBefore = pageErrors.length;
      let level;
      try {
        level = JSON.parse(fs.readFileSync(path.join(ROOT, m.file), 'utf8'));
      } catch (e) {
        rows.push({ tag, ok: false, why: 'unreadable json: ' + e.message });
        console.log(`FAIL  ${tag}  unreadable json`);
        continue;
      }
      const t0 = Date.now();
      let route = null;
      try { route = pathToExit(level, 0.25); } catch (e) { /* reported below */ }
      if (!route) {
        rows.push({ tag, ok: false, why: 'TS-1 offline model found no route to the exit' });
        console.log(`FAIL  ${tag}  TS-1 no route`);
        continue;
      }
      try {
        await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), m.file);
        await page.waitForFunction(
          n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n,
          level.name, { timeout: 180000 });
        // The dead-end net builds on a timer after load; wait for it so
        // TS-5 is a real observation and not a race.
        await page.waitForFunction(
          () => !!(window.CyberTraversal && window.CyberTraversal._rt.net), null, { timeout: 60000 }
        ).catch(() => { });
        await page.evaluate(sp => {
          const e = window.cyberEngine;
          e._deadEndLog = [];
          const f = e.getFloorAt(sp[0], sp[2]);
          e.camera.position.set(sp[0], (f.inside ? f.floorY : sp[1]) + e.player.height, sp[2]);
          e.player.velocity.set(0, 0, 0);
          e.player.onGround = true;
          e.player.safePosition.copy(e.camera.position);
        }, level.playerSpawn.pos);
      } catch (e) {
        rows.push({ tag, ok: false, why: 'load failed: ' + e.message });
        console.log(`FAIL  ${tag}  load failed`);
        continue;
      }
      let r;
      try {
        r = await page.evaluate(([fn, rt]) => new Function('return ' + fn)()(rt), [WALK.toString(), route]);
      } catch (e) {
        rows.push({ tag, ok: false, why: 'walk threw: ' + e.message });
        console.log(`FAIL  ${tag}  walk threw ${e.message}`);
        continue;
      }
      const newErrs = pageErrors.slice(errBefore);
      const ok = r.atExit && r.offFloor === 0 && r.inWall === 0 && r.deadEnds === 0 && newErrs.length === 0;
      rows.push({ tag, ok, ...r, errs: newErrs.length });
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${tag.padEnd(16)} ` +
        `exit=${r.atExit ? 'yes' : 'NO(' + r.toExit + ')'} ` +
        `wp=${r.reached}/${r.total} frames=${r.frames} tp=${r.teleports} ` +
        `offFloor=${r.offFloor} inWall=${r.inWall} deadEnd=${r.deadEnds} err=${newErrs.length} ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (ok ? '' : '  ' + JSON.stringify(r.firstMiss || r.example) + (newErrs.length ? ' ' + newErrs[0].slice(0, 120) : ''))
      );
    }
  } finally {
    await browser.close();
    server.close();
  }

  const fail = rows.filter(r => !r.ok);
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  console.log('\n================ SWEEP SUMMARY ================');
  console.log(`maps           ${rows.length}`);
  console.log(`pass           ${rows.length - fail.length}`);
  console.log(`fail           ${fail.length}`);
  console.log(`teleports used ${sum('teleports')}`);
  console.log(`off-floor      ${sum('offFloor')}`);
  console.log(`wall penetr.   ${sum('inWall')}`);
  console.log(`dead-end fires ${sum('deadEnds')}`);
  if (fail.length) {
    console.log('\nfailures:');
    for (const f of fail) console.log(`  ${f.tag}  ${f.why || JSON.stringify({ exit: f.toExit, offFloor: f.offFloor, inWall: f.inWall, deadEnds: f.deadEnds, errs: f.errs })}`);
  }
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
