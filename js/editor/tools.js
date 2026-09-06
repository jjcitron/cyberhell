/* ===========================================================================
   tools.js — the built-in tools (Select, Sector, Wall, Entity, Trigger, Spawn).

   A tool is {id, title, key, onActivate, onDeactivate, options(el),
   onPointerDown(e, world, screen), onPointerMove, onPointerUp, draw(ctx, view)}.
   Registered through CyberEditor.registerTool, so other lanes add tools the
   same way these do.

   Drags mutate the level live for feedback, then rewind to the pre-drag value
   and re-apply through CyberEditor.apply() so the whole drag is ONE undo step.
   =========================================================================== */
(function () {
  'use strict';

  /* Doom thing id -> display name. Mirrors the STATS table in cyber-enemies.js
     (that file exposes stats but no names). */
  var ENEMY_TYPES = [
    [3004, 'Zombieman'], [9, 'Shotgun Guy'], [65, 'Chaingunner'], [3001, 'Imp'],
    [3002, 'Demon'], [58, 'Spectre'], [3005, 'Cacodemon'], [69, 'Hell Knight'],
    [3003, 'Baron of Hell'], [66, 'Revenant'], [67, 'Mancubus'], [68, 'Arachnotron'],
    [64, 'Archvile'], [16, 'Cyberdemon'], [7, 'Spider Mastermind']
  ];

  var PICKUPS = [
    { type: 'health_stim', label: 'Health stim' },
    { type: 'armor', label: 'Armor' },
    { type: 'ammo_bullets', label: 'Ammo (bullets)' },
    { type: 'ammo_shells', label: 'Ammo (shells)' },
    { type: 'ammo_energy', label: 'Ammo (energy)' },
    { type: 'barrel', label: 'Barrel' },
    { type: 'weapon', label: 'Weapon pickup', name: 'shotgun' }
  ];

  var WEAPON_NAMES = ['pistol', 'shotgun', 'machinegun', 'rocket', 'plasma', 'bfg'];
  var TEX_FLOOR = ['tech_floor', 'tech_panel', 'cyber_rust', 'hell_flesh', 'metal_grate', 'concrete'];
  var TEX_WALL = ['cyber_rust', 'tech_panel', 'door_blast', 'switch_off', 'hell_flesh', 'metal_grate'];

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function select(options, value, onChange) {
    var s = el('select');
    options.forEach(function (o) {
      var opt = el('option', { value: o.value }, o.label);
      s.appendChild(opt);
    });
    s.value = value;
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function install(ed) {
    var map = ed.map;

    /* ---- Select ---------------------------------------------------------- */
    var drag = null;

    ed.registerTool({
      id: 'select', title: 'Select', key: '1', glyph: '↖',
      onPointerDown: function (e, world, screen) {
        if (!ed.level) return;
        drag = null;
        var sel = ed.selection;

        // Grab a vertex of the selected sector first — that is the fine control.
        if (sel && sel.kind === 'sector') {
          var v = map.pickVertex(screen.px, screen.py, 9);
          if (v && v.sector === sel.index) {
            var pt = ed.level.sectors[v.sector].polys[v.poly][v.point];
            drag = { kind: 'vertex', v: v, orig: pt.slice() };
            return;
          }
        }

        var hit = map.pick(screen.px, screen.py);
        if (!hit) {
          drag = { kind: 'box', x0: world.x, z0: world.z, x1: world.x, z1: world.z };
          if (!e.shiftKey) { ed.multi = []; ed.select(null, -1); }
          return;
        }
        if (e.shiftKey) {
          ed.toggleMulti(hit.kind, hit.index);
          return;
        }
        ed.multi = [];
        ed.select(hit.kind, hit.index);
        if (hit.kind === 'entity') {
          drag = { kind: 'entity', index: hit.index, orig: ed.level.entities[hit.index].pos.slice() };
        } else if (hit.kind === 'spawn') {
          drag = { kind: 'spawn', orig: ed.level.playerSpawn.pos.slice() };
        }
      },
      onPointerMove: function (e, world, screen) {
        if (!drag) { map.updateHover(screen.px, screen.py); return; }
        var p = map.snapPoint(world.x, world.z);
        if (drag.kind === 'vertex') {
          var pt = ed.level.sectors[drag.v.sector].polys[drag.v.poly][drag.v.point];
          pt[0] = p.x; pt[1] = p.z;
        } else if (drag.kind === 'entity') {
          var pos = ed.level.entities[drag.index].pos;
          pos[0] = p.x; pos[2] = p.z;
        } else if (drag.kind === 'spawn') {
          ed.level.playerSpawn.pos[0] = p.x;
          ed.level.playerSpawn.pos[2] = p.z;
        } else if (drag.kind === 'box') {
          drag.x1 = world.x; drag.z1 = world.z;
        }
        map.requestRedraw();
      },
      onPointerUp: function () {
        if (!drag) return;
        var d = drag;
        drag = null;
        if (d.kind === 'box') {
          var x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
          var z0 = Math.min(d.z0, d.z1), z1 = Math.max(d.z0, d.z1);
          if (Math.abs(x1 - x0) < 0.2 && Math.abs(z1 - z0) < 0.2) { map.requestRedraw(); return; }
          var picked = [];
          (ed.level.entities || []).forEach(function (en, i) {
            if (en.pos[0] >= x0 && en.pos[0] <= x1 && en.pos[2] >= z0 && en.pos[2] <= z1) picked.push({ kind: 'entity', index: i });
          });
          (ed.level.walls || []).forEach(function (w, i) {
            var mx = (w.p1[0] + w.p2[0]) / 2, mz = (w.p1[1] + w.p2[1]) / 2;
            if (mx >= x0 && mx <= x1 && mz >= z0 && mz <= z1) picked.push({ kind: 'wall', index: i });
          });
          ed.multi = picked;
          ed.select(picked.length ? picked[0].kind : null, picked.length ? picked[0].index : -1);
          ed.toast(picked.length + ' selected');
          return;
        }
        // Rewind the live drag, then re-apply it as one undoable command.
        if (d.kind === 'vertex') {
          var poly = ed.level.sectors[d.v.sector].polys[d.v.poly];
          var final = poly[d.v.point].slice();
          poly[d.v.point] = d.orig.slice();
          if (final[0] === d.orig[0] && final[1] === d.orig[1]) return;
          ed.apply(function (lv) {
            lv.sectors[d.v.sector].polys[d.v.poly][d.v.point] = final;
            window.EdModel.refreshSector(lv.sectors[d.v.sector]);
          }, 'move vertex');
        } else if (d.kind === 'entity') {
          var ent = ed.level.entities[d.index];
          var fpos = ent.pos.slice();
          ent.pos = d.orig.slice();
          if (fpos[0] === d.orig[0] && fpos[2] === d.orig[2]) return;
          ed.apply(function (lv) {
            var si = window.EdModel.sectorAt(lv, fpos[0], fpos[2]);
            if (si >= 0) fpos[1] = lv.sectors[si].floorY;
            lv.entities[d.index].pos = fpos;
          }, 'move entity');
        } else if (d.kind === 'spawn') {
          var sp = ed.level.playerSpawn;
          var spos = sp.pos.slice();
          sp.pos = d.orig.slice();
          if (spos[0] === d.orig[0] && spos[2] === d.orig[2]) return;
          ed.apply(function (lv) {
            var si2 = window.EdModel.sectorAt(lv, spos[0], spos[2]);
            if (si2 >= 0) spos[1] = lv.sectors[si2].floorY + 1.5;
            lv.playerSpawn.pos = spos;
          }, 'move spawn');
        }
      },
      draw: function (ctx) {
        if (!drag || drag.kind !== 'box') return;
        var a = map.worldToScreen(drag.x0, drag.z0), b = map.worldToScreen(drag.x1, drag.z1);
        ctx.strokeStyle = '#00ffee';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.setLineDash([]);
      }
    });

    /* ---- Draw Sector ----------------------------------------------------- */
    var pts = [];
    var sectorOpts = { floorTex: 'tech_floor', ceilTex: 'tech_panel' };

    function neighbourSector(x, z) {
      var lv = ed.level;
      var si = window.EdModel.sectorAt(lv, x, z);
      if (si >= 0) return lv.sectors[si];
      // Otherwise the sector whose bbox centre is nearest — inherit its look.
      var best = null, bestD = Infinity;
      (lv.sectors || []).forEach(function (s) {
        var b = window.EdModel.sectorBBox(s);
        var d = Math.hypot((b.x0 + b.x1) / 2 - x, (b.z0 + b.z1) / 2 - z);
        if (d < bestD) { bestD = d; best = s; }
      });
      return best;
    }

    function commitSector() {
      if (pts.length < 3) { pts = []; map.requestRedraw(); return; }
      var poly = pts.slice();
      pts = [];
      var cx = 0, cz = 0;
      poly.forEach(function (p) { cx += p[0]; cz += p[1]; });
      cx /= poly.length; cz /= poly.length;
      var nb = neighbourSector(cx, cz);
      ed.apply(function (lv) {
        var sec = {
          id: 'sec_' + (lv.sectors || []).length,
          polys: [poly],
          area: 0,
          floorY: nb ? nb.floorY : 0,
          ceilY: nb ? nb.ceilY : 6.4,
          floorTex: sectorOpts.floorTex,
          ceilTex: sectorOpts.ceilTex,
          light: nb ? nb.light : 0.6,
          isSky: false,
          x: 0, z: 0, width: 0, depth: 0
        };
        window.EdModel.refreshSector(sec);
        (lv.sectors = lv.sectors || []).push(sec);
        // A sector without walls has no collision, so give every edge one.
        for (var i = 0; i < poly.length; i++) {
          var a = poly[i], b = poly[(i + 1) % poly.length];
          window.EdModel.addWall(lv, {
            p1: [a[0], a[1]], p2: [b[0], b[1]],
            bottomY: sec.floorY, topY: sec.ceilY, h: sec.ceilY - sec.floorY,
            tex: 'cyber_rust', solid: true
          });
        }
      }, 'draw sector');
      ed.select('sector', ed.level.sectors.length - 1);
    }

    ed.registerTool({
      id: 'sector', title: 'Sector', key: '2', glyph: '◱',
      onActivate: function () { pts = []; },
      onDeactivate: function () { pts = []; },
      options: function (host) {
        host.appendChild(el('span', null, 'floor'));
        host.appendChild(select(TEX_FLOOR.map(function (t) { return { value: t, label: t }; }),
          sectorOpts.floorTex, function (v) { sectorOpts.floorTex = v; }));
        host.appendChild(el('span', null, 'ceil'));
        host.appendChild(select(TEX_FLOOR.map(function (t) { return { value: t, label: t }; }),
          sectorOpts.ceilTex, function (v) { sectorOpts.ceilTex = v; }));
        var done = el('button', null, 'Close polygon');
        done.addEventListener('click', commitSector);
        host.appendChild(done);
        host.appendChild(el('span', { class: 'ed-tag' }, 'click to add points, click the first point or Enter to close, Esc to cancel'));
      },
      onPointerDown: function (e, world) {
        if (!ed.level) return;
        var p = map.snapPoint(world.x, world.z);
        if (e.button === 2) { commitSector(); return; }
        if (pts.length >= 3) {
          var f = pts[0];
          if (Math.hypot(f[0] - p.x, f[1] - p.z) * map.view.scale < 10) { commitSector(); return; }
        }
        pts.push([p.x, p.z]);
        map.requestRedraw();
      },
      onPointerMove: function () { map.requestRedraw(); },
      onKey: function (k) {
        if (k === 'Enter') { commitSector(); return true; }
        if (k === 'Escape') { pts = []; map.requestRedraw(); return true; }
        return false;
      },
      draw: function (ctx) {
        if (!pts.length) return;
        ctx.strokeStyle = '#00ffee';
        ctx.fillStyle = '#00ffee22';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        var s = map.worldToScreen(pts[0][0], pts[0][1]);
        ctx.moveTo(s.x, s.y);
        for (var i = 1; i < pts.length; i++) {
          s = map.worldToScreen(pts[i][0], pts[i][1]);
          ctx.lineTo(s.x, s.y);
        }
        var m = map.snapPoint(map.mouseWorld.x, map.mouseWorld.z);
        var ms = map.worldToScreen(m.x, m.z);
        ctx.lineTo(ms.x, ms.y);
        ctx.stroke();
        if (pts.length > 2) { ctx.closePath(); ctx.fill(); }
        ctx.fillStyle = '#00ffee';
        for (i = 0; i < pts.length; i++) {
          s = map.worldToScreen(pts[i][0], pts[i][1]);
          ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
        }
      }
    });

    /* ---- Wall ------------------------------------------------------------ */
    var wallStart = null;
    var wallOpts = { tex: 'cyber_rust', isDoor: false, isSwitch: false, ledge: false, exit: false };

    ed.registerTool({
      id: 'wall', title: 'Wall', key: '3', glyph: '╱',
      onActivate: function () { wallStart = null; },
      onDeactivate: function () { wallStart = null; },
      options: function (host) {
        host.appendChild(el('span', null, 'tex'));
        host.appendChild(select(TEX_WALL.map(function (t) { return { value: t, label: t }; }),
          wallOpts.tex, function (v) { wallOpts.tex = v; }));
        ['isDoor', 'isSwitch', 'ledge', 'exit'].forEach(function (flag) {
          var lab = el('label');
          var cb = el('input', { type: 'checkbox' });
          cb.checked = !!wallOpts[flag];
          cb.addEventListener('change', function () { wallOpts[flag] = cb.checked; });
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(flag === 'isSwitch' ? 'switch' : (flag === 'isDoor' ? 'door' : flag)));
          host.appendChild(lab);
        });
        host.appendChild(el('span', { class: 'ed-tag' }, 'click-click to add a wall; right-click a wall to split it'));
      },
      onPointerDown: function (e, world, screen) {
        if (!ed.level) return;
        if (e.button === 2) {
          var hit = map.pick(screen.px, screen.py);
          if (hit && hit.kind === 'wall') splitWall(hit.index, map.snapPoint(world.x, world.z));
          return;
        }
        var p = map.snapPoint(world.x, world.z);
        if (!wallStart) { wallStart = [p.x, p.z]; map.requestRedraw(); return; }
        var a = wallStart, b = [p.x, p.z];
        wallStart = null;
        if (a[0] === b[0] && a[1] === b[1]) { map.requestRedraw(); return; }
        var si = window.EdModel.sectorAt(ed.level, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        var sec = si >= 0 ? ed.level.sectors[si] : null;
        ed.apply(function (lv) {
          var w = {
            p1: a, p2: b,
            bottomY: sec ? sec.floorY : 0,
            topY: sec ? sec.ceilY : 6.4,
            h: (sec ? sec.ceilY - sec.floorY : 6.4),
            tex: wallOpts.exit ? 'switch_off' : (wallOpts.isDoor ? 'door_blast' : wallOpts.tex),
            solid: !wallOpts.ledge
          };
          if (wallOpts.isDoor) { w.isDoor = true; w.doorId = 'door_ed' + lv.walls.length; w.closed = true; }
          if (wallOpts.isSwitch || wallOpts.exit) {
            w.isSwitch = true;
            w.switchId = wallOpts.exit ? 'sw_exit_game' : ('sw_ed' + lv.walls.length);
          }
          if (wallOpts.ledge) { w.ledge = true; w.loFloor = (sec ? sec.floorY : 0); w.hiFloor = (sec ? sec.floorY : 0) + 1.6; }
          window.EdModel.addWall(lv, w);
        }, 'add wall');
        ed.select('wall', ed.level.walls.length - 1);
      },
      onPointerMove: function (e, world, screen) { map.updateHover(screen.px, screen.py); map.requestRedraw(); },
      onKey: function (k) { if (k === 'Escape') { wallStart = null; map.requestRedraw(); return true; } return false; },
      draw: function (ctx) {
        if (!wallStart) return;
        var a = map.worldToScreen(wallStart[0], wallStart[1]);
        var m = map.snapPoint(map.mouseWorld.x, map.mouseWorld.z);
        var b = map.worldToScreen(m.x, m.z);
        ctx.strokeStyle = '#00ffee';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    });

    /* Splits wall[i] at p. Both halves keep the same `ai` linedef id, which is
       what the engine wants: byLine maps one linedef to one runtime trigger, so
       two halves of a split switch share one action and a one-shot still fires
       once. trigger.i is a linedef id and must NOT be renumbered. */
    function splitWall(i, p) {
      ed.apply(function (lv) {
        var w = lv.walls[i];
        var second = JSON.parse(JSON.stringify(w));
        second.p1 = [p.x, p.z];
        w.p2 = [p.x, p.z];
        lv.walls.splice(i + 1, 0, second);
      }, 'split wall');
      ed.toast('wall ' + i + ' split');
    }

    /* ---- Entity ---------------------------------------------------------- */
    var entOpts = { pick: 'enemy:3004', weapon: 'shotgun' };

    function entityChoices() {
      var out = [];
      ENEMY_TYPES.forEach(function (t) { out.push({ value: 'enemy:' + t[0], label: t[1] + ' (' + t[0] + ')' }); });
      PICKUPS.forEach(function (p) { out.push({ value: 'item:' + p.type, label: p.label }); });
      (ed.customEnemies() || []).forEach(function (c) {
        out.push({ value: 'custom:' + c.id, label: 'custom: ' + (c.name || c.id) });
      });
      return out;
    }

    ed.registerTool({
      id: 'entity', title: 'Entity', key: '4', glyph: '◉',
      options: function (host) {
        host.appendChild(el('span', null, 'type'));
        host.appendChild(select(entityChoices(), entOpts.pick, function (v) { entOpts.pick = v; }));
        host.appendChild(el('span', null, 'weapon'));
        host.appendChild(select(WEAPON_NAMES.map(function (w) { return { value: w, label: w }; }),
          entOpts.weapon, function (v) { entOpts.weapon = v; }));
        host.appendChild(el('span', { class: 'ed-tag' }, 'click to place'));
      },
      onPointerDown: function (e, world) {
        if (!ed.level) return;
        var p = map.snapPoint(world.x, world.z);
        var si = window.EdModel.sectorAt(ed.level, p.x, p.z);
        var y = si >= 0 ? ed.level.sectors[si].floorY : 0;
        var parts = entOpts.pick.split(':');
        ed.apply(function (lv) {
          var ent;
          if (parts[0] === 'enemy') {
            ent = { type: 'soldier', enemyType: parseInt(parts[1], 10), pos: [p.x, y, p.z], rot: 0 };
          } else if (parts[0] === 'custom') {
            ent = { type: 'soldier', enemyType: 'custom:' + parts[1], pos: [p.x, y, p.z], rot: 0 };
          } else {
            ent = { type: parts[1], pos: [p.x, y, p.z], rot: 0 };
            if (parts[1] === 'weapon') ent.name = entOpts.weapon;
          }
          (lv.entities = lv.entities || []).push(ent);
        }, 'place entity');
        ed.select('entity', ed.level.entities.length - 1);
      },
      onPointerMove: function (e, world, screen) { map.updateHover(screen.px, screen.py); }
    });

    /* ---- Trigger --------------------------------------------------------- */
    var trigOpts = { kind: 'lift', trig: 'use', rep: true };

    ed.registerTool({
      id: 'trigger', title: 'Trigger', key: '5', glyph: '⚙',
      options: function (host) {
        host.appendChild(el('span', null, 'kind'));
        host.appendChild(select(['lift', 'floor', 'tele', 'door'].map(function (k) { return { value: k, label: k }; }),
          trigOpts.kind, function (v) { trigOpts.kind = v; }));
        host.appendChild(el('span', null, 'trig'));
        host.appendChild(select(['use', 'walk', 'gun'].map(function (k) { return { value: k, label: k }; }),
          trigOpts.trig, function (v) { trigOpts.trig = v; }));
        var lab = el('label');
        var cb = el('input', { type: 'checkbox' });
        cb.checked = trigOpts.rep;
        cb.addEventListener('change', function () { trigOpts.rep = cb.checked; });
        lab.appendChild(cb); lab.appendChild(document.createTextNode('repeatable'));
        host.appendChild(lab);
        host.appendChild(el('span', { class: 'ed-tag' }, 'click a wall to bind a trigger; params in Properties'));
      },
      onPointerDown: function (e, world, screen) {
        if (!ed.level) return;
        var hit = map.pick(screen.px, screen.py);
        if (!hit || hit.kind !== 'wall') { ed.toast('click a wall', 'bad'); return; }
        var target = window.EdModel.sectorAt(ed.level, world.x, world.z);
        ed.apply(function (lv) {
          var act = { kind: trigOpts.kind, trig: trigOpts.trig, rep: trigOpts.rep };
          if (trigOpts.kind === 'lift') { act.wait = 1.75; act.speed = 8; act.secs = target >= 0 ? [target] : []; }
          else if (trigOpts.kind === 'floor') { act.to = 'lowestNeighbour'; act.direction = 'down'; act.amt = 0; act.fast = false; act.secs = target >= 0 ? [target] : []; }
          else if (trigOpts.kind === 'door') { act.local = false; }
          window.EdModel.setTrigger(lv, hit.index, act);
        }, 'add trigger');
        ed.select('trigger', window.EdModel.triggerFor(ed.level, hit.index));
      },
      onPointerMove: function (e, world, screen) { map.updateHover(screen.px, screen.py); }
    });

    /* ---- Spawn ----------------------------------------------------------- */
    ed.registerTool({
      id: 'spawn', title: 'Spawn', key: '6', glyph: '⚑',
      options: function (host) {
        host.appendChild(el('span', { class: 'ed-tag' }, 'click to move the player start; shift-click to aim it there'));
      },
      onPointerDown: function (e, world) {
        if (!ed.level) return;
        var p = map.snapPoint(world.x, world.z);
        if (e.shiftKey) {
          var sp = ed.level.playerSpawn;
          var ang = Math.atan2(p.x - sp.pos[0], p.z - sp.pos[2]);
          ed.apply(function (lv) { lv.playerSpawn.rot = Math.round(ang * 1000) / 1000; }, 'aim spawn');
          return;
        }
        var si = window.EdModel.sectorAt(ed.level, p.x, p.z);
        var y = (si >= 0 ? ed.level.sectors[si].floorY : 0) + 1.5;
        ed.apply(function (lv) {
          lv.playerSpawn = lv.playerSpawn || { pos: [0, 1.5, 0], rot: 0 };
          lv.playerSpawn.pos = [p.x, y, p.z];
        }, 'move spawn');
        ed.select('spawn', 0);
      }
    });
  }

  window.EdTools = {
    install: install,
    ENEMY_TYPES: ENEMY_TYPES,
    PICKUPS: PICKUPS,
    WEAPON_NAMES: WEAPON_NAMES,
    TEX_FLOOR: TEX_FLOOR,
    TEX_WALL: TEX_WALL
  };
})();
