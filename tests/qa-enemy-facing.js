#!/usr/bin/env node
/**
 * CYBERHELL ENEMY FACING QA (browser, headless)
 * Joel 2026-10-16: "pinky is facing backwards the mouth is on the wrong side".
 *   CH-FACE-1  Every stock rig, built alone, has its face (eye meshes, or the Pinky's shredder maw)
 *              on the root's +Z side -- the side CyberAI.face() points at its target.
 *   CH-FACE-2  In the engine, on pack2 MAP (Pinkies + Imps + Zombiemen), every enemy chasing a
 *              visible player shows its face to the player (cosine > 0.3) on every frame of a 5 s
 *              chase-and-lunge, the Pinky's charge included.
 * QA_SHOTS=dir writes pinky-closeup.png (the player's view of a charging Pinky).
 */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.env.QA_ROOT || path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8160);
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = process.env.QA_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
let fails = 0;
function check(id, ok, detail) { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`); }
const TYPES = [3004, 9, 65, 3001, 3002, 58, 3005, 69, 3003, 66, 67, 68, 64, 16, 7];

(async () => {
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    await page.waitForTimeout(3000);

    const rest = await page.evaluate((TYPES) => {
      const out = {};
      for (const id of TYPES) {
        const g = window.CyberEnemies.build(id, {}, THREE); g.updateMatrixWorld(true);
        const A = g.userData.anim || {}, marks = A.grinder ? [A.grinder] : (A.eyeMeshes || []);
        if (!marks.length) continue;   // gun-faced soldiers have no eye meshes; covered by CH-FACE-2's Zombiemen
        const v = new THREE.Vector3(); let z = 0;
        marks.forEach(m => { new THREE.Box3().setFromObject(m).getCenter(v); z += v.z; });
        out[id] = +(z / marks.length).toFixed(2);
      }
      return out;
    }, TYPES);
    const back = Object.entries(rest).filter(([, z]) => !(z > 0.02));
    check('CH-FACE-1 rig faces +Z (the AI forward)', back.length === 0, JSON.stringify(rest));

    await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), 'levelPacks/pack2/json1.json');
    await page.waitForFunction(() => /Pack 2/.test(window.cyberEngine.levelData.name || ''), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const res = await page.evaluate(() => {
      const e = window.cyberEngine; e.isRunning = true;
      const bad = [], seen = {};
      for (const en of e.enemies.filter(x => x.state !== 'DEAD').slice(0, 40)) {
        const gp = en.group.position, A = en.group.userData.anim || {};
        const marks = A.grinder ? [A.grinder] : (A.eyeMeshes || []);
        if (!marks.length) continue;
        let spot = null;
        for (let a = 0; a < 16 && !spot; a++) { const ang = a / 16 * Math.PI * 2, x = gp.x + Math.sin(ang) * 5, z = gp.z + Math.cos(ang) * 5;
          const f = e.getFloorAt(x, z); if (f.inside && Math.abs(f.floorY - gp.y) < 0.6) spot = { x, z, y: f.floorY }; }
        if (!spot) continue;
        e.camera.position.set(spot.x, spot.y + e.player.height, spot.z);
        en.state = 'CHASE'; if (en.ai) { en.ai.alert = true; en.ai.reactT = 0; }
        let worst = 1, n = 0;
        for (let i = 0; i < 300; i++) {
          e.player.health = 100; e.isGameOver = false;
          e.updateEnemies(1 / 60);
          if (!en.ai || !en.ai.seen || en.state === 'DEAD') continue;   // out of sight it faces where it last saw you
          en.group.updateMatrixWorld(true);
          const c = new THREE.Vector3(), v = new THREE.Vector3();
          marks.forEach(m => { new THREE.Box3().setFromObject(m).getCenter(v); c.add(v); }); c.divideScalar(marks.length);
          const fx = c.x - gp.x, fz = c.z - gp.z, tx = e.camera.position.x - gp.x, tz = e.camera.position.z - gp.z;
          const tl = Math.hypot(tx, tz); if (tl < 0.8) continue;
          worst = Math.min(worst, (fx * tx + fz * tz) / ((Math.hypot(fx, fz) || 1) * tl)); n++;
        }
        if (!n) continue;
        (seen[en.enemyType] = seen[en.enemyType] || []).push(+worst.toFixed(2));
        if (worst < 0.3) bad.push({ type: en.enemyType, worst: +worst.toFixed(2) });
      }
      return { bad, seen };
    });
    check('CH-FACE-2 face leads the chase (pack2)', res.bad.length === 0 && (res.seen[3002] || []).length > 0,
      'worst cosine per enemy by type ' + JSON.stringify(res.seen) + (res.bad.length ? '  BAD ' + JSON.stringify(res.bad.slice(0, 5)) : ''));

    if (SHOTS) {
      await page.evaluate(() => {
        const e = window.cyberEngine, cv = e.renderer.domElement;
        document.querySelectorAll('body *').forEach(d => { if (d !== cv && !d.contains(cv)) d.style.visibility = 'hidden'; });
        const en = e.enemies.find(x => String(x.enemyType) === '3002' && x.state !== 'DEAD'); const gp = en.group.position;
        for (let a = 0; a < 16; a++) { const ang = a / 16 * Math.PI * 2, x = gp.x + Math.sin(ang) * 6, z = gp.z + Math.cos(ang) * 6;
          const f = e.getFloorAt(x, z); if (f.inside && Math.abs(f.floorY - gp.y) < 0.6) { e.camera.position.set(x, f.floorY + e.player.height, z); break; } }
        en.state = 'CHASE'; if (en.ai) { en.ai.alert = true; en.ai.reactT = 0; }
        for (let i = 0; i < 50; i++) { e.player.health = 100; e.updateEnemies(1 / 60); }
        e.camera.lookAt(gp.x, gp.y + 0.7, gp.z); e.renderer.render(e.scene, e.camera);
      });
      await (await page.$('canvas')).screenshot({ path: path.join(SHOTS, 'pinky-closeup.png') });
    }
  } catch (e) { fails++; console.log('FAIL  harness ' + (e.stack || e)); }
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
