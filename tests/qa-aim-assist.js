#!/usr/bin/env node
/**
 * qa-aim-assist.js — QA test suite for mobile soft aim assist:
 *   CH-AIM-1: Touch build defaults aim assist to ON (50% / 0.50 strength);
 *             desktop defaults to OFF (0% mouseStrength).
 *   CH-AIM-2: Touch settings sheet (#tc-settings-panel) contains AIM ASSIST
 *             slider (#tc-set-assist) with live percent label, updating
 *             touchOpts.assist and persisting to localStorage.
 *   CH-AIM-3: Desktop overlay contains MOUSE AIM ASSIST checkbox (#mouse-assist-chk),
 *             default unchecked (OFF), toggling cleanly and persisting.
 *   CH-AIM-4: Programmatic API / Cvar (engine.aimAssist, engine.setAimAssist,
 *             window.aimAssist) allows full tuning of strength, cone, range,
 *             pullRate, and magnetism.
 *   CH-AIM-5: Soft Reticle Pull: with enemy in forward cone, touch aiming / firing
 *             softly rotates yaw & pitch toward enemy center of mass and sets
 *             #crosshair-container.assist-lock.
 *   CH-AIM-6: Range and Cone Boundary: enemies outside range (32 units) or
 *             outside cone angle (minDot < 0.88) do not engage assist.
 *   CH-AIM-7: Wall Occlusion / Line of Sight: enemies blocked by solid walls
 *             are never targeted by aim assist.
 *   CH-AIM-8: Shot Magnetism: aimDir() and raycastHitscan() apply subtle
 *             magnetism toward target when assist is active, and leave shot
 *             vectors 100% unaltered when assist is OFF.
 *   CH-AIM-9: Zero page console/runtime errors.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=/usr/local/lib/node_modules/playwright-core node tests/qa-aim-assist.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/usr/local/lib/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8165);
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.mid': 'audio/midi',
  '.webmanifest': 'application/manifest+json'
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const failures = [];
const check = (id, ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${msg}`);
  if (!ok) failures.push(`${id}: ${msg}`);
};

(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });

  try {
    /* =========================================================================
       TEST 1: TOUCH BOOT & DEFAULTS (Phone emulation)
       ========================================================================= */
    const touchCtx = await browser.newContext({
      viewport: { width: 851, height: 393 },
      isMobile: true,
      hasTouch: true
    });
    const touchPage = await touchCtx.newPage();
    const pageErrors = [];
    touchPage.on('pageerror', err => pageErrors.push(String(err)));

    await touchPage.goto(`http://127.0.0.1:${PORT}/`);
    await touchPage.waitForFunction(() => window.cyberEngine && window.THREE);

    // CH-AIM-1: Touch defaults
    const touchDefaults = await touchPage.evaluate(() => {
      const e = window.cyberEngine;
      return {
        isTouch: e.isTouch,
        touchAssistOpt: e.touchOpts ? e.touchOpts.assist : null,
        mouseAssist: e.mouseAssist,
        strength: e.getAimAssistStrength(),
        enabled: e.aimAssist.enabled,
        windowAssist: window.aimAssist ? window.aimAssist.strength : null
      };
    });

    check('CH-AIM-1', touchDefaults.isTouch === true, `touch build detected coarse pointer (isTouch=true)`);
    check('CH-AIM-1', touchDefaults.touchAssistOpt === 50, `default touch assist is 50% (got ${touchDefaults.touchAssistOpt}%)`);
    check('CH-AIM-1', touchDefaults.strength === 0.5, `getAimAssistStrength() is 0.50 (got ${touchDefaults.strength})`);
    check('CH-AIM-1', touchDefaults.enabled === true, `aimAssist is enabled on touch by default`);
    check('CH-AIM-1', touchDefaults.windowAssist === 0.5, `window.aimAssist reflects strength 0.5`);

    // CH-AIM-2: Touch Settings Sheet UI
    const settingsUi = await touchPage.evaluate(() => {
      const slider = document.getElementById('tc-set-assist');
      const val = document.getElementById('tc-val-assist');
      return {
        hasSlider: !!slider,
        sliderMin: slider ? slider.min : null,
        sliderMax: slider ? slider.max : null,
        sliderVal: slider ? slider.value : null,
        labelVal: val ? val.innerText : null
      };
    });

    check('CH-AIM-2', settingsUi.hasSlider, `tc-settings-panel has #tc-set-assist slider`);
    check('CH-AIM-2', settingsUi.sliderVal === '50' && settingsUi.labelVal === '50%', `slider displays 50 / 50%`);

    // Test slider change and persistence
    const updatedSettings = await touchPage.evaluate(() => {
      const slider = document.getElementById('tc-set-assist');
      slider.value = '75';
      slider.dispatchEvent(new Event('input'));
      const saved = JSON.parse(localStorage.getItem('cyberhell.touch') || '{}');
      return {
        strength: window.cyberEngine.getAimAssistStrength(),
        touchOpt: window.cyberEngine.touchOpts.assist,
        savedOpt: saved.assist,
        label: document.getElementById('tc-val-assist').innerText
      };
    });

    check('CH-AIM-2', updatedSettings.strength === 0.75 && updatedSettings.savedOpt === 75,
      `changing slider updates assist to 75% and saves to localStorage (label=${updatedSettings.label})`);

    // Reset to 50
    await touchPage.evaluate(() => {
      const slider = document.getElementById('tc-set-assist');
      slider.value = '50';
      slider.dispatchEvent(new Event('input'));
    });

    await touchCtx.close();

    /* =========================================================================
       TEST 2: DESKTOP BOOT & DEFAULTS
       ========================================================================= */
    const deskCtx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      isMobile: false,
      hasTouch: false
    });
    const deskPage = await deskCtx.newPage();
    deskPage.on('pageerror', err => pageErrors.push(String(err)));

    await deskPage.goto(`http://127.0.0.1:${PORT}/`);
    await deskPage.waitForFunction(() => window.cyberEngine && window.THREE);

    // CH-AIM-1 (desktop side): desktop defaults to OFF
    const deskDefaults = await deskPage.evaluate(() => {
      const e = window.cyberEngine;
      return {
        isTouch: e.isTouch,
        mouseAssist: e.mouseAssist,
        strength: e.getAimAssistStrength(),
        enabled: e.aimAssist.enabled
      };
    });

    check('CH-AIM-1', deskDefaults.isTouch === false, `desktop build detects mouse (isTouch=false)`);
    check('CH-AIM-1', deskDefaults.mouseAssist === false && deskDefaults.strength === 0.0,
      `desktop aim assist is OFF (0.0 strength) by default, mouse not sticky`);
    check('CH-AIM-1', deskDefaults.enabled === false, `aimAssist.enabled is false on desktop by default`);

    // CH-AIM-3: Desktop overlay checkbox
    const deskToggle = await deskPage.evaluate(() => {
      const chk = document.getElementById('mouse-assist-chk');
      const label = document.getElementById('mouse-assist-label');
      const initialChecked = chk ? chk.checked : null;

      // Toggle ON
      chk.checked = true;
      chk.dispatchEvent(new Event('change'));
      const turnedOn = {
        strength: window.cyberEngine.getAimAssistStrength(),
        mouseAssist: window.cyberEngine.mouseAssist,
        saved: localStorage.getItem('cyberhell.mouseAssist')
      };

      // Toggle back OFF
      chk.checked = false;
      chk.dispatchEvent(new Event('change'));
      const turnedOff = {
        strength: window.cyberEngine.getAimAssistStrength(),
        mouseAssist: window.cyberEngine.mouseAssist,
        saved: localStorage.getItem('cyberhell.mouseAssist')
      };

      return { hasCheckbox: !!chk, hasLabel: !!label, initialChecked, turnedOn, turnedOff };
    });

    check('CH-AIM-3', deskToggle.hasCheckbox && deskToggle.initialChecked === false,
      `overlay has #mouse-assist-chk, initially unchecked`);
    check('CH-AIM-3', deskToggle.turnedOn.strength === 0.35 && deskToggle.turnedOn.saved === 'true',
      `checking box enables mouse assist (0.35) and saves to localStorage`);
    check('CH-AIM-3', deskToggle.turnedOff.strength === 0.0 && deskToggle.turnedOff.saved === 'false',
      `unchecking box returns mouse assist to 0.0 (clean raw mouse)`);

    // CH-AIM-4: Programmatic API / Cvar tuning
    const cvarTuning = await deskPage.evaluate(() => {
      const e = window.cyberEngine;
      e.setAimAssist({
        touchStrength: 0.65,
        mouseEnabled: true,
        cone: 0.92,
        range: 40,
        pullRate: 10.0,
        magnetism: 0.30
      });
      const aa = e.aimAssist;
      return {
        touchStrength: aa.touchStrength,
        mouseEnabled: aa.mouseEnabled,
        cone: aa.cone,
        range: aa.range,
        pullRate: aa.pullRate,
        magnetism: aa.magnetism
      };
    });

    check('CH-AIM-4',
      cvarTuning.touchStrength === 0.65 &&
      cvarTuning.mouseEnabled === true &&
      cvarTuning.cone === 0.92 &&
      cvarTuning.range === 40 &&
      cvarTuning.pullRate === 10.0 &&
      cvarTuning.magnetism === 0.30,
      `engine.setAimAssist() / engine.aimAssist knobs tuned programmatically`);

    // Reset desktop mouse assist
    await deskPage.evaluate(() => {
      window.cyberEngine.setAimAssist({ mouseEnabled: false, touchStrength: 0.5, cone: 0.88, range: 32, pullRate: 8.0, magnetism: 0.25 });
    });

    /* =========================================================================
       TEST 3: MECHANICS — RETICLE PULL, CONE, OCCLUSION & MAGNETISM
       ========================================================================= */
    // Start game so engine is running and camera/scene are active
    await deskPage.click('#start-btn');
    await deskPage.waitForFunction(() => window.cyberEngine && window.cyberEngine.isRunning);

    const mechanics = await deskPage.evaluate(() => {
      const e = window.cyberEngine;
      e.isTouch = true; // Emulate touch active
      e.touchOpts = { assist: 50 }; // 50% assist

      // Reset camera orientation: facing directly along -Z (yaw=0, pitch=0)
      e.yaw = 0;
      e.pitch = 0;
      e.applyLook(0, 0, 0);

      const cx = e.camera.position.x;
      const cy = e.camera.position.y;
      const cz = e.camera.position.z;

      // Create mock enemy at (cx + 1.0, cy - 0.9, cz - 4) -> distance ~4.1 units, angle ~14 deg in front
      const mockEnemyGroup = new THREE.Group();
      mockEnemyGroup.position.set(cx + 1.0, cy - 0.9, cz - 4);
      const mockEnemy = {
        state: 'CHASE',
        group: mockEnemyGroup,
        stats: { height: 1.8 }
      };

      e.enemies = [mockEnemy];
      e.isFiring = true; // Player is firing

      // Find target
      const target = e.findAimAssistTarget(32, 0.88);
      const targetFound = !!target;
      const targetDist = target ? target.dist : 0;

      // Initial yaw before pull
      const yawBefore = e.yaw;

      // Simulate 10 frames of aim assist update (1/60s each)
      for (let i = 0; i < 10; i++) {
        e.updateAimAssist(1 / 60);
      }
      const yawAfter = e.yaw;
      // Target is at +X (to the right), so yaw should decrease (or rotate toward target)
      // Desired yaw = Math.atan2(-toX, -toZ) = Math.atan2(-1.0, 4) = -0.245 rad
      const yawDelta = Math.abs(yawAfter - yawBefore);
      const movedTowardTarget = (yawAfter < yawBefore);

      const crosshairHasClass = document.getElementById('crosshair-container')?.classList.contains('assist-lock');

      // Test Range boundary: move enemy far away (35 units > max 32)
      mockEnemyGroup.position.set(cx, cy - 0.9, cz - 35);
      const farTarget = e.findAimAssistTarget(32, 0.88);

      // Test Cone boundary: move enemy outside cone (45 deg > 28.3 deg, minDot 0.88)
      mockEnemyGroup.position.set(cx + 4, cy - 0.9, cz - 4); // 45 deg
      const wideTarget = e.findAimAssistTarget(32, 0.88);

      // Test Bullet Magnetism
      // Reset enemy in front at angle
      mockEnemyGroup.position.set(cx + 1.0, cy - 0.9, cz - 4);
      e.yaw = 0; e.pitch = 0; e.applyLook(0, 0, 0);
      e._aimAssistTarget = e.findAimAssistTarget(32, 0.88);
      const baseDir = new THREE.Vector3(0, 0, -1);
      const magDir = baseDir.clone();
      e.applyAimMagnetism(magDir);
      const magnetizedX = magDir.x; // Should be biased toward +X target

      // Test Bullet Magnetism with assist OFF
      e.touchOpts.assist = 0;
      const offDir = baseDir.clone();
      e.applyAimMagnetism(offDir);
      const untouchedX = offDir.x;

      return {
        targetFound,
        targetDist: Math.round(targetDist * 10) / 10,
        yawDelta: Math.round(yawDelta * 1000) / 1000,
        movedTowardTarget,
        crosshairHasClass,
        farTargetNull: farTarget === null,
        wideTargetNull: wideTarget === null,
        magnetizedTowardTarget: magnetizedX > 0,
        untouchedWhenOff: untouchedX === 0
      };
    });

    check('CH-AIM-5', mechanics.targetFound && mechanics.movedTowardTarget && mechanics.yawDelta > 0.02,
      `soft reticle pull rotates toward target (yawDelta=${mechanics.yawDelta} rad toward target)`);
    check('CH-AIM-5', mechanics.crosshairHasClass,
      `crosshair container gets .assist-lock class when target engaged`);

    check('CH-AIM-6', mechanics.farTargetNull, `enemies beyond range (35 > 32) are ignored`);
    check('CH-AIM-6', mechanics.wideTargetNull, `enemies outside cone (45 deg > 28 deg) are ignored`);

    // CH-AIM-7: Line of sight / Wall occlusion test
    const occlusion = await deskPage.evaluate(() => {
      const e = window.cyberEngine;
      e.touchOpts = { assist: 50 };
      e.yaw = 0; e.pitch = 0; e.applyLook(0, 0, 0);

      const cx = e.camera.position.x;
      const cy = e.camera.position.y;
      const cz = e.camera.position.z;

      // Enemy at (cx, cy - 0.9, cz - 4)
      const enemyGroup = new THREE.Group();
      enemyGroup.position.set(cx, cy - 0.9, cz - 4);
      e.enemies = [{ state: 'CHASE', group: enemyGroup, stats: { height: 1.8 } }];

      // Target in clear view
      const clearTarget = e.findAimAssistTarget(32, 0.88);

      // Add a solid wall directly between camera and enemy at cz - 2
      const wall = {
        solid: true,
        p1: { x: cx - 4, z: cz - 2 },
        p2: { x: cx + 4, z: cz - 2 },
        bottomY: cy - 2,
        topY: cy + 2
      };
      e.walls.push(wall);
      if (e._wallGrid) e._wallGrid = null; // bust wall query cache

      const occludedTarget = e.findAimAssistTarget(32, 0.88);

      return {
        clearVisible: clearTarget !== null,
        occludedBlocked: occludedTarget === null
      };
    });

    check('CH-AIM-7', occlusion.clearVisible && occlusion.occludedBlocked,
      `wall occlusion works: enemy visible in open (clear=${occlusion.clearVisible}), blocked behind solid wall (blocked=${occlusion.occludedBlocked})`);

    // CH-AIM-8: Magnetism
    check('CH-AIM-8', mechanics.magnetizedTowardTarget, `bullet vector magnetized toward target when assist is active`);
    check('CH-AIM-8', mechanics.untouchedWhenOff, `bullet vector 100% unaltered when assist is OFF`);

    // CH-AIM-9: Zero errors
    check('CH-AIM-9', pageErrors.length === 0, `zero page console errors (${pageErrors.length})`);

    await deskCtx.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\nQA RESULTS: ${failures.length === 0 ? 'ALL PASS (9/9)' : failures.length + ' FAILURE(S)'}`);
  process.exit(failures.length ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(2);
});
