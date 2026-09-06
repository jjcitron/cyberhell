/**
 * qa-mobile-start.js — boots the game in a touch (phone, landscape) emulation
 * and in a desktop emulation, and checks:
 *   1. a touch tap on START actually starts the run (no pointer lock on touch)
 *   2. no page errors on boot or start
 *   3. the FULL SCREEN button shows on touch and is hidden on desktop
 *   4. the pack/level chosen in the menu survives a page reload
 *   5. the FIRE pad fires, and the SAME finger drags to look without letting go
 *   6. a bare drag in the right half looks
 *   7. a second finger on the left third walks the player while the first fires
 *   8. the weapon arrows change weapon, the gear opens/closes Settings
 *   9. no touch control overlaps the HUD at 851x393 or 915x412
 *
 * Multi-touch goes through CDP Input.dispatchTouchEvent: Playwright's
 * touchscreen API is single-tap only, and the whole point of this layout is
 * three fingers at once.
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

/* Raw multi-touch. Playwright only exposes a single tap, so the finger
   choreography (hold fire, drag it, land a second thumb) goes through CDP. */
class Fingers {
  constructor(cdp) { this.cdp = cdp; this.pts = new Map(); }
  async down(id, x, y) {
    this.pts.set(id, { id, x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...this.pts.values()] });
  }
  async move(id, x, y) {
    const p = this.pts.get(id);
    if (!p) throw new Error('no such finger ' + id);
    p.x = x; p.y = y;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...this.pts.values()] });
  }
  /* Slide a finger in steps: one giant jump reads as a single huge delta and
     would hide a handler that only tracks the first move event. */
  async slide(id, x, y, steps = 10) {
    const p = this.pts.get(id);
    const x0 = p.x, y0 = p.y;
    for (let i = 1; i <= steps; i++) await this.move(id, x0 + (x - x0) * i / steps, y0 + (y - y0) * i / steps);
  }
  async up(id) {
    const gone = this.pts.get(id);
    this.pts.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [gone] });
  }
  async allUp() { for (const id of [...this.pts.keys()]) await this.up(id); }
}

