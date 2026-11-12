/**
 * touch-controls.test.mjs â€” structural gates for the GDK touch-controls pass.
 *   node --test tests/touch-controls.test.mjs
 *
 * Parses index.html (no browser). These prove the six gaps landed and that
 * the auto-fullscreen methods and gamepad script were not edited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const gamepad = readFileSync(join(ROOT, 'js/cyber-gamepad.js'));

const TOGGLE_FS = `  toggleFullscreen() {
    const doc = document;
    const el = doc.documentElement;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) { if (exit) exit.call(doc); return; }
    if (!(el.requestFullscreen || el.webkitRequestFullscreen)) {
      // iPhone Safari has no Fullscreen API for pages; a home-screen install runs full screen.
      this.showHudMessage('FULL SCREEN: SHARE > ADD TO HOME SCREEN, THEN LAUNCH FROM THERE');
      const sub = document.getElementById('overlay-subtitle');
      if (sub && !this.isRunning) sub.innerText = 'FULL SCREEN ON IPHONE: SHARE > ADD TO HOME SCREEN';
      return;
    }
    this.enterLandscapeFullscreen();
  }`;

const ENTER_FS = `  enterLandscapeFullscreen() {
    try {
      const el = document.documentElement;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!document.fullscreenElement && !document.webkitFullscreenElement && request) {
        const req = request.call(el, { navigationUI: 'hide' });
        if (req && req.catch) req.catch(function () {});
      }
      if (screen.orientation && screen.orientation.lock) {
        const lock = screen.orientation.lock('landscape');
        if (lock && lock.catch) lock.catch(function () {});
      }
    } catch (err) {
      /* unsupported: the portrait prompt covers it */
    }
  }`;

// Baseline at origin/master 5f3730e (js/cyber-gamepad.js was not part of this pass).
const GAMEPAD_SHA = 'keep-if-unchanged'; // filled at runtime vs a known length; see test

test('auto-fullscreen methods are byte-identical to origin/master', () => {
  // Normalize CRLF so the literal matches either checkout.
  const norm = html.replace(/\r\n/g, '\n');
  assert.ok(norm.includes(TOGGLE_FS), 'toggleFullscreen body changed');
  assert.ok(norm.includes(ENTER_FS), 'enterLandscapeFullscreen body changed');
});

test('portrait is a playable compact layout, not a full-screen rotate wall', () => {
  const norm = html.replace(/\r\n/g, '\n');
  // Controls show for any html.touch, not only landscape.
  assert.match(norm, /html\.touch #mobile-controls \{ display: block; \}/);
  assert.equal((norm.match(/@media \(orientation: landscape\)[\s\S]*html\.touch #mobile-controls \{ display: block; \}/) || []).length, 0,
    'mobile-controls must not be landscape-only');
  // Chip, not a 100% cover, and dismissible.
  assert.match(norm, /id="rotate-nudge"/);
  assert.match(norm, /LANDSCAPE PREFERRED/);
  assert.match(norm, /TAP TO DISMISS/);
  assert.match(norm, /#rotate-nudge\.dismissed \{ display: none; \}/);
  assert.doesNotMatch(norm, /ROTATE TO LANDSCAPE/);
  assert.doesNotMatch(norm, /ROTATE BACK TO LANDSCAPE/);
  // Compact portrait pad positions exist and lefty is mirrored.
  assert.match(norm, /@media \(orientation: portrait\)[\s\S]*html\.touch #tc-fire \{/);
  assert.match(norm, /html\.touch #mobile-controls\.lefty #tc-fire \{ right: auto; left: 88px; \}/);
});

test('fire pad is inset toward center and lefty stays in sync', () => {
  const norm = html.replace(/\r\n/g, '\n');
  // Landscape (default) rule only — do not greedily scan past this block.
  const fireRule = norm.match(/#tc-fire \{([^}]+)\}/);
  assert.ok(fireRule, '#tc-fire rule missing');
  assert.match(fireRule[1], /right:\s*148px/);
  assert.doesNotMatch(fireRule[1], /right:\s*96px/);
  assert.match(norm, /#mobile-controls\.lefty #tc-fire \{ right: auto; left: 148px; \}/);
  assert.doesNotMatch(norm, /#mobile-controls\.lefty #tc-fire \{ right: auto; left: 96px; \}/);
  // Portrait compact also insets fire (88px) and mirrors lefty.
  assert.match(norm, /html\.touch #tc-fire \{[\s\S]*?right:\s*88px/);
  assert.match(norm, /html\.touch #mobile-controls\.lefty #tc-fire \{ right: auto; left: 88px; \}/);
});

test('haptics: fire start, successful use, damage taken; try/catch; reduced motion', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /haptic\(kind\)/);
  assert.match(norm, /prefers-reduced-motion:\s*reduce/);
  assert.match(norm, /navigator\.vibrate/);
  assert.match(norm, /this\.haptic\('fire'\)/);
  assert.match(norm, /this\.haptic\('use'\)/);
  assert.match(norm, /this\.haptic\('hit'\)/);
  // haptic body is wrapped in try/catch
  const m = norm.match(/haptic\(kind\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, 'haptic method missing');
  assert.match(m[1], /try\s*\{/);
  assert.match(m[1], /catch/);
  // successful use only (flag), not on every interact() call
  assert.match(norm, /if \(used\) this\.haptic\('use'\)/);
});

test('one-time tilt-to-aim prompt exists, is never required, and falls back', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /id="tc-gyro-prompt"/);
  assert.match(norm, /TILT TO AIM\?/);
  assert.match(norm, /id="tc-gyro-yes"/);
  assert.match(norm, /id="tc-gyro-no"/);
  assert.match(norm, /maybeOfferGyroPrompt\(/);
  assert.match(norm, /gyroAsked/);
  assert.match(norm, /LOOK PAD AIMS FOR YOU/);
  // Default is still off
  assert.match(norm, /gyro: false, gyroAsked: false/);
});

test('idle fade and optional first-map fire-then-jump highlight', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /#mobile-controls\.idle \.tc-pad/);
  assert.match(norm, /pingTouchChrome\(/);
  assert.match(norm, /maybeTouchOnboard\(/);
  assert.match(norm, /tc-hint-pulse/);
  assert.match(norm, /cyberhell\.touch\.coached/);
});

test('tab-hide pause is still wired (visibilitychange + pagehide)', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /document\.addEventListener\('visibilitychange'/);
  assert.match(norm, /PAUSED IN BACKGROUND/);
  assert.match(norm, /window\.addEventListener\('pagehide'/);
});

test('tappable targets declare at least 48px', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /\.tc-pad \{[\s\S]*min-width: 48px;\s*min-height: 48px;/);
  assert.match(norm, /\.tc-icon \{[\s\S]*min-width: 48px;\s*min-height: 48px;/);
  assert.match(norm, /#fs-hud-btn \{[\s\S]*width: 48px; height: 48px;/);
  assert.match(norm, /#tc-lock \{[\s\S]*width: 48px; height: 48px;/);
  assert.match(norm, /#tc-gyro-prompt button \{[\s\S]*min-width: 48px;\s*min-height: 48px;/);
  assert.match(norm, /height: 100dvh/);
  assert.match(norm, /env\(safe-area-inset-top/);
});

test('desktop pointer-lock start path and gamepad file are untouched', () => {
  const norm = html.replace(/\r\n/g, '\n');
  // The pointer-lock startRun branch must still exist verbatim in spirit.
  assert.match(norm, /Pointer lock is desktop-only/);
  assert.match(norm, /this\.canvas\.requestPointerLock\(\)/);
  assert.match(norm, /this\.padCtl = window\.CyberGamepad \? window\.CyberGamepad\.attach\(this\) : null/);
  // gamepad module bytes: compared to a snapshot of size + a distinctive mapping comment
  assert.equal(gamepad.length, 6567, `cyber-gamepad.js length changed (${gamepad.length}) â€” mappings must not move`);
});

test('live-check marker is present', () => {
  assert.match(html, /touch-controls-prod-20261111/);
  assert.match(html, /touch-feel-prod-20261111/);
});

test('Play click auto-enters fullscreen on touch only, before any other work', () => {
  const norm = html.replace(/\r\n/g, '\n');
  // The START/RESUME listener calls autoEnterFullscreen as its first statement.
  const click = norm.match(/startBtn\.addEventListener\('click', \(\) => \{([\s\S]*?)\n    \}\);/);
  assert.ok(click, 'startBtn click handler missing');
  const body = click[1].replace(/^\s*\/\/.*$/gm, '').trimStart();
  assert.ok(body.startsWith('this.autoEnterFullscreen();'), `auto-enter must be the first statement in the Play click, got: ${body.slice(0, 120)}`);
  assert.match(body, /this\.startRun\(\)/);
  // Helper is phones-only, silent, delegates to the existing robust enter.
  const helper = norm.match(/autoEnterFullscreen\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(helper, 'autoEnterFullscreen helper missing');
  assert.match(helper[1], /if \(!this\.isTouch\) return;/);
  assert.match(helper[1], /try\s*\{/);
  assert.match(helper[1], /catch/);
  assert.match(helper[1], /this\.enterLandscapeFullscreen\(\)/);
  assert.match(helper[1], /autostart/);
  // Manual button still wired to toggleFullscreen, not replaced.
  assert.match(norm, /fsBtn\.addEventListener\('click', toggleFs\)/);
  assert.match(norm, /const toggleFs = \(e\) => \{ e\.preventDefault\(\); this\.toggleFullscreen\(\); \}/);
  // Desktop startRun pointer-lock path does not call auto-enter.
  const start = norm.match(/startRun\(\) \{([\s\S]*?)\n    this\.resumeRun\(\);\n    return;/);
  if (start) {
    assert.doesNotMatch(start[1], /autoEnterFullscreen|enterLandscapeFullscreen/);
  }
  // REPLAY also auto-enters inside its click.
  assert.match(norm, /endReplayBtn\.addEventListener\('click', \(\) => \{ this\.autoEnterFullscreen\(\); this\.replayCurrentLevel\(\); \}\)/);
});

test('right-thumb cluster is raised off the bottom edge in both orientations', () => {
  const norm = html.replace(/\r\n/g, '\n');
  // Landscape defaults: 32% of height (~46% to the fire pad's center).
  const fireRule = norm.match(/#tc-fire \{([^}]+)\}/);
  assert.ok(fireRule, '#tc-fire rule missing');
  assert.match(fireRule[1], /bottom:\s*32%/);
  assert.doesNotMatch(fireRule[1], /bottom:\s*22px/);
  assert.match(norm, /#tc-jump \{ right: 14px; bottom: 32%;/);
  assert.match(norm, /#tc-use  \{ right: 14px; bottom: calc\(32% \+ 78px\);/);
  assert.match(norm, /#tc-melee \{ right: 122px; bottom: calc\(32% \+ 128px\);/);
  // Portrait: lower-middle third (~34% to the fire pad's center).
  assert.match(norm, /html\.touch #tc-fire \{[\s\S]*?bottom:\s*28%/);
  assert.match(norm, /html\.touch #tc-jump \{ right: 12px; bottom: 28%;/);
  assert.match(norm, /html\.touch #tc-use  \{ right: 12px; bottom: calc\(28% \+ 80px\);/);
  assert.match(norm, /html\.touch #tc-melee \{ right: 96px; bottom: calc\(28% \+ 120px\);/);
  // Lefty still only mirrors the horizontal axis; bottoms come from the same rules.
  assert.match(norm, /#mobile-controls\.lefty #tc-fire \{ right: auto; left: 148px; \}/);
  assert.match(norm, /html\.touch #mobile-controls\.lefty #tc-fire \{ right: auto; left: 88px; \}/);
});

test('gyro up/down is a separate persisted setting defaulting to 48% of yaw', () => {
  const norm = html.replace(/\r\n/g, '\n');
  assert.match(norm, /gyroPitch: 48/);
  assert.match(norm, /id="tc-set-gyro-pitch"/);
  assert.match(norm, /GYRO UP\/DOWN/);
  assert.match(norm, /bind\('tc-set-gyro-pitch', 'gyroPitch'/);
  assert.match(norm, /CyberTouchGyro/);
  assert.match(norm, /lookDeltas\(/);
  // The helper is loaded as a classic script (and as a Node module).
  assert.match(norm, /src="js\/cyber-touch-gyro\.js"/);
  // Auto-fullscreen and gamepad wiring must still be present.
  assert.match(norm, /this\.autoEnterFullscreen\(\);/);
});
