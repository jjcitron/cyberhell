#!/usr/bin/env node
/**
 * MAP01 trooper articulation + evidence capture.
 *
 * Five checks cover the rig contract, non-A-pose idle, rifle hand parenting,
 * carried walk, and firing recoil. Four stills capture spawn/mid-fight on
 * desktop and touch-phone layouts. The capture background and fog are locked
 * to the QA neutral #080a0f; no game materials are recoloured.
 *
 *   STILLS_DIR=/path/to/stills node tests/qa-trooper-articulation.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8246);
const STILLS = process.env.STILLS_DIR || path.join(ROOT, 'prototype_artifacts', 'trooper-qa');
const QA_BG = 0x080a0f;

function playwrightCore() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.join(ROOT, 'node_modules', 'playwright-core'),
    '/workspace/cyberhell-final-r1proof/node_modules/playwright-core',
    'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core'
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch (_) { /* try the next known local install */ }
  }
  throw new Error('playwright-core not found; set PLAYWRIGHT_PATH to its local install');
}

const { chromium } = playwrightCore();
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mid': 'audio/midi', '.webmanifest': 'application/manifest+json'
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const rel = decodeURIComponent(url).replace(/^\/+/, '') || 'index.html';
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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function boot(browser, phone) {
  const context = await browser.newContext(phone ? {
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  } : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // The hand-built MAP01 is already loaded synchronously. Prevent the menu's
  // asynchronous manifest refresh from reloading/duplicating it during a shot.
  await page.route('**/levelPacks/pack1/manifest.json', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]'
  }));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cyberEngine && window.cyberEngine.enemies.length >= 12,
    null, { timeout: 20000 });
  await page.waitForTimeout(250);
  return { context, page, errors };
}

async function lockQaScene(page, mode) {
  return page.evaluate(({ mode, bg }) => {
    const e = window.cyberEngine;
    document.documentElement.style.background = '#080a0f';
    document.body.style.background = '#080a0f';
    document.getElementById('overlay-screen').style.display = 'none';
    e.isRunning = false;
    e.scene.background = new THREE.Color(bg);
    if (e.scene.fog) e.scene.fog.color.setHex(bg);
    e.renderer.setClearColor(bg, 1);
    if (!e.scene.getObjectByName('trooper_qa_key')) {
      const key = new THREE.HemisphereLight(0xb8d8ff, 0x101018, 1.6);
      key.name = 'trooper_qa_key';
      e.scene.add(key);
    }

    const troops = e.enemies.filter(n => n.group.userData.enemyTypeId === 3004).slice(0, 2);
    if (mode === 'spawn') {
      e.camera.position.set(0, 1.5, 8);
      e.yaw = 0; e.pitch = -0.025;
      troops.forEach((n, i) => {
        n.group.rotation.y = Math.PI;
        n.state = 'IDLE'; n.attackT = 0;
        CyberEnemies.animate(n, 1.1 + i * 0.4, 1 / 60);
      });
    } else {
      e.camera.position.set(0, 1.45, 1.1);
      e.yaw = 0; e.pitch = -0.045;
      troops.forEach((n, i) => {
        n.group.rotation.y = Math.PI + (i ? -0.12 : 0.12);
        n.state = i ? 'ATTACK' : 'CHASE';
        n.attackT = i ? 0.56 : 0;
        for (let f = 0; f < 14; f++) CyberEnemies.animate(n, 2.0 + f / 60, 1 / 60);
      });
    }
    e.camera.rotation.order = 'YXZ';
    e.camera.rotation.set(e.pitch, e.yaw, 0);
    e.camera.updateMatrixWorld(true);
    return { level: e.levelData.name, background: `#${bg.toString(16).padStart(6, '0')}`, troops: troops.length };
  }, { mode, bg: QA_BG });
}

