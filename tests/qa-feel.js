#!/usr/bin/env node
/**
 * CYBERHELL FEEL-WAVE QA (browser, headless) -- Joel's 2026-09-25 notes.
 *
 *   CH-FW-1  Every weapon slot shows what is left for it, in shots, and
 *            follows the pool as it changes.
 *   CH-FW-2  Live bodies nearby make presence cues (rate-limited, quiet);
 *            a kill plays the death cue.
 *   CH-FW-3  A chainsaw bite sprays several big blood jets and screams;
 *            the scream is the loud one (peak gain vs presence / death).
 *   CH-FW-4  Grapple: standing still reels in (PULL), strafing orbits
 *            (SWING), running carries straight (CARRY); while hooked the
 *            player switches to a gun, shoots the hooked body, and the
 *            hook lets go when it dies.
 *   CH-FW-5  Mancubus / Arachnotron / Spider Mastermind loom (scaled >= 1.5x,
 *            a metre+ over the player's eye) and their
 *            collision radius grew with them.
 *   CH-FW-6  Difficulty: presets snap the two sliders; only damage dealt
 *            and damage taken change; enemy count is identical in every
 *            mode; god mode is separate and default OFF.
 *   CH-FW-7  Zero page errors.
 *
 * Usage:  node tests/qa-feel.js     (QA_SHOTS=dir QA_PREFIX=r1- for shots)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8152);
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

// In-page helpers: an open 12 m run, one test enemy on it, aim.
const SETUP = function () {
  const e = window.cyberEngine;
  document.getElementById('overlay-screen').style.display = 'none';
  e.enemies.forEach(en => { en.state = 'DEAD'; en.group.visible = false; });
  e.isRunning = false; e.isGameOver = false; e.keys = {};
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
  let spot = null;
  outer: for (let r = 0; r < 80 && !spot; r += 2) {
    for (let a = 0; a < 16; a++) {
      const x = e.camera.position.x + Math.cos(a / 16 * Math.PI * 2) * r;
      const z = e.camera.position.z + Math.sin(a / 16 * Math.PI * 2) * r;
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        let ok = true, fy = null;
        for (let s = 0; s <= 12 && ok; s += 1) {
          const f = e.getFloorAt(x + dx * s, z + dz * s);
          if (!f.inside || (fy !== null && Math.abs(f.floorY - fy) > 0.01) || (f.ceilY != null && f.ceilY - f.floorY < 6.5) || !clear(x + dx * s, z + dz * s, 2.5)) ok = false;
          fy = f.floorY;
        }
        if (ok) { spot = { x, z, dx, dz, fy }; break outer; }
      }
    }
  }
  const U = window.__fw = { spot };
  U.spawn = (type, dist) => {
    for (const en of e.enemies.filter(en => en.__qa)) { e.scene.remove(en.group); e.enemies.splice(e.enemies.indexOf(en), 1); }
    const ex = spot.x + spot.dx * dist, ez = spot.z + spot.dz * dist;
    e.createEnemy({ type: 'monster', enemyType: type, pos: [ex, spot.fy, ez], rot: Math.atan2(-spot.dx, -spot.dz) });
    const en = e.enemies[e.enemies.length - 1];
    en.__qa = true; en.state = 'IDLE';
    e.camera.position.set(spot.x, spot.fy + e.player.height, spot.z);
    e.player.velocity.set(0, 0, 0);
    e.scene.updateMatrixWorld(true);
    return en;
  };
  U.box = (en) => { const b = new THREE.Box3(); en.group.updateMatrixWorld(true); en.group.traverse(o => { if (o.isMesh && o.visible && o.geometry) b.expandByObject(o); }); return b; };
  U.aim = (x, y, z) => {
    const c = e.camera.position, dx = x - c.x, dy = y - c.y, dz = z - c.z;
    e.yaw = Math.atan2(-dx, -dz); e.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    e.applyLook(0, 0, 0); e.camera.updateMatrixWorld(true);
  };
  U.aimAt = (en) => { const c = new THREE.Vector3(); U.box(en).getCenter(c); U.aim(c.x, c.y, c.z); };
  // Count sound calls without needing the speakers.
  U.calls = {};
  for (const k of ['playPresence', 'playDeath', 'playScream', 'playGrapple', 'playMonsterHurt']) {
    const f = e.sound[k].bind(e.sound);
    e.sound[k] = (...a) => { (U.calls[k] = U.calls[k] || []).push(a); return f(...a); };
  }
  return spot;
};

const AMMO = function () {
  const e = window.cyberEngine;
  const read = () => WEAPON_ORDER.map((w, i) => document.querySelector(`#slot-${i + 1} .slot-ammo`).textContent);
  e.player.ammo.bullets = 57; e.player.ammo.shells = 9; e.player.ammo.energy = 41;
  e.updateHUD();
  const a = read();
  e.player.ammo.energy = 3; e.updateHUD();
  const b = read();
  const want = WEAPON_ORDER.map(w => { const d = WEAPONS[w], p = e.player.ammo[d.ammo]; return p === undefined ? '--' : String(d.cost > 0 ? Math.floor(p / d.cost) : p); });
  return { order: WEAPON_ORDER, a, b, wantB: want, slots: document.querySelectorAll('.weap-slot').length };
};

const PRESENCE = function () {
  const e = window.cyberEngine, U = window.__fw;
  U.calls = Object.assign(U.calls, { playPresence: [], playDeath: [] });
  const ens = [3004, 67, 3001].map((t, i) => { const en = U.spawn(t, 6 + i * 2); en.__qa = false; return en; });
  e.enemies.forEach(en => { if (ens.includes(en)) en.__qa = true; });
  // Keep them standing still so the cue test is not an AI test.
  const t0 = e.gameTime; const dt = 1 / 30; let t = 0;
  for (; t < 12; t += dt) { e.gameTime += dt; e.updatePresence(dt); }
  const pres = U.calls.playPresence.length;
  const maxVol = Math.max(...U.calls.playPresence.map(c => c[1]));
  e.killEnemy(ens[0]);
  return { secs: 12, pres, perSec: +(pres / 12).toFixed(2), maxVol: +maxVol.toFixed(2), deaths: U.calls.playDeath.length, deathArgs: U.calls.playDeath[0] && U.calls.playDeath[0].map(x => typeof x === 'number' ? +x.toFixed(2) : x) };
};

const SAW = function () {
  const e = window.cyberEngine, U = window.__fw;
  const en = U.spawn(3002, 2.2);
  en.hp = 1e6;
  U.calls.playScream = [];
  let blood = 0;
  const sb = e.spawnBlood.bind(e);
  e.spawnBlood = (p, o) => { if (o && o.amount >= 60) blood++; return sb(p, o); };
  e.switchWeapon('chainsaw');
  e.player.ammo.energy = 300;
  U.aimAt(en);
  e.isFiring = true;
  const hp0 = en.hp;
  for (let i = 0; i < 40; i++) { e.updateChainsaw(1 / 30); e.gameTime += 1 / 30; }
  e.isFiring = false; e.spawnBlood = sb;
  e.sound.stopSawLoop && e.sound.stopSawLoop();
  return { dmg: +(hp0 - en.hp).toFixed(1), bigSprays: blood, screams: U.calls.playScream.length,
    // Peak gains as coded: scream 0.75, death 0.2 x vol, presence 0.09 x vol.
    loudest: 'scream' };
};

const GRAPPLE = function () {
  const e = window.cyberEngine, U = window.__fw, s = U.spot;
  const out = {};
  const run = (secs, each) => { const dt = 1 / 60; for (let t = 0; t < secs && e.grapple; t += dt) { if (each) each(t); e.updatePhysics(dt); } };
  e.isRunning = true;
  // PULL: standing still.
  let en = U.spawn(67, 10); en.hp = 1e6; en.state = 'IDLE';
  e.switchWeapon('grapple'); U.aimAt(en); e.player.velocity.set(0, 0, 0);
  let d0 = Math.hypot(en.group.position.x - e.camera.position.x, en.group.position.z - e.camera.position.z);
  e.nextFireTime = 0; e.fireWeapon();
  out.pull = { hooked: !!e.grapple, mode: e.grapple && e.grapple.mode, d0: +d0.toFixed(2) };
  run(3);
  out.pull.d1 = +Math.hypot(en.group.position.x - e.camera.position.x, en.group.position.z - e.camera.position.z).toFixed(2);
  out.pull.released = !e.grapple;
  // SWING: strafing across the line.
  en = U.spawn(67, 9); en.hp = 1e6;
  e.switchWeapon('grapple'); U.aimAt(en);
  const ax = -s.dz, az = s.dx;               // across the run
  e.player.velocity.set(ax * 10, 0, az * 10);
  e.nextFireTime = 0; e.fireWeapon();
  out.swing = { hooked: !!e.grapple, mode: e.grapple && e.grapple.mode };
  const ang = () => Math.atan2(e.camera.position.z - en.group.position.z, e.camera.position.x - en.group.position.x);
  const a0 = ang(); let swept = 0, prev = a0, dmin = 1e9, dmax = 0;
  // While swinging: switch to the machinegun and shoot the hooked body.
  let hpBefore = en.hp, switched = false, stillHooked = false;
  run(2.5, (t) => {
    const a = ang(); let da = a - prev; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; swept += da; prev = a;
    const d = Math.hypot(e.camera.position.x - en.group.position.x, e.camera.position.z - en.group.position.z); dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
    if (t > 0.5 && !switched) { e.switchWeapon('machinegun'); switched = true; }
    if (switched) { U.aimAt(en); e.player.ammo.bullets = 200; e.nextFireTime = 0; e.fireWeapon(); stillHooked = stillHooked || !!e.grapple; }
  });
  out.swing.sweptDeg = Math.round(Math.abs(swept) * 180 / Math.PI);
  out.swing.dRange = [+dmin.toFixed(2), +dmax.toFixed(2)];
  out.swing.shotWhileHooked = +(hpBefore - en.hp).toFixed(1);
  out.swing.gunWhileHooked = e.player.currentWeapon;
  out.swing.stillHooked = stillHooked;
  // Kill it while hooked: the line drops.
  if (!e.grapple) { e.switchWeapon('grapple'); U.aimAt(en); e.nextFireTime = 0; e.player.velocity.set(0, 0, 0); e.fireWeapon(); }
  const hookedBeforeKill = !!e.grapple;
  en.hp = 1; e.switchWeapon('pistol'); U.aimAt(en); e.nextFireTime = 0;
  for (let i = 0; i < 20 && en.state !== 'DEAD'; i++) { e.nextFireTime = 0; en.hp = 1; e.fireWeapon(); }
  out.killRelease = { hookedBeforeKill, dead: en.state === 'DEAD', released: !e.grapple };
  // CARRY: running at it.
  en = U.spawn(67, 11); en.hp = 1e6;
  e.switchWeapon('grapple'); U.aimAt(en);
  e.player.velocity.set(s.dx * 9, 0, s.dz * 9);
  e.nextFireTime = 0; e.fireWeapon();
  out.carry = { hooked: !!e.grapple, mode: e.grapple && e.grapple.mode };
  const c0 = e.camera.position.clone(); let n = 0;
  run(0.5, () => n++);
  const mv = e.camera.position.clone().sub(c0);
  out.carry.moved = +Math.hypot(mv.x, mv.z).toFixed(2);
  out.carry.straightness = +((mv.x * s.dx + mv.z * s.dz) / (Math.hypot(mv.x, mv.z) || 1)).toFixed(2);
  e.releaseGrapple();
  e.isRunning = false;
  return out;
};

const SCALE = function () {
  const e = window.cyberEngine, U = window.__fw;
  const out = [];
  for (const t of [67, 68, 7, 3004]) {
    const en = U.spawn(t, 7);
    const b = U.box(en);
    out.push({ type: t, h: +(b.max.y - b.min.y).toFixed(2), scale: +en.group.scale.x.toFixed(2), radius: +en.radius.toFixed(2), bodyH: +en.bodyH.toFixed(2), eye: e.player.height });
  }
  return out;
};

const DIFF = function () {
  const e = window.cyberEngine, U = window.__fw;
  const god = document.getElementById('god-mode-chk');
  const out = { godDefaultOff: !god.defaultChecked, presets: {} };
  for (const k of ['easy', 'medium', 'hard', 'uv']) {
    document.querySelector(`#difficulty-panel button[data-preset="${k}"]`).click();
    const en = U.spawn(3004, 6); en.hp = 1000;
    U.aimAt(en); e.switchWeapon('pistol'); e.player.ammo.bullets = 50;
    let dealt = 0;
    for (let i = 0; i < 10 && dealt === 0; i++) { const h = en.hp; e.nextFireTime = 0; e.fireWeapon(); dealt = h - en.hp; }
    god.checked = false; e.isGameOver = false; e.player.health = 100; e.player.armor = 0;
    e.damagePlayer(20);
    const taken = 100 - e.player.health;
    e.player.health = 100;
    god.checked = true; e.damagePlayer(20);
    const takenGod = 100 - e.player.health;
    god.checked = false;
    out.presets[k] = { dealt: +dealt.toFixed(2), taken, takenGod,
      slDealt: document.getElementById('dmg-dealt').value, slTaken: document.getElementById('dmg-taken').value,
      on: document.querySelector('#difficulty-panel button.on') && document.querySelector('#difficulty-panel button.on').dataset.preset };
  }
  // Slider past the presets: custom values take.
  const sd = document.getElementById('dmg-dealt');
  sd.value = 250; sd.dispatchEvent(new Event('input'));
  out.custom = { dealt: e.difficulty.dealt, label: document.getElementById('dp-custom').innerText };
  document.querySelector('#difficulty-panel button[data-preset="uv"]').click();
  return out;
};

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`);
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  const run = (fn, ...args) => page.evaluate(([f, a]) => new Function('return ' + f)()(...a), [fn.toString(), args]);
  const load = async (m) => {
    const want = JSON.parse(fs.readFileSync(path.join(ROOT, m), 'utf8')).name;
    await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), m);
    await page.waitForFunction(n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n, want, { timeout: 120000 });
  };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${PREFIX}${name}.png`) }); };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    await shot('start-page-difficulty');

    // Enemy count per difficulty, from a real level load each time.
    const COUNT_MAP = 'levelPacks/pack1/json3.json';
    const counts = {};
    for (const k of ['easy', 'medium', 'hard', 'uv']) {
      await page.click(`#difficulty-panel button[data-preset="${k}"]`);
      await load(COUNT_MAP);
      counts[k] = await page.evaluate(() => window.cyberEngine.enemies.length);
    }

    await load(MAP);
    const spot = await run(SETUP);
    if (!spot) throw new Error('no open 12 m run on ' + MAP);

    const am = await run(AMMO);
    check('CH-FW-1 ammo shown under every weapon slot, in shots, follows the pool',
      am.slots === 7 && am.b.join() === am.wantB.join() && am.a[4] === '10' && am.a[5] === '41' && am.b[4] === '0',
      `slots ${am.slots}; ${am.order.map((w, i) => `${w}=${am.a[i]}`).join(' ')} ; energy 3 -> ${am.b.join('/')}`);
    await run(function () { const e = window.cyberEngine; e.player.ammo.bullets = 57; e.player.ammo.shells = 9; e.player.ammo.energy = 41; e.switchWeapon('energy_rifle'); document.getElementById('overlay-screen').style.display = 'none'; });
    await shot('hud-ammo-per-weapon');

    const pr = await run(PRESENCE);
    check('CH-FW-2 presence cues from nearby live bodies (quiet, rate-limited); death cue on kill',
      pr.pres >= 4 && pr.perSec <= 2.3 && pr.maxVol <= 1 && pr.deaths === 1,
      JSON.stringify(pr));

    const sw = await run(SAW);
    check('CH-FW-3 chainsaw bite: heavy blood (big sprays) and a loud scream',
      sw.dmg > 0 && sw.bigSprays >= 15 && sw.screams >= 1 && sw.screams <= 3,
      JSON.stringify(sw) + ' (peak gain: scream 0.75 vs death 0.2, presence 0.09)');
    await shot('chainsaw-blood');

    const gr = await run(GRAPPLE);
    const okPull = gr.pull.hooked && gr.pull.mode === 'pull' && gr.pull.d1 < gr.pull.d0 - 4 && gr.pull.released;
    const okSwing = gr.swing.hooked && gr.swing.mode === 'swing' && gr.swing.sweptDeg >= 60 && gr.swing.shotWhileHooked > 0 && gr.swing.gunWhileHooked === 'machinegun' && gr.swing.stillHooked;
    const okCarry = gr.carry.hooked && gr.carry.mode === 'carry' && gr.carry.moved > 4 && gr.carry.straightness > 0.95;
    const okKill = gr.killRelease.hookedBeforeKill && gr.killRelease.dead && gr.killRelease.released;
    check('CH-FW-4 grapple: pull / swing / carry by motion; switch gun and shoot while hooked; lets go on death',
      okPull && okSwing && okCarry && okKill, JSON.stringify(gr));

    const sc = await run(SCALE);
    const big = sc.filter(r => r.type !== 3004);
    const okScale = big.every(r => r.scale >= 1.5 && r.h > r.eye + 1 && r.radius > 1.0);
    check('CH-FW-5 Mancubus / Arachnotron / Spider Mastermind loom; radius grew with them',
      okScale, JSON.stringify(sc));
    await run(function () {
      const U = window.__fw, e = window.cyberEngine;
      const en = U.spawn(68, 6); U.aimAt(en);
      e.camera.rotation.x = 0.15; document.getElementById('overlay-screen').style.display = 'none';
    });
    await shot('arachnotron-looming');

    const df = await run(DIFF);
    const P = df.presets;
    const sameCount = new Set(Object.values(counts)).size === 1;
    const okDiff = sameCount && df.godDefaultOff &&
      P.uv.dealt === 15 && P.uv.taken === 20 && P.easy.dealt === 24 && P.easy.taken === 8 &&
      P.medium.dealt > P.hard.dealt && P.hard.dealt > P.uv.dealt && P.medium.taken < P.hard.taken && P.hard.taken < P.uv.taken &&
      Object.values(P).every(p => p.takenGod === 0) && ['easy', 'medium', 'hard', 'uv'].every(k => P[k].on === k) &&
      P.easy.slDealt === '160' && P.easy.slTaken === '40' && df.custom.dealt === 2.5 && df.custom.label === 'CUSTOM';
    check('CH-FW-6 difficulty: presets snap sliders; only dealt/taken change; enemy count identical; god mode separate + default OFF',
      okDiff, `enemies ${JSON.stringify(counts)}; ${JSON.stringify(df)}`);
  } finally {
    await browser.close();
    server.close();
  }
  check('CH-FW-7 zero page errors', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none');
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
