/**
 * qa-tablet.js — Android tablet detection (TCL NXTPAPER class) in headless Chromium.
 *
 * A tablet with a stylus digitizer reports (pointer: fine) in Chrome, which used
 * to give it the desktop build: no touch pad, pointer lock requested on START.
 * Playwright's touch emulation always forces (pointer: coarse), so the stylus
 * tablet is emulated with Blink's own pointer settings instead:
 *   --blink-settings=primaryPointerType=4(fine),availablePointerTypes=6(fine|coarse)
 * plus --touch-events=enabled and maxTouchPoints=10.
 *
 * Checks:
 *   1. finger-only Android tablet (pointer: coarse), landscape 1280x800@1.5: touch build, START tap runs, pad shown
 *   2. stylus Android tablet (pointer: fine), no "Mobile" in UA: touch build, START runs without pointer lock
 *   3. same tablet in Chrome "desktop site" mode (X11 Linux UA): touch build
 *   4. portrait tablet shows the rotate prompt
 *   5. Windows touchscreen laptop: stays desktop (pointer lock on START)
 *   6. Windows touchscreen laptop, finger press on the title: upgrades to the touch build
 *   7. ?touch=0 forces desktop on the stylus tablet, ?touch=auto clears it
 *   8. touch drawing buffer stays inside the pixel budget; no page errors anywhere
 *
 *   QA_PORT=8154 node tests/qa-tablet.js
 * Env: PLAYWRIGHT_CORE (module path) and CHROME_PATH (browser) override the defaults.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('playwright-core not found; set PLAYWRIGHT_CORE');
}
const { chromium } = loadPlaywright();
const CHROME = process.env.CHROME_PATH || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8154);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mid': 'audio/midi', '.webmanifest': 'application/manifest+json' };
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

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

const UA_TAB = 'Mozilla/5.0 (Linux; Android 13; 9137W) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const UA_TAB_DESKTOP_SITE = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const STYLUS = 'primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=3';

async function open({ ua, w = 1280, h = 800, dpr = 1.5, finger = false, query = '' }) {
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (!finger) args.push('--blink-settings=' + STYLUS, '--touch-events=enabled');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: finger, isMobile: finger, userAgent: ua });
  if (!finger) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 10 }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cyberEngine, null, { timeout: 30000 });
  return { browser, page, errors };
}
const state = (page) => page.evaluate(() => ({
  isTouch: window.cyberEngine.isTouch,
  htmlTouch: document.documentElement.classList.contains('touch'),
  fine: matchMedia('(pointer: fine)').matches,
  running: window.cyberEngine.isRunning,
  locked: !!document.pointerLockElement,
  pad: getComputedStyle(document.getElementById('mobile-controls')).display,
  rotate: getComputedStyle(document.getElementById('rotate-nudge')).display,
  buffer: (() => { const c = window.cyberEngine.renderer.domElement; return c.width * c.height; })(),
}));
async function tapStart(page, how) {
  const b = await page.locator('#start-btn').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (how === 'finger') await page.touchscreen.tap(x, y);
  else if (how === 'pen') {
    // A pen tap: pointerdown(pen) then the compat click. Synthetic pointerdown
    // because headless has no pen digitizer.
    await page.evaluate(([x, y]) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', clientX: x, clientY: y })), [x, y]);
    await page.mouse.click(x, y);
  } else await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

(async () => {
  const server = await serve();
  try {
    // 1. finger-only tablet
    {
      const { browser, page, errors } = await open({ ua: UA_TAB, finger: true });
      let s = await state(page);
      check(s.isTouch && s.htmlTouch, '1 finger tablet boots the touch build');
      check(s.buffer <= 1.65e6, `1 finger tablet drawing buffer ${s.buffer} px within 1.6 MP budget`);
      await tapStart(page, 'finger');
      s = await state(page);
      check(s.running && !s.locked && s.pad === 'block', '1 finger tablet: START tap runs, pad shown, no pointer lock');
      check(errors.length === 0, '1 no page errors ' + errors.join(' | '));
      await browser.close();
    }
    // 2. stylus tablet, Android UA without "Mobile"
    {
      const { browser, page, errors } = await open({ ua: UA_TAB });
      let s = await state(page);
      check(s.fine, '2 emulation sanity: stylus tablet reports (pointer: fine)');
      check(s.isTouch && s.htmlTouch && s.pad === 'block', '2 stylus tablet boots the touch build despite pointer: fine');
      await tapStart(page, 'pen');
      s = await state(page);
      check(s.running && !s.locked, '2 stylus tablet: START runs without pointer lock');
      check(errors.length === 0, '2 no page errors ' + errors.join(' | '));
      await browser.close();
    }
    // 3. desktop-site mode UA
    {
      const { browser, page } = await open({ ua: UA_TAB_DESKTOP_SITE });
      const s = await state(page);
      check(s.isTouch && s.pad === 'block', '3 tablet in "desktop site" mode (X11 UA) boots the touch build');
      await browser.close();
    }
    // 4. portrait
    {
      const { browser, page } = await open({ ua: UA_TAB, w: 800, h: 1280 });
      const s = await state(page);
      check(s.rotate === 'flex' && s.pad === 'none', '4 portrait stylus tablet shows the rotate prompt');
      await browser.close();
    }
    // 5. Windows touchscreen laptop, mouse click
    {
      const { browser, page } = await open({ ua: UA_WIN, w: 1366, h: 768, dpr: 1 });
      let s = await state(page);
      check(!s.isTouch && !s.htmlTouch && s.pad === 'none', '5 Windows touchscreen laptop boots the desktop build');
      await tapStart(page, 'mouse');
      s = await state(page);
      check(s.locked && s.running && !s.isTouch, '5 Windows laptop mouse START takes pointer lock (desktop preserved)');
      await browser.close();
    }
    // 6. Windows touchscreen laptop, finger on the title
    {
      const { browser, page } = await open({ ua: UA_WIN, w: 1366, h: 768, dpr: 1 });
      await page.evaluate(() => document.getElementById('start-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })));
      await page.click('#start-btn');
      await page.waitForTimeout(800);
      const s = await state(page);
      check(s.isTouch && s.htmlTouch && s.running && !s.locked && s.pad === 'block', '6 finger press upgrades a desktop-detected session to the touch build');
      await browser.close();
    }
    // 7. overrides
    {
      const { browser, page } = await open({ ua: UA_TAB, query: '?touch=0' });
      let s = await state(page);
      check(!s.isTouch && s.pad === 'none', '7 ?touch=0 forces desktop on the stylus tablet');
      await page.goto(`http://127.0.0.1:${PORT}/index.html`);
      await page.waitForFunction(() => window.cyberEngine);
      s = await state(page);
      check(!s.isTouch, '7 ?touch=0 is remembered across reloads');
      await page.goto(`http://127.0.0.1:${PORT}/index.html?touch=auto`);
      await page.waitForFunction(() => window.cyberEngine);
      s = await state(page);
      check(s.isTouch, '7 ?touch=auto clears the override');
      await browser.close();
    }
  } finally { server.close(); }
  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
