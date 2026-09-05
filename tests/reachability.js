/*
 * Reachability verifier.
 *
 * Answers one question about a level: starting at playerSpawn, can the player
 * physically stand on the exit switch?
 *
 * The walk model itself lives in ../js/cyber-traversal.js, which the engine
 * also loads for its in-game dead-end net. Sharing the file is the point: an
 * offline model that disagrees with the engine is worse than none, because it
 * certifies maps the player cannot actually finish.
 *
 * Rules the model reproduces (see cyber-traversal.js for the code):
 *   - Sector polygons are the collision authority. Off-polygon is not walkable.
 *   - Solid wall segments push the player out to a radius of 0.55.
 *   - Doors (closed:true) auto-open within 1.35 units, so they never block.
 *   - Switch walls stay solid and must be touched from a walkable cell.
 *   - A step may drop any distance but may only RISE by one Doom auto-climb
 *     (STEP_UP_MAX), so the graph is directed... except that lifts and
 *     switch-raised floors move, so the rule is really "the destination floor
 *     must be able to come within one auto-climb of the floor you are on".
 *     That is what the per-sector loY/hiY envelope from convert_all_wads.py
 *     encodes, and what Grid.canStep applies.
 *   - Teleporter linedefs are one-way edges to their landing spot.
 */

const T = require('../js/cyber-traversal.js');

const {
  P_RADIUS, STEP_UP_MAX, USE_RANGE, CELL,
  Grid, segDist, wallPoints, pointInPolys, loopsBounds,
  sectorPolys, floorRects, blockingWalls, exitWalls
} = T;

/* Returns {ok, reason, reachableCells, exits:[{reachable, dist}]} */
function analyze(level) {
  const grid = new Grid(level, CELL);
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
   into "the engine's own collision code walked it". Returns null if no route.

   A waypoint is [x, z] for a walk and [x, z, 'tp'] for the far side of a
   teleporter: the caller does not walk to it, the engine puts them there when
   they cross the trigger line. */
function pathToExit(level, strideUnits = 2.0) {
  const grid = new Grid(level, CELL);
  const sp = level.playerSpawn && level.playerSpawn.pos;
  if (!sp) return null;
  const start = grid.snap(sp[0], sp[2]);
  if (!start) return null;

  // BFS carrying a parent pointer so the route can be replayed.
  const N = grid.w * grid.h;
  const prev = new Int32Array(N).fill(-1);
  const viaTele = new Uint8Array(N);
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
      const tk = grid.tele.get(k);
      if (tk !== undefined && prev[tk] === -1) {
        prev[tk] = k;
        viaTele[tk] = 1;
        next.push(tk);
      }
    }
    queue = next;
  }
  if (hit === -1) return null;

  const cells = [];
  for (let k = hit; k !== prev[k]; k = prev[k]) cells.push(k);
  cells.push(s0);
  cells.reverse();

  // Thin the cell chain to waypoints roughly `strideUnits` apart, but never
  // skip a change of floor height (a staircase between two waypoints is
  // invisible to anything that walks the straight line between them) and
  // never skip either side of a teleport hop.
  const pts = [];
  const STRIDE = Math.max(1, Math.round(strideUnits / CELL));
  const at = (k) => {
    const i = k % grid.w;
    return [+grid.wx(i).toFixed(2), +grid.wz((k - i) / grid.w).toFixed(2)];
  };
  let lastY = null, sinceEmit = 0;
  for (let n = 0; n < cells.length; n++) {
    const k = cells[n];
    const y = grid.hi[k];
    const hop = viaTele[k];
    const nextHop = n + 1 < cells.length && viaTele[cells[n + 1]];
    if (n !== 0 && !hop && !nextHop && y === lastY && ++sinceEmit < STRIDE) continue;
    sinceEmit = 0;
    lastY = y;
    const p = at(k);
    if (hop) p.push('tp');
    pts.push(p);
  }
  pts.push(at(cells[cells.length - 1]));
  return pts;
}

/* Floor-coverage metrics: how much of the map's walkable floor is actually
   reachable from spawn, and how big any disconnected pockets are.
   The fill is directed (a pocket you can drop into but not climb out of is a
   separate component), so the "pocket" counts are an upper bound. */
function floorMetrics(level) {
  const grid = new Grid(level, CELL);
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

module.exports = {
  STEP_UP_MAX, CELL, P_RADIUS, USE_RANGE,
  Grid, segDist, wallPoints, pointInPolys, loopsBounds,
  sectorPolys, floorRects, blockingWalls, exitWalls,
  analyze, pathToExit, floorMetrics
};
