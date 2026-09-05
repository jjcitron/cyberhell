#!/usr/bin/env node
/**
 * CYBERHELL PERFORMANCE BASELINE (browser, headless)
 *
 * Loads MAP01 plus six converted maps spanning tiny to the 20,461-wall
 * megamap, and for each one reports, at spawn and after a scripted 20 s
 * walk+fight:
 *
 *   - level load time (ms)
 *   - draw calls and triangles per rendered frame
 *   - scene light count, live geometry / texture counts
 *   - JS simulation cost per frame, median and p95, contention-normalised
 *     the same way tests/qa-ai.js does it (a fixed arithmetic loop measures
 *     how stretched the machine is; the reference is an unloaded box)
 *   - per-module cost: AI brains, enemy rigs, gore, environment, traversal
 *   - heap growth across the run
 *
 * Then loads three maps back to back and reports renderer.info.memory before
 * and after, which is the level-change leak check.
 *
 * Usage:  node tests/perf.js [--maps a,b,c] [--seconds 20]
 *         QA_PORT=8191 node tests/perf.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8190);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(argOf('--seconds', 20));

// Small -> huge. json2 is the 2,229-sector / 20,461-wall / 4,161-enemy map.
const DEFAULT_MAPS = [
  'MAP01',
  'levelPacks/pack3/json29.json',
  'levelPacks/pack3/json4.json',
  'levelPacks/pack5/json23.json',
  'levelPacks/dv/json1.json',
  'levelPacks/pack1/json12.json',
  'levelPacks/dv/json2.json'
];
const MAPS = argOf('--maps', '') ? argOf('--maps', '').split(',') : DEFAULT_MAPS;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.png': 'image/png', '.mid': 'audio/midi' };

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

/* ===========================================================================
   In-page drivers.
   =========================================================================== */

/** A fixed arithmetic loop: how stretched is this box right now. */
const CALIB = function () {
  var acc = 0, best = Infinity;
  for (var k = 0; k < 3; k++) {
    var t0 = performance.now();
    for (var i = 0; i < 20000000; i++) acc += i * 0.5;
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: +best.toFixed(2), guard: acc };
};

/** One render, then the counters that describe what it cost. */
const SNAPSHOT = function () {
  var e = window.cyberEngine;
  e.renderer.info.reset();
  e.renderer.render(e.scene, e.camera);
  var lights = 0, meshes = 0;
  e.scene.traverse(function (o) { if (o.isLight) lights++; if (o.isMesh || o.isPoints || o.isLine) meshes++; });
  var r = e.renderer.info;
  return {
    calls: r.render.calls, triangles: r.render.triangles,
    geometries: r.memory.geometries, textures: r.memory.textures,
    programs: r.programs ? r.programs.length : -1,
    lights: lights, sceneObjects: meshes,
    walls: e.walls.length, sectors: (e.levelData.sectors || []).length,
    enemies: e.enemies.length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1
  };
};

/**
 * Geometry sanity after merging: what is drawn has to be where the level data
 * says it is. Samples random floor points, raycasts down for the floor and up
 * for the ceiling, and compares both with the sector the point is inside.
 * This is the check that catches a batching transform bug -- a merged chunk
 * whose vertices were baked with the wrong matrix draws in the wrong place
 * and nothing else in the suite would notice.
 */
