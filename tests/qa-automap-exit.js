#!/usr/bin/env node
/**
 * CYBERHELL AUTOMAP / EXIT REGRESSION CHECK
 *
 * Covers the two failures reported on 2026-09-03:
 *
 *   CH-QA-10  The automap player marker must track while the map is open.
 *             drawAutomap() used to run only from toggleAutomap(), so the
 *             marker froze wherever the player stood when TAB was pressed even
 *             though movement kept working. Proved by holding the map open,
 *             walking, and reading the marker position back off the canvas
 *             pixels - not off engine state, which was never the bug.
 *
 *   CH-QA-11  The automap must mark the exit, so the way out is findable from
 *             the map instead of by exhaustive search.
 *
 *   CH-QA-12  The exit must be reachable from spawn. tests/reachability.js
 *             computes a route offline; this drives that route through the
 *             engine's own updatePhysics/resolveWallCollisions/getFloorAt, so
 *             a wall still sealing the way shows up as a stalled leg.
 *
 *   CH-QA-13  Standing at the exit switch and pressing USE must end the level.
 *
 * CH-QA-12 and CH-QA-13 run against every level named in QA_LEVELS (default:
 * the built-in MAP01 plus the pack level the page loads on startup).
 *
 * Usage:
 *   node tests/qa-automap-exit.js
 *   QA_LEVELS=levelPacks/pack3/json7.json node tests/qa-automap-exit.js
 *
 * Needs puppeteer-core and a Chrome binary (CHROME_PATH). Set NODE_PATH if
 * puppeteer-core lives outside this repo, which has no package.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { pathToExit, exitWalls, wallPoints } = require('./reachability.js');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mid': 'audio/midi'
};

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* The player arrow is pure #00ffff and nothing else on the map uses it. */
const FIND_MARKER = `(() => {
  const c = document.getElementById('automap-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 60 && d[i+1] > 200 && d[i+2] > 200) {
      const p = i / 4; sx += p % c.width; sy += Math.floor(p / c.width); n++;
    }
  }
  return n ? { x: sx / n, y: sy / n, px: n } : null;
})()`;

/* The exit marker, ring and bearing line are #ffee00. */
const COUNT_EXIT_PIXELS = `(() => {
  const c = document.getElementById('automap-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] > 190 && d[i+2] < 90) n++;
  return n;
})()`;

/* Walk the engine along waypoints. Steering writes velocity, so movement still
   goes through resolveWallCollisions and getFloorAt - the code under test. */
function WALK(route) {
  const e = window.cyberEngine;
  const log = [];
  for (const [tx, tz] of route) {
    let guard = 0;
    while (guard++ < 1200) {
      const dx = tx - e.camera.position.x, dz = tz - e.camera.position.z;
      const L = Math.hypot(dx, dz);
      if (L < 1.0) break;
      e.player.velocity.x = (dx / L) * 6;
      e.player.velocity.z = (dz / L) * 6;
      e.updatePhysics(1 / 60);
    }
    const gap = Math.hypot(tx - e.camera.position.x, tz - e.camera.position.z);
    log.push({ tx, tz, x: +e.camera.position.x.toFixed(2), z: +e.camera.position.z.toFixed(2),
               arrived: gap < 1.6 });
  }
  return log;
}

function LOAD_LEVEL(f) { window.cyberEngine.loadLevelFromFile(f, false); }

/* The built-in MAP01 never comes from a file, so swap it in directly using the
   same teardown loadLevelFromFile performs. MAP01_DATA is a top-level const,
   which lives in the global lexical scope and is reachable by name. */
function LOAD_BUILTIN_MAP01() {
  const e = window.cyberEngine;
  while (e.scene.children.length > 0) e.scene.remove(e.scene.children[0]);
  e.scene.add(e.camera);
  e.walls = []; e.doors = {}; e.switches = {}; e.enemies = [];
  e.pickups = []; e.barrels = []; e.projectiles = []; e.particles = [];
  e.loadLevel(MAP01_DATA);            // eslint-disable-line no-undef
  return e.levelData.name;
}

