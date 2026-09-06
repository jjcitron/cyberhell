/**
 * qa-mobile-start.js — boots the game in a touch (phone, landscape) emulation
 * and in a desktop emulation, and checks:
 *   1. a touch tap on START actually starts the run (no pointer lock on touch)
 *   2. no page errors on boot or start
 *   3. the FULL SCREEN button shows on touch and is hidden on desktop
 *   4. the pack/level chosen in the menu survives a page reload
 *
 * Runs its own static server on its own port and its own headless Chromium.
 *   QA_PORT=8153 node tests/qa-mobile-start.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8153);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mid': 'audio/midi', '.webmanifest': 'application/manifest+json'
};

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

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

async function bootPage(browser, mobile) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 851, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  // Boot finishes when the pack list is filled and the first level has loaded.
  await page.waitForFunction(() => {
    const ps = document.getElementById('pack-select');
    const t = document.getElementById('overlay-title');
    return ps && ps.options.length > 0 && t && !/CYBERHELL|LOADING/i.test(t.innerText);
  }, null, { timeout: 30000 }).catch(() => {});
  return { ctx, page, errors };
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    /* -------- touch build -------- */
    {
      const { ctx, page, errors } = await bootPage(browser, true);
      const state = await page.evaluate(() => ({
        isTouch: window.cyberEngine && window.cyberEngine.isTouch,
        fsVisible: getComputedStyle(document.getElementById('fullscreen-btn')).display !== 'none',
        hudFsVisible: getComputedStyle(document.getElementById('fs-hud-btn')).display !== 'none',
        title: document.getElementById('overlay-title').innerText,
        sub: document.getElementById('overlay-subtitle').innerText
      }));
      check(state.isTouch === true, `touch build detects a coarse pointer (isTouch=${state.isTouch})`);
      check(!/BOOT ERROR/.test(state.sub), `touch boot shows no BOOT ERROR on the title card (${state.sub.slice(0, 80)})`);
      check(state.fsVisible, 'touch title screen shows the FULL SCREEN button');
      check(state.hudFsVisible, 'touch HUD shows the fullscreen corner button');

      // The bug: on a phone START did nothing because the run only began on
      // pointerlockchange. Tap START and expect the run to be live.
      await page.tap('#start-btn');
      const started = await page.waitForFunction(() => {
        const e = window.cyberEngine;
        return e && e.isRunning === true && document.getElementById('overlay-screen').style.display === 'none';
      }, null, { timeout: 5000 }).then(() => true).catch(() => false);
      check(started, 'tapping START on touch starts the run and hides the overlay');
      await page.waitForTimeout(1500); // a second of frames
      const frames = await page.evaluate(() => window.cyberEngine.player && typeof window.cyberEngine.player.health === 'number');
      check(frames, 'engine is live after the touch start');
      check(errors.length === 0, `no page errors on touch boot/start${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

      // Fullscreen tap must not throw in an environment that refuses it.
      const fsErr = await page.evaluate(async () => { try { window.cyberEngine.toggleFullscreen(); return null; } catch (e) { return e.message; } });
      check(fsErr === null, `toggleFullscreen() does not throw (${fsErr})`);
      await ctx.close();
    }

    /* -------- desktop build: button hidden, persistence -------- */
    {
      const { ctx, page, errors } = await bootPage(browser, false);
      const fsVisible = await page.evaluate(() => getComputedStyle(document.getElementById('fullscreen-btn')).display !== 'none');
      check(!fsVisible, 'desktop title screen hides the FULL SCREEN button');

      // Choose a non-default pack and level, press LOAD LEVEL, then reload.
      const picked = await page.evaluate(async () => {
        const ps = document.getElementById('pack-select');
        const ls = document.getElementById('level-select');
        if (ps.options.length > 1) {
          ps.value = ps.options[1].value;
          ps.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 1500));
        }
        if (ls.options.length > 1) ls.value = ls.options[1].value;
        document.getElementById('load-level-btn').click();
        await new Promise(r => setTimeout(r, 1500));
        return { pack: ps.value, level: ls.value, packs: ps.options.length, levels: ls.options.length };
      });
      check(picked.packs > 0 && picked.levels > 0, `menu has packs (${picked.packs}) and levels (${picked.levels})`);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction((want) => {
        const ls = document.getElementById('level-select');
        return ls && ls.options.length > 0 && ls.value === want;
      }, picked.level, { timeout: 15000 }).catch(() => {});
      const after = await page.evaluate(() => ({
        pack: document.getElementById('pack-select').value,
        level: document.getElementById('level-select').value,
        idx: window.cyberEngine.campaign && window.cyberEngine.campaign.index
      }));
      check(after.pack === picked.pack, `pack select survives reload (${after.pack} == ${picked.pack})`);
      check(after.level === picked.level, `level select survives reload (${after.level} == ${picked.level})`);
      check(after.idx > 0 || picked.levels === 1, `campaign index follows the restored level (index=${after.idx})`);
      check(errors.length === 0, `no page errors on desktop boot/reload${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
