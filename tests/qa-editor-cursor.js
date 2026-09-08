#!/usr/bin/env node
/**
 * CYBERHELL EDITOR QA — cursor→world fidelity.
 *
 * Proves that what the Wall and Sector tools draw lands under the mouse.
 * The visible offset comes from the canvas backing store disagreeing with
 * its CSS box (a bottom-drawer panel mounting after the shell measured the
 * canvas): geometry is then drawn against a stale height while the pointer
 * math uses the live rect. This script measures that, not eyeballs it.
 *
 * CUR-1  canvas.width/height == CSS box × devicePixelRatio (no stretch)
 * CUR-2  Wall tool: two real clicks -> the wall's p1 renders within 1.5px
 *        (+ half a snap cell) of the click, on the CSS box the user sees
 * CUR-3  Sector tool: three clicks + Enter -> first vertex under click 1,
 *        and the sector arrives with one wall per edge
 * CUR-4  Entity tool toolbar has one "place" picker (Enemy / Item / Weapon)
 *        driving one dependent list — no orphan weapon dropdown
 *
 * Usage: node tests/qa-editor-cursor.js        (exit 1 on any failure)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5307);
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const results = [];
function record(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

/* Where the editor DRAWS world point (x,z) on the CSS box the user sees:
   worldToScreen gives backing-store CSS px assuming the store matches the box;
   scale by (box / store) to get where the pixel actually lands. Runs in-page. */
function drawnAt(x, z) {
  var m = window.CyberEditor.map, r = m.canvas.getBoundingClientRect();
  var s = m.worldToScreen(x, z);
  return { x: r.left + s.x * r.width / (m.canvas.width / m.dpr), y: r.top + s.y * r.height / (m.canvas.height / m.dpr) };
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/editor.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.CyberEditor && window.CyberEditor.level && window.CyberEditor.map), { timeout: 10000 });
    // Let every lane mount (composer builds on setTimeout 0; drawers change the canvas box).
    await page.waitForTimeout(1200);
    await page.addScriptTag({ content: 'window.__drawnAt = ' + drawnAt.toString() });

    // ------------------------------------------------------------ CUR-1
    const size = await page.evaluate(() => {
      const m = window.CyberEditor.map, r = m.canvas.getBoundingClientRect();
      return { w: m.canvas.width, h: m.canvas.height, bw: r.width * m.dpr, bh: r.height * m.dpr, dpr: m.dpr };
    });
    const dw = Math.abs(size.w - size.bw), dh = Math.abs(size.h - size.bh);
    record('CUR-1 canvas backing store matches its CSS box', dw <= 1 && dh <= 1,
      `store ${size.w}x${size.h} vs box ${size.bw.toFixed(0)}x${size.bh.toFixed(0)} (dpr ${size.dpr}); vertical stretch x${(size.h / size.bh).toFixed(3)}`);

    // Fresh, empty level so counts are deterministic and nothing is under the cursor.
    await page.evaluate(() => {
      const ed = window.CyberEditor;
      ed.level = { name: 'qa-cursor', sectors: [], walls: [], entities: [], triggers: [], playerSpawn: { pos: [0, 1.5, 0], rot: 0 } };
      ed.map.view.cx = 0; ed.map.view.cz = 0; ed.map.view.scale = 8;
      ed.emit('level-loaded', { level: ed.level });
      ed.requestRedraw();
    });
    const box = await page.evaluate(() => { const r = window.CyberEditor.map.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    const tol = await page.evaluate(() => window.CyberEditor.map.grid * window.CyberEditor.map.view.scale / 2 + 1.5);
    const pt = (fx, fy) => ({ x: box.l + box.w * fx, y: box.t + box.h * fy });

    // ------------------------------------------------------------ CUR-2
    await page.evaluate(() => window.CyberEditor.setTool('wall'));
    const a = pt(0.30, 0.70), b = pt(0.60, 0.72);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.up();
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.up();
    const wall = await page.evaluate(() => {
      const ed = window.CyberEditor, w = ed.level.walls[ed.level.walls.length - 1];
      if (!w) return null;
      const d = window.__drawnAt(w.p1[0], w.p1[1]);
      return { n: ed.level.walls.length, x: d.x, y: d.y };
    });
    if (!wall) record('CUR-2 wall tool creates a wall from two clicks', false, 'no wall created');
    else {
      const err = Math.hypot(wall.x - a.x, wall.y - a.y);
      record('CUR-2 wall p1 is drawn under click 1', err <= tol, `offset ${err.toFixed(1)}px (tolerance ${tol.toFixed(1)}px = half snap cell); click (${a.x.toFixed(0)},${a.y.toFixed(0)}) drawn (${wall.x.toFixed(0)},${wall.y.toFixed(0)})`);
    }

    // ------------------------------------------------------------ CUR-3
    await page.evaluate(() => window.CyberEditor.setTool('sector'));
    const s1 = pt(0.35, 0.25), s2 = pt(0.55, 0.25), s3 = pt(0.55, 0.45);
    for (const p of [s1, s2, s3]) { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); }
    await page.keyboard.press('Enter');
    const sec = await page.evaluate(() => {
      const ed = window.CyberEditor, s = ed.level.sectors[ed.level.sectors.length - 1];
      if (!s) return null;
      const v = s.polys[0][0], d = window.__drawnAt(v[0], v[1]);
      return { edges: s.polys[0].length, walls: ed.level.walls.length, x: d.x, y: d.y };
    });
    if (!sec) record('CUR-3 sector tool creates a sector from clicks + Enter', false, 'no sector created');
    else {
      const err = Math.hypot(sec.x - s1.x, sec.y - s1.y);
      record('CUR-3 sector vertex 1 is drawn under click 1', err <= tol, `offset ${err.toFixed(1)}px (tolerance ${tol.toFixed(1)}px)`);
      record('CUR-3 new sector arrives with one wall per edge', sec.walls === 1 + sec.edges, `${sec.edges} edges, ${sec.walls - 1} walls added`);
    }

    // ------------------------------------------------------------ CUR-4
    await page.evaluate(() => window.CyberEditor.setTool('entity'));
    const ui = await page.evaluate(() => {
      const bar = document.getElementById('ed-toolbar');
      const selects = Array.from(bar.querySelectorAll('select'));
      const cat = selects.find(s => Array.from(s.options).map(o => o.textContent).join(',') === 'Enemy,Item,Weapon');
      const labels = Array.from(bar.querySelectorAll('span')).map(s => s.textContent);
      return { selects: selects.length, hasCategory: !!cat, labels };
    });
    record('CUR-4 entity toolbar: one Enemy/Item/Weapon picker + one dependent list', ui.hasCategory && ui.selects === 2,
      `${ui.selects} selects, category picker ${ui.hasCategory ? 'present' : 'missing'}; labels: ${ui.labels.join(' | ')}`);

    record('CUR-0 zero page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  let fail = 0;
  for (const r of results) { if (!r.ok) fail++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -- ' + r.detail : ''}`); }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
