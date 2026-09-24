#!/usr/bin/env node
/**
 * CYBERHELL ARTICULATION QA (browser, headless)
 *
 *   CH-ART-1  A humanoid in CHASE flexes its knees and elbows: over one
 *             stride every leg's knee pivot and every arm's elbow pivot
 *             swings through a visible range (not frozen sticks).
 *   CH-ART-2  Knees bend the human way: the shin trails behind the thigh
 *             (knee pivot rotation.x <= 0 for the whole stride).
 *   CH-ART-3  A fast mover (Demon) runs with deeper knee flex than a
 *             walker (Zombieman).
 *   CH-ART-4  The Zombieman's gun arm kinks at the elbow when it fires.
 *   CH-ART-5  Zero page errors.
 *
 * Screenshots (side view, walk + run) land in QA_SHOTS or prototype_artifacts/.
 *
 * Usage:  node tests/qa-articulation.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5311);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = process.env.QA_SHOTS || path.join(ROOT, 'prototype_artifacts');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      if (!rel) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<body style="margin:0;background:#1a1d22"><script src="js/three.min.js"></script>' +
          '<script src="js/cyber-enemies.js"></script></body>');
      }
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

/* In-page: build one rig, walk it at a real ground speed facing the camera
   the way the AI does (face(): +Z toward the target), sample the joints. */
const RUN = function ([typeId, speed, frames, fire]) {
  const CE = window.CyberEnemies;
  const g = CE.build(typeId, { type: 'monster' }, THREE);
  const e = { group: g, state: 'CHASE', speed: speed, attackCooldown: 0 };
  const L = g.userData.limbs, P = g.userData.parts;
  const s = { knee: [], elbow: [] };
  let t = 0;
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    t += dt;
    g.position.z += speed * dt;           // walking straight along +Z
    if (fire && i === frames - 20) { e.state = 'ATTACK'; e.attackCooldown = 2; }
    CE.animate(e, t, dt);
    if (i > 30) {
      s.knee.push([L.leftLeg.userData.lower.rotation.x, L.rightLeg.userData.lower.rotation.x]);
      s.elbow.push([P.leftElbow.rotation.x, P.rightElbow.rotation.x]);
    }
  }
  const span = (a, k) => Math.max(...a.map(v => v[k])) - Math.min(...a.map(v => v[k]));
  return {
    kneeSpan: Math.min(span(s.knee, 0), span(s.knee, 1)),
    kneeMax: Math.max(...s.knee.map(v => Math.max(v[0], v[1]))),
    kneeMin: Math.min(...s.knee.map(v => Math.min(v[0], v[1]))),
    elbowSpan: Math.min(span(s.elbow, 0), span(s.elbow, 1)),
    rightElbowEnd: P.rightElbow.rotation.x
  };
};

/* In-page: render the rig from the side mid-stride. */
const SHOT = function ([typeId, speed, frames, fire]) {
  const CE = window.CyberEnemies;
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setSize(480, 480);
  document.body.innerHTML = '';
  document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d22);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202020, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(4, 6, 3); scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x2c3036 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const g = CE.build(typeId, { type: 'monster' }, THREE);
  scene.add(g);
  const e = { group: g, state: 'CHASE', speed: speed, attackCooldown: 0 };
  let t = 0;
  for (let i = 0; i < frames; i++) {
    t += 1 / 60;
    g.position.z += speed / 60;
    if (fire && i === frames - 16) { e.state = 'ATTACK'; e.attackCooldown = 2; }
    CE.animate(e, t, 1 / 60);
  }
  const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3());
  const h = box.max.y - box.min.y;
  const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  // three-quarter side view: walking toward +Z, camera off to +X
  cam.position.set(c.x + h * 2.2, c.y + h * 0.1, c.z + h * 0.9);
  cam.lookAt(c);
  r.render(scene, cam);
  r.render(scene, cam);
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.CyberEnemies && window.THREE);

  let fail = 0;
  const check = (id, ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${msg}`); if (!ok) fail++; };

  const zomb = await page.evaluate(RUN, [3004, 3.5, 240, false]);
  const imp = await page.evaluate(RUN, [3001, 3.6, 240, false]);
  const demon = await page.evaluate(RUN, [3002, 6.5, 240, false]);
  const fired = await page.evaluate(RUN, [3004, 3.5, 250, true]);
  const f = n => n.toFixed(2);

  check('CH-ART-1', zomb.kneeSpan > 0.5 && zomb.elbowSpan > 0.2 && imp.kneeSpan > 0.5 && imp.elbowSpan > 0.2,
    `zombie knee ${f(zomb.kneeSpan)} elbow ${f(zomb.elbowSpan)} / imp knee ${f(imp.kneeSpan)} elbow ${f(imp.elbowSpan)}`);
  check('CH-ART-2', zomb.kneeMax <= 1e-6 && demon.kneeMax <= 1e-6, `knee max ${f(zomb.kneeMax)} / ${f(demon.kneeMax)}`);
  check('CH-ART-3', demon.kneeMin < zomb.kneeMin - 0.3, `run knee ${f(demon.kneeMin)} vs walk ${f(zomb.kneeMin)}`);
  check('CH-ART-4', fired.rightElbowEnd > 0.3, `gun elbow ${f(fired.rightElbowEnd)}`);

  const shots = [
    ['enemy-zombieman-walk', 3004, 3.5, 200, false],
    ['enemy-zombieman-aim-fire', 3004, 3.5, 216, true],
    ['enemy-imp-walk', 3001, 3.6, 200, false],
    ['enemy-demon-sprint', 3002, 6.5, 200, false]
  ];
  await page.evaluate(SHOT, [3004, 0, 2, false]);   // warm the GL context up
  await page.waitForTimeout(500);
  for (const [name, id, sp, fr, fire] of shots) {
    await page.evaluate(SHOT, [id, sp, fr, fire]);
    await page.waitForTimeout(300);
    const file = path.join(SHOTS, `articulation-${name}.png`);
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
  check('CH-ART-5', errors.length === 0, errors.join(' | ') || 'no page errors');

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
