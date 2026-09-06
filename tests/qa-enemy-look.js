#!/usr/bin/env node
/**
 * CYBERHELL ENEMY LOOK QA (browser, headless)
 *
 *   CH-LOOK-1  Every stock type renders identically through the engine's
 *              build() and through the editor's buildMesh(id, null): same
 *              node tree, same geometry parameters, same material colours,
 *              same transforms. This is the "look parameterisation changed
 *              nothing" proof.
 *   CH-LOOK-2  A look actually bites: a slot recolour reaches a material, a
 *              hidden slot hides its meshes, look.scale scales the rig, and
 *              look.emissive scales accent intensity.
 *   CH-LOOK-3  The enemy editor panel mounts against a stub CyberEditor,
 *              lists base types, previews a mesh, and Save writes
 *              level.customEnemies.
 *   CH-LOOK-4  Zero page errors.
 *
 * Own server, own port, own headless Chromium (swiftshader) — never the
 * shared browser session. Screenshots land in prototype_artifacts/.
 *
 * Usage:  node tests/qa-enemy-look.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5303);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = path.join(ROOT, 'prototype_artifacts');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

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

/* --------------------------------------------------------------------------
   In-page: summarise a rig down to everything a renderer would care about.
   -------------------------------------------------------------------------- */
const PARITY = function () {
  const CE = window.CyberEnemies;
  const r4 = n => (Math.round(n * 10000) / 10000);
  function matSum(m) {
    if (!m) return 'nomat';
    const a = [
      m.type,
      m.color ? m.color.getHexString() : '-',
      m.emissive ? m.emissive.getHexString() : '-',
      r4(m.emissiveIntensity === undefined ? -1 : m.emissiveIntensity),
      r4(m.metalness === undefined ? -1 : m.metalness),
      r4(m.roughness === undefined ? -1 : m.roughness),
      r4(m.opacity === undefined ? -1 : m.opacity),
      m.transparent ? 1 : 0,
      m.side
    ];
    return a.join(',');
  }
  function geoSum(g) {
    if (!g) return 'nogeo';
    const p = g.parameters || {};
    const keys = Object.keys(p).sort();
    let vc = '';
    const ca = g.attributes && g.attributes.color;
    if (ca) {
      // vgrad bakes its colours into a vertex attribute, so the parameters
      // alone would call two different gradients identical.
      let h = 0;
      for (let i = 0; i < ca.count * 3; i++) h = (Math.imul(h, 31) + Math.round(ca.array[i] * 255)) | 0;
      vc = '#vc' + (h >>> 0).toString(16);
    }
    return g.type + '{' + keys.map(k => k + '=' + (typeof p[k] === 'number' ? r4(p[k]) : p[k])).join(';') + '}' + vc;
  }
  function summarise(root) {
    const lines = [];
    root.traverse(o => {
      lines.push([
        o.type,
        o.visible ? 1 : 0,
        r4(o.position.x), r4(o.position.y), r4(o.position.z),
        r4(o.rotation.x), r4(o.rotation.y), r4(o.rotation.z),
        r4(o.scale.x), r4(o.scale.y), r4(o.scale.z),
        o.isMesh ? geoSum(o.geometry) : '-',
        o.isMesh ? matSum(o.material) : '-',
        o.castShadow ? 1 : 0, o.receiveShadow ? 1 : 0
      ].join('|'));
    });
    return lines.join('\n');
  }
  function digest(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8) + ':' + s.length;
  }

  const out = { types: [], mismatch: [], look: {}, errors: [] };
  const ids = CE.listTypes().map(t => t.id);
  for (const id of ids) {
    let a, b;
    try {
      a = summarise(CE.build(id, {}, window.THREE));
      b = summarise(CE.buildMesh(id, null, {}, window.THREE));
    } catch (e) { out.errors.push(id + ': ' + e.message); continue; }
    const same = a === b;
    out.types.push({ id, nodes: a.split('\n').length, hash: digest(a), same });
    if (!same) {
      const al = a.split('\n'), bl = b.split('\n');
      let first = null;
      for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i]) { first = { i, a: al[i], b: bl[i] }; break; }
      }
      out.mismatch.push({ id, first });
    }
  }

  // CH-LOOK-2 — a look has to actually change the render.
  const base = 3004;
  const def = CE.getDefaultLook(base, window.THREE);
  const slots = def.slots.map(s => s.name);
  const first = slots[0], last = slots[slots.length - 1];
  const glow = def.slots.filter(s => s.kind === 'glow')[0];
  const look = {
    colors: {}, parts: {}, scale: 1.5, emissive: 2
  };
  look.colors[first] = 0xff0000;
  look.parts[last] = false;
  const g = CE.buildMesh(base, look, {}, window.THREE);
  let red = 0, hidden = 0, lit = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.material && o.material.color && o.material.color.getHexString() === 'ff0000') red++;
    if (o.userData.lookSlot === last && !o.visible) hidden++;
  });
  const acc = g.userData.accents || [];
  const defAcc = CE.buildMesh(base, null, {}, window.THREE).userData.accents || [];
  if (acc.length && defAcc.length) lit = +(acc[0].base / defAcc[0].base).toFixed(2);
  out.look = {
    slots: slots.length, slotNames: slots, first, last,
    hasGlowSlot: !!glow, red, hidden, scale: +g.scale.x.toFixed(3), emissiveRatio: lit
  };

  // Every slot getDefaultLook() exposes has to change what is rendered —
  // no dead colour pickers. Recolour one slot at a time and diff the summary.
  out.dead = [];
  out.slotCounts = {};
  for (const t of [3004, 3002, 16]) {
    const dl = CE.getDefaultLook(t, window.THREE);
    const before = summarise(CE.buildMesh(t, null, {}, window.THREE));
    for (const sl of dl.slots) {
      const one = { colors: {} };
      one.colors[sl.name] = (sl.hex === 0x00ff00) ? 0xff00ff : 0x00ff00;
      if (summarise(CE.buildMesh(t, one, {}, window.THREE)) === before) out.dead.push(t + '/' + sl.name);
    }
    out.slotCounts[t] = dl.slots.length;
  }

  // custom enemy resolution, engine side
  CE.registerCustom({ brute: { id: 'brute', name: 'Brute', base: 3002, stats: { hp: 999, speed: 6 }, role: 'bruiser', look: { colors: (function () { const c = {}; c[CE.getDefaultLook(3002).slots[0].name] = 0x00ff00; return c; })() } } });
  const cs = CE.stats('custom:brute');
  const cg = CE.build('custom:brute', {}, window.THREE);
  let green = 0;
  cg.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const c = o.material.color && o.material.color.getHexString();
    const e = o.material.emissive && o.material.emissive.getHexString();
    if (c === '00ff00' || e === '00ff00') { green++; return; }
    const va = o.geometry && o.geometry.attributes && o.geometry.attributes.color;
    if (va) {
      for (let i = 0; i < va.count; i++) {
        if (va.getX(i) === 0 && va.getY(i) === 1 && va.getZ(i) === 0) { green++; return; }
      }
    }
  });
  out.custom = {
    hp: cs.hp, speed: cs.speed, attack: cs.attack, damage: cs.damage,
    typeId: cg.userData.enemyTypeId, customId: cg.userData.customEnemyId, green,
    role: window.CyberAI ? window.CyberAI.roleFor(cs, 'custom:brute') : null
  };
  const unknown = CE.build('custom:nope', {}, window.THREE);
  out.unknown = { built: !!unknown, children: unknown.children.length, stats: CE.stats('custom:nope').hp };
  return out;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let fails = 0;
  const ok = (name, cond, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/tests/enemy-editor-harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.CyberEnemies && !!window.THREE', null, { timeout: 20000 });

    const res = await page.evaluate(PARITY);
    console.log(`\n-- CH-LOOK-1  build() vs buildMesh(id, null) over ${res.types.length} types`);
    for (const t of res.types) console.log(`   ${String(t.id).padStart(4)}  ${String(t.nodes).padStart(3)} nodes  ${t.hash}  ${t.same ? 'identical' : 'CHANGED'}`);
    ok('CH-LOOK-1 every stock rig identical', res.mismatch.length === 0 && res.errors.length === 0,
      res.mismatch.length ? JSON.stringify(res.mismatch[0]) : (res.errors[0] || ''));

    console.log(`\n-- CH-LOOK-2  look overrides: ${JSON.stringify(res.look)}`);
    ok('CH-LOOK-2 slots discovered', res.look.slots >= 3, `${res.look.slots} slots`);
    ok('CH-LOOK-2 colour override applied', res.look.red > 0, `${res.look.red} meshes recoloured`);
    ok('CH-LOOK-2 part toggle applied', res.look.hidden > 0, `${res.look.hidden} meshes hidden`);
    ok('CH-LOOK-2 scale applied', Math.abs(res.look.scale - 1.5) < 1e-6, `scale=${res.look.scale}`);
    ok('CH-LOOK-2 emissive multiplier applied', Math.abs(res.look.emissiveRatio - 2) < 0.01, `x${res.look.emissiveRatio}`);

    console.log(`
-- live slots ${JSON.stringify(res.slotCounts)}  dead=${JSON.stringify(res.dead)}`);
    ok('every exposed slot changes the render', res.dead.length === 0, res.dead.join(','));
    console.log(`\n-- custom resolution: ${JSON.stringify(res.custom)}  unknown: ${JSON.stringify(res.unknown)}`);
    ok('custom stats merge over base', res.custom.hp === 999 && res.custom.speed === 6 && res.custom.attack === 'melee');
    ok('custom look applied', res.custom.green > 0, `${res.custom.green} meshes`);
    ok('custom keeps base type id', res.custom.typeId === 3002 && res.custom.customId === 'brute');
    ok('custom role registered with CyberAI', res.custom.role === 'bruiser', res.custom.role);
    ok('unknown custom id falls back, no crash', res.unknown.built && res.unknown.children > 0 && res.unknown.stats === 50);

    // CH-LOOK-3 — the panel itself.
    await page.waitForFunction('!!document.querySelector("#panel-enemies select")', null, { timeout: 20000 });
    await page.waitForFunction('!!window.CyberEnemyEditor', null, { timeout: 5000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, '_enemy_editor_panel.png') });

    const panel = await page.evaluate(() => {
      const q = s => document.querySelector('#panel-enemies ' + s);
      void 0;
      return {
        options: q('select').options.length,
        slotRows: document.querySelectorAll('#panel-enemies .slots input[type=color]').length,
        statRows: document.querySelectorAll('#panel-enemies .grid input[type=range]').length,
        canvas: !!q('canvas')
      };
    });
    console.log(`\n-- CH-LOOK-3  panel: ${JSON.stringify(panel)}`);
    ok('panel lists base types', panel.options >= 15, `${panel.options} options`);
    ok('panel shows colour slots', panel.slotRows >= 3, `${panel.slotRows} slots`);
    ok('panel shows stat sliders', panel.statRows >= 6, `${panel.statRows} sliders`);
    ok('panel has a live preview canvas', panel.canvas);

    // Edit a colour + stat, then Save, and confirm it lands on the level.
    await page.evaluate(() => {
      const p = document.querySelector('#panel-enemies');
      const col = p.querySelector('.slots input[type=color]');
      col.value = '#ff2288';
      col.dispatchEvent(new Event('input', { bubbles: true }));
      const name = p.querySelector('input[type=text]');
      name.value = 'Test Brute';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const buttons = Array.prototype.slice.call(p.querySelectorAll('button'));
      buttons.filter(b => b.textContent === 'Save')[0].click();
      buttons.filter(b => b.textContent === 'Use for selected')[0].click();
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, '_enemy_editor_saved.png') });

    const saved = await page.evaluate(() => {
      const lvl = window.CyberEditor.level;
      const keys = Object.keys(lvl.customEnemies || {});
      const def = keys.length ? lvl.customEnemies[keys[0]] : null;
      return {
        keys, entType: lvl.entities[0].enemyType,
        colours: def && def.look ? Object.keys(def.look.colors || {}).length : 0,
        hasRecolour: !!(def && def.look && Object.keys(def.look.colors || {}).some(k => def.look.colors[k] === 0xff2288)),
        log: (window.__eeLog || []).slice(-4)
      };
    });
    console.log(`-- saved: ${JSON.stringify(saved)}`);
    ok('Save writes level.customEnemies', saved.keys.length === 1 && saved.keys[0] === 'test-brute', saved.keys.join(','));
    ok('recoloured slot persisted', saved.hasRecolour);
    ok('Use for selected sets entity enemyType', saved.entType === 'custom:test-brute', String(saved.entType));

    ok('CH-LOOK-4 no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
