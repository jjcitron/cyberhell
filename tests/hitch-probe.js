#!/usr/bin/env node
/**
 * LEVEL-CHANGE COMPILE PROBE
 *
 * tests/hitch.js says the biggest stall is the first renderer.render() after
 * a level change. This says WHY: it loads three maps back to back and, for
 * each, reports
 *
 *   - renderer.info.programs.length before and after the build
 *   - how long renderer.compile() takes at the end of the build
 *   - how long the FIRST render after the build takes, and the second
 *
 * A first render far more expensive than the second, with the program count
 * climbing back from near zero, is first-hit shader compile. A first render
 * that matches the second, with the program count flat, is a warm cache.
 *
 * Usage:  node tests/hitch-probe.js [--maps a,b,c]
 *         PLAYWRIGHT_PATH=... QA_PORT=8197 node tests/hitch-probe.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8197);

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    '/usr/local/lib/node_modules/playwright-core',
    'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core',
    'playwright-core'
  ].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch (err) {} }
  throw new Error('playwright-core not found; set PLAYWRIGHT_PATH');
}
const { chromium } = resolvePlaywright();

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MAPS = (argOf('--maps', 'levelPacks/pack3/json29.json,levelPacks/pack5/json23.json,levelPacks/pack1/json12.json')).split(',');

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

const PROBE = function (arg) {
  var e = window.cyberEngine;
  e.isRunning = false;
  var progBefore = e.renderer.info.programs ? e.renderer.info.programs.length : -1;
  var load = function () {
    // loadLevelSliced exists only on the fixed build; fall back to the
    // synchronous path so this probe runs against both.
    if (e.loadLevelSliced) {
      return fetch(arg.file).then(function (r) { return r.json(); }).then(function (d) {
        e.resetLevelScene();
        return e.loadLevelSliced(d);
      });
    }
    return e.loadLevelFromFile(arg.file, false);
  };
  var t0 = performance.now();
  return load().then(function () {
    var buildMs = performance.now() - t0;
    var progAfter = e.renderer.info.programs ? e.renderer.info.programs.length : -1;
    var t1 = performance.now();
    e.renderer.render(e.scene, e.camera);
    var first = performance.now() - t1;
    var t2 = performance.now();
    e.renderer.render(e.scene, e.camera);
    var second = performance.now() - t2;
    var t3 = performance.now();
    e.renderer.render(e.scene, e.camera);
    var third = performance.now() - t3;
    return {
      map: arg.file,
      name: e.levelData.name,
      walls: e.walls.length,
      enemies: e.enemies.length,
      buildMs: +buildMs.toFixed(1),
      programsBefore: progBefore,
      programsAfter: progAfter,
      warmMs: (e._loadPhases && e._loadPhases.warm !== undefined) ? e._loadPhases.warm : null,
      firstRenderMs: +first.toFixed(1),
      secondRenderMs: +second.toFixed(1),
      thirdRenderMs: +third.toFixed(1)
    };
  });
};

const ev = (page, fn, arg) =>
  page.evaluate(([f, a]) => new Function('return ' + f)()(a), [fn.toString(), arg]);

(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
           '--disable-background-timer-throttling']
  });
  const page = await browser.newPage({ viewport: { width: 256, height: 144 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html${process.env.PQ ? '?quality=' + process.env.PQ : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 90000 });

  const rows = [];
  for (const file of MAPS) rows.push(await ev(page, PROBE, { file }));

  const cols = ['name', 'walls', 'enemies', 'buildMs', 'programsBefore', 'programsAfter',
                'warmMs', 'firstRenderMs', 'secondRenderMs', 'thirdRenderMs'];
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log('  ' + w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c])));
  console.log('\n' + JSON.stringify(rows));
  if (errors.length) console.log('\npage errors:\n  ' + [...new Set(errors)].slice(0, 6).join('\n  '));

  await browser.close();
  server.close();
})();
