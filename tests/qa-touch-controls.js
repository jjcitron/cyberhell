/**
 * qa-touch-controls.js — visual + behavioral QA for the GDK touch pass.
 *
 *   PLAYWRIGHT_PATH=... QA_PORT=8161 node tests/qa-touch-controls.js
 *
 * Viewports: 390x844, 844x390, Pixel 9 Pro XL 412x915 / 915x412, desktop 1280x800.
 * Touch emulation on the phone passes. Saves stills next to this file's
 * --out dir (default .qa-touch/). Checks: no page errors, pads >= 48px,
 * portrait is playable (no full-screen rotate wall), fire is inset,
 * lefty mirror, tab-hide pauses, desktop hides the touch layer,
 * gyro prompt appears on a fresh first run.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const PW_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  path.join(__dirname, '..', '.qa-scratch', 'node_modules', 'playwright-core'),
  'C:/dev/Personal/cyberhell/.qa-scratch/node_modules/playwright-core',
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core',
].filter(Boolean);
const PW_PATH = PW_CANDIDATES.find((c) => { try { return require('fs').existsSync(c); } catch (e) { return false; } }) || PW_CANDIDATES[PW_CANDIDATES.length - 1];
const { chromium } = require(PW_PATH);


const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8161);
const OUT = path.resolve(process.env.QA_OUT || path.join(ROOT, '.qa-touch'));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mid': 'audio/midi', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.css': 'text/css', '.wad': 'application/octet-stream',
  '.WAD': 'application/octet-stream',
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

async function openPage(browser, { width, height, touch, urlExtra = '' }) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: !!touch,
    isMobile: !!touch,
    deviceScaleFactor: 2,
    userAgent: touch
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror:' + String(e)));
  const ignored404 = (url) => /\/api\/event(?:\?|$)/.test(url || '');
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (r.status() === 404 && ignored404(r.url())) return; // telemetry sink is a Vercel function, absent on this static server
    errors.push('http' + r.status() + ':' + r.url());
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Chrome's 404 console line has no URL; real 404s are caught via 'response' above.
    if (/Failed to load resource: the server responded with a status of 404/.test(text)) return;
    errors.push('console:' + text);
  });
  const url = `http://127.0.0.1:${PORT}/index.html?touch=${touch ? '1' : '0'}${urlExtra}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Let the engine construct.
  await page.waitForFunction(() => window.cyberEngine || window.CYBER_TOUCH === true || window.CYBER_TOUCH === false, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { context, page, errors };
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const dest = path.join(OUT, name);
  await page.screenshot({ path: dest, fullPage: false });
  console.log('SHOT', dest);
  return dest;
}

async function padBoxes(page) {
  return page.evaluate(() => {
    const ids = ['tc-look', 'tc-move', 'tc-stick', 'tc-fire', 'tc-use', 'tc-jump', 'tc-melee', 'tc-wprev', 'tc-wnext', 'tc-lock'];
    const icons = [...document.querySelectorAll('#tc-top .tc-icon')].map((el, i) => {
      const r = el.getBoundingClientRect();
      return { id: 'tc-icon-' + i, x: r.x, y: r.y, w: r.width, h: r.height, display: getComputedStyle(el).display, visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' };
    });
    const pads = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { pads[id] = null; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      pads[id] = { id, x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, opacity: cs.opacity, visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' };
    }
    const root = document.getElementById('mobile-controls');
    const nudge = document.getElementById('rotate-nudge');
    const gyro = document.getElementById('tc-gyro-prompt');
    const fsHud = document.getElementById('fs-hud-btn');
    const rootCs = root && getComputedStyle(root);
    const nudgeCs = nudge && getComputedStyle(nudge);
    const gyroCs = gyro && getComputedStyle(gyro);
    const fsCs = fsHud && getComputedStyle(fsHud);
    return {
      pads, icons,
      rootDisplay: rootCs && rootCs.display,
      htmlTouch: document.documentElement.classList.contains('touch'),
      nudge: nudge && { display: nudgeCs.display, w: nudge.getBoundingClientRect().width, h: nudge.getBoundingClientRect().height, text: nudge.innerText, dismissed: nudge.classList.contains('dismissed') },
      gyro: gyro && { hidden: gyro.hasAttribute('hidden'), display: gyroCs.display, text: gyro.innerText },
      fsHud: fsHud && { display: fsCs.display, w: fsHud.getBoundingClientRect().width, h: fsHud.getBoundingClientRect().height },
      vp: { w: window.innerWidth, h: window.innerHeight },
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
}

function overlaps(a, b, gutter = 0) {
  return a.x + a.w + gutter > b.x && b.x + b.w + gutter > a.x && a.y + a.h + gutter > b.y && b.y + b.h + gutter > a.y;
}

async function startRun(page) {
  // Dismiss splash if any, then click ENTER THE ABYSS.
  await page.evaluate(() => {
    const splash = document.getElementById('acid-splash') || document.querySelector('[data-acid-splash]');
    if (splash) splash.remove();
  });
  // Spy auto-enter BEFORE the click: the Fullscreen API will refuse in
  // headless, but the Play gesture must still invoke it synchronously.
  await page.evaluate(() => {
    window.__fsCalls = 0;
    window.__fsFromAuto = 0;
    const eng = window.cyberEngine;
    if (!eng) return;
    if (eng.enterLandscapeFullscreen && !eng.enterLandscapeFullscreen.__spied) {
      const orig = eng.enterLandscapeFullscreen.bind(eng);
      const wrapped = function () { window.__fsCalls++; return orig(); };
      wrapped.__spied = true;
      eng.enterLandscapeFullscreen = wrapped;
    }
    if (eng.autoEnterFullscreen && !eng.autoEnterFullscreen.__spied) {
      const origA = eng.autoEnterFullscreen.bind(eng);
      const wrappedA = function () { window.__fsFromAuto++; return origA(); };
      wrappedA.__spied = true;
      eng.autoEnterFullscreen = wrappedA;
    }
  });
  const btn = page.locator('#start-btn');
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
  await page.waitForFunction(() => window.cyberEngine && window.cyberEngine.isRunning, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    running: !!(window.cyberEngine && window.cyberEngine.isRunning),
    isTouch: !!(window.cyberEngine && window.cyberEngine.isTouch),
    fsCalls: window.__fsCalls || 0,
    fsFromAuto: window.__fsFromAuto || 0,
  }));
}

async function runTouchViewport(browser, tag, width, height) {
  const { context, page, errors } = await openPage(browser, { width, height, touch: true });
  const boot = await padBoxes(page);
  check(boot.htmlTouch === true, `${tag}: html.touch is on`);
  check(boot.rootDisplay === 'block', `${tag}: #mobile-controls is shown (display=${boot.rootDisplay})`);
  // Portrait must not be a full-screen rotate wall.
  if (height > width) {
    check(!!boot.nudge && boot.nudge.display === 'flex', `${tag}: landscape-preferred chip is visible`);
    check(!!boot.nudge && boot.nudge.h < height * 0.25, `${tag}: chip is not a full-screen wall (h=${boot.nudge && boot.nudge.h})`);
    check(!!boot.nudge && /LANDSCAPE PREFERRED/.test(boot.nudge.text), `${tag}: chip copy`);
  } else {
    check(!boot.nudge || boot.nudge.display === 'none', `${tag}: landscape-preferred chip hidden in landscape`);
  }
  await shot(page, `${tag}-title.png`);

  const started = await startRun(page);
  check(started.running === true, `${tag}: START starts the run`);
  check(started.isTouch === true, `${tag}: engine is in the touch build`);
  check(started.fsFromAuto >= 1, `${tag}: Play click called autoEnterFullscreen (calls=${started.fsFromAuto})`);
  check(started.fsCalls >= 1, `${tag}: auto-enter delegated to enterLandscapeFullscreen (calls=${started.fsCalls})`);
  await page.waitForTimeout(500);
  const play = await padBoxes(page);
  await shot(page, `${tag}-play.png`);

  const need = ['tc-fire', 'tc-use', 'tc-jump', 'tc-stick', 'tc-look', 'tc-move'];
  for (const id of need) {
    check(play.pads[id] && play.pads[id].visible, `${tag}: ${id} is visible`);
  }
  // 48px targets (look/move are invisible surfaces, stick is 132, lock is 48).
  for (const id of ['tc-fire', 'tc-use', 'tc-jump', 'tc-melee', 'tc-wprev', 'tc-wnext', 'tc-lock']) {
    const p = play.pads[id];
    if (!p || !p.visible) continue;
    check(p.w >= 47.5 && p.h >= 47.5, `${tag}: ${id} is >= 48px (${Math.round(p.w)}x${Math.round(p.h)})`);
  }
  if (play.fsHud && play.fsHud.display === 'flex') {
    check(play.fsHud.w >= 47.5 && play.fsHud.h >= 47.5, `${tag}: fs-hud-btn >= 48px (${Math.round(play.fsHud.w)}x${Math.round(play.fsHud.h)})`);
  }
  // Fire sits inward of jump (outer-right cluster): fire.x < jump.x in right-handed layout.
  const fire = play.pads['tc-fire'], jump = play.pads['tc-jump'];
  if (fire && jump && fire.visible && jump.visible) {
    check(fire.x + 8 < jump.x, `${tag}: fire is inward of jump (fire.x=${Math.round(fire.x)} jump.x=${Math.round(jump.x)})`);
    // And not parked on the far right edge: there is swipe room to the right of fire,
    // occupied by the jump/use cluster, at least 60px of glass past fire's right edge.
    const room = play.vp.w - (fire.x + fire.w);
    check(room >= 60, `${tag}: swipe room to the right of fire is ${Math.round(room)}px`);
    // Height: fire's center should sit at the natural right-thumb rest,
    // not hugging the bottom edge. Landscape 40–55% from the bottom;
    // portrait in the lower-middle third (~25–45%).
    const centerFromBottom = play.vp.h - (fire.y + fire.h / 2);
    const pct = centerFromBottom / play.vp.h;
    const landscape = play.vp.w > play.vp.h;
    if (landscape) {
      check(pct >= 0.38 && pct <= 0.58,
        `${tag}: fire center at ${(pct * 100).toFixed(1)}% from bottom (want ~40–55% in landscape)`);
    } else {
      check(pct >= 0.25 && pct <= 0.45,
        `${tag}: fire center at ${(pct * 100).toFixed(1)}% from bottom (want lower-middle third in portrait)`);
    }
    const bottomEdge = play.vp.h - (fire.y + fire.h);
    check(bottomEdge / play.vp.h >= 0.20,
      `${tag}: fire bottom is ${Math.round(bottomEdge)}px (${(bottomEdge / play.vp.h * 100).toFixed(0)}%) off the bottom edge`);
  }
  // Pads fully on screen.
  for (const p of Object.values(play.pads)) {
    if (!p || !p.visible || p.id === 'tc-look' || p.id === 'tc-move') continue;
    const off = p.x < -1 || p.y < -1 || p.x + p.w > play.vp.w + 1 || p.y + p.h > play.vp.h + 1;
    check(!off, `${tag}: ${p.id} is on screen (${Math.round(p.x)},${Math.round(p.y)} ${Math.round(p.w)}x${Math.round(p.h)} in ${play.vp.w}x${play.vp.h})`);
  }
  // Gyro prompt on a fresh store (we cleared storage via a fresh context).
  // It appears after resumeRun; may already be visible.
  const gyro = play.gyro;
  check(gyro && gyro.hidden === false && /TILT TO AIM/.test(gyro.text || ''), `${tag}: gyro prompt is offered on first play (hidden=${gyro && gyro.hidden} text=${gyro && gyro.text})`);
  await shot(page, `${tag}-gyro.png`);
  // Dismiss it so it does not cover later stills.
  const noBtn = page.locator('#tc-gyro-no');
  if (await noBtn.isVisible().catch(() => false)) await noBtn.click();

  // Dismiss landscape chip in portrait so later stills are clean.
  if (height > width) {
    const chip = page.locator('#rotate-nudge');
    if (await chip.isVisible().catch(() => false)) {
      await chip.click();
      const after = await page.evaluate(() => document.getElementById('rotate-nudge').classList.contains('dismissed'));
      check(after === true, `${tag}: tapping the chip dismisses it`);
    }
  }

  // Tab-hide pauses the run.
  const paused = await page.evaluate(() => {
    const eng = window.cyberEngine;
    const before = !!(eng && eng.isRunning);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const ov = document.getElementById('overlay-screen');
    return {
      before,
      running: !!(eng && eng.isRunning),
      overlay: ov && getComputedStyle(ov).display,
      title: (document.getElementById('overlay-title') || {}).innerText || '',
    };
  });
  check(paused.before === true, `${tag}: run was live before tab-hide`);
  check(paused.running === false, `${tag}: tab-hide pauses the run`);
  check(paused.overlay === 'flex', `${tag}: pause overlay is shown after tab-hide`);
  await shot(page, `${tag}-paused.png`);

  // Resume, then lefty.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
  const resume = page.locator('#start-btn');
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const eng = window.cyberEngine;
    if (!eng || !eng.touchOpts) return;
    eng.touchOpts.lefty = true;
    eng.applyTouchOpts();
  });
  await page.waitForTimeout(200);
  const lefty = await padBoxes(page);
  const lf = lefty.pads['tc-fire'];
  if (lf && lf.visible) {
    check(lf.x + lf.w / 2 < lefty.vp.w / 2, `${tag}: lefty puts fire on the left (cx=${Math.round(lf.x + lf.w / 2)})`);
  }
  await shot(page, `${tag}-lefty.png`);

  // Idle fade: force the class and photograph.
  await page.evaluate(() => {
    const eng = window.cyberEngine;
    if (eng && eng.touchOpts) { eng.touchOpts.lefty = false; eng.applyTouchOpts(); }
    // First-map fire/jump highlight is allowed to stay bright; strip it so
    // this still verifies the idle fade itself.
    document.getElementById('tc-fire')?.classList.remove('tc-hint');
    document.getElementById('tc-jump')?.classList.remove('tc-hint');
    document.getElementById('mobile-controls').classList.add('idle');
  });
  // Idle fade uses a 0.55s opacity transition; wait it out.
  await page.waitForTimeout(750);
  const idle = await padBoxes(page);
  const idleFire = idle.pads['tc-fire'];
  if (idleFire) {
    check(Number(idleFire.opacity) < 0.35, `${tag}: idle fire is faded (opacity=${idleFire.opacity})`);
  }
  await shot(page, `${tag}-idle.png`);

  check(errors.length === 0, `${tag}: no page errors${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
  await context.close();
  return errors;
}

async function runDesktop(browser) {
  const { context, page, errors } = await openPage(browser, { width: 1280, height: 800, touch: false });
  const info = await padBoxes(page);
  check(info.htmlTouch === false, `desktop: html.touch is off`);
  check(info.rootDisplay === 'none', `desktop: #mobile-controls is hidden (display=${info.rootDisplay})`);
  const fsBtn = await page.evaluate(() => {
    const el = document.getElementById('fullscreen-btn');
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return { exists: true, display: cs.display, visible: cs.display !== 'none' && el.offsetParent !== null };
  });
  check(fsBtn.exists && fsBtn.visible === false, `desktop: FULL SCREEN title button is hidden`);
  await shot(page, 'desktop-title.png');
  // Start should take the pointer-lock path (lock will be refused in headless;
  // the engine may stay on the overlay — that's existing desktop behavior.
  // We only assert the touch layer stayed hidden and no errors).
  const started = await page.evaluate(() => {
    window.__fsCalls = 0;
    window.__fsFromAuto = 0;
    const eng = window.cyberEngine;
    if (eng && eng.enterLandscapeFullscreen && !eng.enterLandscapeFullscreen.__spied) {
      const orig = eng.enterLandscapeFullscreen.bind(eng);
      const wrapped = function () { window.__fsCalls++; return orig(); };
      wrapped.__spied = true;
      eng.enterLandscapeFullscreen = wrapped;
    }
    if (eng && eng.autoEnterFullscreen && !eng.autoEnterFullscreen.__spied) {
      const origA = eng.autoEnterFullscreen.bind(eng);
      const wrappedA = function () { window.__fsFromAuto++; return origA(); };
      wrappedA.__spied = true;
      eng.autoEnterFullscreen = wrappedA;
    }
    const btn = document.getElementById('start-btn');
    if (btn) btn.click();
    return {
      isTouch: !!(eng && eng.isTouch),
      hasRequestLock: !!(eng && eng.canvas && typeof eng.canvas.requestPointerLock === 'function'),
      fsFromAuto: window.__fsFromAuto || 0,
      fsCalls: window.__fsCalls || 0,
    };
  });
  await page.waitForTimeout(500);
  check(started.isTouch === false, `desktop: engine stays on the pointer-lock build`);
  check(started.fsCalls === 0, `desktop: Play click does not request fullscreen (enterLandscapeFullscreen calls=${started.fsCalls}, autoEnter=${started.fsFromAuto})`);
  const after = await padBoxes(page);
  check(after.rootDisplay === 'none', `desktop: touch layer still hidden after START`);
  check(after.gyro && after.gyro.hidden === true, `desktop: gyro prompt stays hidden`);
  await shot(page, 'desktop-after-start.png');
  check(errors.length === 0, `desktop: no page errors${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
  await context.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    await runTouchViewport(browser, 'portrait', 390, 844);
    await runTouchViewport(browser, 'landscape', 844, 390);
    // Pixel 9 Pro XL-like CSS viewports (Joel's playtest device).
    await runTouchViewport(browser, 'portrait-p9', 412, 915);
    await runTouchViewport(browser, 'landscape-p9', 915, 412);
    await runDesktop(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASSED');
  for (const f of failures) console.log(' -', f);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
