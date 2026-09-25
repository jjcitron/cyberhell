#!/usr/bin/env node
/**
 * CYBERHELL PLAYTEST-UNBLOCK QA (browser, headless)
 *
 * Joel NO PASS 2026-09-25: still walks into walls, fireballs come through
 * walls and kill him, wants a god-mode checkbox on the start page.
 *
 *   CH-PT-1  Walk head-on into a tall ledge riser from its low side for 1.5 s:
 *            the camera stays >= 0.28 from the riser line (the riser is drawn
 *            as a 0.4-thick box, so < 0.2 means the camera is inside it).
 *   CH-PT-2  An enemy fireball fired at the player from the far side of a
 *            solid wall dies at the wall: no damage, projectile gone.
 *   CH-PT-3  Same shot with no wall in between still hits (control).
 *   CH-PT-4  Start page has #god-mode-chk, unchecked by default.
 *   CH-PT-5  With it checked, damagePlayer(999) leaves health untouched and
 *            no game over; unchecked, the same call kills.
 *   CH-PT-6  Zero page errors.
 *
 * Writes POV screenshots of the riser walk and the fireball wall test to
 * QA_SHOTS (default: none) as <QA_PREFIX>riser-wall.png / fireball-wall.png.
 *
 * Usage:  node tests/qa-playtest.js
 *         QA_SHOTS=dir QA_PREFIX=r1-after- node tests/qa-playtest.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8141);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const MAP = process.env.QA_MAP || 'levelPacks/pack1/json1.json';
const SHOTS = process.env.QA_SHOTS || '';
const PREFIX = process.env.QA_PREFIX || '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mid': 'audio/midi', '.css': 'text/css' };
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// Shared in-page helpers: distance to a segment, put the player somewhere
// facing a point, draw one frame.
const HELPERS = function () {
  const e = window.cyberEngine;
  window.__pt = {
    segD(px, pz, ax, az, bx, bz) {
      const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
      const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz || 1)));
      return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
    },
    place(x, z, lookX, lookZ) {
      const f = e.getFloorAt(x, z);
      e.camera.position.set(x, f.floorY + e.player.height, z);
      e.camera.rotation.set(0, Math.atan2(-(lookX - x), -(lookZ - z)), 0, 'YXZ');
      e.player.velocity.set(0, 0, 0);
      e.player.onGround = true;
      e.player.safePosition.copy(e.camera.position);
    },
    clear(x, z, r) {
      for (const w of e.wallsNear(x, z, r)) if (w.solid && this.segD(x, z, w.p1.x, w.p1.z, w.p2.x, w.p2.z) < r) return false;
      return true;
    },
    draw() { e.scene.updateMatrixWorld(true); e.renderer.render(e.scene, e.camera); }
  };
  document.getElementById('overlay-screen').style.display = 'none';
  e.enemies.forEach(en => { en.state = 'DEAD'; en.group.visible = false; });
  e.isRunning = true;
  e.isGameOver = false;
  e.keys = {};
};

// CH-PT-1: a tall riser, approached from below.
const RISER_SETUP = function () {
  const e = window.cyberEngine, H = window.__pt;
  for (const w of e.walls) {
    if (w.solid || w.isDoor || w.isSwitch || w.topY === undefined || w.bottomY === undefined) continue;
    if (w.topY - w.bottomY < 2.4) continue;
    const L = Math.hypot(w.p2.x - w.p1.x, w.p2.z - w.p1.z);
    if (L < 3) continue;
    const mx = (w.p1.x + w.p2.x) / 2, mz = (w.p1.z + w.p2.z) / 2;
    const nx = -(w.p2.z - w.p1.z) / L, nz = (w.p2.x - w.p1.x) / L;
    for (const s of [1, -1]) {
      const sx = mx + nx * s * 2.5, sz = mz + nz * s * 2.5;
      const f = e.getFloorAt(sx, sz);
      if (!f.inside || Math.abs(f.floorY - w.bottomY) > 0.05) continue;
      if (f.ceilY !== undefined && f.ceilY < f.floorY + 3) continue;
      if (!H.clear(sx, sz, 1.2)) continue;
      H.place(sx, sz, mx, mz);
      window.__riser = w;
      return { wall: [w.p1.x, w.p1.z, w.p2.x, w.p2.z], bottomY: w.bottomY, topY: w.topY, start: [sx, sz] };
    }
  }
  return null;
};
const RISER_WALK = function (frames) {
  const e = window.cyberEngine, H = window.__pt, w = window.__riser;
  e.keys = { KeyW: true };
  let minD = Infinity;
  for (let i = 0; i < frames; i++) {
    e.updatePhysics(1 / 60);
    const p = e.camera.position;
    minD = Math.min(minD, H.segD(p.x, p.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z));
  }
  e.keys = {};
  const p = e.camera.position;
  H.draw();
  return { minD, end: [p.x, p.z], feet: p.y - e.player.height };
};

// CH-PT-2/3: a solid wall with floor on both sides.
const FIREBALL = function (throughWall) {
  const e = window.cyberEngine, H = window.__pt;
  let spot = null;
  for (const w of e.walls) {
    if (!w.solid || w.isDoor || w.isSwitch) continue;
    const L = Math.hypot(w.p2.x - w.p1.x, w.p2.z - w.p1.z);
    if (L < 3) continue;
    const mx = (w.p1.x + w.p2.x) / 2, mz = (w.p1.z + w.p2.z) / 2;
    const nx = -(w.p2.z - w.p1.z) / L, nz = (w.p2.x - w.p1.x) / L;
    const ax = mx + nx * 1.5, az = mz + nz * 1.5, bx = mx - nx * 3, bz = mz - nz * 3;
    const fa = e.getFloorAt(ax, az), fb = e.getFloorAt(bx, bz);
    if (!fa.inside || !fb.inside || Math.abs(fa.floorY - fb.floorY) > 0.3) continue;
    if ((w.bottomY !== undefined && w.bottomY > fa.floorY + 0.1) || (w.topY !== undefined && w.topY < fa.floorY + 3)) continue;
    if (!H.clear(ax, az, 1.0) || !H.clear(bx, bz, 1.0)) continue;
    spot = { w, ax, az, bx, bz, nx, nz, floorY: fa.floorY };
    break;
  }
  if (!spot) return null;
  // Control: the same geometry with the shooter on the player's side.
  const sx = throughWall ? spot.bx : spot.ax + spot.nx * 3, sz = throughWall ? spot.bz : spot.az + spot.nz * 3;
  H.place(spot.ax, spot.az, sx, sz);
  e.player.health = 100; e.player.armor = 0; e.isGameOver = false;
  e.projectiles.slice().forEach(p => e._releaseProjectile(p)); e.projectiles.length = 0;
  const from = new THREE.Vector3(sx, spot.floorY + 1.0, sz);
  const dir = new THREE.Vector3().subVectors(e.camera.position, from).normalize();
  const proj = e.spawnProjectile({ from, dir, kind: 'fireball', owner: 'enemy', damage: 14 });
  const camSide = (spot.w.p2.x - spot.w.p1.x) * (spot.az - spot.w.p1.z) - (spot.w.p2.z - spot.w.p1.z) * (spot.ax - spot.w.p1.x);
  let crossed = false, last = from.clone();
  for (let i = 0; i < 90; i++) {
    e.updateProjectiles(1 / 60);
    if (!e.projectiles.includes(proj)) break;
    last.copy(proj.group.position);
    const side = (spot.w.p2.x - spot.w.p1.x) * (last.z - spot.w.p1.z) - (spot.w.p2.z - spot.w.p1.z) * (last.x - spot.w.p1.x);
    if (throughWall && (side > 0) === (camSide > 0)) { crossed = true; break; }
  }
  // Freeze the game loop on this frame (fireball just through the wall, or
  // its impact flash on the far face) so the screenshot shows it.
  e.isRunning = false;
  H.draw();
  window.__fb = { proj, spot };
  return { wall: [spot.w.p1.x, spot.w.p1.z, spot.w.p2.x, spot.w.p2.z], crossed, at: [last.x, last.z] };
};
const FIREBALL_FINISH = function () {
  const e = window.cyberEngine, { proj } = window.__fb;
  for (let i = 0; i < 120 && e.projectiles.includes(proj); i++) e.updateProjectiles(1 / 60);
  e.isRunning = true;
  return { health: e.player.health, alive: e.projectiles.includes(proj) };
};

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`);
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  const shot = async name => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator('canvas').first().screenshot({ path: path.join(SHOTS, PREFIX + name) });
  };
  const run = (fn, ...args) => page.evaluate(([f, a]) => new Function('return ' + f)()(...a), [fn.toString(), args]);

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    let settled = '';
    for (let i = 0; i < 40; i++) {
      const now = await page.evaluate(() => window.cyberEngine.levelData.name);
      if (now === settled) break;
      settled = now;
      await page.waitForTimeout(500);
    }

    // CH-PT-4 before anything touches the menu.
    const chk = await page.evaluate(() => {
      const c = document.getElementById('god-mode-chk');
      return c ? { exists: true, checked: c.checked, visible: !!(c.offsetParent), label: c.parentElement.textContent.trim() } : { exists: false };
    });
    check('CH-PT-4 god-mode checkbox on start page, default OFF', chk.exists && !chk.checked && chk.visible, JSON.stringify(chk));

    const want = JSON.parse(fs.readFileSync(path.join(ROOT, MAP), 'utf8')).name;
    await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), MAP);
    await page.waitForFunction(n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n, want, { timeout: 120000 });
    await run(HELPERS);

    const rs = await run(RISER_SETUP);
    if (!rs) check('CH-PT-1 riser walk', false, 'no tall riser with open low side found');
    else {
      const r = await run(RISER_WALK, 90);
      await shot('riser-wall.png');
      check('CH-PT-1 walk into tall ledge riser: camera stays out of it', r.minD >= 0.28,
        `riser ${JSON.stringify(rs.wall)} y ${rs.bottomY}..${rs.topY}; closest camera distance ${r.minD.toFixed(3)} (box face at 0.20)`);
    }

    const fw = await run(FIREBALL, true);
    if (fw) { await shot('fireball-wall.png'); Object.assign(fw, await run(FIREBALL_FINISH)); }
    if (!fw) check('CH-PT-2 fireball vs wall', false, 'no two-sided solid wall found');
    else check('CH-PT-2 fireball fired through a solid wall does not reach/damage the player', fw.health === 100 && !fw.crossed,
      `wall ${JSON.stringify(fw.wall)}; health after ${fw.health}; crossed wall ${fw.crossed}`);
    const fc = await run(FIREBALL, false);
    if (fc) Object.assign(fc, await run(FIREBALL_FINISH));
    check('CH-PT-3 control: same fireball with clear line of fire still hits', fc && fc.health < 100, `health after ${fc && fc.health}`);

    const god = await page.evaluate(() => {
      const e = window.cyberEngine, c = document.getElementById('god-mode-chk');
      if (!c) return null;
      const out = {};
      c.checked = true; e.player.health = 100; e.isGameOver = false;
      e.damagePlayer(999); out.on = { health: e.player.health, over: !!e.isGameOver };
      c.checked = false; e.player.health = 100; e.isGameOver = false;
      e.damagePlayer(999); out.off = { health: e.player.health, over: !!e.isGameOver };
      return out;
    });
    check('CH-PT-5 god mode blocks damage/death when ON, not when OFF',
      !!god && god.on.health === 100 && !god.on.over && god.off.health === 0 && god.off.over, JSON.stringify(god));

    check('CH-PT-6 page errors', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 4).join(' | ') : 'none');
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
