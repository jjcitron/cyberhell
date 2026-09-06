/* ===========================================================================
   app.js — the editor shell and the window.CyberEditor contract.

   Every other lane (preview-3d, enemy-editor, midi-composer, validation-qa,
   cloud-api) talks to the editor only through this object:

     level, pack, selection
     on/off('level-loaded'|'level-changed'|'selection-changed'|'pack-changed')
     apply(mutator, label), select(kind, index)
     registerPanel({id,title,side,mount}) -> element
     registerTool({id,title,key,onActivate,onPointerDown,...})
     registerMenu({id,title,items:[{label,onClick}]})
     storage, worldToScreen, screenToWorld, requestRedraw, toast

   This file runs at the bottom of editor.html, so later lane scripts find a
   fully built CyberEditor. Nothing here assumes any lane exists.
   =========================================================================== */
(function () {
  'use strict';

  var LAST_KEY = 'cyberhell.editor.lastLevel';

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  var ed = {
    level: null,
    pack: null,
    packId: null,
    levelId: null,
    selection: { kind: null, index: -1 },
    multi: [],
    lastSector: -1,
    dirty: false,
    tools: [],
    activeTool: null,
    _panels: [],
    _bottomPanels: [],
    _events: {}
  };

  /* ---- events ----------------------------------------------------------- */

  ed.on = function (evt, fn) { (ed._events[evt] || (ed._events[evt] = [])).push(fn); return fn; };
  ed.off = function (evt, fn) {
    var l = ed._events[evt];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  ed.emit = function (evt, payload) {
    (ed._events[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[editor] ' + evt + ' handler failed', err); }
    });
  };

  /* ---- undo-backed mutation --------------------------------------------- */

  var undo = new window.EdUndoStack({
    get: function () { return ed.level; },
    set: function (lv) { ed.level = lv; },
    onChange: function () { ed._syncUndoButtons(); }
  });
  ed.undoStack = undo;

  ed.apply = function (mutator, label) {
    if (!ed.level) return false;
    var ok = undo.apply(mutator, label);
    if (!ok) return false;
    ed.dirty = true;
    ed.requestRedraw();
    ed.emit('level-changed', { reason: label || 'edit' });
    ed._status();
    return true;
  };

  ed.select = function (kind, index) {
    ed.selection = { kind: kind || null, index: index == null ? -1 : index };
    if (kind === 'sector') ed.lastSector = index;
    ed.requestRedraw();
    ed.emit('selection-changed', ed.selection);
    ed._status();
  };

  ed.toggleMulti = function (kind, index) {
    for (var i = 0; i < ed.multi.length; i++) {
      if (ed.multi[i].kind === kind && ed.multi[i].index === index) { ed.multi.splice(i, 1); ed.requestRedraw(); return; }
    }
    ed.multi.push({ kind: kind, index: index });
    ed.select(kind, index);
  };

  /* customEnemies is stored the way the engine reads it: an object map
     { id: def } on the level and on the pack, level winning. It was read here
     as an array, which threw on the object the enemy editor actually writes
     and left the Entity tool with no custom types to place. Arrays are still
     accepted so an older hand-written level keeps loading. */
  ed.customEnemies = function () {
    var byId = {};
    [(ed.pack && ed.pack.customEnemies), (ed.level && ed.level.customEnemies)].forEach(function (t) {
      if (!t) return;
      if (t.length !== undefined && typeof t.slice === 'function') {
        t.forEach(function (d) { if (d && d.id) byId[d.id] = d; });
        return;
      }
      Object.keys(t).forEach(function (k) {
        var d = t[k];
        if (!d) return;
        if (d.id) { byId[d.id] = d; return; }
        var copy = { id: k };
        Object.keys(d).forEach(function (f) { copy[f] = d[f]; });
        byId[k] = copy;
      });
    });
    return Object.keys(byId).map(function (k) { return byId[k]; });
  };

  /* ---- toasts ----------------------------------------------------------- */

  ed.toast = function (msg, kind) {
    var host = document.getElementById('ed-toasts');
    if (!host) return;
    var t = el('div', { class: 'ed-toast' + (kind ? ' ' + kind : '') }, msg);
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 5200 : 2600);
  };

  /* ---- panels / tools / menus ------------------------------------------- */

  ed.registerPanel = function (spec) {
    var bottom = spec.side === 'bottom';
    var tabs = document.getElementById(bottom ? 'ed-drawer-tabs' : 'ed-tabs');
    var panels = document.getElementById(bottom ? 'ed-drawer-panels' : 'ed-panels');
    // The outer .ed-panel is the shell's; the inner element is the lane's to do
    // whatever it likes with. Lanes have overwritten className and set inline
    // display on what they were handed, which used to leak their UI through
    // every other tab -- owning the wrapper makes tab visibility unbreakable.
    var shell = el('div', { class: 'ed-panel', id: 'ed-panel-' + spec.id });
    var body = el('div');
    shell.appendChild(body);
    var tab = el('button', { 'data-panel': spec.id }, spec.title);
    tab.addEventListener('click', function () { ed.showPanel(spec.id); });
    tabs.appendChild(tab);
    panels.appendChild(shell);
    if (bottom) {
      document.getElementById('ed-drawer').hidden = false;
      ed._bottomPanels.push(spec.id);
      if (ed._bottomPanels.length === 1) ed.showPanel(spec.id);
      if (ed.map) ed.map.resize();
    } else {
      ed._panels.push(spec.id);
      if (ed._panels.length === 1) ed.showPanel(spec.id);
    }
    if (spec.mount) { try { spec.mount(body); } catch (err) { console.error('[editor] panel mount failed: ' + spec.id, err); } }
    return body;
  };

  /* Side and bottom are independent tab groups: showing one never hides the
     other, and a panel is only ever visible in the group it was registered in. */
  ed.showPanel = function (id) {
    var group = ed._bottomPanels.indexOf(id) >= 0 ? 'bottom' : 'side';
    var tabSel = group === 'bottom' ? '#ed-drawer-tabs button' : '#ed-tabs button';
    var panelSel = group === 'bottom' ? '#ed-drawer-panels .ed-panel' : '#ed-panels .ed-panel';
    Array.prototype.forEach.call(document.querySelectorAll(tabSel), function (b) {
      b.classList.toggle('active', b.getAttribute('data-panel') === id);
    });
    Array.prototype.forEach.call(document.querySelectorAll(panelSel), function (p) {
      p.classList.toggle('active', p.id === 'ed-panel-' + id);
    });
  };

  ed.registerTool = function (spec) {
    ed.tools.push(spec);
    var strip = document.getElementById('ed-tools');
    var b = el('button', { title: spec.title + (spec.key ? ' (' + spec.key + ')' : '') });
    b.appendChild(el('b', null, spec.glyph || spec.title.charAt(0)));
    b.appendChild(el('span', null, spec.title.slice(0, 6)));
    b.addEventListener('click', function () { ed.setTool(spec.id); });
    spec._button = b;
    strip.appendChild(b);
    if (ed.tools.length === 1) ed.setTool(spec.id);
    return spec;
  };

  ed.setTool = function (id) {
    var next = ed.tools.filter(function (t) { return t.id === id; })[0];
    if (!next || next === ed.activeTool) return;
    if (ed.activeTool && ed.activeTool.onDeactivate) ed.activeTool.onDeactivate();
    ed.activeTool = next;
    ed.tools.forEach(function (t) { if (t._button) t._button.classList.toggle('active', t === next); });
    var bar = document.getElementById('ed-toolbar');
    bar.innerHTML = '';
    if (next.options) next.options(bar);
    bar.style.display = bar.childNodes.length ? 'flex' : 'none';
    if (next.onActivate) next.onActivate();
    ed.requestRedraw();
    ed._status();
  };

  ed.registerMenu = function (spec) {
    var bar = document.getElementById('ed-menubar');
    var wrap = el('div', { class: 'ed-menu', id: 'ed-menu-' + spec.id });
    var btn = el('button', null, spec.title);
    var items = el('div', { class: 'ed-menu-items' });
    (spec.items || []).forEach(function (it) {
      var b = el('button', null, it.label);
      b.addEventListener('click', function () {
        wrap.classList.remove('open');
        try { it.onClick(); } catch (err) { ed.toast(err.message, 'bad'); console.error(err); }
      });
      if (it.id) b.id = 'ed-mi-' + it.id;
      items.appendChild(b);
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = wrap.classList.contains('open');
      Array.prototype.forEach.call(document.querySelectorAll('.ed-menu'), function (m) { m.classList.remove('open'); });
      wrap.classList.toggle('open', !open);
    });
    wrap.appendChild(btn);
    wrap.appendChild(items);
    bar.insertBefore(wrap, document.getElementById('ed-menu-anchor'));
    return wrap;
  };

  /* ---- level lifecycle --------------------------------------------------- */

  ed.setLevel = function (level, packId, levelId, pack) {
    ed.level = level;
    ed.packId = packId || null;
    ed.levelId = levelId || null;
    ed.pack = pack || null;
    ed.selection = { kind: null, index: -1 };
    ed.multi = [];
    ed.lastSector = -1;
    ed.dirty = false;
    undo.reset();
    if (ed.map) ed.map.fit(level);
    ed.emit('level-loaded', { level: level, packId: packId, levelId: levelId });
    ed.emit('pack-changed', { pack: pack });
    ed.requestRedraw();
    ed._status();
  };

  ed.openLevel = function (packId, levelId) {
    return ed.storage.getPack(packId).then(function (pack) {
      return ed.storage.loadLevel(packId, levelId).then(function (json) {
        ed.setLevel(json, packId, levelId, pack);
        try { localStorage.setItem(LAST_KEY, JSON.stringify({ packId: packId, levelId: levelId })); } catch (err) {}
        ed.toast('opened ' + (json.name || levelId), 'ok');
        return json;
      });
    }).catch(function (err) {
      ed.toast('open failed: ' + err.message, 'bad');
      throw err;
    });
  };

  ed.saveLevel = function () {
    if (!ed.level) { ed.toast('no level open', 'bad'); return Promise.resolve(null); }
    if (!ed.packId || !ed.levelId) return ed.saveLevelAs();
    return ed.storage.saveLevel(ed.packId, ed.levelId, ed.level, { note: 'editor save' })
      .then(function (r) { ed.dirty = false; ed.toast('saved', 'ok'); ed._status(); ed.emit('pack-changed', {}); return r; })
      .catch(function (err) { ed.toast(err.message, 'bad'); return null; });
  };

  /* Save as lands in any writable pack — canonical ones stay the reference.
     Filtering on "not canonical" rather than listing backends means a new
     backend (cloud, and whatever comes after) needs no change here; the
     adapter dispatches on the pack's source and fails loudly if it cannot
     write. */
  ed.saveLevelAs = function () {
    if (!ed.level) { ed.toast('no level open', 'bad'); return Promise.resolve(null); }
    var name = prompt('Save level as', (ed.level.name || 'Level') + ' (edit)');
    if (!name) return Promise.resolve(null);
    return ed.storage.listPacks().then(function (packs) {
      var writable = packs.filter(function (p) { return p.source !== 'canonical'; });
      var target;
      if (!writable.length) {
        target = ed.storage.createPack('My Pack').then(function (r) { return r.id; });
      } else if (ed.packId && writable.some(function (p) { return p.id === ed.packId; })) {
        target = Promise.resolve(ed.packId);
      } else {
        var listed = writable.map(function (p, i) { return (i + 1) + ') ' + p.name; }).join('\n');
        var pickIdx = prompt('Save into which pack?\n' + listed + '\n(or leave blank for a new pack)', '1');
        if (pickIdx === null) return null;
        var n = parseInt(pickIdx, 10);
        target = (n >= 1 && n <= writable.length)
          ? Promise.resolve(writable[n - 1].id)
          : ed.storage.createPack('My Pack').then(function (r) { return r.id; });
      }
      return Promise.resolve(target).then(function (packId) {
        if (!packId) return null;
        return ed.storage.saveLevelAs(packId, name, ed.level).then(function (r) {
          return ed.openLevel(packId, r.levelId).then(function () {
            ed.toast('saved as ' + name, 'ok');
            return r;
          });
        });
      });
    }).catch(function (err) { ed.toast(err.message, 'bad'); return null; });
  };

  ed.saveIntoRepo = function (packId) {
    return ed.storage.saveIntoRepo(packId || ed.packId)
      .then(function (r) { ed.toast('wrote ' + r.files + ' files', 'ok'); return r; })
      .catch(function (err) { ed.toast(err.message, 'bad'); return null; });
  };

  ed.newLevel = function () {
    var name = prompt('Level name (keep the MAP## / E#M# token for music)', 'New Level (MAP01)');
    if (!name) return;
    ed.setLevel(window.EdModel.blankLevel(name), null, null, null);
    ed.toast('new level');
  };

  ed.importLevel = function () {
    var input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', function () {
      var f = input.files[0];
      if (!f) return;
      ed.storage.importLevelFile(f).then(function (json) {
        ed.setLevel(json, null, null, null);
        ed.toast('imported ' + f.name, 'ok');
      }).catch(function (err) { ed.toast('import failed: ' + err.message, 'bad'); });
    });
    input.click();
  };

  /* ---- view helpers exposed on the contract ------------------------------ */

  ed.worldToScreen = function (x, z) { return ed.map.worldToScreen(x, z); };
  ed.screenToWorld = function (px, py) { return ed.map.screenToWorld(px, py); };
  ed.requestRedraw = function () { if (ed.map) ed.map.requestRedraw(); };

  /* ---- status bar -------------------------------------------------------- */

  ed._status = function () {
    var s = document.getElementById('ed-status');
    if (!s) return;
    var lv = ed.level;
    var sel = ed.selection && ed.selection.kind
      ? ed.selection.kind + ' ' + ed.selection.index + (ed.multi.length > 1 ? ' (+' + (ed.multi.length - 1) + ')' : '')
      : '—';
    var m = ed.map ? ed.map.mouseWorld : { x: 0, z: 0 };
    s.innerHTML = '';
    function stat(label, value) {
      var d = el('span', { class: 'ed-stat' });
      d.appendChild(document.createTextNode(label + ' '));
      d.appendChild(el('b', null, value));
      s.appendChild(d);
    }
    stat('level', (lv && lv.name) || 'none');
    stat('tool', ed.activeTool ? ed.activeTool.title : '—');
    stat('sel', sel);
    stat('x,z', m.x.toFixed(1) + ', ' + m.z.toFixed(1));
    stat('grid', ed.map ? (ed.map.snap ? ed.map.grid : 'off') : '—');
    stat('zoom', ed.map ? ed.map.view.scale.toFixed(1) : '—');
    s.appendChild(el('span', { class: 'ed-spacer' }));
    if (ed.dirty) {
      var d = el('span', { class: 'ed-stat' }, 'UNSAVED');
      d.style.color = '#ff6600';
      s.appendChild(d);
    }
  };

  ed._syncUndoButtons = function () {
    var u = document.getElementById('ed-mi-undo'), r = document.getElementById('ed-mi-redo');
    if (u) u.textContent = undo.canUndo() ? 'Undo — ' + undo.undoLabel() : 'Undo';
    if (r) r.textContent = undo.canRedo() ? 'Redo — ' + undo.redoLabel() : 'Redo';
  };

  ed.undo = function () {
    var label = undo.undo();
    if (!label) { ed.toast('nothing to undo'); return; }
    ed.dirty = true;
    ed.selection = { kind: null, index: -1 };
    ed.multi = [];
    ed.requestRedraw();
    ed.emit('level-changed', { reason: 'undo:' + label });
    ed.emit('selection-changed', ed.selection);
    ed.toast('undo ' + label);
    ed._status();
  };

  ed.redo = function () {
    var label = undo.redo();
    if (!label) { ed.toast('nothing to redo'); return; }
    ed.dirty = true;
    ed.requestRedraw();
    ed.emit('level-changed', { reason: 'redo:' + label });
    ed.toast('redo ' + label);
    ed._status();
  };

  ed.deleteSelection = function () {
    var sel = ed.selection;
    if (!ed.level || !sel || !sel.kind) return;
    if (sel.kind === 'wall') ed.apply(function (l) { window.EdModel.removeWall(l, sel.index); }, 'delete wall');
    else if (sel.kind === 'sector') ed.apply(function (l) { window.EdModel.removeSector(l, sel.index); }, 'delete sector');
    else if (sel.kind === 'entity') ed.apply(function (l) { l.entities.splice(sel.index, 1); }, 'delete entity');
    else if (sel.kind === 'trigger') ed.apply(function (l) { window.EdModel.removeTrigger(l, sel.index); }, 'delete trigger');
    else return;
    ed.select(null, -1);
  };

  /* ---- boot -------------------------------------------------------------- */

  function boot() {
    ed.storage = new window.EdStorageLocal();
    ed.map = new window.EdMap2D(document.getElementById('ed-canvas'), ed);

    ed.registerMenu({
      id: 'file', title: 'File', items: [
        { label: 'New level', onClick: function () { ed.newLevel(); } },
        { label: 'New pack', onClick: function () {
            var n = prompt('Pack name', 'My Pack');
            if (n) ed.storage.createPack(n).then(function () { ed.toast('pack created', 'ok'); ed.emit('pack-changed', {}); });
          } },
        { label: 'Open…', onClick: function () { ed.showPanel('packs'); } },
        { label: 'Save', onClick: function () { ed.saveLevel(); } },
        { label: 'Save as…', onClick: function () { ed.saveLevelAs(); } },
        { label: 'Export JSON', onClick: function () {
            if (!ed.level) { ed.toast('no level open', 'bad'); return; }
            ed.storage.exportLevel(ed.level).then(function (n) { ed.toast('exported ' + n, 'ok'); });
          } },
        { label: 'Import JSON…', onClick: function () { ed.importLevel(); } },
        { label: 'Save into repo…', onClick: function () {
            if (!ed.packId) { ed.toast('open a local pack first', 'bad'); return; }
            ed.saveIntoRepo(ed.packId);
          } }
      ]
    });

    ed.registerMenu({
      id: 'edit', title: 'Edit', items: [
        { id: 'undo', label: 'Undo', onClick: function () { ed.undo(); } },
        { id: 'redo', label: 'Redo', onClick: function () { ed.redo(); } },
        { label: 'Delete selection', onClick: function () { ed.deleteSelection(); } }
      ]
    });

    ed.registerMenu({
      id: 'view', title: 'View', items: [
        { label: 'Fit level', onClick: function () { ed.map.fit(ed.level); } },
        { label: 'Toggle grid', onClick: function () { ed.map.show.grid = !ed.map.show.grid; ed.requestRedraw(); } },
        { label: 'Toggle snap', onClick: function () { ed.map.snap = !ed.map.snap; ed._status(); } },
        { label: 'Grid ×2', onClick: function () { ed.map.grid *= 2; ed.requestRedraw(); ed._status(); } },
        { label: 'Grid ÷2', onClick: function () { ed.map.grid /= 2; ed.requestRedraw(); ed._status(); } },
        { label: 'Toggle sectors', onClick: function () { ed.map.show.sectors = !ed.map.show.sectors; ed.requestRedraw(); } },
        { label: 'Toggle walls', onClick: function () { ed.map.show.walls = !ed.map.show.walls; ed.requestRedraw(); } },
        { label: 'Toggle entities', onClick: function () { ed.map.show.entities = !ed.map.show.entities; ed.requestRedraw(); } },
        { label: 'Toggle triggers', onClick: function () { ed.map.show.triggers = !ed.map.show.triggers; ed.requestRedraw(); } }
      ]
    });

    window.EdTools.install(ed);
    window.EdPanels.install(ed);
    window.EdBridge.install(ed);

    document.getElementById('ed-test-btn').addEventListener('click', function () { ed.testInGame(); });
    document.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.ed-menu'), function (m) { m.classList.remove('open'); });
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { ed.map.spaceDown = true; e.preventDefault(); return; }
      if (ed.activeTool && ed.activeTool.onKey && ed.activeTool.onKey(e.key)) { e.preventDefault(); return; }
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); ed.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); e.shiftKey ? ed.saveLevelAs() : ed.saveLevel(); return; }
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // A hovered sector vertex wins over deleting the whole sector.
        if (ed.deleteVertexUnderCursor && ed.deleteVertexUnderCursor()) return;
        ed.deleteSelection();
        return;
      }
      if (e.key === 'f') { ed.map.fit(ed.level); return; }
      if (e.key === 'g') { ed.map.snap = !ed.map.snap; ed._status(); return; }
      var byKey = ed.tools.filter(function (tool) { return tool.key === e.key; })[0];
      if (byKey) ed.setTool(byKey.id);
    });
    document.addEventListener('keyup', function (e) { if (e.code === 'Space') ed.map.spaceDown = false; });

    window.addEventListener('beforeunload', function (e) {
      if (!ed.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    var drawerToggle = document.getElementById('ed-drawer-toggle');
    if (drawerToggle) drawerToggle.addEventListener('click', function () {
      var d = document.getElementById('ed-drawer');
      d.classList.toggle('collapsed');
      drawerToggle.textContent = d.classList.contains('collapsed') ? '▴' : '▾';
      ed.map.resize();
    });

    ed._syncUndoButtons();
    ed._status();
    ed.requestRedraw();

    // Open something rather than showing an empty canvas: last level if there
    // is one, else pack1 level 1. Failure is not fatal, the editor still boots.
    ed.showPanel('packs');
    var last = null;
    try { last = JSON.parse(localStorage.getItem(LAST_KEY)); } catch (err) {}
    var target = (last && last.packId && last.levelId) ? last : { packId: 'pack1', levelId: 'json1' };
    ed.openLevel(target.packId, target.levelId).catch(function () {
      if (target.packId !== 'pack1') return ed.openLevel('pack1', 'json1').catch(function () {});
    });
  }

  window.CyberEditor = ed;
  boot();
})();
