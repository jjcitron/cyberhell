/*
 * Reachability verifier.
 *
 * Mirrors the engine's movement rules (index.html: updatePhysics,
 * resolveWallCollisions, getFloorAt) closely enough to answer one question:
 * starting at playerSpawn, can the player physically stand on the exit switch?
 *
 * Engine rules this reproduces:
 *   - Floor rectangles are the collision authority. Off-rect is not walkable.
 *   - Solid wall segments push the player out to a radius of 0.55.
 *   - Doors (closed:true) auto-open within 1.35 units, so they never block.
 *   - Switch walls have no `closed` flag, so they stay solid and must be
 *     touched from a walkable cell in front of them.
 *   - Floor height differences are snapped, never gated, so height is ignored.
 */

const P_RADIUS = 0.55;
const CELL = 0.25;
// Doom's free auto-climb is 24 map units; the WAD->engine scale is 0.05.
// Same constant as STEP_UP_MAX in index.html. Drops are unlimited, so the
// walk graph is DIRECTED -- a ledge you fall off is not a ledge you can climb.
const STEP_UP_MAX = 1.2;   // +1e-3 slack at the comparison; see index.html
// Reach of interact(): raycast hit under 6.5 units. Require the player to get
// meaningfully closer than that so the switch is usable, not just theoretically
// in line of sight from across a chasm.
const USE_RANGE = 4.0;

function floorRects(level) {
  const rects = [];
  for (const sec of level.sectors || []) {
    if (sec.floors && sec.floors.length) {
      for (const r of sec.floors) rects.push(r);
    } else if (sec.width !== undefined) {
      rects.push({ x: sec.x, z: sec.z, width: sec.width, depth: sec.depth });
    }
  }
  return rects;
}

// Converted levels carry real sector boundary loops; only the hand-built
// MAP01 still uses rectangles. Both are reduced to the same free-cell grid.
function sectorPolys(level) {
  const out = [];
  for (const sec of level.sectors || []) {
    if (sec.polys && sec.polys.length) out.push(sec.polys);
  }
  return out;
}

function loopsBounds(polys) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const loop of polys) for (const [x, z] of loop) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
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

function wallPoints(w) {
  const g = (p, i, k) => (p[k] !== undefined ? p[k] : p[i]);
  return [g(w.p1, 0, 'x'), g(w.p1, 1, 'z'), g(w.p2, 0, 'x'), g(w.p2, 1, 'z')];
}

// Walls that actually stop the player. Doors open on approach; everything
// non-solid (step risers) was already flagged passable by the level data.
function blockingWalls(level) {
  return (level.walls || []).filter(w => w.solid && !w.isDoor).map(wallPoints);
}

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

