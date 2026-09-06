#!/usr/bin/env node
/**
 * CYBERHELL CUSTOM ENEMY QA (browser, headless)
 *
 * Boots the real engine on a real pack-1 level whose JSON carries a
 * `customEnemies` block, and asserts the whole data path works end to end:
 *
 *   CH-CUS-1  An entity with enemyType "custom:<id>" spawns, with the def's
 *             stat overrides merged over its base (hp, speed) and the base's
 *             untouched stats intact.
 *   CH-CUS-2  The def's look reaches the rendered mesh (recoloured slot) and
 *             its scale is applied.
 *   CH-CUS-3  The rig still reports its base thing id, so LOD, hit flash and
 *             the AI keep working; the custom id is recorded alongside.
 *   CH-CUS-4  The def's role is registered with CyberAI.
 *   CH-CUS-5  A pack-level customEnemies table is honoured, and a level def
 *             of the same id wins over it.
 *   CH-CUS-6  An entity pointing at an unregistered custom id spawns a body
 *             and warns instead of crashing the level load.
 *   CH-CUS-7  Zero page errors (the console warning is expected and excluded).
 *
 * Own server, own port, own headless Chromium — never the shared session.
 *
 * Usage:  node tests/qa-custom-enemy.js       (QA_PORT to move the port)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5304);
const LEVEL = process.env.QA_LEVEL || 'levelPacks/pack1/json1.json';
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = path.join(ROOT, 'prototype_artifacts');

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

/* Runs in the page against the live engine. */
const PROBE = async function (levelUrl) {
  const e = window.cyberEngine;
  const CE = window.CyberEnemies;
  const data = await fetch(levelUrl).then(r => r.json());

  const slot = CE.getDefaultLook(3001, window.THREE).slots[0].name;
  const MAGENTA = 0xff00ff;
  const packSlot = CE.getDefaultLook(3002, window.THREE).slots[0].name;

  const colors = {}; colors[slot] = MAGENTA;
  data.customEnemies = {
    neon: {
      id: 'neon', name: 'Neon Imp', base: 3001, role: 'rusher',
      stats: { hp: 777, speed: 9 },
      look: { colors: colors, scale: 1.4 }
    },
    // same id as the pack def below — the level's must win
    shared: { id: 'shared', name: 'Level Shared', base: 3004, stats: { hp: 111 }, role: 'skirmisher' }
  };

  // Pack-level table, the shape the editor's pack object carries.
  const packColors = {}; packColors[packSlot] = 0x00ffff;
  e.campaign = e.campaign || {};
  e.campaign.customEnemies = {
    tank: { id: 'tank', name: 'Pack Tank', base: 3002, stats: { hp: 555 }, role: 'bruiser', look: { colors: packColors } },
    shared: { id: 'shared', name: 'Pack Shared', base: 3004, stats: { hp: 999 }, role: 'bruiser' }
  };

  const ents = data.entities.filter(x => x.enemyType !== undefined);
  ents[0].enemyType = 'custom:neon';
  ents[1].enemyType = 'custom:tank';
  ents[2].enemyType = 'custom:shared';
  ents[3].enemyType = 'custom:missing';
  const baseCount = ents.length;

  e.loadLevel(data);

  const find = t => e.enemies.filter(x => x.enemyType === t)[0] || null;
  const paint = (g, hexstr) => {
    let n = 0;
    g.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const c = o.material.color && o.material.color.getHexString();
      const em = o.material.emissive && o.material.emissive.getHexString();
      if (c === hexstr || em === hexstr) { n++; return; }
      const va = o.geometry && o.geometry.attributes && o.geometry.attributes.color;
      if (!va) return;
      for (let i = 0; i < va.count; i++) {
        const r = Math.round(va.getX(i) * 255), gg = Math.round(va.getY(i) * 255), b = Math.round(va.getZ(i) * 255);
        if (('000000' + ((r << 16) | (gg << 8) | b).toString(16)).slice(-6) === hexstr) { n++; return; }
      }
    });
    return n;
  };

  const neon = find('custom:neon');
  const tank = find('custom:tank');
  const shared = find('custom:shared');
  const missing = find('custom:missing');
  const impBase = CE.stats(3001);

  return {
    spawned: e.enemies.length, entities: baseCount,
    neon: neon && {
      hp: neon.hp, speed: neon.speed, damage: neon.stats.damage, range: neon.stats.range,
      baseDamage: impBase.damage,
      typeId: neon.group.userData.enemyTypeId, customId: neon.group.userData.customEnemyId,
      scale: +neon.group.scale.x.toFixed(3), painted: paint(neon.group, 'ff00ff'),
      role: window.CyberAI.roleFor(CE.stats('custom:neon'), 'custom:neon'),
      limbs: !!neon.group.userData.limbs
    },
    tank: tank && { hp: tank.hp, typeId: tank.group.userData.enemyTypeId, painted: paint(tank.group, '00ffff') },
    shared: shared && { hp: shared.hp, typeId: shared.group.userData.enemyTypeId },
    missing: missing && { hp: missing.hp, meshes: missing.group.children.length }
  };
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  const warns = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
    if (m.type() === 'warning') warns.push(m.text());
  });

  let fails = 0;
  const ok = (name, cond, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    const r = await page.evaluate(PROBE, '/' + LEVEL);
    console.log('\n-- ' + JSON.stringify(r, null, 1) + '\n');

    ok('level with customEnemies loads', r.spawned > 0, `${r.spawned} enemies`);
    ok('CH-CUS-1 custom stat overrides applied', !!r.neon && r.neon.hp === 777 && r.neon.speed === 9,
      r.neon && `hp=${r.neon.hp} speed=${r.neon.speed}`);
    ok('CH-CUS-1 base stats survive the merge', !!r.neon && r.neon.damage === r.neon.baseDamage && r.neon.range > 0,
      r.neon && `damage=${r.neon.damage}`);
    ok('CH-CUS-2 look colour reaches the mesh', !!r.neon && r.neon.painted > 0, r.neon && `${r.neon.painted} meshes`);
    ok('CH-CUS-2 look scale applied', !!r.neon && Math.abs(r.neon.scale - 1.4) < 1e-3, r.neon && String(r.neon.scale));
    ok('CH-CUS-3 rig keeps its base thing id', !!r.neon && r.neon.typeId === 3001 && r.neon.customId === 'neon');
    ok('CH-CUS-3 humanoid rig still wired for the walk cycle', !!r.neon && r.neon.limbs);
    ok('CH-CUS-4 role registered with CyberAI', !!r.neon && r.neon.role === 'rusher', r.neon && r.neon.role);
    ok('CH-CUS-5 pack-level def honoured', !!r.tank && r.tank.hp === 555 && r.tank.typeId === 3002 && r.tank.painted > 0,
      r.tank && JSON.stringify(r.tank));
    ok('CH-CUS-5 level def beats the pack def', !!r.shared && r.shared.hp === 111, r.shared && `hp=${r.shared.hp}`);
    ok('CH-CUS-6 unknown custom id spawns a body, no crash', !!r.missing && r.missing.meshes > 0,
      r.missing && JSON.stringify(r.missing));
    ok('CH-CUS-6 unknown custom id warns', warns.some(w => w.indexOf('unknown custom enemy') >= 0),
      warns.filter(w => w.indexOf('custom') >= 0)[0] || 'no warning');
    ok('CH-CUS-7 no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

    await page.screenshot({ path: path.join(SHOTS, '_enemy_editor_ingame.png') });
  } finally {
    await browser.close();
    server.close();
  }

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
