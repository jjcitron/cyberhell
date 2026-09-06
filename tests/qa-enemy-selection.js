#!/usr/bin/env node
/**
 * CYBERHELL ENEMY EDITOR — SELECTION WIRING QA (real editor.html, headless)
 *
 * The eval graded "Use for selected" broken: selectedEntity() read
 * CyberEditor.selection as an entity object, but the shell's contract is
 * {kind, index}. This drives the real editor to prove the wiring:
 *
 *   CH-SEL-1  The Enemies panel mounts in editor.html and the buttons are
 *             disabled until there is both a saved def and an entity selected.
 *   CH-SEL-2  With CyberEditor.select('entity', 0), Save then Use for selected
 *             writes level.entities[0].enemyType = "custom:<id>".
 *   CH-SEL-3  Undo restores the entity's previous enemyType.
 *   CH-SEL-4  Place new loads the Entity tool with that custom type, and the
 *             tool's own type picker lists it (the shell's customEnemies()
 *             used to throw on the object map the panel writes).
 *   CH-SEL-5  The level the editor produced boots in index.html and spawns the
 *             custom enemy with its overridden hp.
 *   CH-SEL-6  Zero page errors.
 *
 * Own server, own port, own headless Chromium. Usage: node tests/qa-enemy-selection.js
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

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.mid': 'audio/midi',
  '.webmanifest': 'application/manifest+json'
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

const q = sel => document.querySelector(sel);
void q;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let fails = 0;
  const ok = (name, cond, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  try {
    // Native prompt/confirm must never reach the page — the shell has dialogs.
    await page.addInitScript(() => {
      window.__native = [];
      window.prompt = function () { window.__native.push('prompt'); return null; };
      window.confirm = function () { window.__native.push('confirm'); return false; };
    });
    await page.goto(`http://127.0.0.1:${PORT}/editor.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.CyberEditor && window.CyberEditor.openLevel), { timeout: 20000 });
    await page.evaluate(() => window.CyberEditor.openLevel('pack1', 'json1'));
    await page.waitForFunction(() => !!(window.CyberEditor.level && window.CyberEditor.level.entities), { timeout: 20000 });
    await page.evaluate(() => window.CyberEditor.showPanel && window.CyberEditor.showPanel('enemies'));
    await page.waitForFunction(() => !!document.querySelector('#ed-panel-enemies select'), { timeout: 20000 });

    const btn = label => `Array.prototype.slice.call(document.querySelectorAll('#ed-panel-enemies button')).filter(b => b.textContent === ${JSON.stringify(label)})[0]`;

    // CH-SEL-1 — nothing saved, nothing selected: both buttons off.
    const before = await page.evaluate(l => {
      const b = n => Array.prototype.slice.call(document.querySelectorAll('#ed-panel-enemies button'))
        .filter(x => x.textContent === n)[0];
      return {
        use: b('Use for selected').disabled, place: b('Place new').disabled,
        note: document.querySelector('#ed-panel-enemies .lbl').textContent,
        entities: window.CyberEditor.level.entities.length
      };
    });
    ok('CH-SEL-1 buttons disabled with no saved def', before.use && before.place, JSON.stringify(before));

    // Select entity 0 and author a def against the real shell.
    const firstEnemy = await page.evaluate(() => {
      const es = window.CyberEditor.level.entities;
      for (let i = 0; i < es.length; i++) if (es[i].enemyType !== undefined) return { i, type: es[i].enemyType };
      return null;
    });
    ok('level has an enemy entity to retarget', !!firstEnemy, JSON.stringify(firstEnemy));

    await page.evaluate(i => window.CyberEditor.select('entity', i), firstEnemy.i);
    await page.evaluate(() => {
      const p = document.querySelector('#ed-panel-enemies');
      const name = p.querySelector('input[type=text]');
      name.value = 'Selection Brute';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const col = p.querySelector('.slots input[type=color]');
      col.value = '#22ddaa';
      col.dispatchEvent(new Event('input', { bubbles: true }));
      const hp = p.querySelectorAll('.grid input[type=number]')[0]; // stats grid leads: hp first
      hp.value = '404';
      hp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(`${btn('Save to level')}.click()`);
    await page.waitForTimeout(200);

    const armed = await page.evaluate(() => {
      const b = n => Array.prototype.slice.call(document.querySelectorAll('#ed-panel-enemies button'))
        .filter(x => x.textContent === n)[0];
      return { use: b('Use for selected').disabled, place: b('Place new').disabled };
    });
    ok('CH-SEL-1 buttons arm once a def is saved and an entity selected', !armed.use && !armed.place, JSON.stringify(armed));

    await page.evaluate(`${btn('Use for selected')}.click()`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, '_enemy_editor_selection.png') });

    const after = await page.evaluate(i => {
      const ed = window.CyberEditor;
      const keys = Object.keys(ed.level.customEnemies || {});
      return {
        entType: ed.level.entities[i].enemyType,
        defs: keys,
        hp: keys.length ? ed.level.customEnemies[keys[0]].stats.hp : null,
        selNote: document.querySelectorAll('#ed-panel-enemies .lbl')[0].textContent
      };
    }, firstEnemy.i);
    console.log('-- after Use for selected: ' + JSON.stringify(after));
    ok('CH-SEL-2 entity enemyType set to the custom def',
      after.entType === 'custom:' + after.defs[0] && after.defs.length === 1, String(after.entType));
    ok('CH-SEL-2 stat edit persisted with the def', after.hp === 404, String(after.hp));
    ok('CH-SEL-2 panel reports the selected entity', after.selNote.indexOf('entity ' + firstEnemy.i) >= 0, after.selNote);

    // CH-SEL-3 — undo.
    await page.evaluate(() => window.CyberEditor.undoStack.undo());
    await page.waitForTimeout(150);
    const undone = await page.evaluate(i => window.CyberEditor.level.entities[i].enemyType, firstEnemy.i);
    ok('CH-SEL-3 undo restores the entity type', undone === firstEnemy.type, `${undone} (was ${firstEnemy.type})`);
    await page.evaluate(() => window.CyberEditor.undoStack.redo());
    await page.waitForTimeout(150);
    const redone = await page.evaluate(i => window.CyberEditor.level.entities[i].enemyType, firstEnemy.i);
    ok('CH-SEL-3 redo puts it back', String(redone).indexOf('custom:') === 0, String(redone));

    // CH-SEL-4 — Place new arms the Entity tool with this type.
    await page.evaluate(`${btn('Place new')}.click()`);
    await page.waitForTimeout(200);
    const placed = await page.evaluate(() => {
      const ed = window.CyberEditor;
      const opts = Array.prototype.slice.call(document.querySelectorAll('#ed-toolbar select option'));
      const picked = document.querySelector('#ed-toolbar select');
      return {
        tool: ed.activeTool && ed.activeTool.id,
        value: picked && picked.value,
        customOptions: opts.filter(o => o.value.indexOf('custom:') === 0).map(o => o.value),
        libraryList: ed.customEnemies().map(c => c.id)
      };
    });
    console.log('-- after Place new: ' + JSON.stringify(placed));
    ok('CH-SEL-4 Entity tool active', placed.tool === 'entity', String(placed.tool));
    ok('CH-SEL-4 picker preloaded with the custom type', placed.value === 'custom:' + after.defs[0], String(placed.value));
    ok('CH-SEL-4 shell customEnemies() reads the object map', placed.libraryList.join(',') === after.defs.join(','),
      JSON.stringify(placed.libraryList));

    // CH-SEL-7 — Export, Import and Delete go through CyberEditor.dialog.
    await page.evaluate(`${btn('Export')}.click()`);
    await page.waitForTimeout(150);
    const exported = await page.evaluate(() => {
      const d = document.querySelector('dialog.ed-dialog[open]');
      const v = d && d.querySelector('input[name=value]');
      const def = v ? JSON.parse(v.value) : null;
      if (d) d.close();
      return { open: !!d, id: def && def.id, hp: def && def.stats.hp };
    });
    ok('CH-SEL-7 Export opens the shell dialog with the def JSON',
      exported.open && exported.hp === 404, JSON.stringify(exported));

    await page.evaluate(`${btn('Import')}.click()`);
    await page.waitForTimeout(150);
    const imported = await page.evaluate(() => {
      const d = document.querySelector('dialog.ed-dialog[open]');
      if (!d) return { open: false };
      const v = d.querySelector('input[name=value]');
      v.value = JSON.stringify({ id: '', name: 'Imported One', base: 3001, stats: { hp: 55 }, role: 'caster' });
      d.querySelector('button.primary').click();
      return { open: true };
    });
    await page.waitForTimeout(200);
    const importedName = await page.evaluate(() =>
      document.querySelector('#ed-panel-enemies input[type=text]').value);
    ok('CH-SEL-7 Import reads the dialog value', imported.open && importedName === 'Imported One', importedName);

    // Import left an unsaved def loaded; go back to the saved one to delete it.
    await page.evaluate(() => {
      const sel = document.querySelector('#ed-panel-enemies select');
      sel.value = 'custom:selection-brute';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.evaluate(`${btn('Delete')}.click()`);
    await page.waitForTimeout(150);
    const deleting = await page.evaluate(() => {
      const d = document.querySelector('dialog.ed-dialog[open]');
      if (d) d.close();   // cancel: the def must survive
      return !!d;
    });
    await page.waitForTimeout(150);
    const stillThere = await page.evaluate(() => Object.keys(window.CyberEditor.level.customEnemies || {}).length);
    ok('CH-SEL-7 Delete confirms first and cancelling keeps the def', deleting && stillThere === 1,
      `dialog=${deleting} defs=${stillThere}`);

    const native = await page.evaluate(() => window.__native);
    ok('CH-SEL-7 no native prompt or confirm reached the page', native.length === 0, native.join(','));

    ok('CH-SEL-6 no page errors in the editor', errors.length === 0, errors.slice(0, 2).join(' | '));

    // CH-SEL-5 — the produced level boots in the game.
    const levelJson = await page.evaluate(() => JSON.stringify(window.CyberEditor.level));
    const gamePage = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const gameErrors = [];
    gamePage.on('pageerror', e => gameErrors.push(String(e)));
    gamePage.on('console', m => { if (m.type() === 'error') gameErrors.push('console: ' + m.text()); });
    await gamePage.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await gamePage.waitForFunction(() => !!(window.cyberEngine && window.cyberEngine.levelData), { timeout: 30000 });
    const spawned = await gamePage.evaluate(json => {
      const e = window.cyberEngine;
      e.loadLevel(JSON.parse(json));
      const id = Object.keys(e.levelData.customEnemies)[0];
      const rec = e.enemies.filter(x => x.enemyType === 'custom:' + id)[0];
      let tinted = 0;
      if (rec) rec.group.traverse(o => {
        if (!o.isMesh || !o.material) return;
        const c = o.material.color && o.material.color.getHexString();
        const em = o.material.emissive && o.material.emissive.getHexString();
        if (c === '22ddaa' || em === '22ddaa') tinted++;
      });
      return rec ? { hp: rec.hp, typeId: rec.group.userData.enemyTypeId, customId: rec.group.userData.customEnemyId, tinted } : null;
    }, levelJson);
    console.log('-- in game: ' + JSON.stringify(spawned));
    ok('CH-SEL-5 the edited level spawns the custom enemy at its edited hp',
      !!spawned && spawned.hp === 404 && spawned.customId === after.defs[0], JSON.stringify(spawned));
    ok('CH-SEL-6 no page errors in the game', gameErrors.length === 0, gameErrors.slice(0, 2).join(' | '));
    await gamePage.close();

    /* ---- pack enemy library -------------------------------------------- */
    // CH-PACK-1  Save to pack persists through storage.saveEnemy.
    await page.evaluate(`${btn('Save to pack')}.click()`);
    await page.waitForTimeout(400);
    const packSaved = await page.evaluate(async () => {
      const ed = window.CyberEditor;
      const rows = await ed.storage.listEnemies(ed.packId);
      return {
        packId: ed.packId,
        stored: rows.map(r => r.id),
        live: Object.keys(ed.pack.customEnemies || {}),
        fromPack: !!(ed.pack.customEnemies || {})[rows[0] && rows[0].id] &&
          ed.pack.customEnemies[rows[0].id].fromPack === true
      };
    });
    console.log('-- pack library: ' + JSON.stringify(packSaved));
    ok('CH-PACK-1 Save to pack writes storage.listEnemies',
      packSaved.stored.length === 1 && packSaved.stored[0] === 'selection-brute', JSON.stringify(packSaved.stored));
    ok('CH-PACK-1 the live pack carries it, marked fromPack',
      packSaved.live.indexOf('selection-brute') >= 0 && packSaved.fromPack, JSON.stringify(packSaved.live));

    // CH-PACK-2  A different level in the same pack sees it.
    const second = await page.evaluate(async () => {
      const ed = window.CyberEditor;
      const pack = await ed.storage.getPack('pack1');
      const other = pack.levels[1];
      await ed.openLevel('pack1', other.id);
      const groups = Array.prototype.slice.call(document.querySelectorAll('#ed-panel-enemies optgroup'))
        .map(g => g.label + ':' + Array.prototype.slice.call(g.children).map(o => o.value).join('|'));
      return {
        levelId: other.id,
        levelDefs: Object.keys(ed.level.customEnemies || {}),
        packDefs: Object.keys(ed.pack.customEnemies || {}),
        groups: groups.filter(g => g.indexOf('Base types') !== 0)
      };
    });
    console.log('-- second level: ' + JSON.stringify(second));
    ok('CH-PACK-2 opening another level hydrates the pack library from storage',
      second.packDefs.indexOf('selection-brute') >= 0 && second.levelDefs.length === 0,
      JSON.stringify(second.packDefs) + ' level=' + JSON.stringify(second.levelDefs));
    ok('CH-PACK-2 the panel lists it under Pack library',
      second.groups.some(g => g.indexOf('Pack library:custom:selection-brute') === 0), JSON.stringify(second.groups));

    // CH-PACK-3  Use it on an entity in this second level, then Test in game.
    const target = await page.evaluate(() => {
      const es = window.CyberEditor.level.entities;
      for (let i = 0; i < es.length; i++) if (es[i].enemyType !== undefined) return i;
      return -1;
    });
    await page.evaluate(i => window.CyberEditor.select('entity', i), target);
    await page.evaluate(() => {
      const sel = document.querySelector('#ed-panel-enemies select');
      sel.value = 'custom:selection-brute';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await page.evaluate(`${btn('Use for selected')}.click()`);
    await page.waitForTimeout(200);

    const draft = await page.evaluate(async () => {
      const ed = window.CyberEditor;
      const lv = ed.levelForGame();
      var sent = await ed.testInGame().catch(function (e) { return 'failed: ' + e.message; });
      return {
        entType: ed.level.entities.filter(e => e.enemyType === 'custom:selection-brute').length,
        inLevel: Object.keys(ed.level.customEnemies || {}).length,
        inDraft: Object.keys(lv.customEnemies || {}),
        draftHp: lv.customEnemies['selection-brute'].stats.hp,
        draftFromPack: lv.customEnemies['selection-brute'].fromPack === true,
        sent: sent
      };
    });
    console.log('-- draft: ' + JSON.stringify(draft));
    ok('CH-PACK-3 the entity uses the pack def', draft.entType === 1, String(draft.entType));
    ok('CH-PACK-3 the level itself stays clean of the pack def', draft.inLevel === 0, String(draft.inLevel));
    ok('CH-PACK-3 testInGame wrote the draft', draft.sent === true, String(draft.sent));
    ok('CH-PACK-3 the draft carries the pack def, marked',
      draft.inDraft.indexOf('selection-brute') >= 0 && draft.draftHp === 404 && draft.draftFromPack,
      JSON.stringify(draft.inDraft));

    // CH-PACK-4  The draft actually boots and spawns it.
    // The draft handoff is IndexedDB, which is per browser context, so the
    // game has to boot in the editor's own context — reuse its page.
    const errorsBefore = errors.length;
    const draftPage = page;
    await draftPage.goto(`http://127.0.0.1:${PORT}/index.html?draft=1`, { waitUntil: 'load' });
    await draftPage.waitForFunction(() => !!(window.cyberEngine && window.cyberEngine.levelData), { timeout: 30000 });
    const inGame = await draftPage.waitForFunction(() => {
      const e = window.cyberEngine;
      if (!e.enemies || !e.enemies.length) return false;
      const rec = e.enemies.filter(x => x.enemyType === 'custom:selection-brute')[0];
      return rec ? { hp: rec.hp, typeId: rec.group.userData.enemyTypeId, customId: rec.group.userData.customEnemyId } : false;
    }, null, { timeout: 20000 }).then(h => h.jsonValue()).catch(() => null);
    const draftState = await draftPage.evaluate(() => {
      const e = window.cyberEngine;
      const ents = (e.levelData.entities || []).filter(x => typeof x.enemyType === 'string');
      return {
        name: e.levelData.name,
        customKeys: Object.keys(e.levelData.customEnemies || {}),
        customEnts: ents.length,
        enemies: (e.enemies || []).length,
        types: Array.from(new Set((e.enemies || []).map(x => x.enemyType))).slice(0, 6)
      };
    });
    console.log('-- draft page state: ' + JSON.stringify(draftState));
    console.log('-- draft in game: ' + JSON.stringify(inGame));
    ok('CH-PACK-4 Test in game spawns the pack enemy at its pack stats',
      !!inGame && inGame.hp === 404 && inGame.customId === 'selection-brute', JSON.stringify(inGame));
    const draftErrors = errors.slice(errorsBefore);
    ok('CH-PACK-4 no page errors on the draft boot', draftErrors.length === 0, draftErrors.slice(0, 2).join(' | '));
    await draftPage.screenshot({ path: path.join(SHOTS, '_enemy_editor_packdraft.png') });

  } finally {
    await browser.close();
    server.close();
  }

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
