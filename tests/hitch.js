#!/usr/bin/env node
/**
 * CYBERHELL HITCH BUDGET (browser, headless)
 *
 * tests/perf.js answers "what does an average frame cost" by driving the sim
 * synchronously. That deliberately sidesteps the thing this job is about:
 * the multi-hundred-millisecond stalls the playtester hit. Those live in the
 * gaps BETWEEN frames -- a level rebuild in a fetch callback, a first-hit
 * shader compile inside the first render of a new material, a GC after a
 * death burst -- and a synchronous driver never sees them.
 *
 * So this harness lets the page's own requestAnimationFrame loop run in real
 * time and measures it from the inside, via window.CyberPerf (js/cyber-perf.js):
 * frame ms rAF-to-rAF, sim ms, rolling p99, and a cause tag on every frame
 * over ~33 ms.
 *
 * Scripted path, per map, matching the producer's acceptance wording:
 *
 *   enter  - load the map while the loop is live, spawn in, look around 3 s
 *   fight  - 12 s of walk + turn + hold the trigger, with the arsenal granted
 *   exit   - load the next map while the loop is live, spawn in, 3 s
 *
 * Profiles:
 *   mid    - no CPU throttle, High/auto quality  (budget: no hang >= 500 ms)
 *   low    - 4x CPU throttle, Low quality        (budget: no hang >= 250 ms)
 *
 * Headless renders through SwiftShader, so raster is CPU work and a steady
 * frame is far more expensive than it is on a real GPU. That makes this
 * conservative for the pass/fail above -- a stall we clear here is one a
 * laptop with a GPU also clears -- but it means the steady-state frame time
 * printed below is NOT a frame rate claim. Read maxFrame / p99 / cause.
 *
 * Usage:
 *   node tests/hitch.js
 *   node tests/hitch.js --profile low --maps MAP01,levelPacks/pack3/json4.json
 *   node tests/hitch.js --json /tmp/hitch-after.json
 *   QA_PORT=8195 PLAYWRIGHT_PATH=/usr/local/lib/node_modules/playwright-core node tests/hitch.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8195);

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    '/usr/local/lib/node_modules/playwright-core',
    'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core',
    'playwright-core'
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (err) { /* next */ }
  }
  throw new Error('playwright-core not found; set PLAYWRIGHT_PATH');
}
const { chromium } = resolvePlaywright();

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.indexOf(n) >= 0;

// small -> large. json2 is the 2,229-sector / 20,461-wall / 4,161-enemy map.
const DEFAULT_MAPS = [
  'MAP01',                        // small, hand-authored
  'levelPacks/pack3/json29.json', // small-medium converted
  'levelPacks/pack5/json23.json', // medium
  'levelPacks/pack1/json12.json'  // large
  // The 20,461-wall megamap (levelPacks/dv/json2.json) is a separate opt-in
  // run: --maps levelPacks/dv/json2.json. Software raster makes it an hour
  // of wall clock in the default sweep and it tells you the same thing.
];
const MAPS = argOf('--maps', '') ? argOf('--maps', '').split(',') : DEFAULT_MAPS;
const PROFILE = argOf('--profile', 'both');
const FIGHT_S = Number(argOf('--fight', 12));
const SETTLE_S = Number(argOf('--settle', 3));
const JSON_OUT = argOf('--json', '');
// Headless renders through SwiftShader on the CPU. A big viewport turns this
// into a rasteriser benchmark and buries the JS stalls we are hunting, so the
// default is deliberately small -- hitch causes, not a frame-rate claim.
const VW = Number(argOf('--width', 256));
const VH = Number(argOf('--height', 144));
// Same reference constant tests/perf.js and tests/qa-ai.js use: what the CALIB
// loop below costs on an unloaded box. A shared box stretches it, and every
// millisecond measured there stretches with it.
const CALIB_REF = 20.4;

