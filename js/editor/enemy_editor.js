/* ===========================================================================
   enemy_editor.js — the editor's Enemies panel.

   Classic script, no build step. Waits for the editor shell (window.CyberEditor)
   and registers one panel that edits custom enemy definitions:

     { id, name, base, stats:{hp,speed,attack,range,cooldown,damage,scale,fly},
       look:{colors:{slot:hex}, parts:{slot:bool}, scale, emissive},
       role:'rusher'|'skirmisher'|'caster'|'bruiser' }

   Definitions are stored on the level as `customEnemies[id]` (through
   CyberEditor.apply so undo works) and referenced by entities as
   enemyType "custom:<id>". The look slots come from
   CyberEnemies.getDefaultLook(baseId) — one slot per distinct material colour
   in that base's rig.

   The preview runs its own small WebGLRenderer on a turntable and drives the
   rig through CyberEnemies.animate, so a look change shows immediately.
   =========================================================================== */
(function () {
  'use strict';

  var ROLES = ['rusher', 'skirmisher', 'caster', 'bruiser'];
  var ATTACKS = ['hitscan', 'fireball', 'melee', 'laser'];
  var STAT_FIELDS = [
    { k: 'hp', label: 'HP', min: 1, max: 2000, step: 1 },
    { k: 'speed', label: 'Speed', min: 0, max: 12, step: 0.1 },
    { k: 'range', label: 'Range', min: 1, max: 60, step: 0.5 },
    { k: 'cooldown', label: 'Cooldown', min: 0.1, max: 6, step: 0.05 },
    { k: 'damage', label: 'Damage', min: 0, max: 100, step: 1 },
    { k: 'scale', label: 'Scale', min: 0.25, max: 3, step: 0.05 }
  ];

  var CSS = [
    '.ee{font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#cfe;padding:8px;display:flex;flex-direction:column;gap:8px}',
    '.ee h4{margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7ad}',
    '.ee select,.ee input[type=text],.ee input[type=number]{background:#0d1218;color:#cfe;border:1px solid #2a3a4a;border-radius:2px;padding:3px 4px;font:inherit;width:100%;box-sizing:border-box}',
    '.ee input[type=range]{width:100%}',
    '.ee button{background:#16222e;color:#cfe;border:1px solid #2a3a4a;border-radius:2px;padding:4px 7px;font:inherit;cursor:pointer}',
    '.ee button:hover{background:#1e3040;border-color:#4a6a8a}',
    '.ee button.pri{background:#1c3a2a;border-color:#2f6a48}',
    '.ee .row{display:flex;gap:4px;flex-wrap:wrap}',
    '.ee .row>*{flex:1 1 auto}',
    '.ee .grid{display:grid;grid-template-columns:64px 1fr 58px;gap:3px 6px;align-items:center}',
    '.ee .lbl{color:#8ab;font-size:11px}',
    '.ee .slots{display:grid;grid-template-columns:1fr auto auto;gap:3px 6px;align-items:center;max-height:190px;overflow:auto;padding-right:2px}',
    '.ee canvas{width:100%;display:block;background:#07090c;border:1px solid #223;border-radius:2px}',
    '.ee fieldset{border:1px solid #223;border-radius:2px;margin:0;padding:6px}',
    '.ee legend{color:#7ad;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:0 4px}'
  ].join('\n');

  // ---------------------------------------------------------------- helpers
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  }
  function hex6(n) { return '#' + ('000000' + (Number(n) >>> 0).toString(16)).slice(-6); }
  function fromHex(s) { return parseInt(String(s).replace('#', ''), 16) || 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function slug(s) {
    return String(s || 'enemy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'enemy';
  }

  function toast(msg) {
    var ed = window.CyberEditor;
    if (ed && typeof ed.toast === 'function') ed.toast(msg);
    else if (typeof console !== 'undefined') console.log('[enemy-editor]', msg);
  }

  /** CyberEditor.selection is {kind, index} into the level, never an object. */
  function selectedEntity() {
    var ed = window.CyberEditor;
    var sel = ed && ed.selection;
    if (!ed || !ed.level || !sel || sel.kind !== 'entity') return null;
    return (ed.level.entities || [])[sel.index] || null;
  }

  /** Split the two libraries. A level def and a pack def can share an id; the
      level's wins, which is also how the engine resolves it. Defs the editor
      baked into a saved level (fromPack) belong to the pack, not the level. */
  function tables() {
    var ed = window.CyberEditor;
    var level = {}, pack = {}, k;
    var raw = (ed && ed.level && ed.level.customEnemies) || {};
    for (k in raw) {
      if (!raw[k]) continue;
      if (raw[k].fromPack) pack[k] = raw[k]; else level[k] = raw[k];
    }
    var live = (ed && ed.pack && ed.pack.customEnemies) || {};
    for (k in live) pack[k] = live[k];       // the pack store beats a baked copy
    return { level: level, pack: pack };
  }

  /** Pack defs first, level defs on top — the same order the engine uses. */
  function customTable() {
    var t = tables(), out = {}, k;
    for (k in t.pack) out[k] = t.pack[k];
    for (k in t.level) out[k] = t.level[k];
    return out;
  }

  // ------------------------------------------------------------- the panel
  function Panel(root) {
    var self = this;
    this.root = root;
    this.def = null;          // definition being edited
    this.baseLook = null;     // default look of the current base
    this.dirty = true;        // preview needs a rebuild
    this.build();
    var ed = window.CyberEditor;
    if (ed && typeof ed.on === 'function') {
      ed.on('level-loaded', function () { self.refreshList(); self.syncSelection(); });
      ed.on('level-changed', function () { self.refreshList(true); self.syncSelection(); });
      ed.on('selection-changed', function () { self.syncSelection(); });
    }
    this.selectType(this.pick.value);
    this.syncSelection();
  }

  Panel.prototype.build = function () {
    var self = this, r = this.root;
    r.className = 'ee';
    if (!document.getElementById('ee-css')) {
      var st = el('style');
      st.id = 'ee-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    this.pick = el('select');
    r.appendChild(this.pick);
    this.pick.addEventListener('change', function () { self.selectType(self.pick.value); });

    var row1 = el('div', 'row');
    this.btnNew = el('button', null, 'New from base');
    this.btnUse = el('button', null, 'Use for selected');
    this.btnPlace = el('button', null, 'Place new');
    row1.appendChild(this.btnNew);
    row1.appendChild(this.btnUse);
    row1.appendChild(this.btnPlace);
    r.appendChild(row1);
    this.selNote = el('div', 'lbl', '');
    r.appendChild(this.selNote);

    this.canvas = el('canvas');
    this.canvas.width = 280;
    this.canvas.height = 210;
    r.appendChild(this.canvas);

    var idf = el('fieldset');
    idf.appendChild(el('legend', null, 'Identity'));
    var g0 = el('div', 'grid');
    this.fName = el('input');
    this.fName.type = 'text';
    this.fRole = el('select');
    ROLES.forEach(function (x) { var o = el('option', null, x); o.value = x; self.fRole.appendChild(o); });
    this.fAttack = el('select');
    ATTACKS.forEach(function (x) { var o = el('option', null, x); o.value = x; self.fAttack.appendChild(o); });
    this.fFly = el('input');
    this.fFly.type = 'checkbox';
    g0.appendChild(el('span', 'lbl', 'Name')); g0.appendChild(this.fName); g0.appendChild(el('span'));
    g0.appendChild(el('span', 'lbl', 'Role')); g0.appendChild(this.fRole); g0.appendChild(el('span'));
    g0.appendChild(el('span', 'lbl', 'Attack')); g0.appendChild(this.fAttack); g0.appendChild(el('span'));
    g0.appendChild(el('span', 'lbl', 'Flies')); g0.appendChild(this.fFly); g0.appendChild(el('span'));
    idf.appendChild(g0);
    r.appendChild(idf);

    var sf = el('fieldset');
    sf.appendChild(el('legend', null, 'Stats'));
    this.statGrid = el('div', 'grid');
    this.stat = {};
    STAT_FIELDS.forEach(function (f) {
      var sl = el('input');
      sl.type = 'range'; sl.min = f.min; sl.max = f.max; sl.step = f.step;
      var nu = el('input');
      nu.type = 'number'; nu.min = f.min; nu.max = f.max; nu.step = f.step;
      sl.addEventListener('input', function () { nu.value = sl.value; self.onStat(f.k, sl.value); });
      nu.addEventListener('input', function () { sl.value = nu.value; self.onStat(f.k, nu.value); });
      self.statGrid.appendChild(el('span', 'lbl', f.label));
      self.statGrid.appendChild(sl);
      self.statGrid.appendChild(nu);
      self.stat[f.k] = { slider: sl, num: nu, spec: f };
    });
    sf.appendChild(this.statGrid);
    r.appendChild(sf);

    var lf = el('fieldset');
    lf.appendChild(el('legend', null, 'Look'));
    var g1 = el('div', 'grid');
    this.lScale = el('input');
    this.lScale.type = 'range'; this.lScale.min = 0.3; this.lScale.max = 3; this.lScale.step = 0.05;
    this.lScaleN = el('input');
    this.lScaleN.type = 'number'; this.lScaleN.min = 0.3; this.lScaleN.max = 3; this.lScaleN.step = 0.05;
    this.lEmis = el('input');
    this.lEmis.type = 'range'; this.lEmis.min = 0; this.lEmis.max = 4; this.lEmis.step = 0.05;
    this.lEmisN = el('input');
    this.lEmisN.type = 'number'; this.lEmisN.min = 0; this.lEmisN.max = 4; this.lEmisN.step = 0.05;
    function pair(sl, nu, set) {
      sl.addEventListener('input', function () { nu.value = sl.value; set(parseFloat(sl.value)); });
      nu.addEventListener('input', function () { sl.value = nu.value; set(parseFloat(nu.value)); });
    }
    pair(this.lScale, this.lScaleN, function (v) { self.def.look.scale = v; self.mark(); });
    pair(this.lEmis, this.lEmisN, function (v) { self.def.look.emissive = v; self.mark(); });
    g1.appendChild(el('span', 'lbl', 'Mesh')); g1.appendChild(this.lScale); g1.appendChild(this.lScaleN);
    g1.appendChild(el('span', 'lbl', 'Glow')); g1.appendChild(this.lEmis); g1.appendChild(this.lEmisN);
    lf.appendChild(g1);
    this.slots = el('div', 'slots');
    lf.appendChild(this.slots);
    var rowR = el('div', 'row');
    this.btnReset = el('button', null, 'Reset look');
    rowR.appendChild(this.btnReset);
    lf.appendChild(rowR);
    r.appendChild(lf);

    var row2 = el('div', 'row');
    this.btnSave = el('button', 'pri', 'Save to level');
    this.btnPack = el('button', null, 'Save to pack');
    this.btnDel = el('button', null, 'Delete');
    this.btnExp = el('button', null, 'Export');
    this.btnImp = el('button', null, 'Import');
    [this.btnSave, this.btnPack, this.btnDel, this.btnExp, this.btnImp]
      .forEach(function (b) { row2.appendChild(b); });
    r.appendChild(row2);
    this.note = el('div', 'lbl', '');
    r.appendChild(this.note);

    this.btnNew.addEventListener('click', function () { self.newFromBase(); });
    this.btnUse.addEventListener('click', function () { self.useForSelected(); });
    this.btnPlace.addEventListener('click', function () { self.placeNew(); });
    this.btnSave.addEventListener('click', function () { self.save(); });
    this.btnPack.addEventListener('click', function () { self.saveToPack(); });
    this.btnDel.addEventListener('click', function () { self.remove(); });
    this.btnExp.addEventListener('click', function () { self.exportDef(); });
    this.btnImp.addEventListener('click', function () { self.importDef(); });
    this.btnReset.addEventListener('click', function () {
      self.def.look = window.CyberEnemies.getDefaultLook(self.def.base, window.THREE);
      self.fillLook();
      self.mark();
    });

    this.fName.addEventListener('input', function () { self.def.name = self.fName.value; });
    this.fRole.addEventListener('change', function () { self.def.role = self.fRole.value; });
    this.fAttack.addEventListener('change', function () { self.def.stats.attack = self.fAttack.value; });
    this.fFly.addEventListener('change', function () { self.def.stats.fly = self.fFly.checked; });

    this.refreshList();
    this.startPreview();
  };

  Panel.prototype.mark = function () { this.dirty = true; };

  Panel.prototype.onStat = function (k, v) {
    this.def.stats[k] = parseFloat(v);
    if (k === 'scale') this.mark();
  };

  Panel.prototype.refreshList = function (keep) {
    var self = this, CE = window.CyberEnemies;
    if (!CE) return;
    var prev = this.pick.value;
    this.pick.innerHTML = '';
    var t = tables();
    [['Level enemies', t.level], ['Pack library', t.pack]].forEach(function (pair) {
      var keys = Object.keys(pair[1]);
      if (!keys.length) return;
      var g = el('optgroup');
      g.label = pair[0];
      keys.forEach(function (k) {
        var o = el('option', null, pair[1][k].name || k);
        o.value = 'custom:' + k;
        g.appendChild(o);
      });
      self.pick.appendChild(g);
    });
    var gBase = el('optgroup');
    gBase.label = 'Base types';
    CE.listTypes().forEach(function (t) {
      var o = el('option', null, t.name + '  (' + t.id + ', ' + t.role + ')');
      o.value = 'base:' + t.id;
      gBase.appendChild(o);
    });
    this.pick.appendChild(gBase);
    var match = null;
    for (var i = 0; i < this.pick.options.length; i++) {
      if (this.pick.options[i].value === prev) { match = prev; break; }
    }
    if (match) this.pick.value = match;
    else if (!keep) this.pick.value = this.pick.options.length ? this.pick.options[0].value : '';
  };

  /** Load either a base type (as a fresh template) or a saved custom def. */
  Panel.prototype.selectType = function (key) {
    var CE = window.CyberEnemies;
    if (!CE || !key) return;
    if (key.indexOf('custom:') === 0) {
      var saved = customTable()[key.slice(7)];
      if (!saved) return;
      this.def = clone(saved);
      if (!this.def.look) this.def.look = CE.getDefaultLook(this.def.base, window.THREE);
    } else {
      var id = parseInt(key.slice(5), 10);
      this.def = {
        id: '',
        name: (CE.NAMES[id] || ('Type ' + id)) + ' variant',
        base: id,
        stats: clone(CE.stats(id)),
        role: CE.roleOf(id),
        look: CE.getDefaultLook(id, window.THREE)
      };
    }
    this.baseLook = CE.getDefaultLook(this.def.base, window.THREE);
    this.fill();
    this.mark();
  };

  Panel.prototype.fill = function () {
    var d = this.def;
    this.fName.value = d.name || '';
    this.fRole.value = d.role || 'rusher';
    this.fAttack.value = d.stats.attack || 'melee';
    this.fFly.checked = !!d.stats.fly;
    for (var k in this.stat) {
      var v = d.stats[k];
      if (v === undefined) v = this.stat[k].spec.min;
      this.stat[k].slider.value = v;
      this.stat[k].num.value = v;
    }
    this.fillLook();
    this.note.textContent = d.id ? ('custom:' + d.id) : 'unsaved — Save writes it to the level';
    if (this.selNote) this.syncSelection();
  };

  Panel.prototype.fillLook = function () {
    var self = this, d = this.def;
    if (!d.look) d.look = clone(this.baseLook);
    if (d.look.scale === undefined) d.look.scale = 1;
    if (d.look.emissive === undefined) d.look.emissive = 1;
    this.lScale.value = this.lScaleN.value = d.look.scale;
    this.lEmis.value = this.lEmisN.value = d.look.emissive;
    this.slots.innerHTML = '';
    (this.baseLook.slots || []).forEach(function (s) {
      var cur = (d.look.colors && d.look.colors[s.name] !== undefined) ? d.look.colors[s.name] : s.hex;
      var lab = el('span', 'lbl', s.name);
      var col = el('input');
      col.type = 'color';
      col.value = hex6(cur);
      var vis = el('input');
      vis.type = 'checkbox';
      vis.checked = !(d.look.parts && d.look.parts[s.name] === false);
      vis.title = 'visible';
      col.addEventListener('input', function () {
        d.look.colors = d.look.colors || {};
        d.look.colors[s.name] = fromHex(col.value);
        self.mark();
      });
      vis.addEventListener('change', function () {
        d.look.parts = d.look.parts || {};
        d.look.parts[s.name] = vis.checked;
        self.mark();
      });
      self.slots.appendChild(lab);
      self.slots.appendChild(col);
      self.slots.appendChild(vis);
    });
  };

  // ------------------------------------------------------------- commands
  Panel.prototype.newFromBase = function () {
    var d = this.def;
    if (!d) return;
    d.id = '';
    d.name = (d.name || 'enemy') + ' copy';
    this.fill();
    this.mark();
    toast('New definition — press Save to store it on the level');
  };

  Panel.prototype.ensureId = function () {
    var d = this.def;
    if (d.id) return d.id;
    var base = slug(d.name), tbl = customTable(), id = base, n = 2;
    while (tbl[id]) id = base + '-' + (n++);
    d.id = id;
    return id;
  };

  /** The pack library: persisted through storage.saveEnemy, and mirrored onto
      the live pack object so levelForGame() bakes it into every level the
      editor hands the game. */
  Panel.prototype.saveToPack = function () {
    var self = this, ed = window.CyberEditor, d = this.def;
    if (!ed || !d) return;
    if (!ed.packId) { toast('Open a level from a pack first', 'bad'); return; }
    this.ensureId();
    var def = clone(d);
    def.fromPack = true;
    ed.pack = ed.pack || {};
    ed.pack.customEnemies = ed.pack.customEnemies || {};
    ed.pack.customEnemies[def.id] = def;
    if (window.CyberEnemies) {
      var t = {}; t[def.id] = def;
      window.CyberEnemies.registerCustom(t);
    }
    ed.emit('pack-changed', { pack: ed.pack });
    self.refreshList();
    self.pick.value = 'custom:' + def.id;
    self.note.textContent = 'custom:' + def.id + ' (pack)';
    self.syncSelection();
    ed.storage.saveEnemy(ed.packId, def).then(function () {
      toast('Saved ' + (def.name || def.id) + ' to ' + ed.packId, 'ok');
    }).catch(function (err) {
      toast('Pack save failed: ' + err.message, 'bad');
    });
  };

  Panel.prototype.save = function () {
    var ed = window.CyberEditor, d = this.def;
    if (!ed || !d) return;
    this.ensureId();
    var def = clone(d);
    delete def.fromPack;   // copying a pack def down makes it the level's own
    ed.apply(function (level) {
      level.customEnemies = level.customEnemies || {};
      level.customEnemies[def.id] = def;
    }, 'save enemy ' + (def.name || def.id));
    if (window.CyberEnemies) {
      var t = {};
      t[def.id] = def;
      window.CyberEnemies.registerCustom(t);
    }
    this.refreshList();
    this.pick.value = 'custom:' + def.id;
    this.note.textContent = 'custom:' + def.id;
    this.syncSelection();
    toast('Saved ' + (def.name || def.id));
  };

  Panel.prototype.remove = function () {
    var ed = window.CyberEditor, d = this.def;
    if (!ed || !d || !d.id) { toast('Nothing saved to delete'); return; }
    var self = this, id = d.id, t = tables();
    var inLevel = !!t.level[id], inPack = !!t.pack[id];
    var where = inLevel && inPack ? 'this level and the pack library'
      : (inPack ? 'the pack library' : 'this level');
    ed.confirm('Delete enemy', 'Delete "' + (d.name || id) + '" from ' + where + '?').then(function (yes) {
      if (!yes) return;
      if (inLevel || inPack) {
        // The baked fromPack copy lives on the level too, so clear both.
        ed.apply(function (level) {
          if (level.customEnemies) delete level.customEnemies[id];
        }, 'delete enemy ' + id);
      }
      if (inPack) {
        if (ed.pack && ed.pack.customEnemies) delete ed.pack.customEnemies[id];
        if (ed.packId) ed.storage.deleteEnemy(ed.packId, id).catch(function () {});
        ed.emit('pack-changed', { pack: ed.pack });
      }
      self.refreshList();
      self.selectType(self.pick.value);
      toast('Deleted ' + id + ' from ' + where, 'ok');
    });
  };

  /** Button state follows the shell's selection, so it never lies. */
  Panel.prototype.syncSelection = function () {
    var ed = window.CyberEditor;
    var sel = ed && ed.selection;
    var ent = selectedEntity();
    var saved = !!(this.def && this.def.id);
    this.btnUse.disabled = !ent || !saved;
    this.btnPlace.disabled = !saved || !ed || typeof ed.setEntityPick !== 'function';
    if (!sel || !sel.kind) this.selNote.textContent = 'no selection';
    else if (!ent) this.selNote.textContent = 'selected: ' + sel.kind + ' ' + sel.index + ' (not an entity)';
    else this.selNote.textContent = 'selected: entity ' + sel.index + ' — ' + (ent.enemyType === undefined ? ent.type : ent.enemyType);
  };

  Panel.prototype.useForSelected = function () {
    var ed = window.CyberEditor;
    if (!this.def || !this.def.id) { toast('Save the definition first'); return; }
    var sel = ed && ed.selection;
    if (!sel || sel.kind !== 'entity') { toast('Select an entity on the map first'); return; }
    var index = sel.index, type = 'custom:' + this.def.id;
    // Mutate through the level the undo stack hands us, not a captured
    // reference: apply() snapshots and may swap the level object.
    ed.apply(function (level) {
      var ent = (level.entities || [])[index];
      if (ent) ent.enemyType = type;
    }, 'set enemy type ' + type);
    this.syncSelection();
    toast('entity ' + index + ' now spawns ' + type, 'ok');
  };

  /** Hand the Entity tool this type so the next map click places it. */
  Panel.prototype.placeNew = function () {
    var ed = window.CyberEditor;
    if (!this.def || !this.def.id) { toast('Save the definition first'); return; }
    if (!ed || typeof ed.setEntityPick !== 'function') { toast('This shell has no Entity tool'); return; }
    ed.setEntityPick('custom:' + this.def.id);
    toast('Entity tool loaded with custom:' + this.def.id + ' — click the map', 'ok');
  };

  Panel.prototype.exportDef = function () {
    var ed = window.CyberEditor;
    var txt = JSON.stringify(this.def, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // Rejects (not throws) when the page lacks clipboard permission, so the
      // catch has to be on the promise or it surfaces as a page error.
      try { navigator.clipboard.writeText(txt).catch(function () {}); } catch (e) {}
    }
    ed.ask('Export enemy', 'Definition JSON', txt, 'Already copied to the clipboard.');
    toast('Definition exported', 'ok');
  };

  Panel.prototype.importDef = function () {
    var self = this;
    window.CyberEditor.ask('Import enemy', 'Definition JSON', '', 'Paste a definition exported from this panel.')
      .then(function (txt) { if (txt) self.applyImport(txt); });
  };

  Panel.prototype.applyImport = function (txt) {
    try {
      var d = JSON.parse(txt);
      if (d.base === undefined) throw new Error('missing base');
      if (!d.stats) d.stats = clone(window.CyberEnemies.stats(d.base));
      this.def = d;
      this.baseLook = window.CyberEnemies.getDefaultLook(d.base, window.THREE);
      this.fill();
      this.mark();
      toast('Imported ' + (d.name || d.id || 'definition'));
    } catch (e) {
      toast('Bad JSON: ' + e.message);
    }
  };

  // -------------------------------------------------------------- preview
  Panel.prototype.startPreview = function () {
    var self = this, THREE = window.THREE;
    if (!THREE || !window.CyberEnemies) { this.note.textContent = 'THREE / CyberEnemies missing'; return; }
    var r;
    try {
      r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    } catch (e) {
      this.note.textContent = 'no WebGL: ' + e.message;
      return;
    }
    r.setSize(this.canvas.width, this.canvas.height, false);
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090c);
    var cam = new THREE.PerspectiveCamera(40, this.canvas.width / this.canvas.height, 0.1, 100);
    scene.add(new THREE.AmbientLight(0x8899aa, 0.9));
    var key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 6, 4);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0x4477ff, 0.6);
    rim.position.set(-4, 2, -3);
    scene.add(rim);
    var pivot = new THREE.Group();
    scene.add(pivot);
    this.renderer = r;
    this.scene = scene;
    this.pivot = pivot;

    // CyberEnemies.animate only reads these fields off an enemy record.
    var stub = { group: null, state: 'IDLE', attackCooldown: 0, speed: 3, stats: null, floorY: 0 };
    var last = (window.performance || Date).now();
    var spin = 0;

    function rebuild() {
      while (pivot.children.length) pivot.remove(pivot.children[0]);
      var d = self.def;
      if (!d) return;
      var look = clone(d.look || {});
      var bs = window.CyberEnemies.stats(d.base).scale || 1;
      if (d.stats && d.stats.scale) look.scale = (Number(look.scale) || 1) * (Number(d.stats.scale) / bs);
      var g;
      try {
        g = window.CyberEnemies.buildMesh(d.base, look, {}, THREE);
      } catch (e) {
        self.note.textContent = 'build failed: ' + e.message;
        return;
      }
      pivot.add(g);
      stub.group = g;
      stub.stats = window.CyberEnemies.stats(d.base);
      var b = new THREE.Box3().setFromObject(g);
      var size = b.getSize(new THREE.Vector3());
      var mid = b.getCenter(new THREE.Vector3());
      var h = size.y || 2;
      pivot.position.y = -mid.y;
      cam.position.set(0, h * 0.15, Math.max(size.x, size.z, h) * 1.9 + 1.0);
      cam.lookAt(0, 0, 0);
      self.previewBuilds = (self.previewBuilds || 0) + 1;
    }

    function frame(now) {
      requestAnimationFrame(frame);
      var dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (self.dirty) { self.dirty = false; rebuild(); }
      spin += dt * 0.6;
      pivot.rotation.y = spin;
      if (stub.group) {
        try { window.CyberEnemies.animate(stub, now / 1000, dt); } catch (e) { /* rig-only preview */ }
      }
      r.render(scene, cam);
    }
    requestAnimationFrame(frame);
  };

  // ------------------------------------------------------------ bootstrap
  function mount() {
    var ed = window.CyberEditor;
    if (!ed || typeof ed.registerPanel !== 'function') return false;
    if (mount.done) return true;
    mount.done = true;
    var host = ed.registerPanel({
      id: 'enemies',
      title: 'Enemies',
      side: 'right',
      mount: function (elm) { new Panel(elm); }
    });
    // Shells that hand back the element instead of calling mount() work too.
    if (host && host.nodeType === 1 && !host.firstChild) new Panel(host);
    return true;
  }

  function boot() {
    if (mount()) return;
    var tries = 0;
    var t = setInterval(function () {
      if (mount() || ++tries > 600) clearInterval(t);
    }, 100);
    window.addEventListener('cybereditor-ready', function () { if (mount()) clearInterval(t); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if (typeof window !== 'undefined') window.CyberEnemyEditor = { Panel: Panel };
})();
