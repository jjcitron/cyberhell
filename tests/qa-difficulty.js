#!/usr/bin/env node
/**
 * CYBERHELL DIFFICULTY QA (browser, headless)
 *   CH-DIFF-1  Fresh profile defaults to NORMAL, and NORMAL is the pre-slider game: CyberAI TUNING
 *              equals its stock values, damagePlayer(n) costs exactly n, damageEnemy(n) exactly n.
 *   CH-DIFF-2  The slider is visible on the title screen.
 *   CH-DIFF-3  The slider is visible on the pause menu (pauseRun, the touch pause path).
 *   CH-DIFF-4  Moving it to HARD retunes CyberAI live, scales damage taken, survives a reload.
 *   CH-DIFF-5  Mobile (touch, portrait 390x844 and landscape 844x390): the slider is on screen and
 *              a tap on it changes the level without starting the game.
 *   CH-DIFF-6  Zero page errors.
 * Usage: node tests/qa-difficulty.js   (QA_SHOTS=dir writes screenshots)
 */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8150);
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = process.env.QA_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
let fails = 0;
function check(id, ok, detail) { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`); }
const STOCK = { maxAttackers: 3, accuracy: 1.0, damageScale: 1.0, reactMax: 0.55, burstSize: 3 };
const visible = (page) => page.evaluate(() => { const el = document.getElementById('difficulty-slider'); if (!el) return false;
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 50 && r.height > 20 && r.bottom > 0 && r.top < innerHeight; });

(async () => {
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData && !!window.CyberDifficulty', null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const d1 = await page.evaluate((STOCK) => {
      const e = window.cyberEngine, T = window.CyberAI.TUNING, D = window.CyberDifficulty;
      const tun = Object.keys(STOCK).every(k => T[k] === STOCK[k]);
      e.player.armor = 0; e.player.health = 100; e.damagePlayer(17); const took = 100 - e.player.health; e.player.health = 100;
      const en = e.enemies.find(x => x.state !== 'DEAD'); let dealt = null;
      if (en) { const h = en.hp; e.damageEnemy(en, 7); dealt = h - en.hp; en.hp = h; en.state = 'IDLE'; }
      return { id: D.get().id, stored: localStorage.getItem('cyberhell-difficulty'), tun, took, dealt };
    }, STOCK);
    check('CH-DIFF-1 default NORMAL == old game', d1.id === 'normal' && d1.tun && d1.took === 17 && (d1.dealt === null || d1.dealt === 7), JSON.stringify(d1));

    check('CH-DIFF-2 slider on title screen', await visible(page), 'mode=' + await page.evaluate(() => document.getElementById('overlay-screen').className));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'main-menu-slider.png') });

    await page.evaluate(() => { const e = window.cyberEngine; document.getElementById('overlay-screen').style.display = 'none'; e.isRunning = true; e.missionStarted = true; e.pauseRun(); });
    await page.waitForTimeout(400);
    const pm = await page.evaluate(() => ({ mode: document.getElementById('overlay-screen').className, title: document.getElementById('overlay-title').innerText }));
    check('CH-DIFF-3 slider on pause menu', (await visible(page)) && pm.title === 'PAUSED', JSON.stringify(pm));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pause-menu-slider.png') });

    await page.evaluate(() => { const i = document.querySelector('#difficulty-slider input'); i.value = 3; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const d4 = await page.evaluate(() => { const e = window.cyberEngine, T = window.CyberAI.TUNING; e.isGameOver = false; e.player.armor = 0; e.player.health = 100; e.damagePlayer(20); const took = 100 - e.player.health; e.player.health = 100;
      return { id: window.CyberDifficulty.get().id, stored: localStorage.getItem('cyberhell-difficulty'), maxAttackers: T.maxAttackers, damageScale: T.damageScale, took, label: document.querySelector('#difficulty-slider .dn').textContent }; });
    await page.reload(); await page.waitForFunction('!!window.CyberDifficulty && !!window.CyberAI && !!document.querySelector("#difficulty-slider input")', null, { timeout: 30000 });
    const after = await page.evaluate(() => ({ id: window.CyberDifficulty.get().id, ui: document.querySelector('#difficulty-slider input').value, maxAttackers: window.CyberAI.TUNING.maxAttackers }));
    check('CH-DIFF-4 HARD live + persisted', d4.id === 'hard' && d4.stored === 'hard' && d4.maxAttackers === 5 && d4.damageScale === 1 && d4.took === 25 && after.id === 'hard' && after.ui === '3' && after.maxAttackers === 5,
      JSON.stringify({ d4, after }));
    await ctx.close();

    for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const m = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const mp = await m.newPage();
      mp.on('pageerror', e => errs.push(String(e)));
      await mp.goto(`http://127.0.0.1:${PORT}/index.html`);
      await mp.waitForFunction('!!window.cyberEngine && !!window.CyberDifficulty', null, { timeout: 30000 });
      await mp.waitForTimeout(1500);
      await mp.evaluate(() => document.getElementById('difficulty-slider').scrollIntoView({ block: 'center' }));
      const vis = await visible(mp);
      const box = await (await mp.$('#difficulty-slider input')).boundingBox();
      await mp.touchscreen.tap(box.x + box.width * 0.02, box.y + box.height / 2);   // far left = STORY
      await mp.waitForTimeout(300);
      const r = await mp.evaluate(() => ({ id: window.CyberDifficulty.get().id, overlay: getComputedStyle(document.getElementById('overlay-screen')).display, running: !!window.cyberEngine.isRunning }));
      check(`CH-DIFF-5 mobile ${vp.width}x${vp.height}`, vis && r.id === 'story' && r.overlay !== 'none' && !r.running, JSON.stringify({ vis, ...r }));
      if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `mobile-${vp.width}x${vp.height}-slider.png`) });
      await m.close();
    }
  } catch (e) { fails++; console.log('FAIL  harness ' + (e.stack || e)); }
  check('CH-DIFF-6 page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