const GEOMCHECK = function (arg) {
  var e = window.cyberEngine;
  var secs = e.levelData.sectors || [];
  var inPolys = function (sec, x, z) {
    // MAP01 and other hand-authored levels have no boundary loops, only the
    // rectangles buildSectorGeometry resolves them to.
    if (!sec.polys) {
      var rects = sec.resolvedFloors || sec.floors ||
                  (sec.width !== undefined ? [{ x: sec.x, z: sec.z, width: sec.width, depth: sec.depth }] : []);
      for (var q = 0; q < rects.length; q++) {
        var rr = rects[q];
        if (Math.abs(x - rr.x) <= rr.width / 2 && Math.abs(z - rr.z) <= rr.depth / 2) return true;
      }
      return false;
    }
    var inside = false;
    for (var l = 0; l < sec.polys.length; l++) {
      var loop = sec.polys[l];
      for (var a = 0, b = loop.length - 1; a < loop.length; b = a++) {
        var xi = loop[a][0], zi = loop[a][1], xj = loop[b][0], zj = loop[b][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  e.scene.updateMatrixWorld(true);
  var ray = new THREE.Raycaster();
  ray.far = 500;
  var UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
  // Only the horizontal surfaces: a wall's top face or a step riser's
  // underside would otherwise answer the raycast instead of the floor.
  var floors = [], ceils = [];
  e.scene.traverse(function (o) {
    if (!o.isMesh || !o.visible) return;
    if (o.userData.floorY !== undefined) floors.push(o);
    if (o.userData.ceilY !== undefined) ceils.push(o);
  });

  var tried = 0, tested = 0, floorBad = 0, ceilBad = 0, ceilMissing = 0;
  var examples = [];
  for (var i = 0; i < secs.length && tested < arg.samples; i++) {
    var sec = secs[Math.floor((i * 7919) % secs.length)];
    if (sec.isSky || sec.ceilY === undefined) continue;
    var r = (sec.resolvedFloors && sec.resolvedFloors[0]) || sec;
    if (r.x === undefined) continue;
    tried++;
    var x = r.x, z = r.z;
    var f = e.getFloorAt(x, z);
    // A sample sitting exactly on a shared sector edge is answered by either
    // neighbour's triangle, so only take points comfortably inside this one.
    if (!f.inside || !inPolys(sec, x, z)) continue;
    if (!inPolys(sec, x + 0.06, z) || !inPolys(sec, x - 0.06, z) ||
        !inPolys(sec, x, z + 0.06) || !inPolys(sec, x, z - 0.06)) continue;
    if (sec.ceilY - f.floorY < 0.5) continue;      // a closed sector, nothing to see
    tested++;
    var mid = (f.floorY + sec.ceilY) / 2;
    ray.set(new THREE.Vector3(x, mid, z), DOWN);
    var down = ray.intersectObjects(floors, false);
    if (!down.length || Math.abs((mid - down[0].distance) - f.floorY) > 0.12) {
      floorBad++;
      if (examples.length < 3) examples.push({ kind: 'floor', x: +x.toFixed(1), z: +z.toFixed(1),
        want: f.floorY, drawn: down.length ? +(mid - down[0].distance).toFixed(2) : null });
    }
    ray.set(new THREE.Vector3(x, mid, z), UP);
    var up = ray.intersectObjects(ceils, false);
    if (!up.length) { ceilMissing++; continue; }
    var drawnCeil = mid + up[0].distance;
    if (Math.abs(drawnCeil - sec.ceilY) > 0.12) {
      ceilBad++;
      if (examples.length < 3) examples.push({ kind: 'ceil', x: +x.toFixed(1), z: +z.toFixed(1),
        want: sec.ceilY, drawn: +drawnCeil.toFixed(2) });
    }
  }
  return { tried: tried, tested: tested, floorBad: floorBad, ceilBad: ceilBad,
           ceilMissing: ceilMissing, examples: examples };
};

/**
 * Scripted walk + fight. Runs the real per-frame work (physics, AI, render)
 * at a fixed 1/60 step so the numbers do not depend on how fast the headless
 * GPU happens to be. Walks forward, turns every couple of seconds, and holds
 * the trigger down throughout.
 */
const RUN = function (arg) {
  var e = window.cyberEngine;
  e.isRunning = true;
  e.grantFullArsenal();
  e.player.health = 1e9;                 // the run must not end in a death
  e.perfReset();
  if (window.CyberAI && window.CyberAI.resetStats) window.CyberAI.resetStats();

  var frames = Math.round(arg.seconds * 60);
  var dt = 1 / 60;
  var sim = [], ren = [];
  var heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  e.renderer.info.reset();
  var callsSum = 0, triSum = 0, rendered = 0;

  for (var f = 0; f < frames; f++) {
    // Walk forward; turn 40 degrees every 90 frames so we sweep the room
    // instead of grinding into one wall for 20 seconds.
    e.keys['KeyW'] = true;
    if (f % 90 === 0) { e.yaw = (e.yaw || 0) + 0.7; e.camera.rotation.y = e.yaw; }
    if (f % 20 === 0) { e.isFiring = true; try { e.fireWeapon(); } catch (err) {} }

    var t0 = performance.now();
    e.updatePhysics(dt);
    e.updateEnemies(dt);
    e.gameTime += dt;
    sim.push(performance.now() - t0);

    // Render every third frame: the swiftshader rasteriser dominates wall
    // clock and would swamp the JS numbers, but the draw-call count is the
    // headline for a real GPU so it still has to be measured.
    if (f % 3 === 0) {
      e.renderer.info.reset();
      var t1 = performance.now();
      e.renderer.render(e.scene, e.camera);
      ren.push(performance.now() - t1);
      callsSum += e.renderer.info.render.calls;
      triSum += e.renderer.info.render.triangles;
      rendered++;
    }
  }
  e.keys['KeyW'] = false;
  e.isFiring = false;
  e.isRunning = false;      // stop the page's own rAF competing with the next map

  var pct = function (a, p) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3);
  };
  var ai = (window.CyberAI && window.CyberAI.stats) ? window.CyberAI.stats() : {};
  return {
    simMed: pct(sim, 0.5), simP95: pct(sim, 0.95),
    renMed: pct(ren, 0.5),
    calls: Math.round(callsSum / Math.max(1, rendered)),
    triangles: Math.round(triSum / Math.max(1, rendered)),
    modules: Object.assign({ brain: ai.brainMsAvg || 0, rig: ai.rigMsAvg || 0 }, e.perfStats()),
    animated: ai.animated || 0, awake: ai.awake || 0,
    heapGrowthMB: performance.memory
      ? +((performance.memory.usedJSHeapSize - heap0) / 1048576).toFixed(1) : -1
  };
};

/* ------------------------------------------------------------------------- */
async function loadMap(page, file) {
  if (file === 'MAP01') {
    // MAP01 is inline in the page, so there is nothing to fetch.
    const t = await page.evaluate(() => {
      const e = window.cyberEngine;
      e.isRunning = false;
      const t0 = performance.now();
      e.resetLevelScene();
      e.loadLevel(MAP01_DATA);
      return performance.now() - t0;
    });
    return { name: 'MAP01', ms: Math.round(t), phases: await page.evaluate(() => window.cyberEngine._loadPhases) };
  }
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).name;
  // Timed inside the page so the number is parse+build, not playwright's
  // round trip, and stop the rAF loop first so it is not competing.
  const ms = await page.evaluate(async f => {
    const e = window.cyberEngine;
    e.isRunning = false;
    const t0 = performance.now();
    await e.loadLevelFromFile(f, false);
    return performance.now() - t0;
  }, file);
  return { name: want, ms: Math.round(ms), phases: await page.evaluate(() => window.cyberEngine._loadPhases) };
}

const ev = (page, fn, arg) =>
  page.evaluate(([f, a]) => new Function('return ' + f)()(a), [fn.toString(), arg]);

function table(rows, cols) {
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log('  ' + w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c] ?? '')));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc']
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  const rows = [];
  const geomRows = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 60000 });
    // The page boots MAP01 then fetches the first pack level over it.
    let settled = '';
    for (let i = 0; i < 40; i++) {
      const nm = await page.evaluate(() => window.cyberEngine.levelData.name);
      if (nm === settled) break;
      settled = nm; await page.waitForTimeout(500);
    }

    const cal = await ev(page, CALIB, null);
    const CALIB_REF = 20.4;               // same reference qa-ai.js uses
    const slack = Math.min(1, CALIB_REF / cal.ms);
    console.log(`Machine calibration ${cal.ms} ms vs ${CALIB_REF} ms reference ` +
      `-> ${(1 / slack).toFixed(2)}x load; JS timings below are divided by that.\n`);

    for (const map of MAPS) {
      const info = await loadMap(page, map);
      const spawn = await ev(page, SNAPSHOT, null);
      const geom = await ev(page, GEOMCHECK, { samples: 120 });
      geomRows.push(Object.assign({ map: map.replace('levelPacks/', '') }, {
        sampled: geom.tested, 'floor wrong': geom.floorBad, 'ceiling wrong': geom.ceilBad,
        'no ceiling': geom.ceilMissing,
        detail: geom.examples.length ? JSON.stringify(geom.examples[0]) : ''
      }));
      const run = await ev(page, RUN, { seconds: SECONDS });
      const m = run.modules;
      rows.push({
        map: map.replace('levelPacks/', ''),
        sec: spawn.sectors, walls: spawn.walls, enem: spawn.enemies,
        'load ms': info.ms < 0 ? 'inline' : info.ms,
        'calls@spawn': spawn.calls, 'calls@run': run.calls,
        'tris@run': run.triangles,
        geo: spawn.geometries, tex: spawn.textures, lights: spawn.lights,
        'sim med': +(run.simMed * slack).toFixed(2),
        'sim p95': +(run.simP95 * slack).toFixed(2),
        brain: +((m.brain || 0) * slack).toFixed(2),
        rig: +((m.rig || 0) * slack).toFixed(2),
        gore: +((m.gore || 0) * slack).toFixed(2),
        env: +((m.env || 0) * slack).toFixed(2),
        trav: +((m.traversal || 0) * slack).toFixed(2),
        'heap +MB': run.heapGrowthMB
      });
      console.log(`  done ${map}  load phases ${JSON.stringify(info.phases)}`);
    }

    console.log('\n=== PER-MAP ===  (ms figures contention-normalised, JS only)\n');
    table(rows, ['map', 'sec', 'walls', 'enem', 'load ms', 'calls@spawn', 'calls@run',
                 'tris@run', 'geo', 'tex', 'lights', 'sim med', 'sim p95',
                 'brain', 'rig', 'gore', 'env', 'trav', 'heap +MB']);

    console.log('\n=== GEOMETRY SANITY (drawn surface vs level data) ===\n');
    table(geomRows, ['map', 'sampled', 'floor wrong', 'ceiling wrong', 'no ceiling', 'detail']);
    const geomBad = geomRows.reduce((a, r) => a + r['floor wrong'] + r['ceiling wrong'], 0);
    console.log(`\n  ${geomBad === 0 ? 'PASS' : 'FAIL'}: ${geomBad} surfaces drawn away from where the level data puts them`);

    /* ---- level-change memory ------------------------------------------ */
    console.log('\n=== MEMORY ACROSS THREE LEVEL LOADS ===\n');
    const cycle = ['levelPacks/pack3/json4.json', 'levelPacks/pack5/json23.json', 'levelPacks/dv/json1.json'];
    const mem = [];
    for (let round = 0; round < 3; round++) {
      for (const c of cycle) await loadMap(page, c);
      const s = await ev(page, SNAPSHOT, null);
      mem.push({ round: round + 1, geometries: s.geometries, textures: s.textures,
                 programs: s.programs, heapMB: s.heapMB });
    }
    table(mem, ['round', 'geometries', 'textures', 'programs', 'heapMB']);
    const leak = mem[2].geometries - mem[0].geometries;
    console.log(`\n  geometry delta over rounds 1 -> 3: ${leak > 0 ? '+' : ''}${leak}` +
      `  (must not climb; a climbing count is an undisposed level)`);

    /* ---- mobile budget ------------------------------------------------ */
    console.log('\n=== MOBILE (851x393, coarse pointer, touch events) ===\n');
    const mob = await browser.newContext({
      viewport: { width: 851, height: 393 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 3
    });
    const mp = await mob.newPage();
    const mobErrors = [];
    mp.on('pageerror', e => mobErrors.push(String(e)));
    mp.on('console', m => { if (m.type() === 'error') mobErrors.push('console: ' + m.text()); });
    await mp.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await mp.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 60000 });
    await mp.waitForTimeout(2500);
    await loadMap(mp, 'levelPacks/pack5/json23.json');
    const m6 = await ev(mp, RUN, { seconds: 6 });
    const msnap = await ev(mp, SNAPSHOT, null);
    const cfg = await mp.evaluate(() => {
      const e = window.cyberEngine;
      return {
        touch: e.isTouch,
        pixelRatio: e.renderer.getPixelRatio(),
        shadows: e.renderer.shadowMap.enabled,
        props: window.CyberEnv ? window.CyberEnv.__debugCounts() : null,
        dpad: !!document.querySelector('#dpad, .dpad, #touch-controls')
      };
    });
    console.log(`  isTouch=${cfg.touch}  pixelRatio=${cfg.pixelRatio}  shadows=${cfg.shadows}  dpad=${cfg.dpad}`);
    console.log(`  props placed ${JSON.stringify(cfg.props)}`);
    console.log(`  draw calls ${msnap.calls} at spawn / ${m6.calls} walking; ` +
      `sim ${m6.simMed} ms median, ${m6.simP95} ms p95 over 6 s`);
    console.log(`  mobile page errors: ${mobErrors.length ? mobErrors.slice(0, 4).join(' | ') : 'none'}`);
    await mob.close();
    console.log(`\n  page errors: ${pageErrors.length ? pageErrors.slice(0, 4).join(' | ') : 'none'}`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(e => { console.error(e); process.exit(2); });