/* Two boxes overlap only if they overlap on BOTH axes. */
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function bootPage(browser, mobile, size) {
  const vp = size || { width: 851, height: 393 };
  const ctx = await browser.newContext(mobile
    ? { viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
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

    /* -------- touch control layer: fire, look, move, weapons, layout -------- */
    for (const vp of [{ width: 851, height: 393 }, { width: 915, height: 412 }]) {
      const tag = `${vp.width}x${vp.height}`;
      const { ctx, page, errors } = await bootPage(browser, true, vp);
      const cdp = await ctx.newCDPSession(page);
      const fingers = new Fingers(cdp);

      // All six weapons so the prev/next arrows have something to cycle.
      await page.evaluate(() => { document.getElementById('all-weapons-chk').checked = true; });
      await page.tap('#start-btn');
      await page.waitForFunction(() => window.cyberEngine && window.cyberEngine.isRunning, null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const box = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      }, sel);

      /* ---- the pads are actually laid out and thumb-sized ---- */
      const pads = {};
      for (const id of ['tc-fire', 'tc-use', 'tc-jump', 'tc-wprev', 'tc-wnext', 'tc-look', 'tc-move']) pads[id] = await box('#' + id);
      check(Object.values(pads).every(Boolean), `${tag}: every touch control is in the DOM`);
      check(['tc-fire', 'tc-use', 'tc-jump', 'tc-wprev', 'tc-wnext']
        .every(id => pads[id].w >= 48 && pads[id].h >= 48),
        `${tag}: every action pad is at least 48px (` +
        ['tc-fire', 'tc-use', 'tc-jump', 'tc-wprev', 'tc-wnext'].map(id => `${id}=${Math.round(pads[id].w)}`).join(' ') + ')');
      check(pads['tc-look'].x <= vp.width / 2 + 1 && Math.round(pads['tc-look'].x + pads['tc-look'].w) >= vp.width,
        `${tag}: the look surface covers the whole right half (x=${Math.round(pads['tc-look'].x)}..${Math.round(pads['tc-look'].x + pads['tc-look'].w)})`);

      /* ---- HUD overlap: nothing on the control layer may sit on a readout ---- */
      const hudBoxes = await page.evaluate(() => [...document.querySelectorAll('#hud-bar .hud-block')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => { const r = el.getBoundingClientRect(); return { id: el.querySelector('.hud-label').innerText, x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const ctlBoxes = await page.evaluate(() => [...document.querySelectorAll('#mobile-controls .tc-pad, #mobile-controls .tc-arrow, #mobile-controls .tc-icon, #tc-wname, #fs-hud-btn')]
        .map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const clashes = [];
      hudBoxes.forEach(h => ctlBoxes.forEach(c => { if (overlaps(h, c)) clashes.push(`${c.id} over ${h.id}`); }));
      check(hudBoxes.length >= 3, `${tag}: HUD still shows its readouts (${hudBoxes.map(h => h.id).join(',')})`);
      check(clashes.length === 0, `${tag}: no touch control overlaps the HUD${clashes.length ? ': ' + clashes.join(', ') : ''}`);
      // Controls must not sit on each other either: a pad half under an arrow
      // gives the wrong action to a thumb that landed where it aimed.
      const selfClash = [];
      for (let i = 0; i < ctlBoxes.length; i++) {
        for (let j = i + 1; j < ctlBoxes.length; j++) {
          if (overlaps(ctlBoxes[i], ctlBoxes[j])) selfClash.push(`${ctlBoxes[i].id}/${ctlBoxes[j].id}`);
        }
      }
      check(selfClash.length === 0, `${tag}: no two touch controls overlap${selfClash.length ? ': ' + selfClash.join(', ') : ''}`);
      check(await page.evaluate(() => {
        const s = document.getElementById('tc-stick');
        return getComputedStyle(s).display !== 'none' && parseFloat(getComputedStyle(s).opacity) > 0.05;
      }), `${tag}: the move stick is visible at rest so the zone is discoverable`);

      const offscreen = ctlBoxes.filter(c => c.x < 0 || c.y < 0 || c.x + c.w > vp.width + 0.5 || c.y + c.h > vp.height + 0.5);
      check(offscreen.length === 0, `${tag}: every control is fully on screen${offscreen.length ? ': ' + offscreen.map(o => o.id).join(',') : ''}`);

      /* ---- FIRE pad fires, and the same finger drags to look ---- */
      const before = await page.evaluate(() => ({
        ammo: window.cyberEngine.player.ammo.bullets,
        yaw: window.cyberEngine.yaw
      }));
      await fingers.down(1, pads['tc-fire'].cx, pads['tc-fire'].cy);
      await page.waitForTimeout(120);
      const firing = await page.evaluate(() => ({
        isFiring: window.cyberEngine.isFiring,
        ammo: window.cyberEngine.player.ammo.bullets
      }));
      check(firing.isFiring === true, `${tag}: holding the FIRE pad holds the trigger down`);
      check(firing.ammo < before.ammo, `${tag}: the FIRE pad actually shoots (bullets ${before.ammo} -> ${firing.ammo})`);

      // 200px drag with the finger STILL on the trigger.
      await fingers.slide(1, pads['tc-fire'].cx - 200, pads['tc-fire'].cy, 12);
      await page.waitForTimeout(60);
      const dragged = await page.evaluate(() => ({ yaw: window.cyberEngine.yaw, isFiring: window.cyberEngine.isFiring }));
      const yawTurn = Math.abs(dragged.yaw - before.yaw);
      check(yawTurn > 1.0, `${tag}: dragging the FIRE pad 200px turns the camera (${(yawTurn * 180 / Math.PI).toFixed(0)} deg)`);
      check(dragged.isFiring === true, `${tag}: the trigger stays down through the look drag`);

      await fingers.up(1);
      await page.waitForTimeout(60);
      check(await page.evaluate(() => window.cyberEngine.isFiring === false), `${tag}: lifting off the FIRE pad stops the fire`);

      /* ---- bare drag in the right half looks ---- */
      const yaw0 = await page.evaluate(() => window.cyberEngine.yaw);
      await fingers.down(2, pads['tc-look'].cx, pads['tc-look'].cy);
      await fingers.slide(2, pads['tc-look'].cx - 150, pads['tc-look'].cy, 10);
      await fingers.up(2);
      const yaw1 = await page.evaluate(() => window.cyberEngine.yaw);
      check(Math.abs(yaw1 - yaw0) > 0.8, `${tag}: a bare drag in the right half looks (${((yaw1 - yaw0) * 180 / Math.PI).toFixed(0)} deg)`);

      /* ---- three fingers: move stick + fire + look, all at once ---- */
      const pos0 = await page.evaluate(() => ({ x: window.cyberEngine.camera.position.x, z: window.cyberEngine.camera.position.z }));
      const stickAt = { x: pads['tc-move'].cx, y: pads['tc-move'].cy };
      await fingers.down(3, stickAt.x, stickAt.y);              // left thumb: stick
      await fingers.down(4, pads['tc-fire'].cx, pads['tc-fire'].cy); // right thumb: trigger
      await fingers.slide(3, stickAt.x, stickAt.y - 70, 5);     // push the stick forward
      const stickOn = await page.evaluate(() => ({
        visible: document.getElementById('tc-stick').classList.contains('on'),
        axis: window.cyberEngine.moveAxis,
        firing: window.cyberEngine.isFiring
      }));
      check(stickOn.visible === true, `${tag}: the move stick appears under the thumb that spawned it`);
      check(!!stickOn.axis && stickOn.axis.z < -0.5, `${tag}: pushing the stick forward asks for forward movement (z=${stickOn.axis && stickOn.axis.z.toFixed(2)})`);
      check(stickOn.firing === true, `${tag}: the trigger is still held while the other thumb steers`);
      const yaw2 = await page.evaluate(() => window.cyberEngine.yaw);
      await fingers.slide(4, pads['tc-fire'].cx - 120, pads['tc-fire'].cy, 8); // third axis: look with the trigger finger
      await page.waitForTimeout(700);
      const moved = await page.evaluate(() => ({
        x: window.cyberEngine.camera.position.x, z: window.cyberEngine.camera.position.z, yaw: window.cyberEngine.yaw
      }));
      const dist = Math.hypot(moved.x - pos0.x, moved.z - pos0.z);
      check(dist > 0.3, `${tag}: the second finger walks the player (${dist.toFixed(2)} units)`);
      check(Math.abs(moved.yaw - yaw2) > 0.5, `${tag}: looking still works with three fingers down`);
      await fingers.allUp();
      await page.waitForTimeout(60);
      const rested = await page.evaluate(() => ({ axis: window.cyberEngine.moveAxis, firing: window.cyberEngine.isFiring,
        stick: document.getElementById('tc-stick').classList.contains('on') }));
      check(rested.axis === null && rested.firing === false && rested.stick === false,
        `${tag}: lifting every finger clears movement, fire and the stick`);

      /* ---- weapon arrows ---- */
      const w0 = await page.evaluate(() => window.cyberEngine.player.currentWeapon);
      await page.tap('#tc-wnext');
      const w1 = await page.evaluate(() => ({ w: window.cyberEngine.player.currentWeapon, label: document.getElementById('tc-wname').innerText }));
      check(w1.w !== w0, `${tag}: the next-weapon arrow changes weapon (${w0} -> ${w1.w})`);
      check(w1.label.length > 0, `${tag}: the arrows carry the weapon name (${w1.label})`);
      await page.tap('#tc-wprev');
      check(await page.evaluate((want) => window.cyberEngine.player.currentWeapon === want, w0),
        `${tag}: the prev-weapon arrow goes back`);

      /* ---- automap opens from the top icon and closes by tapping the map ---- */
      await page.tap('#tc-top .tc-icon[data-act="map"]');
      check(await page.evaluate(() => window.cyberEngine.automapOpen === true), `${tag}: the map icon opens the automap`);
      await page.tap('#automap-modal');
      check(await page.evaluate(() => window.cyberEngine.automapOpen === false), `${tag}: tapping the automap closes it (the icon is buried under it)`);

      /* ---- settings sheet ---- */
      await page.tap('#tc-top .tc-icon[data-act="settings"]');
      const opened = await page.evaluate(() => ({
        on: document.getElementById('tc-settings-panel').classList.contains('on'),
        running: window.cyberEngine.isRunning
      }));
      check(opened.on && !opened.running, `${tag}: the gear opens Settings and freezes the sim`);
      await page.evaluate(() => {
        const s = document.getElementById('tc-set-sens');
        s.value = '200'; s.dispatchEvent(new Event('input'));
        const l = document.getElementById('tc-set-lefty');
        l.checked = true; l.dispatchEvent(new Event('input'));
      });
      const applied = await page.evaluate(() => ({
        sens: window.cyberEngine.touchOpts.sens,
        lefty: document.getElementById('mobile-controls').classList.contains('lefty'),
        saved: JSON.parse(localStorage.getItem('cyberhell.touch') || '{}')
      }));
      check(applied.sens === 200 && applied.lefty === true, `${tag}: Settings apply live (sens=${applied.sens} lefty=${applied.lefty})`);
      check(applied.saved.sens === 200 && applied.saved.lefty === true, `${tag}: Settings persist to localStorage`);
      const leftFire = await box('#tc-fire');
      check(leftFire.cx < vp.width / 2, `${tag}: left-handed puts the FIRE pad on the left (cx=${Math.round(leftFire.cx)})`);
      await page.evaluate(() => {
        const l = document.getElementById('tc-set-lefty');
        l.checked = false; l.dispatchEvent(new Event('input'));
      });
      await page.tap('#tc-settings-close');
      check(await page.evaluate(() => !document.getElementById('tc-settings-panel').classList.contains('on') && window.cyberEngine.isRunning),
        `${tag}: closing Settings resumes the run`);

      await page.screenshot({ path: path.join(ROOT, `.claude-documentation/audits/touch-${tag}.png`) });
      check(errors.length === 0, `${tag}: no page errors through the whole touch pass${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
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