class Grid {
  constructor(level) {
    const polySectors = sectorPolys(level);
    const rects = polySectors.length ? [] : floorRects(level);
    if (!rects.length && !polySectors.length) throw new Error('level has no floor geometry');

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.x - r.width / 2);
      maxX = Math.max(maxX, r.x + r.width / 2);
      minZ = Math.min(minZ, r.z - r.depth / 2);
      maxZ = Math.max(maxZ, r.z + r.depth / 2);
    }
    for (const polys of polySectors) {
      const [a, b, c, d] = loopsBounds(polys);
      minX = Math.min(minX, a); minZ = Math.min(minZ, b);
      maxX = Math.max(maxX, c); maxZ = Math.max(maxZ, d);
    }
    this.minX = minX - 1; this.minZ = minZ - 1;
    this.w = Math.ceil((maxX - minX + 2) / CELL);
    this.h = Math.ceil((maxZ - minZ + 2) / CELL);
    this.free = new Uint8Array(this.w * this.h);

    // Pass 1: mark every cell that sits on real floor geometry.
    for (const r of rects) {
      const x0 = this.cx(r.x - r.width / 2), x1 = this.cx(r.x + r.width / 2);
      const z0 = this.cz(r.z - r.depth / 2), z1 = this.cz(r.z + r.depth / 2);
      for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
        for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
          this.free[j * this.w + i] = 1;
        }
      }
    }
    // Scanline fill per sector, recording each cell's floor height: the walk
    // graph is height-aware, so a cell without a height cannot be stepped on.
    // Per-cell point-in-polygon would be O(cells x edges) and take minutes on
    // the big maps.
    this.floorY = new Float32Array(this.w * this.h);
    for (const sec of level.sectors || []) {
      if (sec.polys && sec.polys.length) this.fillLoops(sec.polys, sec.floorY);
    }
    // Rectangle levels (MAP01) overlap their sectors on purpose. Take the
    // HIGHEST floor covering a cell, matching getFloorAt in index.html --
    // array order would pick a floor that is not the one drawn on top.
    const written = new Uint8Array(this.w * this.h);
    for (const sec of level.sectors || []) {
      if (sec.polys && sec.polys.length) continue;
      const secRects = (sec.floors && sec.floors.length) ? sec.floors
        : (sec.width !== undefined ? [{ x: sec.x, z: sec.z, width: sec.width, depth: sec.depth }] : []);
      for (const r of secRects) {
        const x0 = this.cx(r.x - r.width / 2), x1 = this.cx(r.x + r.width / 2);
        const z0 = this.cz(r.z - r.depth / 2), z1 = this.cz(r.z + r.depth / 2);
        for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
          for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
            const k = j * this.w + i;
            const y = sec.floorY || 0;
            if (!written[k] || y > this.floorY[k]) this.floorY[k] = y;
            written[k] = 1;
          }
        }
      }
    }

    // Pass 2: carve out the player-radius band around every solid wall.
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
  }
  // Even-odd scanline fill of one sector's loops into this.free/this.floorY.
  fillLoops(loops, floorY) {
    const buckets = new Array(this.h);
    const edges = [];
    for (const loop of loops) {
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const z1 = loop[j][1], z2 = loop[i][1];
        if (z1 === z2) continue;                 // horizontal: never crossed
        const e = edges.length;
        edges.push([loop[j][0], z1, loop[i][0], z2]);
        let r0 = Math.max(0, Math.ceil((Math.min(z1, z2) - this.minZ) / CELL));
        let r1 = Math.min(this.h - 1, Math.floor((Math.max(z1, z2) - this.minZ) / CELL));
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
          this.free[j * this.w + i] = 1;
          if (floorY !== undefined) this.floorY[j * this.w + i] = floorY;
        }
      }
    }
  }
  cx(x) { return Math.round((x - this.minX) / CELL); }
  cz(z) { return Math.round((z - this.minZ) / CELL); }
  wx(i) { return this.minX + i * CELL; }
  wz(j) { return this.minZ + j * CELL; }
  isFree(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i] === 1; }

  // A step is legal if the destination is floor and is not more than one
  // free auto-climb above where we stand. Falling any distance is legal.
  canStep(fromK, toK) { return this.floorY[toK] - this.floorY[fromK] <= STEP_UP_MAX + 1e-3; }

  // Nearest free cell to a world point, searched outward. Spawns land on a
  // wall band often enough that snapping is necessary, and the engine does the
  // same thing implicitly by pushing the player out on the first frame.
  snap(x, z, maxR = 40) {
    let i = this.cx(x), j = this.cz(z);
    if (this.isFree(i, j)) return [i, j];
    for (let r = 1; r <= maxR; r++) {
      for (let d = -r; d <= r; d++) {
        const cand = [[i + d, j - r], [i + d, j + r], [i - r, j + d], [i + r, j + d]];
        for (const [ci, cj] of cand) if (this.isFree(ci, cj)) return [ci, cj];
      }
    }
    return null;
  }

  // 4-connected flood fill. CELL is small enough relative to the 1.1-wide
  // wall band that the fill cannot leak diagonally through a wall.
  flood(si, sj) {
    const seen = new Uint8Array(this.w * this.h);
    const stack = [sj * this.w + si];
    seen[sj * this.w + si] = 1;
    let count = 0;
    while (stack.length) {
      const k = stack.pop();
      count++;
      const i = k % this.w, j = (k - i) / this.w;
      const nb = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
      for (const [ni, nj] of nb) {
        if (!this.isFree(ni, nj)) continue;
        const nk = nj * this.w + ni;
        if (seen[nk]) continue;
        if (!this.canStep(k, nk)) continue;
        seen[nk] = 1;
        stack.push(nk);
      }
    }
    return { seen, count };
  }
}

