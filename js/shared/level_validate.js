/* ==========================================================================
   Shared level validator -- runs identically in the browser (editor Validate
   panel, window.LevelValidate) and in node (tests, future API validation).

   Reuses js/cyber-traversal.js (already UMD, already the single source of
   truth cyber-traversal.js/reachability.js tests are built on) for the walk
   graph, instead of re-implementing collision. Two invariants that model
   answers -- "can spawn reach the exit switch" and "what fraction of floor
   is reachable" -- are computed here directly against CyberTraversal's Grid
   rather than via tests/reachability.js, because that file does
   `require('../js/cyber-traversal.js')` unconditionally and is therefore
   node-only; this module has to load as a plain <script> in the editor too.

   Perf note (see tests/level-validate.test.mjs perf case): levelPacks/dv's
   json2 is ~20k walls over a ~1300x1100 unit map. At the model's CELL=0.25
   that is ~23M grid cells. A single Grid build + single flood from spawn
   (what exit-reachability needs) runs in under a second. A full per-pocket
   floor-coverage scan the way tests/reachability.js's floorMetrics() does it
   -- flood-filling every disconnected component, allocating a fresh
   Uint8Array(cells) per component -- is the thing that actually blows the
   budget (minutes, not seconds) whenever a map that size has more than a
   couple of stray disconnected cells. So: full mode always computes exit
   reachability (cheap, always correct, matches check-exits.js's model
   exactly). Floor-coverage/pocket percentage is also computed, but only via
   ONE extra flood + ONE linear scan (reachable/total free cells) -- good
   enough for a warning-level "how much of the map can the player reach"
   signal -- and is skipped entirely (reachableFloorPct: null, a warning
   explains why) above GRID_CELL_BUDGET cells, which only the dv megamaps
   hit today.
   ponytail: floor-coverage stat is reachable/total-free ratio, not real
   per-pocket detection (that's still tests/check-floor-coverage.js's job,
   unchanged). Upgrade path if the editor ever needs pocket locations live:
   port floorMetrics' component loop but reuse one scratch Uint8Array instead
   of allocating one per component.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../cyber-traversal.js'));
  } else {
    root.LevelValidate = factory(root.CyberTraversal);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (T) {
  'use strict';

  // Mirrors js/cyber-enemies.js STATS keys (see .claude-documentation/research
  // /2026-09-06-editor-data-reference.md sec 3). Kept as data here rather than
  // requiring cyber-enemies.js, which is a browser-oriented THREE.js builder
  // module the validator (node + browser, no THREE dependency) shouldn't need.
  var KNOWN_ENEMY_TYPES = [3004, 9, 65, 3001, 3002, 58, 3005, 69, 3003, 66, 67, 68, 64, 16, 7];
  var GRID_CELL_BUDGET = 4000000; // ~500x500 world units at CELL=0.25; dv/json2 (~23M) skips floor%

  function err(errors, code, msg, ref) { errors.push({ code: code, msg: msg, ref: ref }); }
  function warn(warnings, code, msg, ref) { warnings.push({ code: code, msg: msg, ref: ref }); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isNumArr(v, n) { return Array.isArray(v) && v.length === n && v.every(isNum); }

  function checkSchema(level, errors) {
    // 'triggers' deliberately excluded: the hand-built MAP01 (one of
    // check-exits.js's 198/198 canonical, currently-shipping levels) has no
    // triggers key at all -- every reader in the codebase treats it as
    // `level.triggers || []`, so it's optional, not required.
    var required = ['name', 'skyColor', 'fogColor', 'fogDensity', 'ambientLight', 'sunLight',
      'playerSpawn', 'sectors', 'walls', 'entities'];
    required.forEach(function (key) {
      if (!(key in level)) err(errors, 'MISSING_FIELD', 'level is missing required field "' + key + '"', { kind: 'level', index: -1 });
    });
    if (level.skyColor !== undefined && !isNum(level.skyColor)) err(errors, 'INVALID_FIELD_TYPE', 'skyColor must be numeric', { kind: 'level', index: -1 });
    if (level.fogColor !== undefined && !isNum(level.fogColor)) err(errors, 'INVALID_FIELD_TYPE', 'fogColor must be numeric', { kind: 'level', index: -1 });
    if (level.ambientLight !== undefined && !isNum(level.ambientLight)) err(errors, 'INVALID_FIELD_TYPE', 'ambientLight must be numeric', { kind: 'level', index: -1 });
    if (level.fogDensity !== undefined && !isNum(level.fogDensity)) err(errors, 'INVALID_FIELD_TYPE', 'fogDensity must be numeric', { kind: 'level', index: -1 });
    if (level.sunLight !== undefined) {
      var sl = level.sunLight;
      if (!sl || !isNum(sl.color) || !isNum(sl.intensity) || !isNumArr(sl.pos, 3)) {
        err(errors, 'INVALID_FIELD_TYPE', 'sunLight must be {color:number, intensity:number, pos:[x,y,z]}', { kind: 'level', index: -1 });
      }
    }
    if (level.playerSpawn !== undefined) {
      var sp = level.playerSpawn;
      if (!sp || !isNumArr(sp.pos, 3) || !isNum(sp.rot)) {
        err(errors, 'INVALID_FIELD_TYPE', 'playerSpawn must be {pos:[x,y,z], rot:number}', { kind: 'spawn', index: 0 });
      }
    }
    if (level.music !== undefined) {
      var m = level.music;
      var hasSrc = m && (typeof m.file === 'string' && m.file || typeof m.url === 'string' && m.url);
      if (!m || !hasSrc || (m.name !== undefined && typeof m.name !== 'string')) {
        err(errors, 'INVALID_MUSIC', 'music must be {file|url:string, name?:string}', { kind: 'level', index: -1 });
      }
    }
  }

  // Segment [p1,p2] properly crosses [p3,p4] (shared endpoints don't count --
  // adjacent polygon edges legitimately share a vertex).
  function segsCross(p1, p2, p3, p4) {
    function orient(a, b, c) {
      var v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
    }
    var o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
    return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
  }

  var LOOP_SELFX_CAP = 400; // ponytail: O(n^2) per loop; skip (warn) past this, upgrade to a sweep-line if ever hit

  function checkPolys(level, errors, warnings) {
    var sectors = level.sectors || [];
    sectors.forEach(function (sec, si) {
      var polys = sec.polys;
      if (!polys) return; // legacy rectangle sector (e.g. hand-built MAP01) -- not this invariant's concern
      if (!polys.length) {
        warn(warnings, 'EMPTY_SECTOR_POLYS', 'sector ' + (sec.id || si) + ' has a polys key but no loops', { kind: 'sector', index: si });
        return;
      }
      polys.forEach(function (loop, li) {
        if (!Array.isArray(loop) || loop.length < 3) {
          err(errors, 'OPEN_POLY', 'sector ' + (sec.id || si) + ' loop ' + li + ' has fewer than 3 points', { kind: 'sector', index: si });
          return;
        }
        if (loop.length > LOOP_SELFX_CAP) {
          warn(warnings, 'LOOP_TOO_LARGE_TO_CHECK', 'sector ' + (sec.id || si) + ' loop ' + li + ' has ' + loop.length + ' points, skipped self-intersection check', { kind: 'sector', index: si });
          return;
        }
        var n = loop.length;
        outer:
        for (var i = 0; i < n; i++) {
          var a1 = loop[i], a2 = loop[(i + 1) % n];
          for (var j = i + 1; j < n; j++) {
            if (j === i) continue;
            var adjacent = (j === i + 1) || (i === 0 && j === n - 1);
            if (adjacent) continue;
            var b1 = loop[j], b2 = loop[(j + 1) % n];
            if (segsCross(a1, a2, b1, b2)) {
              // Warning, not error: verified two real, currently-shipping
              // canonical levels (pack3/json13 sec_41, pack4/json26 sec_1)
              // have small self-crossing loops from the WAD's directed-edge
              // chaining (tiny stair/curb geometry) and are still counted in
              // check-exits.js's 198/198 -- the scanline fill in Grid.fillLoops
              // degrades gracefully (even-odd fill) rather than breaking.
              warn(warnings, 'SELF_INTERSECTION', 'sector ' + (sec.id || si) + ' loop ' + li + ' self-intersects (edges ' + i + ',' + j + ')', { kind: 'sector', index: si });
              break outer;
            }
          }
        }
      });
    });
  }

  // NB: despite the "walls[i] <-> triggers[].i" phrasing in the research doc,
  // trigger.i is NOT a positional index into walls[] -- js/cyber-traversal.js
  // (~line 452, 467) keys a byLine Map on trigger.i and looks it up via each
  // wall's separate .ai field ("action id", present on ~3% of walls: the
  // interactive ones). Positional walls[i]<->engine.walls[i] alignment is a
  // real, different invariant (don't reorder/delete wall entries), but
  // trigger-to-wall pairing itself is by .ai value. Verified empirically:
  // pack1/json1.json has a trigger.i (949) with no matching wall.ai, and that
  // level is one of check-exits.js's 198/198 passing levels -- the engine
  // just leaves obj._trig null for it (soft no-op, same pattern as a missing
  // doorId). So a well-formed but unmatched trigger.i is a WARNING, not an
  // error; a malformed one (missing/non-integer/negative) is a real defect.
  function checkExitsAndTriggers(level, errors, warnings) {
    var walls = level.walls || [];
    var exitWalls = [];
    walls.forEach(function (w, wi) {
      if (w.isSwitch && w.switchId === 'sw_exit_game') exitWalls.push(wi);
    });
    if (exitWalls.length === 0) {
      err(errors, 'NO_EXIT', 'no wall has switchId "sw_exit_game"', { kind: 'level', index: -1 });
    } else if (exitWalls.length > 1) {
      // A warning, not an error: the engine's own exitWalls = walls.filter(...)
      // treats every one of them as valid (a single WAD exit linedef commonly
      // converts to several wall segments), and 70/198 real canonical levels
      // have more than one -- "exactly one" is not an actual engine invariant.
      warn(warnings, 'MULTIPLE_EXIT_WALLS', exitWalls.length + ' walls carry switchId "sw_exit_game" (walls ' + exitWalls.join(', ') + ') -- fine if intentional (e.g. one exit linedef split into several segments)', { kind: 'wall', index: exitWalls[0] });
    }

    var aiSet = {};
    walls.forEach(function (w) { if (w.ai !== undefined) aiSet[w.ai] = true; });
    (level.triggers || []).forEach(function (t, ti) {
      if (!Number.isInteger(t.i) || t.i < 0) {
        err(errors, 'TRIGGER_INVALID_INDEX', 'trigger ' + ti + ' has a missing/invalid .i (' + JSON.stringify(t.i) + ')', { kind: 'trigger', index: ti });
      } else if (!aiSet[t.i]) {
        warn(warnings, 'TRIGGER_ORPHANED', 'trigger ' + ti + ' (.i=' + t.i + ') matches no wall.ai; engine will silently no-op it', { kind: 'trigger', index: ti });
      }
    });

    return exitWalls;
  }

  // Numeric enemyType not in KNOWN_ENEMY_TYPES is a WARNING, not an error:
  // js/cyber-enemies.js's stat lookup is `STATS[typeId] || DEFAULT_STATS`
  // and its mesh lookup falls back to BUILDERS[0] -- a real, graceful runtime
  // fallback, not a crash. Verified against real data: Doom Thing id 84
  // (Wolfenstein SS) appears in three shipping canonical levels (pack3
  // json31/32/33) with no STATS entry and no reported ill effect. A
  // "custom:<id>" reference with no matching customEnemies entry has no such
  // fallback (nothing in the engine resolves a non-numeric type key), so
  // that stays a hard error, as does a structurally invalid enemyType.
  function checkEnemies(level, errors, warnings) {
    var customIds = {};
    if (level.customEnemies) {
      Object.keys(level.customEnemies).forEach(function (id) { customIds[id] = true; });
    }
    (level.entities || []).forEach(function (e, ei) {
      if (e.enemyType === undefined || e.enemyType === null) return; // pickup/decoration, not an enemy spawn
      var t = e.enemyType;
      if (typeof t === 'string' && t.indexOf('custom:') === 0) {
        var id = t.slice('custom:'.length);
        if (!customIds[id]) {
          err(errors, 'UNKNOWN_ENEMY_TYPE', 'entity ' + ei + ' references customEnemies id "' + id + '" which is not defined on this level', { kind: 'entity', index: ei });
        }
      } else if (typeof t === 'number') {
        if (KNOWN_ENEMY_TYPES.indexOf(t) === -1) {
          warn(warnings, 'ENEMY_TYPE_UNKNOWN_FALLBACK', 'entity ' + ei + ' has enemyType ' + t + ' with no STATS entry; engine will use DEFAULT_STATS and a generic mesh', { kind: 'entity', index: ei });
        }
      } else {
        err(errors, 'UNKNOWN_ENEMY_TYPE', 'entity ' + ei + ' has invalid enemyType ' + JSON.stringify(t), { kind: 'entity', index: ei });
      }
    });
  }

  // Grid cell size to use for THIS level: T.CELL (0.25, identical to
  // check-exits.js's model) normally, scaled up only far enough to keep the
  // grid under GRID_CELL_BUDGET cells for outlier megamaps (levelPacks/dv's
  // json1/2/5, ~20k walls). Below budget this returns T.CELL exactly, so
  // every normal-sized level (the other ~193 canonical levels) gets the
  // exact same resolution check-exits.js uses -- no risk of this validator
  // disagreeing with the authoritative offline check on a normal map.
  // ponytail: coarsening trades a little precision for a lot of speed on the
  // one map size class where the fine grid is a multi-second build; a sub-
  // cell-wide critical passage could in principle be missed, but P_RADIUS
  // (0.55) already makes anything under ~1.1 units unwalkable anyway, so at
  // the scale this actually triggers (dv/json2, cell ~0.6) it doesn't bite.
  // Upgrade path if that ever changes: optimize Grid's wall-blocking pass in
  // cyber-traversal.js (the actual cost driver) instead of coarsening.
  function pickCell(level) {
    var polys = T.sectorPolys(level);
    var rects = polys.length ? [] : T.floorRects(level);
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    polys.forEach(function (p) {
      var b = T.loopsBounds(p);
      minX = Math.min(minX, b[0]); minZ = Math.min(minZ, b[1]);
      maxX = Math.max(maxX, b[2]); maxZ = Math.max(maxZ, b[3]);
    });
    rects.forEach(function (r) {
      minX = Math.min(minX, r.x - r.width / 2); maxX = Math.max(maxX, r.x + r.width / 2);
      minZ = Math.min(minZ, r.z - r.depth / 2); maxZ = Math.max(maxZ, r.z + r.depth / 2);
    });
    if (!isFinite(minX)) return T.CELL;
    var baseCells = Math.ceil((maxX - minX + 2) / T.CELL) * Math.ceil((maxZ - minZ + 2) / T.CELL);
    if (baseCells <= GRID_CELL_BUDGET) return T.CELL;
    return T.CELL * Math.sqrt(baseCells / GRID_CELL_BUDGET);
  }

  /* Exit reachability + floor-coverage, computed against ONE CyberTraversal
     Grid build (same model check-exits.js's analyze() uses, same CELL for
     every normal-sized level, so "reachable" here never disagrees with the
     authoritative offline check). Handles any number of exit walls sharing
     switchId "sw_exit_game" -- the engine itself (this.exitWalls = walls
     .filter(...)) treats all of them as valid, e.g. a single WAD exit
     linedef split into several wall segments, or multiple genuine switches;
     "reachable" means the player can reach ANY of them. */
  function checkReachability(level, exitWalls, errors, warnings, stats) {
    var Grid = T.Grid, wallPoints = T.wallPoints, segDist = T.segDist, USE_RANGE = T.USE_RANGE;
    var sp = level.playerSpawn && level.playerSpawn.pos;
    if (!sp) return; // already flagged by schema check

    var cell = pickCell(level);
    if (cell !== T.CELL) {
      warn(warnings, 'REDUCED_PRECISION_GRID', 'level is large enough that reachability was checked at a coarser grid (' + cell.toFixed(2) + ' vs normal ' + T.CELL + ')', { kind: 'level', index: -1 });
    }

    var grid;
    try { grid = new Grid(level, cell); }
    catch (e) { err(errors, 'GRID_BUILD_FAILED', 'could not build the walk graph: ' + e.message, { kind: 'level', index: -1 }); return; }

    var start = grid.snap(sp[0], sp[2]);
    if (!start) { err(errors, 'SPAWN_OFF_FLOOR', 'playerSpawn is not on walkable floor', { kind: 'spawn', index: 0 }); return; }

    var flood = grid.flood(start[0], start[1]);
    var seen = flood.seen, reachableCells = flood.count;

    if (exitWalls.length) {
      var reachable = false;
      var pad = Math.ceil(USE_RANGE / cell) + 1;
      for (var e = 0; e < exitWalls.length && !reachable; e++) {
        var pts = wallPoints((level.walls || [])[exitWalls[e]]);
        var x0 = grid.cx(Math.min(pts[0], pts[2])) - pad, x1 = grid.cx(Math.max(pts[0], pts[2])) + pad;
        var z0 = grid.cz(Math.min(pts[1], pts[3])) - pad, z1 = grid.cz(Math.max(pts[1], pts[3])) + pad;
        for (var j = Math.max(0, z0); j <= Math.min(grid.h - 1, z1) && !reachable; j++) {
          for (var i = Math.max(0, x0); i <= Math.min(grid.w - 1, x1); i++) {
            if (!seen[j * grid.w + i]) continue;
            if (segDist(grid.wx(i), grid.wz(j), pts[0], pts[1], pts[2], pts[3]) <= USE_RANGE) { reachable = true; break; }
          }
        }
      }
      if (!reachable) {
        err(errors, 'EXIT_UNREACHABLE', 'exit switch(es) exist but are sealed off from spawn', { kind: 'wall', index: exitWalls[0] });
      }
    }

    var totalFree = 0;
    for (var k = 0; k < grid.free.length; k++) if (grid.free[k]) totalFree++;
    var pct = totalFree ? (reachableCells / totalFree) * 100 : 0;
    stats.reachableFloorPct = +pct.toFixed(1);
    var reachableArea = reachableCells * cell * cell;
    if (reachableArea < 200) {
      warn(warnings, 'SPAWN_POCKET_SMALL', 'only ' + reachableArea.toFixed(0) + ' sq units reachable from spawn', { kind: 'spawn', index: 0 });
    } else if (pct < 60 && totalFree * cell * cell >= 300) {
      warn(warnings, 'FLOOR_COVERAGE_LOW', 'only ' + pct.toFixed(1) + '% of floor is reachable from spawn', { kind: 'level', index: -1 });
    }
  }

  function validateLevel(level, opts) {
    opts = opts || {};
    var errors = [], warnings = [];
    var stats = {
      sectors: (level.sectors || []).length,
      walls: (level.walls || []).length,
      entities: (level.entities || []).length,
      triggers: (level.triggers || []).length,
      reachableFloorPct: null
    };

    checkSchema(level, errors);
    checkPolys(level, errors, warnings);
    var exitWalls = checkExitsAndTriggers(level, errors, warnings);
    checkEnemies(level, errors, warnings);

    if (!opts.quick && level.playerSpawn) {
      checkReachability(level, exitWalls, errors, warnings, stats);
    }

    return { errors: errors, warnings: warnings, stats: stats };
  }

  return { validateLevel: validateLevel, KNOWN_ENEMY_TYPES: KNOWN_ENEMY_TYPES };
});