function RESET_TO_SPAWN(sp) {
  const e = window.cyberEngine;
  const f = e.getFloorAt(sp[0], sp[2]);
  e.camera.position.set(sp[0], (f.inside ? f.floorY : 0) + e.player.height, sp[2]);
  e.player.safePosition.copy(e.camera.position);
  e.player.velocity.set(0, 0, 0);
  e.isVictory = false;
}

/* Face the exit switch from whichever side the player can stand on and USE. */
const PRESS_EXIT = `(() => {
  const e = window.cyberEngine;
  const w = e.exitWalls[0];
  const mx = (w.p1.x + w.p2.x) / 2, mz = (w.p1.z + w.p2.z) / 2;
  const dx = w.p2.x - w.p1.x, dz = w.p2.z - w.p1.z;
  const L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L, nz = dx / L;
  // Try both faces: only one of them has floor the player can occupy.
  for (const s of [1, -1]) {
    for (const back of [1.6, 2.4, 3.2]) {
      const px = mx + nx * s * back, pz = mz + nz * s * back;
      if (!e.getFloorAt(px, pz).inside) continue;
      e.camera.position.set(px, e.getFloorAt(px, pz).floorY + e.player.height, pz);
      e.camera.rotation.order = 'YXZ';
      e.camera.rotation.set(0, Math.atan2(mx - px, mz - pz) + Math.PI, 0);
      e.camera.updateMatrixWorld(true);
      e.interact();
      if (e.isVictory) return { victory: true, from: [+px.toFixed(2), +pz.toFixed(2)] };
    }
  }
  return { victory: false, from: null };
})()`;

