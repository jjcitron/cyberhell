/* ===========================================================================
   panels.js — the Properties panel and the Pack manager panel.

   Both are registered through CyberEditor.registerPanel, the same door other
   lanes use, so nothing here is privileged.
   =========================================================================== */
(function () {
  'use strict';

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function row(host, label, control) {
    var r = el('div', { class: 'ed-row' });
    r.appendChild(el('label', null, label));
    r.appendChild(control);
    host.appendChild(r);
    return control;
  }

  function num(value, onCommit, step) {
    var i = el('input', { type: 'number', step: step || 'any' });
    i.value = value == null ? '' : value;
    i.addEventListener('change', function () {
      var v = parseFloat(i.value);
      if (!isNaN(v)) onCommit(v);
    });
    return i;
  }

  function text(value, onCommit) {
    var i = el('input', { type: 'text' });
    i.value = value == null ? '' : value;
    i.addEventListener('change', function () { onCommit(i.value); });
    return i;
  }

  function bool(value, onCommit) {
    var i = el('input', { type: 'checkbox' });
    i.checked = !!value;
    i.addEventListener('change', function () { onCommit(i.checked); });
    return i;
  }

  function pick(options, value, onCommit) {
    var s = el('select');
    options.forEach(function (o) { s.appendChild(el('option', { value: o }, o)); });
    if (options.indexOf(value) < 0 && value != null) s.appendChild(el('option', { value: value }, value));
    s.value = value;
    s.addEventListener('change', function () { onCommit(s.value); });
    return s;
  }

  function intToHex(n) { return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6); }
  function hexToInt(h) { return parseInt(h.replace('#', ''), 16); }

  function colour(value, onCommit) {
    var i = el('input', { type: 'color' });
    i.value = intToHex(value || 0);
    i.addEventListener('change', function () { onCommit(hexToInt(i.value)); });
    return i;
  }

  function install(ed) {
    installProperties(ed);
    installPacks(ed);
  }

  /* ---- Properties ------------------------------------------------------- */

  function installProperties(ed) {
    var host = ed.registerPanel({ id: 'properties', title: 'Properties', side: 'right' });

    function render() {
      host.innerHTML = '';
      var lv = ed.level;
      if (!lv) { host.appendChild(el('div', { class: 'ed-hint' }, 'No level open.')); return; }
      var sel = ed.selection;

      host.appendChild(el('div', { class: 'ed-head' }, 'Selection'));
      if (!sel || !sel.kind) host.appendChild(el('div', { class: 'ed-hint' }, 'Nothing selected.'));
      else if (sel.kind === 'sector') renderSector(lv, sel.index);
      else if (sel.kind === 'wall') renderWall(lv, sel.index);
      else if (sel.kind === 'entity') renderEntity(lv, sel.index);
      else if (sel.kind === 'trigger') renderTrigger(lv, sel.index);
      else if (sel.kind === 'spawn') renderSpawn(lv);

      host.appendChild(el('div', { class: 'ed-head' }, 'Level'));
      row(host, 'name', text(lv.name, function (v) { ed.apply(function (l) { l.name = v; }, 'rename level'); }));
      row(host, 'skyColor', colour(lv.skyColor, function (v) { ed.apply(function (l) { l.skyColor = v; }, 'sky colour'); }));
      row(host, 'fogColor', colour(lv.fogColor, function (v) { ed.apply(function (l) { l.fogColor = v; }, 'fog colour'); }));
      row(host, 'fogDensity', num(lv.fogDensity, function (v) { ed.apply(function (l) { l.fogDensity = v; }, 'fog density'); }, '0.001'));
      row(host, 'ambientLight', colour(lv.ambientLight, function (v) { ed.apply(function (l) { l.ambientLight = v; }, 'ambient'); }));
      if (lv.sunLight) {
        row(host, 'sun colour', colour(lv.sunLight.color, function (v) { ed.apply(function (l) { l.sunLight.color = v; }, 'sun colour'); }));
        row(host, 'sun intensity', num(lv.sunLight.intensity, function (v) { ed.apply(function (l) { l.sunLight.intensity = v; }, 'sun intensity'); }, '0.05'));
      }
      var counts = el('div', { class: 'ed-hint' },
        (lv.sectors || []).length + ' sectors · ' + (lv.walls || []).length + ' walls · ' +
        (lv.triggers || []).length + ' triggers · ' + (lv.entities || []).length + ' entities');
      host.appendChild(counts);
      var exitIdx = window.EdModel.exitWallIndex(lv);
      var exit = el('div', { class: 'ed-hint' }, exitIdx >= 0 ? ('exit switch: wall ' + exitIdx) : 'NO sw_exit_game wall — the level cannot be finished');
      if (exitIdx < 0) exit.style.color = '#ff3355';
      else exit.style.cursor = 'pointer';
      exit.addEventListener('click', function () { if (exitIdx >= 0) ed.select('wall', exitIdx); });
      host.appendChild(exit);
    }

    function renderSector(lv, i) {
      var sec = lv.sectors[i];
      if (!sec) return;
      host.appendChild(el('div', { class: 'ed-hint' }, 'sector ' + i + ' (' + (sec.id || '') + ')'));
      row(host, 'floorY', num(sec.floorY, function (v) { ed.apply(function (l) { l.sectors[i].floorY = v; }, 'floorY'); }, '0.1'));
      row(host, 'ceilY', num(sec.ceilY, function (v) { ed.apply(function (l) { l.sectors[i].ceilY = v; }, 'ceilY'); }, '0.1'));
      row(host, 'light', num(sec.light, function (v) { ed.apply(function (l) { l.sectors[i].light = v; }, 'light'); }, '0.02'));
      row(host, 'floorTex', pick(window.EdTools.TEX_FLOOR, sec.floorTex, function (v) { ed.apply(function (l) { l.sectors[i].floorTex = v; }, 'floorTex'); }));
      row(host, 'ceilTex', pick(window.EdTools.TEX_FLOOR, sec.ceilTex, function (v) { ed.apply(function (l) { l.sectors[i].ceilTex = v; }, 'ceilTex'); }));
      row(host, 'isSky', bool(sec.isSky, function (v) { ed.apply(function (l) { l.sectors[i].isSky = v; }, 'isSky'); }));
      host.appendChild(el('div', { class: 'ed-hint' }, 'area ' + (sec.area || 0) + ' · ' + ((sec.polys || []).length) + ' loop(s)'));
      var del = el('button', null, 'Delete sector');
      del.addEventListener('click', function () {
        ed.apply(function (l) { window.EdModel.removeSector(l, i); }, 'delete sector');
        ed.select(null, -1);
      });
      host.appendChild(del);
    }

    function renderWall(lv, i) {
      var w = lv.walls[i];
      if (!w) return;
      host.appendChild(el('div', { class: 'ed-hint' }, 'wall ' + i));
      row(host, 'bottomY', num(w.bottomY, function (v) { ed.apply(function (l) { l.walls[i].bottomY = v; l.walls[i].h = l.walls[i].topY - v; }, 'bottomY'); }, '0.1'));
      row(host, 'topY', num(w.topY, function (v) { ed.apply(function (l) { l.walls[i].topY = v; l.walls[i].h = v - l.walls[i].bottomY; }, 'topY'); }, '0.1'));
      row(host, 'tex', pick(window.EdTools.TEX_WALL, w.tex, function (v) { ed.apply(function (l) { l.walls[i].tex = v; }, 'wall tex'); }));
      row(host, 'solid', bool(w.solid, function (v) { ed.apply(function (l) { l.walls[i].solid = v; }, 'solid'); }));
      row(host, 'door', bool(w.isDoor, function (v) {
        ed.apply(function (l) {
          if (v) { l.walls[i].isDoor = true; l.walls[i].doorId = l.walls[i].doorId || ('door_ed' + i); l.walls[i].closed = true; }
          else { delete l.walls[i].isDoor; delete l.walls[i].doorId; delete l.walls[i].closed; }
        }, 'door flag');
      }));
      if (w.isDoor) row(host, 'doorId', text(w.doorId, function (v) { ed.apply(function (l) { l.walls[i].doorId = v; }, 'doorId'); }));
      row(host, 'switch', bool(w.isSwitch, function (v) {
        ed.apply(function (l) {
          if (v) { l.walls[i].isSwitch = true; l.walls[i].switchId = l.walls[i].switchId || ('sw_ed' + i); }
          else { delete l.walls[i].isSwitch; delete l.walls[i].switchId; }
        }, 'switch flag');
      }));
      if (w.isSwitch) {
        row(host, 'switchId', text(w.switchId, function (v) { ed.apply(function (l) { l.walls[i].switchId = v; }, 'switchId'); }));
        var mk = el('button', null, 'Make this the level exit');
        mk.addEventListener('click', function () {
          ed.apply(function (l) {
            (l.walls || []).forEach(function (ww) { if (ww.switchId === 'sw_exit_game') ww.switchId = 'sw_old_exit'; });
            l.walls[i].isSwitch = true;
            l.walls[i].switchId = 'sw_exit_game';
          }, 'set exit switch');
        });
        host.appendChild(mk);
      }
      row(host, 'ledge', bool(w.ledge, function (v) {
        ed.apply(function (l) {
          if (v) {
            l.walls[i].ledge = true;
            if (l.walls[i].loFloor == null) l.walls[i].loFloor = l.walls[i].bottomY;
            if (l.walls[i].hiFloor == null) l.walls[i].hiFloor = l.walls[i].bottomY + 1.6;
            l.walls[i].solid = false;
          } else { delete l.walls[i].ledge; delete l.walls[i].hiFloor; delete l.walls[i].loFloor; l.walls[i].solid = true; }
        }, 'ledge flag');
      }));
      if (w.ledge) row(host, 'hiFloor', num(w.hiFloor, function (v) { ed.apply(function (l) { l.walls[i].hiFloor = v; }, 'hiFloor'); }, '0.1'));

      if (w.ai !== undefined || w.fs !== undefined) {
        host.appendChild(el('div', { class: 'ed-hint' },
          'linedef ai=' + (w.ai === undefined ? '-' : w.ai) +
          '  front sector=' + (w.fs === undefined ? '-' : w.fs) +
          '  back=' + (w.bs === undefined ? '-' : w.bs)));
      }
      var t = window.EdModel.triggerFor(lv, i);
      var btns = el('div', { class: 'ed-btns' });
      if (t >= 0) {
        var go = el('button', null, 'Edit trigger');
        go.addEventListener('click', function () { ed.select('trigger', t); });
        btns.appendChild(go);
      }
      var del = el('button', null, 'Delete wall');
      del.addEventListener('click', function () {
        ed.apply(function (l) { window.EdModel.removeWall(l, i); }, 'delete wall');
        ed.select(null, -1);
      });
      btns.appendChild(del);
      host.appendChild(btns);
    }

    function renderEntity(lv, i) {
      var e = lv.entities[i];
      if (!e) return;
      host.appendChild(el('div', { class: 'ed-hint' }, 'entity ' + i + ' — ' + e.type + (e.enemyType != null ? ' / ' + e.enemyType : '')));
      row(host, 'type', text(e.type, function (v) { ed.apply(function (l) { l.entities[i].type = v; }, 'entity type'); }));
      if (e.enemyType != null) {
        var names = window.EdTools.ENEMY_TYPES.map(function (t) { return String(t[0]); });
        row(host, 'enemyType', pick(names, String(e.enemyType), function (v) {
          ed.apply(function (l) { l.entities[i].enemyType = /^\d+$/.test(v) ? parseInt(v, 10) : v; }, 'enemyType');
        }));
      }
      if (e.type === 'weapon') row(host, 'name', text(e.name, function (v) { ed.apply(function (l) { l.entities[i].name = v; }, 'weapon name'); }));
      row(host, 'x', num(e.pos[0], function (v) { ed.apply(function (l) { l.entities[i].pos[0] = v; }, 'entity x'); }, '0.1'));
      row(host, 'y', num(e.pos[1], function (v) { ed.apply(function (l) { l.entities[i].pos[1] = v; }, 'entity y'); }, '0.1'));
      row(host, 'z', num(e.pos[2], function (v) { ed.apply(function (l) { l.entities[i].pos[2] = v; }, 'entity z'); }, '0.1'));
      row(host, 'rot', num(e.rot, function (v) { ed.apply(function (l) { l.entities[i].rot = v; }, 'entity rot'); }, '0.05'));
      var del = el('button', null, 'Delete entity');
      del.addEventListener('click', function () {
        ed.apply(function (l) { l.entities.splice(i, 1); }, 'delete entity');
        ed.select(null, -1);
      });
      host.appendChild(del);
    }

    function renderTrigger(lv, i) {
      var t = (lv.triggers || [])[i];
      if (!t) return;
      var act = t.act || {};
      var boundWalls = window.EdModel.wallsForTrigger(lv, i);
      host.appendChild(el('div', { class: 'ed-hint' },
        'trigger ' + i + ' on linedef ' + t.i + ' - wall(s) ' + (boundWalls.length ? boundWalls.join(', ') : 'none')));
      row(host, 'kind', pick(['lift', 'floor', 'tele', 'door'], act.kind, function (v) { ed.apply(function (l) { l.triggers[i].act.kind = v; }, 'trigger kind'); }));
      row(host, 'trig', pick(['use', 'walk', 'gun'], act.trig, function (v) { ed.apply(function (l) { l.triggers[i].act.trig = v; }, 'trigger trig'); }));
      row(host, 'rep', bool(act.rep, function (v) { ed.apply(function (l) { l.triggers[i].act.rep = v; }, 'trigger rep'); }));
      if (act.kind === 'lift') {
        row(host, 'wait', num(act.wait, function (v) { ed.apply(function (l) { l.triggers[i].act.wait = v; }, 'trigger wait'); }, '0.05'));
        row(host, 'speed', num(act.speed, function (v) { ed.apply(function (l) { l.triggers[i].act.speed = v; }, 'trigger speed'); }, '0.5'));
      }
      if (act.kind === 'floor') {
        row(host, 'to', text(act.to, function (v) { ed.apply(function (l) { l.triggers[i].act.to = v; }, 'trigger to'); }));
        row(host, 'direction', pick(['up', 'down'], act.direction, function (v) { ed.apply(function (l) { l.triggers[i].act.direction = v; }, 'trigger dir'); }));
        row(host, 'amt', num(act.amt, function (v) { ed.apply(function (l) { l.triggers[i].act.amt = v; }, 'trigger amt'); }, '0.1'));
        row(host, 'fast', bool(act.fast, function (v) { ed.apply(function (l) { l.triggers[i].act.fast = v; }, 'trigger fast'); }));
      }
      if (act.kind === 'door') row(host, 'local', bool(act.local, function (v) { ed.apply(function (l) { l.triggers[i].act.local = v; }, 'trigger local'); }));
      if (act.secs) {
        row(host, 'sectors', text(act.secs.join(','), function (v) {
          var ids = v.split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
          ed.apply(function (l) { l.triggers[i].act.secs = ids; }, 'trigger sectors');
        }));
        var btns = el('div', { class: 'ed-btns' });
        var add = el('button', null, 'Add selected sector');
        add.addEventListener('click', function () {
          var s = ed.lastSector;
          if (s == null || s < 0) { ed.toast('select a sector first', 'bad'); return; }
          ed.apply(function (l) {
            var arr = l.triggers[i].act.secs || (l.triggers[i].act.secs = []);
            if (arr.indexOf(s) < 0) arr.push(s);
          }, 'trigger target');
        });
        btns.appendChild(add);
        host.appendChild(btns);
      }
      if (boundWalls.length) {
        var showWall = el('button', null, 'Select its wall');
        showWall.addEventListener('click', function () { ed.select('wall', boundWalls[0]); });
        host.appendChild(showWall);
      }
      var del = el('button', null, 'Delete trigger');
      del.addEventListener('click', function () {
        ed.apply(function (l) { window.EdModel.removeTrigger(l, i); }, 'delete trigger');
        ed.select(null, -1);
      });
      host.appendChild(del);
    }

    function renderSpawn(lv) {
      var sp = lv.playerSpawn;
      host.appendChild(el('div', { class: 'ed-hint' }, 'player start'));
      row(host, 'x', num(sp.pos[0], function (v) { ed.apply(function (l) { l.playerSpawn.pos[0] = v; }, 'spawn x'); }, '0.1'));
      row(host, 'y', num(sp.pos[1], function (v) { ed.apply(function (l) { l.playerSpawn.pos[1] = v; }, 'spawn y'); }, '0.1'));
      row(host, 'z', num(sp.pos[2], function (v) { ed.apply(function (l) { l.playerSpawn.pos[2] = v; }, 'spawn z'); }, '0.1'));
      row(host, 'rot', num(sp.rot, function (v) { ed.apply(function (l) { l.playerSpawn.rot = v; }, 'spawn rot'); }, '0.05'));
    }

    ed.on('level-loaded', render);
    ed.on('level-changed', render);
    ed.on('selection-changed', render);
    render();
  }

  /* ---- Pack manager ----------------------------------------------------- */

  function installPacks(ed) {
    var host = ed.registerPanel({ id: 'packs', title: 'Packs', side: 'right' });
    var openPackId = null;
    var dragId = null;

    function render() {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'ed-head' }, 'Packs'));
      var listBox = el('div', { class: 'ed-list' });
      host.appendChild(listBox);
      listBox.appendChild(el('div', { class: 'ed-hint' }, 'loading…'));

      var btns = el('div', { class: 'ed-btns' });
      var mk = el('button', null, 'New pack');
      mk.addEventListener('click', function () {
        ed.ask('New pack', 'Pack name', 'My Pack').then(function (name) {
          if (!name || !name.trim()) return;
          return ed.storage.createPack(name.trim()).then(function (r) {
            openPackId = r.id;
            ed.toast('pack created', 'ok');
            render();
          });
        });
      });
      btns.appendChild(mk);
      host.appendChild(btns);

      var levelsHead = el('div', { class: 'ed-head' }, 'Levels');
      host.appendChild(levelsHead);
      var levelBox = el('div', { class: 'ed-list' });
      host.appendChild(levelBox);
      var levelBtns = el('div', { class: 'ed-btns' });
      host.appendChild(levelBtns);

      ed.storage.listPacks().then(function (packs) {
        listBox.innerHTML = '';
        if (!packs.length) listBox.appendChild(el('div', { class: 'ed-hint' }, 'none'));
        packs.forEach(function (p) {
          var item = el('div', { class: 'ed-item' + (p.id === openPackId ? ' sel' : '') });
          item.appendChild(el('span', { class: 'ed-grow' }, p.name));
          item.appendChild(el('span', { class: 'ed-tag' }, p.source === 'canonical' ? 'repo' : 'local'));
          item.addEventListener('click', function () { openPackId = p.id; render(); });
          listBox.appendChild(item);
        });
        if (openPackId) renderLevels(levelBox, levelBtns);
        else levelBox.appendChild(el('div', { class: 'ed-hint' }, 'pick a pack'));
      });
    }

    function renderLevels(box, btns) {
      box.innerHTML = '';
      btns.innerHTML = '';
      ed.storage.getPack(openPackId).then(function (pack) {
        if (!pack) { box.appendChild(el('div', { class: 'ed-hint' }, 'gone')); return; }
        var local = pack.source !== 'canonical';
        (pack.levels || []).forEach(function (lvl) {
          var item = el('div', { class: 'ed-item' + (ed.levelId === lvl.id && ed.packId === pack.id ? ' sel' : '') });
          if (local) {
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', function () { dragId = lvl.id; });
            item.addEventListener('dragover', function (e) { e.preventDefault(); item.classList.add('drag-over'); });
            item.addEventListener('dragleave', function () { item.classList.remove('drag-over'); });
            item.addEventListener('drop', function (e) {
              e.preventDefault();
              item.classList.remove('drag-over');
              if (!dragId || dragId === lvl.id) return;
              var ids = pack.levels.map(function (l) { return l.id; });
              ids.splice(ids.indexOf(dragId), 1);
              ids.splice(ids.indexOf(lvl.id), 0, dragId);
              ed.storage.reorderLevels(pack.id, ids).then(function () { dragId = null; render(); });
            });
          }
          item.appendChild(el('span', { class: 'ed-grow' }, lvl.name || lvl.id));
          item.addEventListener('click', function () { ed.openLevel(pack.id, lvl.id); });
          box.appendChild(item);
        });
        if (!(pack.levels || []).length) box.appendChild(el('div', { class: 'ed-hint' }, 'empty'));

        if (local) {
          var ren = el('button', null, 'Rename pack');
          ren.addEventListener('click', function () {
            ed.ask('Rename pack', 'Pack name', pack.name).then(function (n) {
              if (n && n.trim()) ed.storage.renamePack(pack.id, n.trim()).then(render);
            });
          });
          btns.appendChild(ren);
          var delp = el('button', null, 'Delete pack');
          delp.addEventListener('click', function () {
            ed.confirm('Delete pack', 'Delete "' + pack.name + '" and its ' + (pack.levels || []).length + ' level(s)? This cannot be undone.')
              .then(function (ok) {
                if (!ok) return;
                return ed.storage.deletePack(pack.id).then(function () { openPackId = null; render(); ed.toast('pack deleted', 'ok'); });
              });
          });
          btns.appendChild(delp);
          var newLvl = el('button', null, 'New level here');
          newLvl.addEventListener('click', function () {
            ed.ask('New level', 'Level name', 'New Level (MAP01)',
              'Keep the MAP## / E#M# token so the music assignment still matches.'
            ).then(function (n) {
              if (!n || !n.trim()) return;
              return ed.storage.saveLevelAs(pack.id, n.trim(), window.EdModel.blankLevel(n.trim())).then(function (r) {
                return ed.openLevel(pack.id, r.levelId).then(render);
              });
            });
          });
          btns.appendChild(newLvl);
          var repo = el('button', null, 'Save into repo');
          repo.addEventListener('click', function () { ed.saveIntoRepo(pack.id).then(render); });
          btns.appendChild(repo);
        } else {
          btns.appendChild(el('span', { class: 'ed-hint' }, 'repo pack — read only. Save as into a local pack to edit.'));
        }

        if (ed.levelId && ed.packId === pack.id && local) {
          var dup = el('button', null, 'Duplicate level');
          dup.addEventListener('click', function () {
            ed.storage.saveLevelAs(pack.id, (ed.level.name || 'Level') + ' copy', ed.level).then(function () {
              ed.toast('duplicated');
              render();
            });
          });
          btns.appendChild(dup);
          var dl = el('button', null, 'Delete level');
          dl.addEventListener('click', function () {
            ed.confirm('Delete level', 'Delete "' + (ed.level.name || ed.levelId) + '"? This cannot be undone.')
              .then(function (ok) {
                if (!ok) return;
                return ed.storage.deleteLevel(pack.id, ed.levelId).then(function () { render(); ed.toast('level deleted', 'ok'); });
              });
          });
          btns.appendChild(dl);
        }
      });
    }

    ed.on('pack-changed', render);
    ed.on('level-loaded', render);
    render();
  }

  window.EdPanels = { install: install };
})();