const PROFILES = {
  mid: { name: 'mid', cpuThrottle: 1, quality: 'high', budgetMs: 500 },
  low: { name: 'low', cpuThrottle: 4, quality: 'low', budgetMs: 250 }
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.png': 'image/png', '.mid': 'audio/midi', '.webmanifest': 'application/manifest+json' };

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
   In-page drivers. Everything here runs against the live rAF loop -- nothing
   steps the sim by hand, because hand-stepping is what hides the stalls.
   =========================================================================== */

/** Load a map and keep the loop running through the rebuild. */
const ENTER = function (arg) {
  var e = window.cyberEngine;
  window.CyberPerf.reset(arg.label);
  var done;
  var p = new Promise(function (r) { done = r; });
  var finish = function () {
    e.player.health = 1e9;
    e.grantFullArsenal();
    e.resumeRun();
    setTimeout(function () { done(window.CyberPerf.snapshot()); }, arg.settleMs);
  };
  if (arg.file === 'MAP01') {
    // MAP01 is inline in the page, so this is the build without the fetch.
    e.resetLevelScene();
    e.loadLevel(MAP01_DATA);
    finish();
  } else {
    e.loadLevelFromFile(arg.file, false).then(finish);
  }
  return p;
};

/** Walk + turn + hold the trigger for N seconds of real frames. */
const FIGHT = function (arg) {
  var e = window.cyberEngine;
  window.CyberPerf.reset(arg.label);
  e.player.health = 1e9;
  e.grantFullArsenal();
  e.resumeRun();
  e.keys['KeyW'] = true;
  e.isFiring = true;

  var t0 = performance.now();
  var n = 0;
  return new Promise(function (done) {
    var tick = function () {
      n++;
      // Sweep the room instead of grinding into one wall, and keep the
      // trigger down. Same shape as tests/perf.js RUN so the two agree on
      // what "fight" means.
      if (n % 45 === 0) { e.yaw = (e.yaw || 0) + 0.7; e.camera.rotation.y = e.yaw; }
      if (n % 12 === 0) { try { e.fireWeapon(); } catch (err) {} }
      if (performance.now() - t0 >= arg.ms) {
        e.keys['KeyW'] = false;
        e.isFiring = false;
        done(window.CyberPerf.snapshot());
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Fixed arithmetic loop: how contended is this box right now. Recorded with
    every run because a shared box's spare capacity moves under you. */
const CALIB = function () {
  var acc = 0, best = Infinity;
  for (var k = 0; k < 3; k++) {
    var t0 = performance.now();
    for (var i = 0; i < 20000000; i++) acc += i * 0.5;
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: +best.toFixed(2), guard: acc };
};

const ev = (page, fn, arg) =>
  page.evaluate(([f, a]) => new Function('return ' + f)()(a), [fn.toString(), arg]);

/* ------------------------------------------------------------------------- */

function fmt(n) { return n === undefined || n === null ? '' : String(n); }

function table(rows, cols) {
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => fmt(r[c]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => fmt(c).padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log('  ' + w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c])));
}

async function runProfile(prof, results) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--js-flags=--expose-gc',
      // Headless Chrome treats the page as occluded and drops the renderer to
      // a background priority with throttled timers. On a shared box that
      // turns every measurement into a measurement of the scheduler.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling'
    ]
  });
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  const cdp = await page.context().newCDPSession(page);

  await page.goto(`http://127.0.0.1:${PORT}/index.html?quality=${prof.quality}`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData && !!window.CyberPerf', null, { timeout: 90000 });
  // Silence the synth: a MIDI cue in a headless box is wall clock nobody asked for.
  await page.evaluate(() => { try { window.cyberMidi && window.cyberMidi.stop && window.cyberMidi.stop(); } catch (e) {} });

  const tier = await page.evaluate(() => window.CyberQuality ? window.CyberQuality.summary() : null);
  const calib = await ev(page, CALIB, null);
  // Contention normalisation, the convention this repo already uses. Raw ms is
  // what this box did; normalised ms is what it would have done unloaded, and
  // is what the budget is judged on. Both are printed, always.
  const slack = Math.min(1, CALIB_REF / calib.ms);
  const norm = (v) => +(v * slack).toFixed(1);
  console.log(`\n=== profile ${prof.name}  (cpu x${prof.cpuThrottle}, quality ${tier ? tier.tier : 'n/a'}, ` +
    `budget ${prof.budgetMs} ms, viewport ${VW}x${VH}, calib ${calib.ms} vs ${CALIB_REF} ms ref ` +
    `= ${(1 / slack).toFixed(1)}x machine load) ===`);

  if (prof.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpuThrottle });

  for (let i = 0; i < MAPS.length; i++) {
    const file = MAPS[i];
    const next = MAPS[(i + 1) % MAPS.length];
    const label = `${prof.name}:${file}`;

    const enter = await ev(page, ENTER, { file, settleMs: SETTLE_S * 1000, label: label + ':enter' });
    const scale = await page.evaluate(() => {
      const e = window.cyberEngine;
      return { walls: e.walls.length, sectors: (e.levelData.sectors || []).length,
               enemies: e.enemies.length, name: e.levelData.name };
    });
    const fight = await ev(page, FIGHT, { ms: FIGHT_S * 1000, label: label + ':fight' });
    const exit = await ev(page, ENTER, { file: next, settleMs: SETTLE_S * 1000, label: label + ':exit' });

    const phases = { enter, fight, exit };
    const worstRaw = Math.max(enter.maxFrameMs, fight.maxFrameMs, exit.maxFrameMs);
    const worst = norm(worstRaw);
    results.push({
      profile: prof.name, map: file, name: scale.name, scale,
      budgetMs: prof.budgetMs,
      worstHangMs: worst, worstHangRawMs: +worstRaw.toFixed(1),
      p99FrameMs: norm(Math.max(enter.p99FrameMs, fight.p99FrameMs, exit.p99FrameMs)),
      maxSimMs: norm(Math.max(enter.maxSimMs, fight.maxSimMs, exit.maxSimMs)),
      pass: worst < prof.budgetMs,
      calibMs: calib.ms, calibRefMs: CALIB_REF, machineLoadX: +(1 / slack).toFixed(2),
      quality: tier ? tier.tier : null, viewport: VW + 'x' + VH, phases
    });

    const row = (p, s) => ({
      map: `${file} [${p}]`, frames: s.frames,
      medFrame: norm(s.medianFrameMs), p99Frame: norm(s.p99FrameMs),
      maxFrame: norm(s.maxFrameMs), rawMax: s.maxFrameMs,
      maxSim: norm(s.maxSimMs), over33: s.overBudgetFrames,
      cause: s.maxFrameCause
    });
    table([row('enter', enter), row('fight', fight), row('exit', exit)],
      ['map', 'frames', 'medFrame', 'p99Frame', 'maxFrame', 'rawMax', 'maxSim', 'over33', 'cause']);
  }

  if (prof.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await browser.close();
  return pageErrors;
}

(async () => {
  const server = await serve();
  const results = [];
  const errors = [];
  try {
    const list = PROFILE === 'both' ? ['mid', 'low'] : [PROFILE];
    for (const p of list) errors.push(...await runProfile(PROFILES[p], results));
  } finally {
    server.close();
  }

  console.log('\n=== HITCH BUDGET ===');
  console.log('(worstHang is contention-normalised; rawWorst is what this box actually did)');
  table(results.map(r => ({
    profile: r.profile, map: r.map, walls: r.scale.walls, enemies: r.scale.enemies,
    worstHang: r.worstHangMs, rawWorst: r.worstHangRawMs, loadX: r.machineLoadX,
    p99: r.p99FrameMs, budget: r.budgetMs, verdict: r.pass ? 'PASS' : 'FAIL'
  })), ['profile', 'map', 'walls', 'enemies', 'worstHang', 'rawWorst', 'loadX', 'p99', 'budget', 'verdict']);

  console.log('\n=== WORST HITCHES (top 8 overall, with cause) ===');
  const all = [];
  for (const r of results) {
    for (const ph of ['enter', 'fight', 'exit']) {
      for (const h of r.phases[ph].worstHitches) {
        all.push({ profile: r.profile, map: r.map, phase: ph, ms: h.frameMs, sim: h.simMs, cause: h.cause,
                   notes: (h.notes || []).join(',') });
      }
    }
  }
  all.sort((a, b) => b.ms - a.ms);
  table(all.slice(0, 8), ['profile', 'map', 'phase', 'ms', 'sim', 'cause', 'notes']);

  if (errors.length) {
    console.log('\npage errors:');
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }

  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? `\nFAIL: ${failed.length} of ${results.length} map/profile runs over budget`
                            : `\nPASS: all ${results.length} map/profile runs inside budget`);
  process.exit(has('--soft') ? 0 : (failed.length ? 1 : 0));
})();