async function main() {
  const server = await serve();
  const port = server.address().port;
  const base = process.env.QA_BASE || `http://127.0.0.1:${port}/index.html`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
           '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(base, { waitUntil: 'load' });
  // The page loads the built-in MAP01, then the level selector replaces it with
  // the first pack level. Wait for that swap so the run is deterministic.
  await page.waitForFunction(
    'window.cyberEngine && window.cyberEngine.walls.length > 0 && window.cyberEngine.exitWalls',
    { timeout: 20000 });
  await sleep(1500);

  await page.evaluate(`document.getElementById('start-btn').click()`);
  await sleep(400);

  /* ---------------- CH-QA-11: the map marks the exit ---------------- */
  await page.evaluate(`window.cyberEngine.toggleAutomap()`);
  await sleep(250);
  const exitCount = await page.evaluate(`window.cyberEngine.exitWalls.length`);
  const exitPixels = await page.evaluate(COUNT_EXIT_PIXELS);
  const header = await page.evaluate(`document.querySelector('.automap-header').innerText`);
  check('CH-QA-11',
    exitCount >= 1 && exitPixels > 40 && /EXTRACTION MARKED/.test(header),
    `exitWalls=${exitCount}, exit-marker pixels=${exitPixels}, header="${header}"`);

  /* ---------------- CH-QA-10: the marker tracks while open ---------- */
  const before = await page.evaluate(FIND_MARKER);
  await page.evaluate(`window.cyberEngine.keys['KeyW'] = true`);
  await sleep(900);
  const mid = await page.evaluate(FIND_MARKER);
  await page.evaluate(`window.cyberEngine.keys['KeyW'] = false`);
  await sleep(200);
  const after = await page.evaluate(FIND_MARKER);
  const mapOpen = await page.evaluate(
    `document.getElementById('automap-modal').style.display === 'flex'`);
  const moved = before && after ? Math.hypot(after.x - before.x, after.y - before.y) : 0;
  check('CH-QA-10',
    mapOpen && before && after && mid && moved > 3,
    `map open=${mapOpen}, marker ` +
    `${before ? `(${before.x.toFixed(1)},${before.y.toFixed(1)})` : 'MISSING'} -> ` +
    `${after ? `(${after.x.toFixed(1)},${after.y.toFixed(1)})` : 'MISSING'}, ` +
    `moved ${moved.toFixed(1)}px (a frozen marker moves 0)`);
  await page.evaluate(`window.cyberEngine.toggleAutomap()`);
  await sleep(150);

  /* ------------- CH-QA-12 / 13: reach the exit and use it ----------- */
  const levels = (process.env.QA_LEVELS ||
    'levelPacks/pack1/json1.json,levelPacks/pack3/json7.json,levelPacks/dv/json1.json')
    .split(',').map(s => s.trim()).filter(Boolean);

  // The built-in MAP01 is only briefly on screen at startup, so exercise it
  // from its literal rather than through the loader.
  const cases = [{ label: 'MAP01_DATA (built-in)', level: loadMap01(), file: null }];
  for (const f of levels) {
    cases.push({ label: f, level: JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')), file: f });
  }

  for (const c of cases) {
    if (c.file) {
      await page.evaluate(LOAD_LEVEL, c.file);
      await page.waitForFunction(
        `window.cyberEngine.levelData && window.cyberEngine.levelData.name === ${JSON.stringify(c.level.name)}`,
        { timeout: 20000 });
      await sleep(300);
    } else {
      const loaded = await page.evaluate(LOAD_BUILTIN_MAP01);
      if (loaded !== c.level.name) {
        check(`CH-QA-12 ${c.label}`, false,
          `expected the engine to hold "${c.level.name}" but it holds "${loaded}"`);
        continue;
      }
      await sleep(200);
    }

    const route = pathToExit(c.level);
    if (!route) { check(`CH-QA-12 ${c.label}`, false, 'no offline route to an exit switch'); continue; }

    // Put the player back on the real spawn before walking.
    await page.evaluate(RESET_TO_SPAWN, c.level.playerSpawn.pos);

    const walk = await page.evaluate(WALK, route);
    const stalled = walk.filter(l => !l.arrived);
    const end = walk[walk.length - 1];
    check(`CH-QA-12 ${c.label}`, stalled.length === 0,
      stalled.length === 0
        ? `engine walked all ${walk.length} legs from spawn ` +
          `(${c.level.playerSpawn.pos[0]}, ${c.level.playerSpawn.pos[2]}) to the exit at (${end.x}, ${end.z})`
        : `${stalled.length}/${walk.length} legs stalled, first at ` +
          `target(${stalled[0].tx},${stalled[0].tz}) reached(${stalled[0].x},${stalled[0].z})`);

    const used = await page.evaluate(PRESS_EXIT);
    check(`CH-QA-13 ${c.label}`, used.victory === true,
      used.victory ? `USE on the exit switch from (${used.from}) ended the level`
                   : 'USE on the exit switch did not end the level');
    await page.evaluate(`window.cyberEngine.isVictory = false; window.cyberEngine.isRunning = true;`);
  }

  /* ---------------- CH-QA-14: the gate switch opens the exit -------- */
  // MAP01 gates both the wasteland and the exit chamber behind sw_south_yard.
  // Verify the switch actually drives those doors rather than the player only
  // getting through because doors also auto-open on approach.
  await page.evaluate(LOAD_BUILTIN_MAP01);
  await sleep(200);
  const gate = await page.evaluate(() => {
    const e = window.cyberEngine;
    const sw = e.walls.find(w => w.switchId === 'sw_south_yard');
    const before = ['door_exit', 'door_east_yard'].map(id => e.doors[id] && e.doors[id].closed);
    // Stand off the switch and look at it, then press USE.
    const mx = (sw.p1.x + sw.p2.x) / 2, mz = (sw.p1.z + sw.p2.z) / 2;
    e.camera.position.set(mx - 2.2, e.camera.position.y, mz);
    e.camera.rotation.order = 'YXZ';
    e.camera.rotation.set(0, Math.atan2(mx - (mx - 2.2), mz - mz) + Math.PI, 0);
    e.camera.updateMatrixWorld(true);
    e.interact();
    const after = ['door_exit', 'door_east_yard'].map(id => e.doors[id] && e.doors[id].closed);
    return { before, after };
  });
  check('CH-QA-14',
    gate.before.every(c => c === true) && gate.after.every(c => c === false),
    `sw_south_yard: [door_exit, door_east_yard] closed ${JSON.stringify(gate.before)} ` +
    `-> ${JSON.stringify(gate.after)} after USE`);

  check('no-pageerror', pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : 'no uncaught exceptions during the run');

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
