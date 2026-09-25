#!/usr/bin/env node
/**
 * CYBERHELL ENEMIES-DIE QA (browser, headless)
 *
 * Joel 2026-09-25 with GOD MODE on: "these guys don't die no matter how much
 * I shoot" (tall segmented robots), then a small humanoid on a ledge and a
 * fat foreground robot. Every class, god mode ON, the real fire path.
 *
 *   CH-UD-1  God mode ON: every enemy type, shot at its visible chest with
 *            the pistol / machinegun / shotgun / rifle / repeater through
 *            engine.fireWeapon, loses hp to every weapon and dies.
 *   CH-UD-2  Hurt volume covers the mesh: rays aimed at a grid of points on
 *            each type's visible body (head to shins) register a hit on at
 *            least 85% of the points that are actually on the mesh.
 *   CH-UD-2b The same grid with energy-weapon bolts.
 *   CH-UD-3  The live frame (AI + physics + held trigger, chainsaw walked
 *            up to the body) kills every type with every weapon at 60 fps;
 *   CH-UD-3b and at a hitching 12 fps, where bolts used to step over bodies.
 *   CH-UD-4  An enemy standing on a ledge above the player dies to the
 *            pistol / rifle / repeater fired from the floor below.
 *   CH-UD-5  God mode eats player damage only, and is default OFF.
 *   CH-UD-6  Zero page errors.
 *
 * Usage:  node tests/qa-undying.js     (QA_SHOTS=dir QA_PREFIX=r1- for shots)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8151);
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

const TYPES = [3004, 9, 65, 3001, 3002, 58, 3005, 69, 3003, 66, 67, 68, 64, 16, 7];

// In-page: an open floor patch, a way to spawn one enemy there, aim helpers.
const SETUP = function () {
  const e = window.cyberEngine;
  document.getElementById('overlay-screen').style.display = 'none';
  e.enemies.forEach(en => { en.state = 'DEAD'; en.group.visible = false; });
  e.isRunning = false;
  e.isGameOver = false;
  e.keys = {};
  for (const k in e.player.weapons) e.player.weapons[k] = true;
  const segD = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
  };
  const clear = (x, z, r) => {
    for (const w of e.wallsNear(x, z, r)) if ((w.solid || w.riser) && segD(x, z, w.p1.x, w.p1.z, w.p2.x, w.p2.z) < r) return false;
    return true;
  };
  // A 12 m flat run with 3 m clearance and a tall ceiling.
  let spot = null;
  for (const s of e.sectors || []) {
    const b = s.bounds || s.bbox;
    if (!b) continue;
  }
  const f0 = e.getFloorAt(e.camera.position.x, e.camera.position.z);
  outer: for (let r = 0; r < 60 && !spot; r += 2) {
    for (let a = 0; a < 16; a++) {
      const x = e.camera.position.x + Math.cos(a / 16 * Math.PI * 2) * r;
      const z = e.camera.position.z + Math.sin(a / 16 * Math.PI * 2) * r;
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        let ok = true, fy = null;
        for (let s = 0; s <= 10 && ok; s += 1) {
          const f = e.getFloorAt(x + dx * s, z + dz * s);
          if (!f.inside || (fy !== null && Math.abs(f.floorY - fy) > 0.01) || (f.ceilY != null && f.ceilY - f.floorY < 6.5) || !clear(x + dx * s, z + dz * s, 2.5)) ok = false;
          fy = f.floorY;
        }
        if (ok) { spot = { x, z, dx, dz, fy }; break outer; }
      }
    }
  }
  window.__ud = { spot, f0 };
  return spot;
};

const SPAWN = function (type, dist) {
  const e = window.cyberEngine, s = window.__ud.spot;
  // Drop any previous test enemy.
  for (const en of e.enemies.filter(en => en.__qa)) { e.scene.remove(en.group); e.enemies.splice(e.enemies.indexOf(en), 1); }
  const ex = s.x + s.dx * dist, ez = s.z + s.dz * dist;
  e.createEnemy({ type: 'monster', enemyType: type, pos: [ex, s.fy, ez], rot: Math.atan2(-s.dx, -s.dz) });
  const en = e.enemies[e.enemies.length - 1];
  en.__qa = true;
  en.state = 'IDLE';
  en.group.position.set(ex, en.group.position.y, ez);
  e.camera.position.set(s.x, s.fy + e.player.height, s.z);
  e.player.velocity.set(0, 0, 0);
  e.scene.updateMatrixWorld(true);
  return en;
};

// Visible body box in world space, from the rig's own meshes.
const BODY_BOX = function (en) {
  const box = new THREE.Box3();
  en.group.updateMatrixWorld(true);
  en.group.traverse(o => { if (o.isMesh && o.visible && o.geometry) box.expandByObject(o); });
  return box;
};

const AIM = function (x, y, z) {
  const e = window.cyberEngine, c = e.camera.position;
  const dx = x - c.x, dy = y - c.y, dz = z - c.z;
  e.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
  e.camera.updateMatrixWorld(true);
};

const SHOOT_ALL = function (types, weapons, dist) {
  const e = window.cyberEngine, U = window.__ud;
  const god = document.getElementById('god-mode-chk'); god.checked = true;
  const out = [];
  for (const type of types) {
    for (const w of weapons) {
      const en = U.spawn(type, dist);
      const hp0 = en.hp;
      const box = U.box(en), c = new THREE.Vector3(); box.getCenter(c);
      let shots = 0, hpAfter1 = null;
      e.switchWeapon(w);
      for (; shots < 400 && en.state !== 'DEAD'; shots++) {
        e.player.ammo.bullets = 200; e.player.ammo.shells = 50; e.player.ammo.energy = 300;
        box.copy(U.box(en)); box.getCenter(c);
        U.aim(c.x, c.y, c.z);
        e.nextFireTime = 0;
        e.fireWeapon();
        for (let k = 0; k < 20 && e.projectiles.some(p => p.owner === 'player'); k++) e.updateProjectiles(1 / 60);
        if (shots === 4) hpAfter1 = en.hp;
        en.group.position.x = U.spot.x + U.spot.dx * dist; en.group.position.z = U.spot.z + U.spot.dz * dist;
      }
      out.push({ type, w, hp0, hpAfter1, dead: en.state === 'DEAD', shots, hpEnd: en.hp, h: +(box.max.y - box.min.y).toFixed(2), w_: +(box.max.x - box.min.x).toFixed(2) });
    }
  }
  return out;
};

// Hurt-volume coverage: rays at a grid over the visible silhouette; count the
// points whose ray actually meets the rig mesh, and how many of those damage.
const COVERAGE = function (types, dist, proj) {
  const e = window.cyberEngine, U = window.__ud;
  const out = [];
  const ray = new THREE.Raycaster();
  for (const type of types) {
    const en = U.spawn(type, dist);
    en.hp = 1e9;
    const box = U.box(en);
    let onMesh = 0, hurt = 0; const misses = [];
    for (let iy = 0; iy <= 8; iy++) for (let ix = 0; ix <= 6; ix++) {
      const p = new THREE.Vector3(
        box.min.x + (box.max.x - box.min.x) * ix / 6,
        box.min.y + (box.max.y - box.min.y) * (0.05 + 0.9 * iy / 8),
        (box.min.z + box.max.z) / 2);
      // Enemy faces the camera along the spot axis; sweep across that axis.
      const s = U.spot, ax = -s.dz, az = s.dx;
      const cx = s.x + s.dx * dist, cz = s.z + s.dz * dist;
      const off = (ix / 6 - 0.5) * Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      p.x = cx + ax * off; p.z = cz + az * off;
      const c = e.camera.position;
      ray.set(c, p.clone().sub(c).normalize()); ray.far = 60;
      if (!ray.intersectObject(en.group, true).length) continue;
      onMesh++;
      U.aim(p.x, p.y, p.z);
      const hp = en.hp;
      if (proj) {
        const dir = p.clone().sub(c).normalize();
        e.spawnProjectile({ from: c.clone().addScaledVector(dir, 0.6), dir, owner: 'player', kind: 'energy_burst', speed: 55, damage: 10, radius: 0.2 });
        for (let k = 0; k < 40 && e.projectiles.some(q => q.owner === 'player'); k++) e.updateProjectiles(1 / 60);
        en.group.position.set(cx, en.group.position.y, cz);
      } else e.raycastHitscan(10, 0);
      if (en.hp < hp) hurt++; else misses.push([+off.toFixed(2), +(p.y - box.min.y).toFixed(2)]);
    }
    out.push({ type, onMesh, hurt, frac: onMesh ? +(hurt / onMesh).toFixed(3) : 0, misses: misses.slice(0, 6) });
  }
  return out;
};


// The real frame: physics + AI + weapon tick running, trigger held, the aim
// tracking the body's visible centre every frame, god mode ON. This is what
// Joel did; the static path above can pass while this one fails.
const LIVE = function (types, weapons, dist, secs, dt) {
  const e = window.cyberEngine, U = window.__ud;
  const god = document.getElementById('god-mode-chk'); god.checked = true;
  const out = [];
  for (const type of types) {
    for (const w of weapons) {
      const en = U.spawn(type, dist);
      const hp0 = en.hp;
      e.switchWeapon(w);
      e.isRunning = true; e.isGameOver = false;
      e.player.health = 100;
      const c = new THREE.Vector3();
      let t = 0, fired = 0;
      for (; t < secs && en.state !== 'DEAD'; t += dt) {
        e.player.ammo.bullets = 200; e.player.ammo.shells = 50; e.player.ammo.energy = 300;
        // The saw is melee: walk up to the body, as the player would.
        if (w === 'chainsaw') {
          const ep = en.group.position, cp = e.camera.position;
          const d = Math.hypot(ep.x - cp.x, ep.z - cp.z), want = (en.radius || 0.6) + 0.9;
          if (d > want) { cp.x += (ep.x - cp.x) * (1 - want / d); cp.z += (ep.z - cp.z) * (1 - want / d); }
        }
        U.box(en).getCenter(c);
        U.aim(c.x, c.y, c.z);
        e.isFiring = true;
        if (!WEAPONS[w].auto && Math.round(t / dt) % 6 === 0) { e.nextFireTime = 0; e.fireWeapon(); fired++; }
        e.updatePhysics(dt);
        e.updateEnemies(dt);
      }
      e.isFiring = false; e.isRunning = false;
      out.push({ type, w, hp0, hpEnd: +en.hp.toFixed(1), dead: en.state === 'DEAD', t: +t.toFixed(2), state: en.state, health: e.player.health,
        dist: +Math.hypot(en.group.position.x - e.camera.position.x, en.group.position.z - e.camera.position.z).toFixed(2),
        ey: +(en.group.position.y - e.camera.position.y).toFixed(2) });
    }
  }
  return out;
};

// An enemy on a ledge above the player: a floor 1.5-4 m higher, 5-9 m off,
// with the eye-to-chest line clear of floors and walls the whole way.
const LEDGE = function (weapons) {
  const e = window.cyberEngine, U = window.__ud;
  document.getElementById('god-mode-chk').checked = true;
  const c0 = U.f0 && e.camera.position;
  let pair = null;
  const sample = (x, z) => e.getFloorAt(x, z);
  for (let r = 0; r < 120 && !pair; r += 3) for (let a = 0; a < 24 && !pair; a++) {
    const lx = c0.x + Math.cos(a / 24 * 6.283) * r, lz = c0.z + Math.sin(a / 24 * 6.283) * r;
    const L = sample(lx, lz); if (!L.inside) continue;
    for (let b = 0; b < 12 && !pair; b++) for (const d of [6, 8, 5]) {
      const hx = lx + Math.cos(b / 12 * 6.283) * d, hz = lz + Math.sin(b / 12 * 6.283) * d;
      const H = sample(hx, hz);
      if (!H.inside || H.floorY - L.floorY < 1.5 || H.floorY - L.floorY > 4) continue;
      if (H.ceilY != null && H.ceilY - H.floorY < 3) continue;
      const ey = L.floorY + e.player.height, ty = H.floorY + 1.0;
      let ok = true;
      for (let s = 0.02; s < 1 && ok; s += 0.02) {
        const f = sample(lx + (hx - lx) * s, lz + (hz - lz) * s), y = ey + (ty - ey) * s;
        if (!f.inside || y < f.floorY + 0.15 || (f.ceilY != null && y > f.ceilY - 0.1)) ok = false;
      }
      if (ok && !e.wallBetween(lx, lz, hx, hz, (ey + ty) / 2)) pair = { lx, lz, ly: L.floorY, hx, hz, hy: H.floorY };
    }
  }
  if (!pair) return null;
  const out = [];
  for (const type of [3004, 3001, 69]) for (const w of weapons) {
    for (const en of e.enemies.filter(en => en.__qa)) { e.scene.remove(en.group); e.enemies.splice(e.enemies.indexOf(en), 1); }
    e.createEnemy({ type: 'monster', enemyType: type, pos: [pair.hx, pair.hy, pair.hz], rot: 0 });
    const en = e.enemies[e.enemies.length - 1]; en.__qa = true; en.state = 'IDLE';
    e.camera.position.set(pair.lx, pair.ly + e.player.height, pair.lz);
    e.switchWeapon(w);
    let n = 0; const c = new THREE.Vector3();
    for (; n < 400 && en.state !== 'DEAD'; n++) {
      e.player.ammo.bullets = 200; e.player.ammo.shells = 50; e.player.ammo.energy = 300;
      U.box(en).getCenter(c); U.aim(c.x, c.y, c.z);
      e.nextFireTime = 0; e.fireWeapon();
      for (let k = 0; k < 30 && e.projectiles.some(p => p.owner === 'player'); k++) e.updateProjectiles(1 / 30);
    }
    out.push({ type, w, dead: en.state === 'DEAD', shots: n, rise: +(pair.hy - pair.ly).toFixed(2), onFloor: +(en.group.position.y - pair.hy).toFixed(2) });
  }
  return out;
};

// God mode is the player's switch only: ticked, enemy hits do nothing to
// the player; unticked they land. Enemy damage from the player is covered
// above with it ticked.
const GOD = function () {
  const e = window.cyberEngine, god = document.getElementById('god-mode-chk');
  e.isGameOver = false; e.isVictory = false;
  e.player.health = 100; e.player.armor = 0;
  god.checked = true; e.damagePlayer(30);
  const withGod = e.player.health;
  god.checked = false; e.damagePlayer(30);
  const without = e.player.health;
  e.player.health = 100;
  return { withGod, without, defaultOff: !document.getElementById('god-mode-chk').defaultChecked && !god.hasAttribute('checked') };
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
  const run = (fn, ...args) => page.evaluate(([f, a]) => new Function('return ' + f)()(...a), [fn.toString(), args]);

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    const want = JSON.parse(fs.readFileSync(path.join(ROOT, MAP), 'utf8')).name;
    await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), MAP);
    await page.waitForFunction(n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n, want, { timeout: 120000 });
    const spot = await run(SETUP);
    if (!spot) throw new Error('no open 10 m run found on ' + MAP);
    await page.evaluate(([s, b, a]) => {
      const U = window.__ud;
      U.spawn = new Function('return ' + s)();
      U.box = new Function('return ' + b)();
      U.aim = new Function('return ' + a)();
    }, [SPAWN.toString(), BODY_BOX.toString(), AIM.toString()]);

    const shots = await run(SHOOT_ALL, TYPES, ['pistol', 'machinegun', 'shotgun', 'energy_rifle', 'energy_repeater'], 7);
    const bad = shots.filter(r => !r.dead || (r.hpAfter1 !== null && !(r.hpAfter1 < r.hp0)));
    for (const r of bad) console.log('   undying:', JSON.stringify(r));
    check('CH-UD-1 god mode ON: every type loses hp within 5 shots of every weapon and dies', bad.length === 0,
      `${shots.length - bad.length}/${shots.length} type x weapon runs killed` + (bad.length ? `; first bad ${JSON.stringify(bad[0])}` : ''));

    const cov = await run(COVERAGE, TYPES, 7);
    const thin = cov.filter(r => r.frac < 0.85);
    for (const r of cov) console.log('   coverage:', JSON.stringify(r));
    check('CH-UD-2 hurt volume covers >= 85% of on-mesh aim points, every type', thin.length === 0,
      thin.length ? thin.map(r => `${r.type}:${r.frac}`).join(' ') : `min ${Math.min(...cov.map(r => r.frac))}`);

    // Same grid, energy weapons: a bolt aimed at any point on the body hurts.
    const pcov = await run(COVERAGE, TYPES, 7, true);
    const pthin = pcov.filter(r => r.frac < 0.85);
    for (const r of pcov) console.log('   proj coverage:', JSON.stringify(r));
    check('CH-UD-2b projectile hurt volume covers >= 85% of on-mesh aim points, every type', pthin.length === 0,
      pthin.length ? pthin.map(r => `${r.type}:${r.frac}`).join(' ') : `min ${Math.min(...pcov.map(r => r.frac))}`);

    // 60 fps and a hitching 12 fps: bolts must not step over bodies.
    for (const [fps, id] of [[60, 'CH-UD-3'], [12, 'CH-UD-3b']]) {
      const live = await run(LIVE, TYPES, ['pistol', 'machinegun', 'shotgun', 'energy_rifle', 'energy_repeater', 'chainsaw'], 7, 25, 1 / fps);
      // A boss with the pistol (1,000+ hp at 45 dps) or an Arch-vile keeping
      // 27 m off can outlast 25 s; those must still be down past half hp.
      const liveBad = live.filter(r => !r.dead && r.hpEnd > r.hp0 * 0.5);
      for (const r of live.filter(r => !r.dead)) console.log(liveBad.includes(r) ? '   live undying:' : '   live slow (past half hp):', JSON.stringify(r));
      const worst = live.reduce((m, r) => Math.max(m, r.t), 0);
      check(`${id} live frame loop at ${fps} fps (AI + physics + held fire), god mode ON: every type dies (or is past half hp in 25 s)`, liveBad.length === 0,
        `${live.filter(r => r.dead).length}/${live.length} killed, ${liveBad.length} undying; slowest kill ${worst.toFixed(1)} s`);
    }
    const ledge = await run(LEDGE, ['pistol', 'energy_rifle', 'energy_repeater']);
    if (!ledge) check('CH-UD-4 ledge enemy dies to shots from the floor below', false, 'no ledge pair found on ' + MAP);
    else {
      const lb = ledge.filter(r => !r.dead);
      for (const r of lb) console.log('   ledge undying:', JSON.stringify(r));
      check('CH-UD-4 ledge enemy dies to shots from the floor below', lb.length === 0,
        `${ledge.length - lb.length}/${ledge.length} killed, rise ${ledge[0].rise} m`);
    }
    const g = await run(GOD);
    check('CH-UD-5 god mode is player-only and default OFF', g.withGod === 100 && g.without < 100 && g.defaultOff, JSON.stringify(g));
  } finally {
    await browser.close();
    server.close();
  }
  check('CH-UD-6 zero page errors', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none');
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
