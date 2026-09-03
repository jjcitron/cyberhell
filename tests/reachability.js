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
    const rects = floorRects(level);
    if (!rects.length) throw new Error('level has no floor rectangles');

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.x - r.width / 2);
      maxX = Math.max(maxX, r.x + r.width / 2);
      minZ = Math.min(minZ, r.z - r.depth / 2);
      maxZ = Math.max(maxZ, r.z + r.depth / 2);
    }
    this.minX = minX - 1; this.minZ = minZ - 1;
    this.w = Math.ceil((maxX - minX + 2) / CELL);
    this.h = Math.ceil((maxZ - minZ + 2) / CELL);
    this.free = new Uint8Array(this.w * this.h);

    // Pass 1: mark every cell that sits on a floor rectangle.
    for (const r of rects) {
      const x0 = this.cx(r.x - r.width / 2), x1 = this.cx(r.x + r.width / 2);
      const z0 = this.cz(r.z - r.depth / 2), z1 = this.cz(r.z + r.depth / 2);
      for (let j = Math.max(0, z0); j <= Math.min(this.h - 1, z1); j++) {
        for (let i = Math.max(0, x0); i <= Math.min(this.w - 1, x1); i++) {
          this.free[j * this.w + i] = 1;
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
  cx(x) { return Math.round((x - this.minX) / CELL); }
  cz(z) { return Math.round((z - this.minZ) / CELL); }
  wx(i) { return this.minX + i * CELL; }
  wz(j) { return this.minZ + j * CELL; }
  isFree(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i] === 1; }

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
function pathToExit(level) {
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

  // Thin the cell chain down to waypoints roughly 2 units apart, plus the end.
  const pts = [];
  const STRIDE = Math.max(1, Math.round(2.0 / CELL));
  for (let n = 0; n < cells.length; n += STRIDE) {
    const i = cells[n] % grid.w, j = (cells[n] - (cells[n] % grid.w)) / grid.w;
    pts.push([+grid.wx(i).toFixed(2), +grid.wz(j).toFixed(2)]);
  }
  const last = cells[cells.length - 1];
  const li = last % grid.w, lj = (last - li) / grid.w;
  pts.push([+grid.wx(li).toFixed(2), +grid.wz(lj).toFixed(2)]);
  return pts;
}

module.exports = { analyze, pathToExit, exitWalls, Grid, floorRects, blockingWalls, wallPoints, segDist, CELL, P_RADIUS, USE_RANGE };