function exitWalls(level) {
  return (level.walls || []).filter(w => w.isSwitch && w.switchId === 'sw_exit_game');
}

/* Returns {ok, reason, reachableCells, exits:[{reachable, dist}]} */
function analyze(level) {
  const grid = new Grid(level);
  const sp = level.playerSpawn && level.playerSpawn.pos;
  if (!sp) return { ok: false, reason: 'no playerSpawn' };
  const start = grid.snap(sp[0], sp[2]);
  if (!start) return { ok: false, reason: 'spawn is not on walkable floor' };

  const { seen, count } = grid.flood(start[0], start[1]);
  const exits = exitWalls(level);
  if (!exits.length) return { ok: false, reason: 'no sw_exit_game switch', reachableCells: count, exits: [] };

  const results = exits.map(w => {
    const [ax, az, bx, bz] = wallPoints(w);
    // A switch is usable if some reachable cell sits within USE_RANGE of it.
    let best = Infinity;
    const pad = Math.ceil(USE_RANGE / CELL) + 1;
    const x0 = grid.cx(Math.min(ax, bx)) - pad, x1 = grid.cx(Math.max(ax, bx)) + pad;
    const z0 = grid.cz(Math.min(az, bz)) - pad, z1 = grid.cz(Math.max(az, bz)) + pad;
    for (let j = Math.max(0, z0); j <= Math.min(grid.h - 1, z1); j++) {
      for (let i = Math.max(0, x0); i <= Math.min(grid.w - 1, x1); i++) {
        if (!seen[j * grid.w + i]) continue;
        const d = segDist(grid.wx(i), grid.wz(j), ax, az, bx, bz);
        if (d < best) best = d;
      }
    }
    return { switchId: w.switchId, dist: best, reachable: best <= USE_RANGE };
  });

  const ok = results.some(r => r.reachable);
  return {
    ok,
    reason: ok ? 'exit reachable from spawn' : 'exit switch exists but is sealed off from spawn',
    reachableCells: count,
    exits: results
  };
}

/* Waypoints from spawn to the exit switch, in world coordinates.
   Feeding these to the real engine turns "the flood fill says it is reachable"
   into "the engine's own collision code walked it". Returns null if no route. */
