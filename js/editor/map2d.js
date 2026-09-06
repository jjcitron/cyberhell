/* ===========================================================================
   map2d.js — the top-down map canvas: view transform, drawing, hit testing.

   Pointer events are dispatched to the active tool; this file only owns pan
   (middle-drag or space-drag), wheel zoom, and the redraw. Redraws are
   coalesced through requestAnimationFrame.
   =========================================================================== */
(function () {
  'use strict';

  var GRID_MIN_PX = 14;   // never draw a grid finer than this on screen

  function Map2D(canvas, ed) {
    this.canvas = canvas;
    this.ed = ed;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cz: 0, scale: 8 };   // px per world unit
    this.grid = 1.6;                          // world units (half a Doom 32-unit block)
    this.snap = true;
    this.show = { sectors: true, walls: true, entities: true, triggers: true, grid: true };
    this.hover = null;                        // {kind,index}
    this.mouseWorld = { x: 0, z: 0 };
    this.spaceDown = false;
    this._raf = 0;
    this._pan = null;
    this._bind();
    this.resize();
  }

  /* ---- view ------------------------------------------------------------- */

  Map2D.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.w = r.width;
    this.h = r.height;
    this.requestRedraw();
  };

  Map2D.prototype.worldToScreen = function (x, z) {
    return { x: (x - this.view.cx) * this.view.scale + this.w / 2,
             y: (z - this.view.cz) * this.view.scale + this.h / 2 };
  };

  Map2D.prototype.screenToWorld = function (px, py) {
    return { x: (px - this.w / 2) / this.view.scale + this.view.cx,
             z: (py - this.h / 2) / this.view.scale + this.view.cz };
  };

  Map2D.prototype.snapPoint = function (x, z) {
    if (!this.snap) return { x: x, z: z };
    var g = this.grid;
    return { x: Math.round(x / g) * g, z: Math.round(z / g) * g };
  };

  Map2D.prototype.fit = function (level) {
    if (!level) return;
    var b = window.EdModel.levelBounds(level);
    var pad = 4;
    var sx = this.w / Math.max(1, (b.x1 - b.x0) + pad * 2);
    var sz = this.h / Math.max(1, (b.z1 - b.z0) + pad * 2);
    this.view.scale = Math.max(0.4, Math.min(sx, sz));
    this.view.cx = (b.x0 + b.x1) / 2;
    this.view.cz = (b.z0 + b.z1) / 2;
    this.requestRedraw();
  };

  Map2D.prototype.zoomAt = function (px, py, factor) {
    var before = this.screenToWorld(px, py);
    this.view.scale = Math.max(0.3, Math.min(200, this.view.scale * factor));
    var after = this.screenToWorld(px, py);
    this.view.cx += before.x - after.x;
    this.view.cz += before.z - after.z;
    this.requestRedraw();
  };

  /* ---- events ----------------------------------------------------------- */

  Map2D.prototype._bind = function () {
    var self = this, c = this.canvas;

    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = c.getBoundingClientRect();
      self.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    c.addEventListener('pointerdown', function (e) {
      c.setPointerCapture(e.pointerId);
      var p = self._local(e);
      if (e.button === 1 || (e.button === 0 && self.spaceDown)) {
        self._pan = { px: p.px, py: p.py, cx: self.view.cx, cz: self.view.cz };
        c.classList.add('panning');
        return;
      }
      var tool = self.ed.activeTool;
      if (tool && tool.onPointerDown) tool.onPointerDown(e, self.screenToWorld(p.px, p.py), p);
    });

    c.addEventListener('pointermove', function (e) {
      var p = self._local(e);
      var w = self.screenToWorld(p.px, p.py);
      self.mouseWorld = w;
      if (self._pan) {
        self.view.cx = self._pan.cx - (p.px - self._pan.px) / self.view.scale;
        self.view.cz = self._pan.cz - (p.py - self._pan.py) / self.view.scale;
        self.requestRedraw();
        self.ed._status();
        return;
      }
      var tool = self.ed.activeTool;
      if (tool && tool.onPointerMove) tool.onPointerMove(e, w, p);
      else self.updateHover(p.px, p.py);
      self.ed._status();
    });

    function up(e) {
      if (self._pan) { self._pan = null; c.classList.remove('panning'); return; }
      var p = self._local(e);
      var tool = self.ed.activeTool;
      if (tool && tool.onPointerUp) tool.onPointerUp(e, self.screenToWorld(p.px, p.py), p);
    }
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', function () { self._pan = null; c.classList.remove('panning'); });

    window.addEventListener('resize', function () { self.resize(); });
  };

  Map2D.prototype._local = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  /* ---- hit testing ------------------------------------------------------ */

  function distToSeg(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* Priority: entity glyph > spawn > wall segment > sector fill. */
  Map2D.prototype.pick = function (px, py) {
    var level = this.ed.level;
    if (!level) return null;
    var i, s;

    if (this.show.entities) {
      var ents = level.entities || [];
      for (i = ents.length - 1; i >= 0; i--) {
        s = this.worldToScreen(ents[i].pos[0], ents[i].pos[2]);
        if (Math.abs(s.x - px) <= 7 && Math.abs(s.y - py) <= 7) return { kind: 'entity', index: i };
      }
    }

    if (level.playerSpawn) {
      s = this.worldToScreen(level.playerSpawn.pos[0], level.playerSpawn.pos[2]);
      if (Math.abs(s.x - px) <= 9 && Math.abs(s.y - py) <= 9) return { kind: 'spawn', index: 0 };
    }

    if (this.show.walls) {
      var walls = level.walls || [], best = null, bestD = 7;
      for (i = 0; i < walls.length; i++) {
        var a = this.worldToScreen(walls[i].p1[0], walls[i].p1[1]);
        var b = this.worldToScreen(walls[i].p2[0], walls[i].p2[1]);
        if (Math.min(a.x, b.x) - bestD > px || Math.max(a.x, b.x) + bestD < px) continue;
        if (Math.min(a.y, b.y) - bestD > py || Math.max(a.y, b.y) + bestD < py) continue;
        var d = distToSeg(px, py, a.x, a.y, b.x, b.y);
        if (d < bestD) { bestD = d; best = { kind: 'wall', index: i }; }
      }
      if (best) return best;
    }

    if (this.show.sectors) {
      var w = this.screenToWorld(px, py);
      var si = window.EdModel.sectorAt(level, w.x, w.z);
      if (si >= 0) return { kind: 'sector', index: si };
    }
    return null;
  };

  /* Nearest sector vertex within grab range: {sector, poly, point, dist}. */
  Map2D.prototype.pickVertex = function (px, py, range) {
    var level = this.ed.level;
    if (!level || !level.sectors) return null;
    range = range || 8;
    var best = null;
    for (var i = 0; i < level.sectors.length; i++) {
      var polys = level.sectors[i].polys;
      if (!polys) continue;
      for (var j = 0; j < polys.length; j++) {
        for (var k = 0; k < polys[j].length; k++) {
          var s = this.worldToScreen(polys[j][k][0], polys[j][k][1]);
          var d = Math.hypot(s.x - px, s.y - py);
          if (d <= range && (!best || d < best.dist)) best = { sector: i, poly: j, point: k, dist: d };
        }
      }
    }
    return best;
  };

  Map2D.prototype.updateHover = function (px, py) {
    var h = this.pick(px, py);
    var same = (h && this.hover && h.kind === this.hover.kind && h.index === this.hover.index) || (!h && !this.hover);
    this.hover = h;
    if (!same) this.requestRedraw();
  };

  /* ---- drawing ---------------------------------------------------------- */

  Map2D.prototype.requestRedraw = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(); });
  };

  function floorColor(sec) {
    // Hue by floor height so stairs/lifts read at a glance, value by sector light.
    var y = sec.floorY || 0;
    var hue = (200 + y * 9) % 360;
    var light = Math.max(0.12, Math.min(1, sec.light == null ? 0.6 : sec.light));
    return 'hsl(' + hue.toFixed(0) + ',34%,' + (7 + light * 20).toFixed(0) + '%)';
  }

  Map2D.prototype.draw = function () {
    var ctx = this.ctx, level = this.ed.level;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.show.grid) this._drawGrid(ctx);
    if (!level) { this._drawEmpty(ctx); return; }

    var sel = this.ed.selection, i;
    var multi = this.ed.multi || [];
    function isSel(kind, idx) {
      if (sel && sel.kind === kind && sel.index === idx) return true;
      for (var m = 0; m < multi.length; m++) if (multi[m].kind === kind && multi[m].index === idx) return true;
      return false;
    }

    if (this.show.sectors) this._drawSectors(ctx, level, isSel);
    if (this.show.walls) this._drawWalls(ctx, level, isSel);
    if (this.show.triggers) this._drawTriggers(ctx, level, isSel);
    if (this.show.entities) this._drawEntities(ctx, level, isSel);
    this._drawSpawn(ctx, level, isSel);

    var tool = this.ed.activeTool;
    if (tool && tool.draw) tool.draw(ctx, this);

    // hover ring
    if (this.hover) this._outline(ctx, this.hover, '#ffffff55', 1);
  };

  Map2D.prototype._drawEmpty = function (ctx) {
    ctx.fillStyle = '#33465c';
    ctx.font = '13px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No level open — File > New level, or open one from the Pack panel.', this.w / 2, this.h / 2);
    ctx.textAlign = 'left';
  };

  Map2D.prototype._drawGrid = function (ctx) {
    var g = this.grid;
    while (g * this.view.scale < GRID_MIN_PX) g *= 2;
    var tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.w, this.h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#0d141f';
    ctx.beginPath();
    var x, z;
    for (x = Math.floor(tl.x / g) * g; x <= br.x; x += g) {
      var sx = Math.round(this.worldToScreen(x, 0).x) + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h);
    }
    for (z = Math.floor(tl.z / g) * g; z <= br.z; z += g) {
      var sy = Math.round(this.worldToScreen(0, z).y) + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(this.w, sy);
    }
    ctx.stroke();
    // origin cross
    ctx.strokeStyle = '#17293d';
    ctx.beginPath();
    var o = this.worldToScreen(0, 0);
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.h);
    ctx.moveTo(0, o.y); ctx.lineTo(this.w, o.y);
    ctx.stroke();
  };

  Map2D.prototype._sectorPath = function (ctx, sec) {
    var polys = window.EdModel.sectorPolys(sec);
    ctx.beginPath();
    for (var j = 0; j < polys.length; j++) {
      var poly = polys[j];
      if (poly.length < 3) continue;
      var s = this.worldToScreen(poly[0][0], poly[0][1]);
      ctx.moveTo(s.x, s.y);
      for (var k = 1; k < poly.length; k++) {
        s = this.worldToScreen(poly[k][0], poly[k][1]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
    }
  };

  Map2D.prototype._drawSectors = function (ctx, level, isSel) {
    var secs = level.sectors || [];
    for (var i = 0; i < secs.length; i++) {
      var b = window.EdModel.sectorBBox(secs[i]);
      var a = this.worldToScreen(b.x0, b.z0), c = this.worldToScreen(b.x1, b.z1);
      if (c.x < -4 || a.x > this.w + 4 || c.y < -4 || a.y > this.h + 4) continue;
      this._sectorPath(ctx, secs[i]);
      ctx.fillStyle = floorColor(secs[i]);
      ctx.fill('evenodd');
      if (isSel('sector', i)) {
        ctx.strokeStyle = '#00ffee';
        ctx.lineWidth = 2;
        ctx.stroke();
        // vertices, so they can be grabbed
        var polys = secs[i].polys || [];
        ctx.fillStyle = '#00ffee';
        for (var j = 0; j < polys.length; j++) {
          for (var k = 0; k < polys[j].length; k++) {
            var s = this.worldToScreen(polys[j][k][0], polys[j][k][1]);
            ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
          }
        }
      }
    }
  };

  function wallColor(w) {
    if (w.isSwitch) return w.switchId === 'sw_exit_game' ? '#00ff66' : '#ffcc00';
    if (w.isDoor) return '#ff6600';
    if (w.ledge) return '#8866ff';
    if (!w.solid) return '#3a4a60';
    return '#7f93ad';
  }

  Map2D.prototype._drawWalls = function (ctx, level, isSel) {
    var walls = level.walls || [];
    ctx.lineWidth = 1.5;
    var grouped = {};
    for (var i = 0; i < walls.length; i++) {
      var a = this.worldToScreen(walls[i].p1[0], walls[i].p1[1]);
      var b = this.worldToScreen(walls[i].p2[0], walls[i].p2[1]);
      if (Math.max(a.x, b.x) < -4 || Math.min(a.x, b.x) > this.w + 4) continue;
      if (Math.max(a.y, b.y) < -4 || Math.min(a.y, b.y) > this.h + 4) continue;
      if (isSel('wall', i)) continue;
      var col = wallColor(walls[i]);
      (grouped[col] || (grouped[col] = [])).push([a, b]);
    }
    Object.keys(grouped).forEach(function (col) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      var segs = grouped[col];
      for (var k = 0; k < segs.length; k++) {
        ctx.moveTo(segs[k][0].x, segs[k][0].y);
        ctx.lineTo(segs[k][1].x, segs[k][1].y);
      }
      ctx.stroke();
    });
    // selected walls on top, fat
    ctx.strokeStyle = '#00ffee';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    for (i = 0; i < walls.length; i++) {
      if (!isSel('wall', i)) continue;
      var sa = this.worldToScreen(walls[i].p1[0], walls[i].p1[1]);
      var sb = this.worldToScreen(walls[i].p2[0], walls[i].p2[1]);
      ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y);
    }
    ctx.stroke();
  };

  var TRIG_LETTER = { lift: 'L', floor: 'F', tele: 'T', door: 'D' };

  /* trigger.i is a Doom linedef id; a wall claims it through wall.ai. Cached
     per level so the badge loop stays O(walls + triggers). */
  Map2D.prototype._lineIndex = function (level) {
    if (this._lineCacheFor === level && this._lineCacheLen === (level.walls || []).length) return this._lineCache;
    var map = {};
    (level.walls || []).forEach(function (w) { if (w.ai !== undefined && !map[w.ai]) map[w.ai] = w; });
    this._lineCache = map;
    this._lineCacheFor = level;
    this._lineCacheLen = (level.walls || []).length;
    return map;
  };

  Map2D.prototype._drawTriggers = function (ctx, level, isSel) {
    var trs = level.triggers || [];
    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var byLine = this._lineIndex(level);
    for (var i = 0; i < trs.length; i++) {
      var w = byLine[trs[i].i];
      if (!w) continue;
      var a = this.worldToScreen(w.p1[0], w.p1[1]), b = this.worldToScreen(w.p2[0], w.p2[1]);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (mx < -8 || mx > this.w + 8 || my < -8 || my > this.h + 8) continue;
      var kind = (trs[i].act && trs[i].act.kind) || '?';
      ctx.fillStyle = isSel('trigger', i) ? '#00ffee' : '#1b2b3f';
      ctx.strokeStyle = isSel('trigger', i) ? '#00ffee' : '#ffcc00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = isSel('trigger', i) ? '#04222a' : '#ffcc00';
      ctx.fillText(TRIG_LETTER[kind] || '?', mx, my + 0.5);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  };

  var ENT_STYLE = {
    soldier:      { c: '#ff3355', g: 'o' },
    monster:      { c: '#ff3355', g: 'o' },
    weapon:       { c: '#00ffee', g: 'W' },
    ammo_bullets: { c: '#cccc00', g: 'a' },
    ammo_shells:  { c: '#ff6600', g: 'a' },
    ammo_energy:  { c: '#00ffee', g: 'a' },
    health_stim:  { c: '#44dd88', g: '+' },
    armor:        { c: '#3388ff', g: 'A' },
    barrel:       { c: '#aa7722', g: 'b' }
  };

  Map2D.prototype._drawEntities = function (ctx, level, isSel) {
    var ents = level.entities || [];
    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < ents.length; i++) {
      var s = this.worldToScreen(ents[i].pos[0], ents[i].pos[2]);
      if (s.x < -8 || s.x > this.w + 8 || s.y < -8 || s.y > this.h + 8) continue;
      var st = ENT_STYLE[ents[i].type] || { c: '#c8d6e5', g: '?' };
      var on = isSel('entity', i);
      ctx.fillStyle = on ? '#00ffee' : '#0a0f18';
      ctx.strokeStyle = on ? '#00ffee' : st.c;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = on ? '#04222a' : st.c;
      ctx.fillText(st.g, s.x, s.y + 0.5);
      if (typeof ents[i].rot === 'number') {
        ctx.strokeStyle = on ? '#00ffee' : st.c;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + Math.sin(ents[i].rot) * 9, s.y + Math.cos(ents[i].rot) * 9);
        ctx.stroke();
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  };

  Map2D.prototype._drawSpawn = function (ctx, level, isSel) {
    var sp = level.playerSpawn;
    if (!sp) return;
    var s = this.worldToScreen(sp.pos[0], sp.pos[2]);
    var r = sp.rot || 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-r);
    ctx.fillStyle = isSel('spawn', 0) ? '#00ffee' : '#ffffff';
    ctx.strokeStyle = '#04060a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(7, 7); ctx.lineTo(0, 3); ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  Map2D.prototype._outline = function (ctx, sel, colour, width) {
    var level = this.ed.level;
    if (!level) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width || 1;
    var s;
    if (sel.kind === 'wall' && level.walls[sel.index]) {
      var w = level.walls[sel.index];
      var a = this.worldToScreen(w.p1[0], w.p1[1]), b = this.worldToScreen(w.p2[0], w.p2[1]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (sel.kind === 'sector' && level.sectors[sel.index]) {
      this._sectorPath(ctx, level.sectors[sel.index]);
      ctx.stroke();
    } else if (sel.kind === 'entity' && level.entities[sel.index]) {
      s = this.worldToScreen(level.entities[sel.index].pos[0], level.entities[sel.index].pos[2]);
      ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.stroke();
    }
  };

  window.EdMap2D = Map2D;
})();
