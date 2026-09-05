/* ==========================================================================
   Cyberhell traversal: moving sectors, teleporters, and the dead-end net.
   --------------------------------------------------------------------------
   Doom moves the player between floor heights with lifts, switch-raised
   floors and teleporters.  The engine had none of them, so every pocket you
   could only drop into was a dead end -- which is exactly what "stuck in a
   room with no exit" was.  convert_all_wads.py now exports each linedef's
   action as `wall.act` and each sector's reachable floor-height envelope as
   `sector.loY` / `sector.hiY`; this file is the only thing that reads them.

   Two halves, one file on purpose:

     MODEL   a walk graph over a cell grid, shared verbatim by the runtime
             safety net and by tests/reachability.js (which requires this
             file).  One implementation means the offline model and the
             engine cannot drift apart -- the whole point of the net.

     RUNTIME window.CyberTraversal, driven by index.html: animates sector
             floors, fires walkover/use actions, teleports, and offers an
             extraction when the player is somewhere the exit is unreachable
             from.

   Loads in the browser (window.CyberTraversal) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CyberTraversal = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------------ model */

  const P_RADIUS = 0.55;
  // Doom's free auto-climb is 24 map units; the WAD->engine scale is 0.05.
  // Same constant as STEP_UP_MAX in index.html.  Drops are unlimited, so the
  // walk graph is DIRECTED.
  const STEP_UP_MAX = 1.2;
  // Reach of interact(): require the player to get meaningfully close, not
  // just to have line of sight from across a chasm.
  const USE_RANGE = 4.0;
  const MODEL_CELL = 0.25;   // offline tests: fine enough to resolve doorways
  const NET_CELL = 1.0;      // in-browser safety net: 16x cheaper to build

  function segDist(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az;
    const wx = px - ax, wz = pz - az;
    const c1 = wx * vx + wz * vz;
    if (c1 <= 0) return Math.hypot(px - ax, pz - az);
    const c2 = vx * vx + vz * vz;
    if (c2 <= c1) return Math.hypot(px - bx, pz - bz);
    const t = c1 / c2;
    return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
  }

  function wallPoints(w) {
    const g = (p, i, k) => (p[k] !== undefined ? p[k] : p[i]);
    return [g(w.p1, 0, 'x'), g(w.p1, 1, 'z'), g(w.p2, 0, 'x'), g(w.p2, 1, 'z')];
  }

  function pointInPolys(x, z, polys) {
    let inside = false;
    for (const loop of polys) {
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  function loopsBounds(polys) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const loop of polys) for (const [x, z] of loop) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return [minX, minZ, maxX, maxZ];
  }

  function sectorPolys(level) {
    const out = [];
    for (const sec of level.sectors || []) if (sec.polys && sec.polys.length) out.push(sec.polys);
    return out;
  }

  function floorRects(level) {
    const rects = [];
    for (const sec of level.sectors || []) {
      if (sec.floors && sec.floors.length) for (const r of sec.floors) rects.push(r);
      else if (sec.width !== undefined) rects.push({ x: sec.x, z: sec.z, width: sec.width, depth: sec.depth });
    }
    return rects;
  }

  // Walls that actually stop the player.  Doors open on approach; step risers
  // are already flagged non-solid by the converter (height is the gate).
  function blockingWalls(level) {
    return (level.walls || []).filter(w => w.solid && !w.isDoor).map(wallPoints);
  }

  function exitWalls(level) {
    return (level.walls || []).filter(w => w.isSwitch && w.switchId === 'sw_exit_game');
  }

  function teleLines(level) {
    return (level.walls || []).filter(w => w.act && w.act.kind === 'tele' && w.act.dest);
  }

  /* Plan-view bounds of a sector, padded by an enemy radius, cached on the
     sector. Used to decide which enemies a moving floor can possibly affect. */
  function secBox(sec) {
    if (sec._tbb) return sec._tbb;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    if (sec.polys) {
      for (const loop of sec.polys) for (const pt of loop) {
        if (pt[0] < x0) x0 = pt[0];
        if (pt[0] > x1) x1 = pt[0];
        if (pt[1] < z0) z0 = pt[1];
        if (pt[1] > z1) z1 = pt[1];
      }
    }
    if (!(x0 < x1) && sec.x !== undefined && sec.width !== undefined) {
      x0 = sec.x - sec.width / 2; x1 = sec.x + sec.width / 2;
      z0 = sec.z - sec.depth / 2; z1 = sec.z + sec.depth / 2;
    }
    if (!(x0 < x1)) { x0 = -Infinity; z0 = -Infinity; x1 = Infinity; z1 = Infinity; }
    return (sec._tbb = [x0 - 1.5, z0 - 1.5, x1 + 1.5, z1 + 1.5]);
  }

  // The floor-height envelope of a sector: the lowest and highest its floor
  // can ever be, given every lift / raise / lower that targets it.  Absent
  // keys mean a static floor.
  function sectorLo(sec) { return sec.loY !== undefined ? Math.min(sec.loY, sec.floorY) : sec.floorY; }
  function sectorHi(sec) { return sec.hiY !== undefined ? Math.max(sec.hiY, sec.floorY) : sec.floorY; }

  class Grid {
    constructor(level, cell) {
      this.cell = cell || MODEL_CELL;
      const CELL = this.cell;
      const polySectors = sectorPolys(level);
      const rects = polySectors.length ? [] : floorRects(level);
      if (!rects.length && !polySectors.length) throw new Error('level has no floor geometry');

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const r of rects) {
        minX = Math.min(minX, r.x - r.width / 2); maxX = Math.max(maxX, r.x + r.width / 2);
        minZ = Math.min(minZ, r.z - r.depth / 2); maxZ = Math.max(maxZ, r.z + r.depth / 2);
      }
      for (const polys of polySectors) {
        const [a, b, c, d] = loopsBounds(polys);
        minX = Math.min(minX, a); minZ = Math.min(minZ, b);
        maxX = Math.max(maxX, c); maxZ = Math.max(maxZ, d);
      }
      this.minX = minX - 1; this.minZ = minZ - 1;
      this.w = Math.ceil((maxX - minX + 2) / CELL);
      this.h = Math.ceil((maxZ - minZ + 2) / CELL);
      const N = this.w * this.h;
      this.free = new Uint8Array(N);
      // lo/hi are the per-cell floor envelope.  A step is legal when the
      // destination floor CAN be brought within one auto-climb of the floor
      // we are standing on -- that single rule is lifts, raising floors and
      // ordinary stairs all at once.
      this.lo = new Float32Array(N);
      this.hi = new Float32Array(N);

      for (const r of rects) {
        const x0 = this.cx(r.x - r.width / 2), x1 = this.cx(r.x + r.width / 2);
        const z0 = this.cz(r.z - r.depth / 2), z1 = this.cz(r.z + r.depth / 2);
        for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++)
          for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) this.free[j * this.w + i] = 1;
      }
      for (const sec of level.sectors || []) {
        if (sec.polys && sec.polys.length) this.fillLoops(sec.polys, sectorLo(sec), sectorHi(sec));
      }
      // Rectangle levels (the hand-built MAP01) overlap their sectors on
      // purpose; take the HIGHEST floor covering a cell, matching getFloorAt.
      const written = new Uint8Array(N);
      for (const sec of level.sectors || []) {
        if (sec.polys && sec.polys.length) continue;
        const secRects = (sec.floors && sec.floors.length) ? sec.floors
          : (sec.width !== undefined ? [{ x: sec.x, z: sec.z, width: sec.width, depth: sec.depth }] : []);
        for (const r of secRects) {
          const x0 = this.cx(r.x - r.width / 2), x1 = this.cx(r.x + r.width / 2);
          const z0 = this.cz(r.z - r.depth / 2), z1 = this.cz(r.z + r.depth / 2);
          for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
            for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
              const k = j * this.w + i, y = sec.floorY || 0;
              if (!written[k] || y > this.hi[k]) { this.lo[k] = sectorLo(sec); this.hi[k] = sectorHi(sec); }
              written[k] = 1;
            }
          }
        }
      }

      const pad = Math.ceil(P_RADIUS / CELL) + 1;
      for (const [ax, az, bx, bz] of blockingWalls(level)) {
        const x0 = this.cx(Math.min(ax, bx)) - pad, x1 = this.cx(Math.max(ax, bx)) + pad;
        const z0 = this.cz(Math.min(az, bz)) - pad, z1 = this.cz(Math.max(az, bz)) + pad;
        for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
          for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
            const k = j * this.w + i;
            if (!this.free[k]) continue;
            if (segDist(this.wx(i), this.wz(j), ax, az, bx, bz) < P_RADIUS) this.free[k] = 0;
          }
        }
      }

      // Teleport edges: any free cell you can stand on while touching the
      // line jumps to the landing spot, height ignored.
      this.tele = new Map();
      this.teleRev = new Map();
      const tpad = Math.ceil((P_RADIUS + CELL) / CELL) + 1;
      for (const w of teleLines(level)) {
        const [ax, az, bx, bz] = wallPoints(w);
        const d = w.act.dest;
        const dk = this.nearestFree(d[0], d[1]);
        if (dk < 0) continue;
        const x0 = this.cx(Math.min(ax, bx)) - tpad, x1 = this.cx(Math.max(ax, bx)) + tpad;
        const z0 = this.cz(Math.min(az, bz)) - tpad, z1 = this.cz(Math.max(az, bz)) + tpad;
        for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
          for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
            const k = j * this.w + i;
            if (!this.free[k] || k === dk) continue;
            if (segDist(this.wx(i), this.wz(j), ax, az, bx, bz) > P_RADIUS + CELL) continue;
            this.tele.set(k, dk);
            let back = this.teleRev.get(dk);
            if (!back) this.teleRev.set(dk, back = []);
            back.push(k);
          }
        }
      }
    }

    // Even-odd scanline fill of one sector's loops.  Per-cell point-in-polygon
    // would be O(cells x edges) and take minutes on the megamaps.
    fillLoops(loops, lo, hi) {
      const CELL = this.cell;
      const buckets = new Array(this.h);
      const edges = [];
      for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const z1 = loop[j][1], z2 = loop[i][1];
          if (z1 === z2) continue;
          const e = edges.length;
          edges.push([loop[j][0], z1, loop[i][0], z2]);
          const r0 = Math.max(0, Math.ceil((Math.min(z1, z2) - this.minZ) / CELL));
          const r1 = Math.min(this.h - 1, Math.floor((Math.max(z1, z2) - this.minZ) / CELL));
          for (let r = r0; r <= r1; r++) (buckets[r] || (buckets[r] = [])).push(e);
        }
      }
      const xs = [];
      for (let j = 0; j < this.h; j++) {
        const b = buckets[j];
        if (!b) continue;
        const z = this.wz(j);
        xs.length = 0;
        for (const e of b) {
          const [ax, az, bx, bz] = edges[e];
          if ((az > z) === (bz > z)) continue;
          xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil((xs[k] - this.minX) / CELL));
          const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.minX) / CELL));
          for (let i = i0; i <= i1; i++) {
            const c = j * this.w + i;
            this.free[c] = 1;
            this.lo[c] = lo; this.hi[c] = hi;
          }
        }
      }
    }

    cx(x) { return Math.round((x - this.minX) / this.cell); }
    cz(z) { return Math.round((z - this.minZ) / this.cell); }
    wx(i) { return this.minX + i * this.cell; }
    wz(j) { return this.minZ + j * this.cell; }
    isFree(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i] === 1; }

    // A step is legal when the destination floor can be brought to within one
    // auto-climb of the floor we stand on.  For static floors that is the
    // plain Doom rule; for a lift or a raising floor it is the rule plus the
    // travel the sector can do.
    canStep(fromK, toK) { return this.lo[toK] - this.hi[fromK] <= STEP_UP_MAX + 1e-3; }

    nearestFree(x, z, maxR) {
      const s = this.snap(x, z, maxR);
      return s ? s[1] * this.w + s[0] : -1;
    }

    snap(x, z, maxR) {
      const R = maxR || Math.ceil(40 / this.cell);
      let i = this.cx(x), j = this.cz(z);
      if (this.isFree(i, j)) return [i, j];
      for (let r = 1; r <= R; r++) {
        for (let d = -r; d <= r; d++) {
          const cand = [[i + d, j - r], [i + d, j + r], [i - r, j + d], [i + r, j + d]];
          for (const [ci, cj] of cand) if (this.isFree(ci, cj)) return [ci, cj];
        }
      }
      return null;
    }

    // 4-connected flood, directed by canStep, plus one-way teleport edges.
    // CELL is small enough relative to the wall band that it cannot leak
    // diagonally through a wall.
    flood(si, sj) {
      const seen = new Uint8Array(this.w * this.h);
      const s0 = sj * this.w + si;
      const stack = [s0];
      seen[s0] = 1;
      let count = 0;
      while (stack.length) {
        const k = stack.pop();
        count++;
        const i = k % this.w, j = (k - i) / this.w;
        const nb = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
        for (const [ni, nj] of nb) {
          if (!this.isFree(ni, nj)) continue;
          const nk = nj * this.w + ni;
          if (seen[nk] || !this.canStep(k, nk)) continue;
          seen[nk] = 1; stack.push(nk);
        }
        const tk = this.tele.get(k);
        if (tk !== undefined && !seen[tk]) { seen[tk] = 1; stack.push(tk); }
      }
      return { seen, count };
    }

    /* Cells from which the exit is still reachable: the forward walk graph,
       run backwards from every cell that can operate the exit switch.  A cell
       outside this set can never reach the exit, whatever the player does --
       the envelope already contains every sector action the map has. */
    /* Steps to the exit from each cell, -1 where the exit cannot be reached
       at all: the forward walk graph run backwards from every cell that can
       operate the exit switch. -1 can never change, whatever the player does,
       because the envelope already contains every sector action the map has.
       The distance (not just the sign) is what lets the net notice a player
       who is somewhere legal but getting no closer. */
    canReachExit(level) {
      const targets = exitWalls(level).map(wallPoints);
      if (!targets.length) return null;
      const dist = new Int32Array(this.w * this.h).fill(-1);
      const stack = [];
      const pad = Math.ceil(USE_RANGE / this.cell) + 1;
      for (const [ax, az, bx, bz] of targets) {
        const x0 = this.cx(Math.min(ax, bx)) - pad, x1 = this.cx(Math.max(ax, bx)) + pad;
        const z0 = this.cz(Math.min(az, bz)) - pad, z1 = this.cz(Math.max(az, bz)) + pad;
        for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
          for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
            const k = j * this.w + i;
            if (!this.free[k] || dist[k] >= 0) continue;
            if (segDist(this.wx(i), this.wz(j), ax, az, bx, bz) > USE_RANGE) continue;
            dist[k] = 0; stack.push(k);
          }
        }
      }
      // Breadth first, so dist is a real step count rather than whatever a
      // stack happened to reach first.
      for (let head = 0; head < stack.length; head++) {
        const k = stack[head];
        const d = dist[k] + 1;
        const i = k % this.w, j = (k - i) / this.w;
        for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
          if (!this.isFree(ni, nj)) continue;
          const nk = nj * this.w + ni;
          if (dist[nk] >= 0 || !this.canStep(nk, k)) continue;   // reversed edge
          dist[nk] = d; stack.push(nk);
        }
        const back = this.teleRev.get(k);
        if (back) for (const bk of back) if (dist[bk] < 0) { dist[bk] = d; stack.push(bk); }
      }
      return dist;
    }
  }

  /* ---------------------------------------------------------------- runtime */

  // Do two segments cross?  Used for walkover lines: the player's step this
  // frame against the trigger line.
  function segsCross(ax, az, bx, bz, cx0, cz0, dx0, dz0) {
    const s = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
    const d1 = s(ax, az, bx, bz, cx0, cz0), d2 = s(ax, az, bx, bz, dx0, dz0);
    const d3 = s(cx0, cz0, dx0, dz0, ax, az), d4 = s(cx0, cz0, dx0, dz0, bx, bz);
    return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
  }

  // Where to look for a floor the player is trying to get onto: their own
  // cell and one step out in each direction.
  const ASSIST_PROBE = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]];

  // How long the player may go without getting any closer to the exit before
  // the net offers a way out. Generous: a long fight must not trip it.
  const NO_PROGRESS_SECONDS = 60;

  const rt = {
    active: [],        // sectors currently animating
    trigs: [],         // { act, pts, bb, spent, lastFire } per acted linedef
    secWalls: null,    // sector index -> runtime wall objects to slide with it
    net: null,         // { grid, mask }
    netTimer: 0,
    holdTimer: 0,
    lastTele: 0,

    reset() {
      this.active = []; this.trigs = []; this.waits = []; this.secWalls = null; this.secActs = null;
      this.net = null; this.netTimer = 0; this.holdTimer = 0; this.lastTele = -99;
      // Simulation seconds, not wall clock: a lift that waits on setTimeout
      // never comes back for anything that steps the engine faster than real
      // time (the 198-map sweep), and would keep counting down through a
      // pause. Everything timed in here reads this.
      this.clock = 0;
      this.waits = [];
      // Closest the player has ever been to the exit, in net-grid steps, and
      // how long since that improved.
      this.bestDist = Infinity;
      this.stallT = 0;
      this._data = null;
      if (this._netJob) clearTimeout(this._netJob);
      this._netJob = null;
    },

    /* Called from loadLevel once meshes exist.

       Triggers come from data.triggers, NOT from the wall list: most lifts
       and every teleporter sit on a two-sided line with no floor step, so the
       converter emits no wall for them at all. A wall that does exist for the
       same linedef carries `ai`, its linedef index, so both point at one
       runtime trigger and a one-shot cannot fire twice.

       data.walls[i] pairs with engine.walls[i] -- buildWall pushes exactly
       one runtime object per entry, which is what lets us find the meshes to
       slide when a neighbouring floor moves. */
    init(engine, data) {
      this.reset();
      this._data = data;
      this.secWalls = new Map();
      this.secActs = new Map();

      const byLine = new Map();
      for (const t of data.triggers || []) {
        const pts = wallPoints(t);
        const trig = {
          act: t.act, pts, spent: false, lastFire: 0,
          bb: [Math.min(pts[0], pts[2]), Math.min(pts[1], pts[3]),
               Math.max(pts[0], pts[2]), Math.max(pts[1], pts[3])]
        };
        this.trigs.push(trig);
        if (t.i !== undefined) byLine.set(t.i, trig);
        if (t.act.secs && t.act.kind !== 'tele') {
          for (const si of t.act.secs) {
            let a = this.secActs.get(si);
            if (!a) this.secActs.set(si, a = []);
            a.push(trig);
          }
        }
      }

      const dw = data.walls || [];
      for (let i = 0; i < dw.length; i++) {
        const src = dw[i], obj = engine.walls[i];
        if (!obj) break;
        // The panel you press [E] on shares the linedef's one trigger.
        if (src.ai !== undefined) obj._trig = byLine.get(src.ai) || null;
        if (src.fs !== undefined) {
          obj.fs = src.fs; obj.bs = src.bs;
          for (const s of [src.fs, src.bs]) {
            if (s === undefined || s < 0) continue;
            let a = this.secWalls.get(s);
            if (!a) this.secWalls.set(s, a = []);
            a.push(obj);
          }
        }
      }
      const secs = data.sectors || [];
      for (let i = 0; i < secs.length; i++) {
        secs[i]._restY = secs[i].floorY;   // where a lift returns to
        secs[i]._idx = i;
      }
      // The dead-end net costs a grid build; do it off the load frame so a
      // megamap does not stall on entry.  Until it lands the net just does
      // not fire.
      this._netJob = setTimeout(() => this.buildNet(engine, data), 300);
    },

    buildNet(engine, data) {
      this._netJob = null;
      try {
        const grid = new Grid(data, NET_CELL);
        const dist = grid.canReachExit(data);
        if (dist) this.net = { grid, dist };
      } catch (e) {
        console.warn('[traversal] dead-end net unavailable:', e && e.message);
      }
    },

    /* ---- actions ---- */

    // Fire whatever this linedef's special does. Accepts a trigger or a wall
    // that carries one. `how` is 'use' or 'walk'; a line only answers its own
    // trigger, except that shooting a gun-line is close enough to using it.
    fire(engine, target, how) {
      const trig = target && (target._trig || (target.act ? target : null));
      const act = trig && trig.act;
      if (!act) return false;
      if (act.trig !== how && !(how === 'use' && act.trig === 'gun')) return false;
      if (trig.spent) return false;
      if (!act.rep) trig.spent = true;
      if (act.kind === 'tele') {
        // teleGrace stops a landing pad that sits next to another trigger
        // from bouncing the player around forever.
        if (engine.player.teleGrace > 0) { trig.spent = false; return false; }
        return this.teleport(engine, act.dest);
      }
      if (act.kind === 'door') return false;   // door sectors are never sealed; nothing to open
      const secs = act.secs || [];
      let any = false;
      for (const si of secs) {
        const sec = (this._data.sectors || [])[si];
        if (!sec) continue;
        const lo = sectorLo(sec), hi = sectorHi(sec);
        if (act.kind === 'lift') {
          if (this.isMoving(sec)) continue;
          this.move(engine, sec, lo, act.speed || 4, () => {
            this.waits.push({ sec, at: this.clock + (act.wait || 3), speed: act.speed || 4 });
          });
          any = true;
        } else {
          const target = act.dir === 'down' ? lo : hi;
          if (Math.abs(target - sec.floorY) < 0.01) continue;
          this.move(engine, sec, target, act.speed || 1);
          any = true;
        }
      }
      if (any) { try { engine.sound.playSwitch(); } catch (e) { } }
      return any;
    },

    isMoving(sec) { return this.active.some(a => a.sec === sec); },

    move(engine, sec, target, speed, onDone) {
      const i = this.active.findIndex(a => a.sec === sec);
      if (i >= 0) this.active.splice(i, 1);
      this.active.push({ sec, target, speed: Math.max(0.2, speed), onDone });
    },

    teleport(engine, dest) {
      if (!dest) return false;
      if (this.clock - this.lastTele < 0.6) return false;   // no ping-pong on the landing pad
      this.lastTele = this.clock;
      // Doom landing spots are point-sized and often sit flush against a
      // wall; dropping the camera straight on one embeds the player in
      // geometry, which is the only place the sweep ever found the player
      // inside a wall. Push out first, exactly as a movement step would.
      const f0 = engine.getFloorAt(dest[0], dest[1]);
      let x = dest[0], z = dest[1];
      let y = (f0.inside ? f0.floorY : 0) + engine.player.height;
      if (engine.resolveWallCollisions) {
        const c = engine.resolveWallCollisions(x, z, 0.6, y - engine.player.height, engine.player.height);
        const cf = engine.getFloorAt(c.x, c.z);
        if (cf.inside) { x = c.x; z = c.z; y = cf.floorY + engine.player.height; }
      }
      engine.camera.position.set(x, y, z);
      engine.player.velocity.set(0, 0, 0);
      engine.player.safePosition.set(x, y, z);
      if (dest[2] !== undefined) { engine.yaw = dest[2]; engine.camera.rotation.y = dest[2]; }
      try { engine.triggerPickupFlash(); } catch (e) { }
      try { engine.sound.playSwitch(); } catch (e) { }
      engine.player.teleGrace = 1.0;
      // A teleport moves the goalposts; re-measure from wherever we landed.
      this.bestDist = Infinity;
      this.stallT = 0;
      return true;
    },

    /* ---- per-frame ---- */

    update(engine, delta) {
      this.clock += delta;
      // Lifts that have finished lowering and are waiting to come back up.
      for (let i = this.waits.length - 1; i >= 0; i--) {
        const w = this.waits[i];
        if (this.clock < w.at) continue;
        this.waits.splice(i, 1);
        // The level may have been swapped out while the lift was down.
        const live = this._data && this._data.sectors;
        if (!live || live[w.sec._idx] !== w.sec) continue;
        this.move(engine, w.sec, w.sec._restY, w.speed);
      }
      if (this.active.length) this.animate(engine, delta);
      if (engine.player.teleGrace > 0) engine.player.teleGrace -= delta;
    },

    /* The offline model treats a floor that CAN move as passable, because
       that is the truth about the map. The engine used to move it only if the
       player happened to touch the trigger line, so the two disagreed: the
       player stood at the foot of a lift that never came, or on a bridge
       section that was supposed to rise. This closes the gap in both
       directions -- a floor out of reach that can come down to you comes
       down, and a floor you are standing on that is meant to move, moves.

       Bounded to ONE assisted actuation per linedef per level. Explicit
       triggers (walking the line, pressing [E]) stay unlimited; this only
       ever supplies the actuation the model already assumed had happened, so
       once is exactly right and it cannot turn into a yo-yo. */
    assist(engine, delta) {
      if (!this.secActs || !this.secActs.size) return;
      this._assistT = (this._assistT || 0) + delta;
      if (this._assistT < 0.25) return;      // 4 Hz is plenty and keeps it cheap
      this._assistT = 0;
      const cam = engine.camera.position;
      const feet = cam.y - engine.player.height;
      const now = this.clock;
      const seen = this._seen || (this._seen = new Set());
      seen.clear();
      for (const [dx, dz] of ASSIST_PROBE) {
        for (const sec of engine.sectorsNear(cam.x + dx, cam.z + dz)) {
          if (sec._idx === undefined || seen.has(sec._idx)) continue;
          seen.add(sec._idx);
          const list = this.secActs.get(sec._idx);
          if (!list || this.isMoving(sec)) continue;
          const gap = sec.floorY - feet;
          // Either we are standing on a floor the model expects to move, or
          // we are at the foot of one that is out of reach and could come
          // down to us. Anything else and we would be cycling lifts for fun.
          // "Standing on it" has to mean inside its polygon: matching heights
          // alone fires the raise on the bridge section NEXT to the player,
          // which lifts it out of reach before they can step on.
          const standingOnIt = Math.abs(gap) < 0.4 && sec.polys && sec.polys.length &&
            pointInPolys(cam.x, cam.z, sec.polys);
          const couldComeToUs = gap > STEP_UP_MAX + 0.01 &&
            sectorLo(sec) - feet <= STEP_UP_MAX + 0.01;
          if (!standingOnIt && !couldComeToUs) continue;
          if (standingOnIt && sectorLo(sec) === sectorHi(sec)) continue;
          for (const t of list) {
            if (t.spent || t.assisted || now - t.lastFire < 1.5) continue;
            t.lastFire = now;
            // Only burn the one assisted actuation if it actually did
            // something -- a sector already at its target reports false.
            if (this.fire(engine, t, t.act.trig)) { t.assisted = true; break; }
          }
        }
      }
    },

    animate(engine, delta) {
      const cam = engine.camera.position;
      const feet = cam.y - engine.player.height;
      const standingOn = engine.getFloorAt(cam.x, cam.z);
      const movedBoxes = this._movedBoxes || (this._movedBoxes = []);
      movedBoxes.length = 0;
      for (let i = this.active.length - 1; i >= 0; i--) {
        const a = this.active[i];
        const sec = a.sec;
        const before = sec.floorY;
        const d = a.target - before;
        const stepAmt = a.speed * delta;
        sec.floorY = Math.abs(d) <= stepAmt ? a.target : before + Math.sign(d) * stepAmt;
        const moved = sec.floorY - before;
        if (sec._floorMesh) {
          sec._floorMesh.position.y = sec.floorY;
          // Tests raycast the rendered floor and compare it with getFloorAt;
          // leaving this at the sector's build-time height is exactly the
          // "drawn floor disagrees with collision" bug, self-inflicted.
          sec._floorMesh.userData.floorY = sec.floorY;
          // Nothing has rendered since we moved it, so its world matrix (and
          // therefore anything that raycasts it) is still at the old height.
          sec._floorMesh.updateMatrixWorld();
        }
        this.slideRisers(sec);
        // Carry whoever is standing on it.  A rising floor must never push
        // the camera through the ceiling of the level -- it only ever tracks
        // the floor it is already resting on.
        if (moved !== 0 && standingOn.inside && Math.abs(standingOn.floorY - feet) < 0.35 + Math.abs(moved)) {
          const f2 = engine.getFloorAt(cam.x, cam.z);
          if (f2.inside) {
            cam.y = f2.floorY + engine.player.height;
            engine.player.velocity.y = 0;
            engine.player.onGround = true;
            engine.player.safePosition.set(cam.x, cam.y, cam.z);
          }
        }
        if (moved !== 0) movedBoxes.push(secBox(sec));
        if (sec.floorY === a.target) {
          this.active.splice(i, 1);
          if (a.onDone) a.onDone();
        }
      }
      // Enemies cache the floor they stand on and only refresh it when they
      // successfully move; one standing still on a lift would keep the old
      // height and hang in the air. Only the ones actually over a floor that
      // moved need re-deriving: doing it for everyone cost 15 ms a frame on
      // the 4,161-enemy megamap, because every one of them was a getFloorAt.
      if (movedBoxes.length && engine.enemies) {
        for (const e of engine.enemies) {
          const p = e.group && e.group.position;
          if (!p) continue;
          let over = false;
          for (let b = 0; b < movedBoxes.length; b++) {
            const bb = movedBoxes[b];
            if (p.x >= bb[0] && p.x <= bb[2] && p.z >= bb[1] && p.z <= bb[3]) { over = true; break; }
          }
          if (!over) continue;
          const f = engine.getFloorAt(p.x, p.z);
          if (!f.inside) continue;
          // CyberAI re-seats any enemy that moved this frame and owns it;
          // we only take the ones it left standing still, or the two of us
          // fight over y on the same enemy.
          const still = e._trX === p.x && e._trZ === p.z;
          e._trX = p.x; e._trZ = p.z;
          if (!still) continue;
          if (Math.abs(f.floorY - e.floorY) < 0.005) continue;
          e.floorY = f.floorY;
          // Same seating rule as updateEnemies in index.html.
          p.y = f.floorY + ((e.stats && e.stats.fly) ? 2.2 : 0);
          e._trX = p.x; e._trZ = p.z;
        }
      }
    },

    // Risers next to a moving floor are drawn from the two sector heights, so
    // they have to follow or a lowered lift leaves a slab hanging in the air.
    slideRisers(sec) {
      const secs = this._data.sectors || [];
      const list = this.secWalls && this.secWalls.get(sec._idx);
      if (!list) return;
      for (const w of list) {
        if (!w.mesh || w.solid) continue;         // solid panels keep their geometry
        const a = secs[w.fs], b = w.bs >= 0 ? secs[w.bs] : null;
        if (!a || !b) continue;
        const bottom = Math.min(a.floorY, b.floorY), top = Math.max(a.floorY, b.floorY);
        const h = top - bottom;
        if (w._origH === undefined) w._origH = Math.max(0.1, w.height !== undefined ? w.height : 8) + 0.2;
        if (h <= 0.05) { w.mesh.visible = false; w.bottomY = bottom; w.topY = top; continue; }
        w.mesh.visible = true;
        w.mesh.scale.y = (h + 0.2) / w._origH;
        w.mesh.position.y = bottom - 0.1 + (h + 0.2) / 2;
        w.mesh.updateMatrixWorld();
        w.bottomY = bottom; w.topY = top;
      }
    },

    /* One pass per frame over the trigger list. A walkover line fires when
       the step just taken crosses it; a use line fires when the player ends
       up touching it. Doom makes you press use on a lift, but a switch the
       player brushed past and did not notice is a stuck room later, and every
       action in the table only ever opens the map up.

       The bounding-box reject is what makes this affordable: the megamaps
       carry ~2400 triggers and this runs every frame. */
    onMove(engine, x0, z0, x1, z1) {
      const R = 1.35;
      const loX = Math.min(x0, x1) - R, hiX = Math.max(x0, x1) + R;
      const loZ = Math.min(z0, z1) - R, hiZ = Math.max(z0, z1) + R;
      for (const t of this.trigs) {
        if (t.spent) continue;
        const bb = t.bb;
        if (bb[2] < loX || bb[0] > hiX || bb[3] < loZ || bb[1] > hiZ) continue;
        const p = t.pts;
        if (t.act.trig === 'walk') {
          if (segsCross(x0, z0, x1, z1, p[0], p[1], p[2], p[3])) { this.fire(engine, t, 'walk'); continue; }
          // Teleporters are walkover lines, but the offline model gives a
          // teleport edge to any cell standing near one, so the engine has to
          // agree or the two disagree about what is reachable.
          if (t.act.kind !== 'tele') continue;
          // Exactly the model's teleport-edge radius (P_RADIUS + one model
          // cell), not the looser use radius: firing a teleporter the offline
          // route did not plan drops the player somewhere else entirely.
          if (segDist(x1, z1, p[0], p[1], p[2], p[3]) <= P_RADIUS + MODEL_CELL) this.fire(engine, t, 'walk');
          continue;
        }
        if (segDist(x1, z1, p[0], p[1], p[2], p[3]) <= R) this.fire(engine, t, 'use');
      }
    },

    /* ---- dead-end safety net ---- */

    // Called every frame with the player's position.  Returns a HUD line when
    // the exit cannot be reached from here, or null.
    checkStuck(engine, delta, holdingUse) {
      const net = this.net;
      if (!net) return null;
      const cam = engine.camera.position;
      const g = net.grid;
      // The net grid is coarse (1 unit) and carves a player-radius band around
      // every wall, so the player's own cell is often not a free one. Ask the
      // nearest free cell instead; off-grid or nothing free nearby is not
      // evidence of a dead end, so the net stays quiet.
      const near = g.snap(cam.x, cam.z, 4);
      if (!near) { this.netTimer = 0; this.holdTimer = 0; return null; }
      const d = net.dist[near[1] * g.w + near[0]];
      if (d >= 0) {
        this.netTimer = 0;
        // Belt and braces. The rule above only catches a player the model
        // agrees is cut off; this one catches one who is somewhere legal and
        // still getting nowhere -- a doorway the collision will not let them
        // through, say. Never automatic: a long firefight just shows a prompt
        // the player can ignore.
        if (d < this.bestDist) { this.bestDist = d; this.stallT = 0; this.holdTimer = 0; return null; }
        if (this.active.length) { this.stallT = 0; this.holdTimer = 0; return null; }  // a lift is still moving
        this.stallT += delta;
        if (this.stallT < NO_PROGRESS_SECONDS) { this.holdTimer = 0; return null; }
      } else {
        this.netTimer += delta;
        if (this.netTimer < 1.5) return null;
      }
      if (holdingUse) {
        this.holdTimer += delta;
        if (this.holdTimer >= 0.8) { this.extract(engine); return null; }
        return 'DEAD END — EXTRACTING… ' + Math.ceil((0.8 - this.holdTimer) * 10) / 10 + 's';
      }
      this.holdTimer = 0;
      return 'DEAD END — HOLD [E] TO EXTRACT';
    },

    extract(engine) {
      const net = this.net;
      this.netTimer = 0; this.holdTimer = 0; this.stallT = 0;
      if (!net) return;
      const g = net.grid, cam = engine.camera.position;
      const si = g.cx(cam.x), sj = g.cz(cam.z);
      // Nearest cell that can reach the exit -- and when we are extracting a
      // player who simply stopped making progress, one that is actually
      // closer to it than their best so far, or the move achieves nothing.
      const want = this.bestDist === Infinity ? -1 : this.bestDist;
      let best = -1, bestD = Infinity;
      for (let k = 0; k < net.dist.length; k++) {
        if (net.dist[k] < 0) continue;
        if (want >= 0 && net.dist[k] >= want) continue;
        const i = k % g.w, j = (k - i) / g.w;
        const d = (i - si) * (i - si) + (j - sj) * (j - sj);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0 && want >= 0) {          // nothing closer: settle for reachable
        for (let k = 0; k < net.dist.length; k++) {
          if (net.dist[k] < 0) continue;
          const i = k % g.w, j = (k - i) / g.w;
          const dd = (i - si) * (i - si) + (j - sj) * (j - sj);
          if (dd < bestD) { bestD = dd; best = k; }
        }
      }
      if (best < 0) return;
      this.bestDist = net.dist[best];
      const i = best % g.w, j = (best - i) / g.w;
      const x = g.wx(i), z = g.wz(j);
      console.warn('[traversal] DEAD END extraction on "' +
        ((this._data && this._data.name) || '?') + '" from ' +
        cam.x.toFixed(1) + ',' + cam.z.toFixed(1) + ' -> ' + x.toFixed(1) + ',' + z.toFixed(1));
      if (!engine._deadEndLog) engine._deadEndLog = [];
      engine._deadEndLog.push({ map: (this._data && this._data.name) || '?', from: [cam.x, cam.z], to: [x, z] });
      this.teleport(engine, [x, z, engine.yaw]);
    }
  };

  return {
    // model
    P_RADIUS, STEP_UP_MAX, USE_RANGE, CELL: MODEL_CELL, NET_CELL,
    Grid, segDist, wallPoints, pointInPolys, loopsBounds, sectorPolys,
    floorRects, blockingWalls, exitWalls, teleLines, sectorLo, sectorHi, segsCross,
    // runtime
    reset: rt.reset.bind(rt),
    init: rt.init.bind(rt),
    update: rt.update.bind(rt),
    fire: rt.fire.bind(rt),
    onMove: rt.onMove.bind(rt),
    assist: rt.assist.bind(rt),
    checkStuck: rt.checkStuck.bind(rt),
    extract: rt.extract.bind(rt),
    _rt: rt
  };
});