function pathToExit(level, strideUnits = 2.0) {
  const grid = new Grid(level);
  const sp = level.playerSpawn && level.playerSpawn.pos;
  if (!sp) return null;
  const start = grid.snap(sp[0], sp[2]);
  if (!start) return null;

  // BFS carrying a parent pointer so the route can be replayed.
  const N = grid.w * grid.h;
  const prev = new Int32Array(N).fill(-1);
  const s0 = start[1] * grid.w + start[0];
  prev[s0] = s0;
  let queue = [s0];
  const targets = exitWalls(level).map(wallPoints);
  if (!targets.length) return null;

  let hit = -1;
  while (queue.length && hit === -1) {
    const next = [];
    for (const k of queue) {
      const i = k % grid.w, j = (k - i) / grid.w;
      const x = grid.wx(i), z = grid.wz(j);
      for (const [ax, az, bx, bz] of targets) {
        if (segDist(x, z, ax, az, bx, bz) <= USE_RANGE) { hit = k; break; }
      }
      if (hit !== -1) break;
      for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (!grid.isFree(ni, nj)) continue;
        const nk = nj * grid.w + ni;
        if (prev[nk] !== -1) continue;
        if (!grid.canStep(k, nk)) continue;
        prev[nk] = k;
        next.push(nk);
      }
    }
    queue = next;
  }
  if (hit === -1) return null;

  const cells = [];
  for (let k = hit; k !== prev[k]; k = prev[k]) cells.push(k);
  cells.push(s0);
  cells.reverse();

  // Thin the cell chain to waypoints roughly 2 units apart, but never skip a
  // change of floor height: a staircase between two waypoints is invisible to
  // anything that walks the straight line between them, and the climb rule
  // then refuses the whole rise at once.
  const pts = [];
  // The straight line between two waypoints can cut across a ledge the cell
  // path went around, so a caller that actually walks the route wants a fine
  // stride (CELL) rather than the default 2 units.
  const STRIDE = Math.max(1, Math.round(strideUnits / CELL));
  let lastY = null, sinceEmit = 0;
  for (let n = 0; n < cells.length; n++) {
    const k = cells[n];
    const y = grid.floorY[k];
    if (n !== 0 && y === lastY && ++sinceEmit < STRIDE) continue;
    sinceEmit = 0;
    lastY = y;
    const i = k % grid.w, j = (k - (k % grid.w)) / grid.w;
    pts.push([+grid.wx(i).toFixed(2), +grid.wz(j).toFixed(2)]);
  }
  const last = cells[cells.length - 1];
  const li = last % grid.w, lj = (last - li) / grid.w;
  pts.push([+grid.wx(li).toFixed(2), +grid.wz(lj).toFixed(2)]);
  return pts;
}

/* Floor-coverage metrics: how much of the map's walkable floor is actually
   reachable from spawn, and how big any disconnected pockets are.
   Risers are non-solid in the level data (see convert_all_wads.py); climbing
   is gated by floor height instead, so the fill is directed and the "pocket"
   counts are an upper bound (a pocket you can drop into but not climb out of
   is still counted separately). */
function floorMetrics(level) {
  const grid = new Grid(level);
  let totalCells = 0;
  for (let k = 0; k < grid.free.length; k++) if (grid.free[k]) totalCells++;

  const cellArea = CELL * CELL;
  const sp = level.playerSpawn && level.playerSpawn.pos;
  const start = sp && grid.snap(sp[0], sp[2]);
  if (!start) {
    return {
      spawnOnFloor: false, totalFloorArea: +(totalCells * cellArea).toFixed(1),
      reachableArea: 0, reachableFraction: 0, pockets: []
    };
  }

  const visited = new Uint8Array(grid.w * grid.h);
  const components = [];
  let reachableCount = 0;
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      const k = j * grid.w + i;
      if (!grid.free[k] || visited[k]) continue;
      const { seen, count } = grid.flood(i, j);
      for (let idx = 0; idx < seen.length; idx++) if (seen[idx]) visited[idx] = 1;
      const isSpawnComponent = !!seen[start[1] * grid.w + start[0]];
      if (isSpawnComponent) reachableCount = count;
      components.push({ cells: count, isSpawnComponent });
    }
  }

  const pockets = components
    .filter(c => !c.isSpawnComponent)
    .map(c => +(c.cells * cellArea).toFixed(1))
    .sort((a, b) => b - a);

  return {
    spawnOnFloor: true,
    totalFloorArea: +(totalCells * cellArea).toFixed(1),
    reachableArea: +(reachableCount * cellArea).toFixed(1),
    reachableFraction: totalCells ? reachableCount / totalCells : 0,
    pockets
  };
}

module.exports = { STEP_UP_MAX, sectorPolys, pointInPolys, loopsBounds, analyze, pathToExit, exitWalls, Grid, floorRects, blockingWalls, wallPoints, segDist, floorMetrics, CELL, P_RADIUS, USE_RANGE };