async function articulation(page) {
  return page.evaluate(() => {
    const g = CyberEnemies.build(3004, { type: 'soldier' }, THREE);
    const P = g.userData.parts;
    const A = g.userData.anim;
    const enemy = {
      group: g, type: 'soldier', enemyType: 3004, state: 'IDLE',
      attackT: 0, attackCooldown: 0, speed: 3.5,
      stats: CyberEnemies.stats(3004), floorY: 0
    };
    const sameParent = () => P.rifle.parent === P.rightHand && P.rifle.parent.name === 'trooper_right_hand';
    const rot = o => [o.rotation.x, o.rotation.y, o.rotation.z];
    const diff = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-3);

    const rig = !!(P.torso && P.head && P.leftShoulder && P.rightShoulder &&
      P.leftElbow && P.rightElbow && P.limbs.leftLeg && P.limbs.rightLeg);

    CyberEnemies.animate(enemy, 0.3, 1 / 60);
    const idleShoulders = [rot(P.leftShoulder), rot(P.rightShoulder)];
    const idleNoAPose = Math.abs(P.leftShoulder.rotation.x) > 0.7 &&
      Math.abs(P.rightShoulder.rotation.x) > 0.7 &&
      Math.abs(P.leftElbow.rotation.x) > 0.25 && Math.abs(P.rightElbow.rotation.x) > 0.2 &&
      Math.abs(P.leftShoulder.rotation.z) < 0.8 && Math.abs(P.rightShoulder.rotation.z) < 0.8;
    const idleAttached = sameParent() && P.rifle.visible;

    const left0 = rot(P.limbs.leftLeg), right0 = rot(P.limbs.rightLeg);
    enemy.state = 'CHASE';
    for (let i = 0; i < 20; i++) CyberEnemies.animate(enemy, 0.4 + i / 60, 1 / 60);
    const walkLegs = diff(left0, rot(P.limbs.leftLeg)) && diff(right0, rot(P.limbs.rightLeg));
    const carriedWalk = sameParent() && A.weaponStance === true && walkLegs;

    const rifle0 = rot(P.rifle), shoulder0 = rot(P.rightShoulder);
    enemy.state = 'ATTACK'; enemy.attackT = 0.56;
    CyberEnemies.animate(enemy, 1.0, 1 / 60);
    const firing = sameParent() && P.rifleMuzzleFlash.visible &&
      (diff(rifle0, rot(P.rifle)) || diff(shoulder0, rot(P.rightShoulder)));

    const box = new THREE.Box3().setFromObject(P.rifle);
    const size = new THREE.Vector3(); box.getSize(size);
    const rifleShape = P.rifle.name === 'trooper_rifle' && size.length() > 0.9 && P.rifle.children.length >= 10;

    return {
      checks: { rig, idleNoAPose, rifleHandAttachment: idleAttached && rifleShape, carriedWalk, firing },
      detail: {
        rifleParent: P.rifle.parent.name, rifleChildren: P.rifle.children.length,
        rifleBounds: size.toArray().map(v => +v.toFixed(3)), idleShoulders,
        weaponStance: A.weaponStance, muzzleFlash: P.rifleMuzzleFlash.visible
      }
    };
  });
}

(async () => {
  fs.mkdirSync(STILLS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });
  const captures = [];
  let pageErrors = [];
  try {
    const desktop = await boot(browser, false);
    const art = await articulation(desktop.page);
    check('1/5 rig exposes articulated torso, head, arms and legs', art.checks.rig, art.detail.rifleParent);
    check('2/5 idle is a bent two-handed pose, never A/T', art.checks.idleNoAPose,
      `shoulder pitch ${art.detail.idleShoulders.map(r => r[0].toFixed(2)).join('/')}`);
    check('3/5 rifle is a full long gun parented to the right hand', art.checks.rifleHandAttachment,
      `${art.detail.rifleChildren} parts, bounds ${art.detail.rifleBounds.join('x')}`);
    check('4/5 walk articulates both legs while preserving the carried rifle', art.checks.carriedWalk,
      `weaponStance=${art.detail.weaponStance}`);
    check('5/5 fire articulates recoil/flash without detaching the rifle', art.checks.firing,
      `muzzleFlash=${art.detail.muzzleFlash}`);

    for (const mode of ['spawn', 'midfight']) {
      const meta = await lockQaScene(desktop.page, mode);
      const file = path.join(STILLS, `map01-${mode}-desktop.png`);
      await desktop.page.screenshot({ path: file });
      captures.push({ file, device: 'desktop-1280x720', mode, ...meta });
    }
    pageErrors = pageErrors.concat(desktop.errors);
    await desktop.context.close();

    const phone = await boot(browser, true);
    for (const mode of ['spawn', 'midfight']) {
      const meta = await lockQaScene(phone.page, mode);
      const file = path.join(STILLS, `map01-${mode}-phone.png`);
      await phone.page.screenshot({ path: file });
      captures.push({ file, device: 'phone-landscape-844x390@2x', mode, ...meta });
    }
    pageErrors = pageErrors.concat(phone.errors);
    await phone.context.close();

    check('console/page errors', pageErrors.length === 0, pageErrors.join(' | ') || '0 errors');
    const report = {
      qaBackground: '#080a0f', articulation: results.slice(0, 5), captures,
      pageErrors, pass: results.every(r => r.pass)
    };
    fs.writeFileSync(path.join(STILLS, 'trooper-articulation.json'), JSON.stringify(report, null, 2) + '\n');
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
