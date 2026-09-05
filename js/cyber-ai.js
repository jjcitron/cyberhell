/* ============================================================================
   CYBERHELL ENEMY AI  (window.CyberAI)

   Replaces the old "walk straight at the player if within 18 units" loop with
   perception, navigation, roles, coordination and pain.

     CyberAI.update(engine, delta)          driven by engine.updateEnemies
     CyberAI.onDamage(engine, enemy, amt)   wake + stagger on a hit
     CyberAI.hear(engine, x, z, radius)     noise event (player gunfire)
     CyberAI.losBetween(e, ax,ay,az, bx,by,bz)   clear line of sight?
     CyberAI.stats() / CyberAI.resetStats() nav + cost counters
     CyberAI.TUNING                         difficulty knobs, mutable
     CyberAI.setDifficulty('easy'|'normal'|'hard'|'nightmare')

   The engine keeps ownership of movement (moveEnemy), shooting
   (enemyAttack, spawnProjectile) and separation (separateEnemies); this
   module only decides where to go and when to fire.

   Enemy state stays 'IDLE' | 'CHASE' | 'DEAD' so existing tests and the
   enemy animation code keep working. Everything new hangs off enemy.ai.
   ========================================================================= */
(function () {
  'use strict';

  var T = null;                                   // THREE, bound on first use
  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /* ---------------------------------------------------------------------
     TUNING — one place for every number that changes how hard the game is.
     --------------------------------------------------------------------- */
  var TUNING = {
    // perception
    sightRange:     34,     // world units an enemy can see
    viewHalfAngle:  1.75,   // rad; 100 deg either side of facing = 200 deg cone
    peripheralRange: 4.0,   // inside this, facing does not matter
    hearRadius:     42,     // player gunfire wakes enemies within this
    hearPropagate:  14,     // a woken enemy wakes neighbours within this (one hop)
    losPeriod:      0.15,   // s between sight tests for an alerted enemy
    idleLosScale:   3.0,    // unalerted enemies test sight this much less often
    memory:         6.0,    // s an enemy keeps hunting after losing sight
    reactMin:       0.10,   // wake stagger, so a room does not react as one
    reactMax:       0.55,

    // budgets
    fullRadius:     40,     // full-rate brain inside this
    farRadius:      130,    // awake enemies out to here tick at 1/slowRate
    slowRate:       10,
    scanStripe:     4,      // frames to sweep the whole enemy array over (see update)
    maxNear:        90,     // hard cap on full-rate brains per frame
    animRadius:     22,     // rigs inside this animate every frame
    animSlowRate:   3,      // rigs from there out to fullRadius, 1 frame in 3

    // navigation
    cellSize:       1.5,
    fieldPeriod:    0.5,    // s between flow-field rebuilds
    fieldRadius:    58,     // world units the field reaches from the player
    fieldBudget:    5000,   // max cells per BFS
    fieldNewBudget: 160,    // max UNCACHED cells evaluated per BFS (see buildField)

    // coordination
    coordPeriod:    0.25,
    fanSpacing:     0.61,   // rad (35 deg) between neighbouring attackers
    maxAttackers:   3,      // ranged enemies allowed to fire at once (melee is free)

    // combat feel
    strafeSwap:     1.4,    // s between strafe direction flips
    leadFactor:     0.85,   // how much of the player's velocity casters lead
    burstSize:      3,      // shots a hitscanner fires before repositioning
    burstGap:       0.28,   // cooldown multiplier inside a burst
    repositionTime: 0.9,    // s a hitscanner sidesteps after a burst
    flinchFraction: 0.18,   // hit >= this share of max hp staggers
    flinchTime:     0.35,
    retreatHp:      0.25,   // smart types fall back below this share of max hp
    accuracy:       1.0,    // scales hitscan hit chance
    damageScale:    1.0,    // scales all enemy damage
    wanderRadius:   3.0,    // how far an unalerted enemy drifts from its post
    wanderPeriod:   1.6
  };

  var DIFFICULTY = {
    easy:      { maxAttackers: 2, accuracy: 0.7, damageScale: 0.7, reactMax: 0.8, burstSize: 2 },
    normal:    { maxAttackers: 3, accuracy: 1.0, damageScale: 1.0, reactMax: 0.55, burstSize: 3 },
    hard:      { maxAttackers: 5, accuracy: 1.2, damageScale: 1.15, reactMax: 0.35, burstSize: 4 },
    nightmare: { maxAttackers: 8, accuracy: 1.4, damageScale: 1.35, reactMax: 0.18, burstSize: 5 }
  };

  function setDifficulty(name) {
    var d = DIFFICULTY[name];
    if (!d) return false;
    for (var k in d) if (d.hasOwnProperty(k)) TUNING[k] = d[k];
    return true;
  }

  /* ---------------------------------------------------------------------
     ROLES
     Derived from CyberEnemies.stats(), overridden per Doom thing id where
     the stat line does not capture the intent (a Baron and an Imp both
     throw fireballs, but only one of them should walk into your shotgun).
     --------------------------------------------------------------------- */
  var ROLE_BY_ID = {
    3004: 'skirmisher',  // Zombieman
    9:    'skirmisher',  // Shotgun Guy
    65:   'skirmisher',  // Chaingunner
    3001: 'caster',      // Imp
    3002: 'rusher',      // Demon
    58:   'rusher',      // Spectre
    3005: 'caster',      // Cacodemon (flies)
    69:   'bruiser',     // Hell Knight
    3003: 'bruiser',     // Baron of Hell
    66:   'caster',      // Revenant (flies)
    67:   'bruiser',     // Mancubus
    68:   'caster',      // Arachnotron
    64:   'caster',      // Archvile
    16:   'bruiser',     // Cyberdemon
    7:    'bruiser'      // Spider Mastermind
  };

  // Stand-off distance as a fraction of the type's own range, and whether
  // the role gives ground when the player closes.
  var ROLE_BAND = {
    rusher:     { hold: 0.80, min: 0.00, backOff: false, strafes: false },
    skirmisher: { hold: 0.55, min: 0.30, backOff: true,  strafes: true  },
    caster:     { hold: 0.70, min: 0.45, backOff: true,  strafes: true  },
    bruiser:    { hold: 0.50, min: 0.00, backOff: false, strafes: false }
  };

  var DEFAULT_STATS = { hp: 50, speed: 3.5, attack: 'melee', range: 2.5, cooldown: 1.6, damage: 10 };

  // Projectile muzzle speeds, mirrored from PROJECTILE_KINDS in index.html so
  // casters can lead their shots. ponytail: three duplicated numbers beat
  // exporting the table across the region boundary; if a kind's speed changes
  // there, change it here.
  var PROJ_SPEED = { fireball: 12, plasma: 16, laser: 42 };

  function roleFor(stats, typeId) {
    var r = ROLE_BY_ID[parseInt(typeId, 10)];
    if (r) return r;
    var a = stats.attack;
    if (a === 'melee' || stats.range < 4) return 'rusher';
    if (stats.hp >= 300) return 'bruiser';
    if (a === 'hitscan') return 'skirmisher';
    return 'caster';
  }

  /* ---------------------------------------------------------------------
     Counters (CyberAI.stats)
     --------------------------------------------------------------------- */
  var M = {
    navMs: 0, fieldRebuilds: 0, fieldCells: 0, awake: 0,
    aiMs: 0, aiSum: 0, aiN: 0, aiMax: 0, rigMs: 0, rigSum: 0, rigN: 0, animN: 0,
    // Per-phase sums, so the frame budget can be attributed instead of guessed.
    pScan: 0, pField: 0, pCoord: 0, pBrain: 0, pSep: 0, nearN: 0, farN: 0
  };
  function resetStats() {
    M.aiMs = 0; M.aiSum = 0; M.aiN = 0; M.aiMax = 0;
    M.rigMs = 0; M.rigSum = 0; M.rigN = 0;
    M.pScan = 0; M.pField = 0; M.pCoord = 0; M.pBrain = 0; M.pSep = 0;
  }

  /* =====================================================================
     LINE OF SIGHT
     A 2D segment test against the engine's own solid walls, gated on
     height so you can see over a knee-high riser and under a lintel.
     Walls are collected by walking the engine's 4-unit wall buckets along
     the segment.
     ===================================================================== */
  var losSeen = new Set();

  function wallX(p) { return p.x !== undefined ? p.x : p[0]; }
  function wallZ(p) { return p.z !== undefined ? p.z : p[1]; }

  // Where segment A->B crosses segment C->D, as a parameter along A->B, or
  // -1 if they do not cross.
  function crossAt(ax, az, bx, bz, cx, cz, dx, dz) {
    var rx = bx - ax, rz = bz - az;
    var sx = dx - cx, sz = dz - cz;
    var denom = rx * sz - rz * sx;
    if (denom === 0) return -1;
    var qpx = cx - ax, qpz = cz - az;
    var t = (qpx * sz - qpz * sx) / denom;
    var u = (qpx * rz - qpz * rx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
    return t;
  }

  function losBetween(engine, ax, ay, az, bx, by, bz) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return true;
    // Sample every 2 units: the wall grid is 4 units, so no bucket the
    // segment passes through is skipped, including diagonal clips.
    var steps = Math.min(96, Math.ceil(len / 2));
    losSeen.clear();
    for (var s = 0; s <= steps; s++) {
      var f = s / steps;
      var arr = engine.wallsNear(ax + dx * f, az + dz * f, 0.1);
      for (var i = 0; i < arr.length; i++) {
        var w = arr[i];
        if (!w.solid || losSeen.has(w)) continue;
        losSeen.add(w);
        var t = crossAt(ax, az, bx, bz, wallX(w.p1), wallZ(w.p1), wallX(w.p2), wallZ(w.p2));
        if (t < 0) continue;
        if (w.topY === undefined || w.bottomY === undefined) return false;
        var y = ay + (by - ay) * t;
        if (y > w.bottomY && y < w.topY) return false;
      }
    }
    return true;
  }

  /* =====================================================================
     NAVIGATION
     A coarse grid materialised lazily: a cell is only evaluated the first
     time a flow field reaches it, and the answer is kept for the level.
     The biggest map is 1314 x 1104 units (645k cells at 1.5) so building
     it up front is not an option; the flow field only ever needs the
     few thousand cells around the player.
     ===================================================================== */
  var nav = null;
  // Enemies close enough or awake enough to be worth looking at every frame.
  // Rebuilt incrementally; see the scan in update().
  var active = [];
  var DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];

  function cellKey(i, j) { return (i + 16384) * 32768 + (j + 16384); }

  function ensureLevel(engine) {
    if (nav && nav.level === engine.levelData) return;
    nav = { level: engine.levelData, cells: new Map(), field: null, fieldT: -1e9 };
    active.length = 0;
    M.navMs = 0; M.fieldRebuilds = 0; M.fieldCells = 0;
  }

  // Work done materialising fresh cells in the current BFS, so the first
  // field on a level does not land as one big hitch.
  var buildWork = 0;

  // { w: walkable, y: floor height, m: 4-bit passable-edge mask, -1 = unknown }
  function cellAt(engine, i, j) {
    var k = cellKey(i, j);
    var c = nav.cells.get(k);
    if (c !== undefined) return c;
    buildWork++;
    var S = TUNING.cellSize;
    var f = engine.getFloorAt((i + 0.5) * S, (j + 0.5) * S);
    c = { w: !!f.inside, y: f.inside ? f.floorY : 0, m: -1 };
    nav.cells.set(k, c);
    return c;
  }

  // A wall blocks the step between two cell centres unless it is a door or a
  // switch panel (both open for anything that walks into them) or it sits
  // entirely below the feet / above the head of a body standing in the cell.
  function edgeMask(engine, i, j, c) {
    if (c.m >= 0) return c.m;
    buildWork += 2;                      // four segment sweeps, the pricier half
    var S = TUNING.cellSize;
    var x = (i + 0.5) * S, z = (j + 0.5) * S;
    var feet = c.y, head = c.y + 1.6;
    var m = 0;
    for (var d = 0; d < 4; d++) {
      var nx = x + DI[d] * S, nz = z + DJ[d] * S;
      var arr = engine.wallsNear((x + nx) / 2, (z + nz) / 2, S);
      var blocked = false;
      for (var a = 0; a < arr.length; a++) {
        var w = arr[a];
        if (!w.solid || w.isDoor || w.isSwitch) continue;
        if (w.topY !== undefined && w.topY <= feet + 0.05) continue;
        if (w.bottomY !== undefined && w.bottomY >= head) continue;
        if (crossAt(x, z, nx, nz, wallX(w.p1), wallZ(w.p1), wallX(w.p2), wallZ(w.p2)) >= 0) {
          blocked = true;
          break;
        }
      }
      if (!blocked) m |= (1 << d);
    }
    c.m = m;
    return m;
  }

  /* Breadth-first distance field rooted at the player. Enemies walk down it,
     which is what makes them come round a corner instead of pressing into a
     wall. One field is shared by everyone; flyers use it too and simply
     shortcut over ledges, since moveEnemy already lets them.
     ponytail: no separate flyer field, and no diagonal edges — the descent
     direction is averaged over all downhill neighbours, which smooths the
     4-connected staircase well enough at this cell size. */
  function buildField(engine, px, pz) {
    var t0 = now();
    var S = TUNING.cellSize;
    var STEP = 1.2;                       // climbable rise between cells
    var pi = Math.floor(px / S), pj = Math.floor(pz / S);

    var start = cellAt(engine, pi, pj);
    if (!start.w) {                       // player over a seam: seed a neighbour
      var found = false;
      for (var oi = -1; oi <= 1 && !found; oi++) {
        for (var oj = -1; oj <= 1 && !found; oj++) {
          if (cellAt(engine, pi + oi, pj + oj).w) { pi += oi; pj += oj; found = true; }
        }
      }
      if (!found) { nav.field = null; M.navMs += now() - t0; return; }
    }

    var maxRing = Math.ceil(TUNING.fieldRadius / S);
    buildWork = 0;
    var dist = new Map();
    var qi = [pi], qj = [pj], head = 0;
    dist.set(cellKey(pi, pj), 0);

    while (head < qi.length && dist.size < TUNING.fieldBudget) {
      var ci = qi[head], cj = qj[head]; head++;
      var d0 = dist.get(cellKey(ci, cj));
      if (d0 >= maxRing) continue;
      var c = cellAt(engine, ci, cj);
      // Past the work budget the frontier only advances through cells this
      // level has already paid for. The next rebuild, half a second later,
      // picks up where this one stopped, so the first field on a big map
      // grows in over a couple of seconds instead of costing 6 ms at once.
      var frugal = buildWork >= TUNING.fieldNewBudget;
      if (frugal && c.m < 0) continue;
      var mask = edgeMask(engine, ci, cj, c);
      for (var d = 0; d < 4; d++) {
        if (!(mask & (1 << d))) continue;
        var ni = ci + DI[d], nj = cj + DJ[d];
        var nk = cellKey(ni, nj);
        if (dist.has(nk)) continue;
        if (frugal && !nav.cells.has(nk)) continue;
        var nc = cellAt(engine, ni, nj);
        if (!nc.w) continue;
        // One Doom step up; drops are free, same rule moveEnemy enforces.
        if (nc.y - c.y > STEP) continue;
        dist.set(nk, d0 + 1);
        qi.push(ni); qj.push(nj);
      }
    }

    nav.field = { dist: dist, ci: pi, cj: pj };
    M.fieldRebuilds++;
    M.fieldCells = dist.size;
    M.navMs += now() - t0;
  }

  // Descent direction out of the field at a world position, or null.
  // Averages the pull of every downhill neighbour so the 4-connected grid
  // does not produce a visible zig-zag.
  function fieldDir(x, z, out) {
    var f = nav && nav.field;
    if (!f) return false;
    var S = TUNING.cellSize;
    var i = Math.floor(x / S), j = Math.floor(z / S);
    var here = f.dist.get(cellKey(i, j));
    if (here === undefined) return false;
    if (here === 0) return false;                 // standing on the player's cell
    var vx = 0, vz = 0, any = false;
    for (var d = 0; d < 4; d++) {
      var nd = f.dist.get(cellKey(i + DI[d], j + DJ[d]));
      if (nd === undefined || nd >= here) continue;
      var wgt = (here - nd);
      vx += DI[d] * wgt; vz += DJ[d] * wgt;
      any = true;
    }
    if (!any) return false;
    // Bias toward the centre line of the next cell so bodies do not scrape
    // the wall they are rounding.
    var cx = (i + 0.5) * S, cz = (j + 0.5) * S;
    vx += (cx - x) * 0.35; vz += (cz - z) * 0.35;
    var len = Math.sqrt(vx * vx + vz * vz);
    if (len < 1e-5) return false;
    out.x = vx / len; out.z = vz / len;
    return true;
  }

  /* =====================================================================
     PER-ENEMY STATE
     ===================================================================== */
  var seq = 0;

  function initEnemy(e) {
    var st = e.stats || DEFAULT_STATS;
    var role = roleFor(st, e.enemyType);
    e.ai = {
      role: role,
      alert: 0,
      seen: false,
      lastSeen: null,
      memT: 0,
      losT: Math.random() * TUNING.losPeriod,
      reactT: 0,
      slotAngle: null,
      attacker: false,
      burst: 0,
      cool: Math.random() * 0.6,
      repositionT: 0,
      strafe: (seq % 2) ? 1 : -1,
      strafeT: Math.random() * TUNING.strafeSwap,
      stuckT: 0,
      wanderT: Math.random() * TUNING.wanderPeriod,
      wanderX: e.group.position.x,
      wanderZ: e.group.position.z,
      retreat: false,
      hover: 2.2,
      phase: (seq++) % TUNING.slowRate,
      acc: 0,
      maxHp: e.hp || st.hp || 50,
      bearing: 0
    };
    if (e.flinchT === undefined) e.flinchT = 0;
    return e.ai;
  }

  function wake(e, delay) {
    if (!e.ai) return;
    if (e.state === 'DEAD' || e.ai.alert) return;
    e.ai.alert = 1;
    e.state = 'CHASE';
    e.ai.memT = TUNING.memory;
    e.ai.reactT = delay !== undefined ? delay
      : TUNING.reactMin + Math.random() * (TUNING.reactMax - TUNING.reactMin);
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */

  // Gunfire. Wakes everything inside `radius` regardless of walls, then
  // propagates one hop to their neighbours — a shot in the next room is
  // heard, and the room after that hears the reaction.
  function hear(engine, x, z, radius) {
    if (!engine || !engine.enemies) return 0;
    var r2 = radius * radius;
    var outer = radius + TUNING.hearPropagate;
    var outer2 = outer * outer;
    var fringe = [];
    var woken = [];
    var i, e, p, dx, dz, d2;
    for (i = 0; i < engine.enemies.length; i++) {
      e = engine.enemies[i];
      if (e.state === 'DEAD') continue;
      if (!e.ai) initEnemy(e);
      if (e.ai.alert) continue;
      p = e.group.position;
      dx = p.x - x; dz = p.z - z;
      d2 = dx * dx + dz * dz;
      if (d2 <= r2) {
        // Distant listeners react later, so a corridor wakes in a ripple.
        wake(e, TUNING.reactMin + Math.sqrt(d2) / radius * TUNING.reactMax);
        e.ai.lastSeen = { x: x, z: z };     // go and look where the shot came from
        woken.push(e);
      } else if (d2 <= outer2) {
        fringe.push(e);
      }
    }
    var prop2 = TUNING.hearPropagate * TUNING.hearPropagate;
    for (i = 0; i < fringe.length; i++) {
      e = fringe[i];
      if (e.ai.alert) continue;
      p = e.group.position;
      for (var j = 0; j < woken.length; j++) {
        var q = woken[j].group.position;
        dx = p.x - q.x; dz = p.z - q.z;
        if (dx * dx + dz * dz <= prop2) {
          wake(e, TUNING.reactMax * (1 + Math.random()));
          break;
        }
      }
    }
    return woken.length;
  }

  // A hit always wakes, and a big one staggers: the enemy stops, the pose
  // code picks up enemy.flinchT, and it cannot fire until it recovers.
  function onDamage(engine, enemy, amount) {
    if (!enemy || enemy.state === 'DEAD') return;
    var ai = enemy.ai || initEnemy(enemy);
    wake(enemy, 0);
    ai.memT = TUNING.memory;
    if (engine && engine.camera) ai.lastSeen = { x: engine.camera.position.x, z: engine.camera.position.z };
    if (amount >= ai.maxHp * TUNING.flinchFraction) {
      enemy.flinchT = TUNING.flinchTime;
      ai.burst = 0;
      ai.cool = Math.max(ai.cool, TUNING.flinchTime);
    }
    // A scream carries: the pack nearby comes looking.
    if (engine) hear(engine, enemy.group.position.x, enemy.group.position.z, TUNING.hearPropagate);
  }

  /* =====================================================================
     PERCEPTION
     ===================================================================== */
  function perceive(engine, e, cam) {
    var ai = e.ai, p = e.group.position;
    var dx = cam.x - p.x, dz = cam.z - p.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > TUNING.sightRange) return false;
    if (!ai.alert && dist > TUNING.peripheralRange) {
      // Unalerted enemies only see what is in front of them.
      var facing = e.group.rotation.y;
      var toA = Math.atan2(dx, dz);
      var diff = Math.abs(((toA - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff > TUNING.viewHalfAngle) return false;
    }
    var eyeY = p.y + ((e.stats && e.stats.fly) ? 0.2 : 1.2);
    return losBetween(engine, p.x, eyeY, p.z, cam.x, cam.y, cam.z);
  }

  /* =====================================================================
     COORDINATION
     Attackers are fanned around the player rather than stacked on the
     shortest line to him, and only a few of them may shoot at once.
     ===================================================================== */
  var fanList = [];

  function coordinate(engine, list, cam) {
    fanList.length = 0;
    var i, e;
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (e.state !== 'CHASE' || !e.ai.alert) { if (e.ai) e.ai.attacker = false; continue; }
      var p = e.group.position;
      e.ai.bearing = Math.atan2(p.x - cam.x, p.z - cam.z);
      fanList.push(e);
    }
    var n = fanList.length;
    if (!n) return;

    // Rank by current bearing so the assignment never asks two enemies to
    // swap sides of the player.
    fanList.sort(function (a, b) { return a.ai.bearing - b.ai.bearing; });

    // Centre the fan on the widest occupied span (the side they came from),
    // found as the complement of the largest gap in the bearing ring.
    var gapAt = 0, gapSize = -1;
    for (i = 0; i < n; i++) {
      var a = fanList[i].ai.bearing;
      var b = fanList[(i + 1) % n].ai.bearing + (i + 1 === n ? Math.PI * 2 : 0);
      var g = b - a;
      if (g > gapSize) { gapSize = g; gapAt = i; }
    }
    var spacing = Math.min(TUNING.fanSpacing, (Math.PI * 2 - 0.2) / Math.max(1, n));
    // The enemy just after the largest gap is the start of the arc.
    var startIdx = (gapAt + 1) % n;
    var arcStart = fanList[startIdx].ai.bearing;
    var span = spacing * (n - 1);
    var occupied = (Math.PI * 2 - gapSize);
    var base = arcStart + (occupied - span) / 2;
    for (i = 0; i < n; i++) {
      var e2 = fanList[(startIdx + i) % n];
      e2.ai.slotAngle = base + spacing * i;
    }

    // Attack budget. Melee is never rationed — a demon on your face always
    // bites — but ranged fire is, so the rest keep moving instead of all
    // unloading from the back rank.
    var budget = TUNING.maxAttackers;
    fanList.sort(function (a, b) {
      var pa = a.group.position, pb = b.group.position;
      var da = (pa.x - cam.x) * (pa.x - cam.x) + (pa.z - cam.z) * (pa.z - cam.z);
      var db = (pb.x - cam.x) * (pb.x - cam.x) + (pb.z - cam.z) * (pb.z - cam.z);
      return da - db;
    });
    for (i = 0; i < n; i++) {
      e = fanList[i];
      var melee = (e.stats && e.stats.attack === 'melee') || e.ai.role === 'rusher';
      if (melee) { e.ai.attacker = true; continue; }
      if (e.ai.seen && budget > 0) { e.ai.attacker = true; budget--; }
      else e.ai.attacker = false;
    }
  }

  /* =====================================================================
     THE BRAIN
     ===================================================================== */
  var dirTmp = { x: 0, z: 0 };

  function brain(engine, e, dt, cam) {
    var ai = e.ai;
    var st = e.stats || DEFAULT_STATS;
    var p = e.group.position;

    // --- perception ----------------------------------------------------
    ai.losT -= dt;
    if (ai.losT <= 0) {
      ai.losT = TUNING.losPeriod * (ai.alert ? 1 : TUNING.idleLosScale) * (0.75 + Math.random() * 0.5);
      ai.seen = perceive(engine, e, cam);
      if (ai.seen) {
        if (!ai.lastSeen) ai.lastSeen = { x: cam.x, z: cam.z };
        else { ai.lastSeen.x = cam.x; ai.lastSeen.z = cam.z; }
        ai.memT = TUNING.memory;
      }
    }
    if (!ai.seen && ai.memT > 0) ai.memT -= dt;

    // --- unalerted: hold the post, drift a little ----------------------
    if (!ai.alert) {
      if (ai.seen) wake(e);
      else { idle(engine, e, dt); return; }
    }

    // --- staggered by a hit, or still reacting to the alarm ------------
    if (e.flinchT > 0) {
      e.flinchT -= dt;
      face(e, ai.seen ? cam.x : (ai.lastSeen ? ai.lastSeen.x : cam.x),
              ai.seen ? cam.z : (ai.lastSeen ? ai.lastSeen.z : cam.z));
      return;
    }
    if (ai.reactT > 0) {
      ai.reactT -= dt;
      face(e, cam.x, cam.z);
      return;
    }

    var dx = cam.x - p.x, dz = cam.z - p.z;
    var dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    face(e, ai.seen || !ai.lastSeen ? cam.x : ai.lastSeen.x,
            ai.seen || !ai.lastSeen ? cam.z : ai.lastSeen.z);

    var band = ROLE_BAND[ai.role] || ROLE_BAND.rusher;
    var hold = Math.max(1.6, st.range * band.hold);
    var minKeep = st.range * band.min;

    // Smart types that are nearly dead break off instead of feeding you a kill.
    if (band.backOff && e.hp <= ai.maxHp * TUNING.retreatHp) ai.retreat = true;
    if (ai.retreat && dist > st.range * 1.05) ai.retreat = false;

    // --- where to be ---------------------------------------------------
    var wx = 0, wz = 0, moving = true;

    if (ai.retreat) {
      // ponytail: "cover" is just distance plus a sidestep. A real
      // cover search wants a second BFS over cells with no LOS to the
      // player; add it if the fallback reads as cowardly-but-dumb.
      wx = -dx / dist; wz = -dz / dist;
      wx += -dz / dist * ai.strafe * 0.6;
      wz += dx / dist * ai.strafe * 0.6;
    } else if (!ai.seen || dist > Math.max(10, hold * 1.2)) {
      // Out of sight, or outside its own stand-off ring: route around the
      // geometry instead of pressing into it.
      var goalX = ai.seen || !ai.lastSeen ? cam.x : ai.lastSeen.x;
      var goalZ = ai.seen || !ai.lastSeen ? cam.z : ai.lastSeen.z;
      if (fieldDir(p.x, p.z, dirTmp)) {
        wx = dirTmp.x; wz = dirTmp.z;
      } else {
        var gx = goalX - p.x, gz = goalZ - p.z;
        var gl = Math.sqrt(gx * gx + gz * gz) || 1;
        wx = gx / gl; wz = gz / gl;
      }
      // Close on the assigned slot rather than the player's exact spot, so
      // a pack arrives spread out instead of in single file.
      if (ai.slotAngle !== null && dist < hold * 2.2) {
        var sx = cam.x + Math.sin(ai.slotAngle) * hold;
        var sz = cam.z + Math.cos(ai.slotAngle) * hold;
        var ox = sx - p.x, oz = sz - p.z;
        var ol = Math.sqrt(ox * ox + oz * oz) || 1;
        wx += ox / ol * 0.8; wz += oz / ol * 0.8;
      }
    } else {
      // In sight and close: hold the band, take the assigned bearing.
      var ang = ai.slotAngle !== null ? ai.slotAngle : Math.atan2(p.x - cam.x, p.z - cam.z);
      var tx = cam.x + Math.sin(ang) * hold;
      var tz = cam.z + Math.cos(ang) * hold;
      var vx = tx - p.x, vz = tz - p.z;
      var vl = Math.sqrt(vx * vx + vz * vz);
      if (vl > 0.35) { wx = vx / vl; wz = vz / vl; } else moving = false;

      if (band.backOff && dist < minKeep) {           // too close: give ground
        wx = -dx / dist; wz = -dz / dist; moving = true;
      }
      if (band.strafes && (ai.repositionT > 0 || (dist > minKeep && dist < st.range))) {
        var s = ai.repositionT > 0 ? 1.0 : 0.55;
        wx += -dz / dist * ai.strafe * s;
        wz += dx / dist * ai.strafe * s;
        moving = true;
      }
    }

    ai.strafeT -= dt;
    if (ai.strafeT <= 0) { ai.strafe = -ai.strafe; ai.strafeT = TUNING.strafeSwap * (0.7 + Math.random() * 0.8); }
    if (ai.repositionT > 0) ai.repositionT -= dt;

    // --- move ----------------------------------------------------------
    if (moving) {
      var wl = Math.sqrt(wx * wx + wz * wz);
      if (wl > 1e-4) {
        var sp = st.speed * (ai.retreat ? 1.1 : 1.0);
        var bx = p.x, bz = p.z;
        var stepX = (wx / wl) * sp * dt, stepZ = (wz / wl) * sp * dt;
        engine.moveEnemy(e, stepX, stepZ);
        // Blocked? Flip the strafe and lean on the field next time round.
        var got = Math.abs(p.x - bx) + Math.abs(p.z - bz);
        var wanted = Math.abs(stepX) + Math.abs(stepZ);
        if (wanted > 1e-4 && got < wanted * 0.3) {
          ai.stuckT += dt;
          if (ai.stuckT > 0.35) { ai.strafe = -ai.strafe; ai.stuckT = 0; ai.slotAngle = null; }
        } else ai.stuckT = 0;
      }
    }

    // --- vertical --------------------------------------------------------
    place(engine, e, dt, cam);

    // --- shoot ------------------------------------------------------------
    ai.cool -= dt;
    if (!ai.attacker || !ai.seen) return;
    if (dist > st.range) return;
    if (ai.cool > 0) return;

    ai.lead = leadTime(st, dist);
    engine.enemyAttack(e);

    if (ai.role === 'skirmisher') {
      // Burst, then break off sideways for a beat.
      if (ai.burst <= 0) ai.burst = TUNING.burstSize;
      ai.burst--;
      if (ai.burst > 0) ai.cool = st.cooldown * TUNING.burstGap;
      else { ai.cool = st.cooldown * 1.5; ai.repositionT = TUNING.repositionTime; }
    } else if (ai.role === 'bruiser') {
      ai.cool = st.cooldown * 0.9;                 // heavy, and it keeps coming
      ai.repositionT = 0;
    } else {
      ai.cool = st.cooldown * (0.85 + Math.random() * 0.4);
    }
  }

  // Seconds of flight to the player, used to lead the shot.
  function leadTime(st, dist) {
    var sp = PROJ_SPEED[st.attack];
    if (!sp) return 0;
    return Math.min(1.2, dist / sp) * TUNING.leadFactor;
  }

  function face(e, x, z) {
    e.group.rotation.y = Math.atan2(x - e.group.position.x, z - e.group.position.z);
  }

  // Unalerted drift: a few steps around the post, then a new heading. Cheap
  // and rate-limited — the megamaps keep thousands of these standing about.
  function idle(engine, e, dt) {
    var ai = e.ai, p = e.group.position;
    ai.wanderT -= dt;
    if (ai.wanderT <= 0) {
      ai.wanderT = TUNING.wanderPeriod * (0.6 + Math.random() * 1.4);
      var a = Math.random() * Math.PI * 2;
      var r = TUNING.wanderRadius * Math.random();
      ai.wanderGoalX = ai.wanderX + Math.cos(a) * r;
      ai.wanderGoalZ = ai.wanderZ + Math.sin(a) * r;
    }
    if (ai.wanderGoalX !== undefined) {
      var gx = ai.wanderGoalX - p.x, gz = ai.wanderGoalZ - p.z;
      var gl = Math.sqrt(gx * gx + gz * gz);
      if (gl > 0.4) {
        var sp = ((e.stats && e.stats.speed) || 3) * 0.28;
        engine.moveEnemy(e, gx / gl * sp * dt, gz / gl * sp * dt);
        face(e, ai.wanderGoalX, ai.wanderGoalZ);
      }
    }
    place(engine, e, dt, null);
  }

  // Walkers sit on their floor; flyers hover, and lift toward the player's
  // eye line when they are engaging so they attack from above.
  function place(engine, e, dt, cam) {
    var p = e.group.position;
    var ai = e.ai;
    // moveEnemy refreshes floorY whenever a body actually moves, but a body
    // that is standing still can still have the floor move under it: lifts and
    // switch-raised sectors change sec.floorY at runtime. Re-read it on a slow
    // timer so a hovering flyer does not end up sitting under its own floor.
    ai.floorT = (ai.floorT || 0) - dt;
    if (e.floorY === undefined || ai.floorT <= 0) {
      ai.floorT = 0.25;
      var f = engine.getFloorAt(p.x, p.z);
      e.floorY = f.inside ? f.floorY : (e.floorY !== undefined ? e.floorY : p.y);
    }
    if (e.stats && e.stats.fly) {
      var want = 2.2;
      if (cam && ai.alert) {
        want = Math.min(5.0, Math.max(1.9, (cam.y - e.floorY) + 0.9));
      }
      ai.hover += (want - ai.hover) * Math.min(1, dt * 1.5);
      e.bobT = (e.bobT || 0) + dt * 1.6;
      p.y = e.floorY + ai.hover + Math.sin(e.bobT) * 0.18;
    } else {
      p.y = e.floorY;
    }
  }

  /* =====================================================================
     FRAME
     ===================================================================== */
  var nearList = [];
  var animList = [];
  var lastAmmo = -1;
  var coordT = 0;
  var frameNo = 0;

  function totalAmmo(engine) {
    var a = engine.player && engine.player.ammo;
    if (!a) return 0;
    var s = 0;
    for (var k in a) if (typeof a[k] === 'number') s += a[k];
    return s;
  }

  // The player's own gunfire is the loudest thing in the level. Rather than
  // reach into the weapons region for a hook, watch the ammo pools: any
  // decrease is a shot, wherever it came from.
  function detectGunfire(engine) {
    var t = totalAmmo(engine);
    if (lastAmmo >= 0 && t < lastAmmo) hear(engine, engine.camera.position.x, engine.camera.position.z, TUNING.hearRadius);
    lastAmmo = t;
  }

  function update(engine, delta) {
    if (!engine || !engine.enemies) return;
    if (!T) T = (typeof THREE !== 'undefined') ? THREE : (typeof window !== 'undefined' ? window.THREE : null);
    var t0 = now();

    ensureLevel(engine);
    detectGunfire(engine);

    var cam = engine.camera.position;
    var FULL2 = TUNING.fullRadius * TUNING.fullRadius;
    var FAR2 = TUNING.farRadius * TUNING.farRadius;
    frameNo++;
    var slowPhase = frameNo % TUNING.slowRate;

    var tPhase = now();
    nearList.length = 0;
    animList.length = 0;
    var awake = 0;
    var farN = 0;
    var enemies = engine.enemies;

    // Touching all 4,161 enemies every frame was a third of the AI budget on
    // the megamap. Instead keep an `active` set of everything near or awake and
    // walk that in full, discovering new entrants by sweeping a quarter of the
    // array each frame. A distant sleeper notices the player up to three frames
    // late, which is 50 ms and invisible; nothing already engaged is ever
    // missed, because it stays in `active` until it is both far and asleep.
    var STRIPE = TUNING.scanStripe;
    var lane = frameNo % STRIPE;
    var KEEP2 = FAR2 * 1.3;
    var w = 0, a, ea, pa, ax, az, a2;
    for (a = 0; a < active.length; a++) {
      ea = active[a];
      pa = ea.group.position;
      ax = pa.x - cam.x; az = pa.z - cam.z;
      a2 = ax * ax + az * az;
      if ((ea.state === 'DEAD' && a2 > FULL2) || (a2 > KEEP2 && ea.state !== 'CHASE')) {
        if (ea.ai) ea.ai.inActive = false;
        continue;
      }
      active[w++] = ea;
    }
    active.length = w;
    for (var n0 = lane; n0 < enemies.length; n0 += STRIPE) {
      var en0 = enemies[n0];
      if (en0.ai && en0.ai.inActive) continue;
      var pn = en0.group.position;
      var nx = pn.x - cam.x, nz = pn.z - cam.z;
      if (nx * nx + nz * nz > FULL2 && en0.state !== 'CHASE') continue;
      // Nothing is allocated for an enemy that is neither near nor awake: the
      // megamap has 4,161 of them and initialising them all on the first
      // frame was a 17 ms hitch on level load.
      (en0.ai || initEnemy(en0)).inActive = true;
      active.push(en0);
    }

    for (var i = 0; i < active.length; i++) {
      var e = active[i];
      var p0 = e.group.position;
      var qx = p0.x - cam.x, qz = p0.z - cam.z;
      var q2 = qx * qx + qz * qz;
      // Corpses still animate (they are falling over), so the animation set
      // is collected before the DEAD skip.
      if (q2 <= FULL2) animList.push(e);
      if (e.state === 'DEAD') continue;
      var ai = e.ai;
      if (e.state === 'CHASE') {
        if (!ai.alert) {
          // Woken by something outside this module (a hit, or a test).
          ai.alert = 1;
          ai.memT = TUNING.memory;
          if (!ai.lastSeen) ai.lastSeen = { x: cam.x, z: cam.z };
        }
        awake++;
      }
      var d2 = q2;
      ai.acc += delta;
      if (d2 <= FULL2) {
        // Unalerted bystanders are the bulk of a near set on the megamaps
        // (297 of them in the busiest room). They only look around and shuffle,
        // so they run at a fifth of the rate; sight tests are rate-limited to
        // 0.45 s anyway, so nothing is lost.
        if (ai.alert || (ai.phase % 5) === (slowPhase % 5)) nearList.push(e);
      } else if (ai.alert && d2 <= FAR2 && ai.phase === slowPhase) {
        // Awake but out of the action: one frame in ten, with the whole
        // accumulated delta, so they keep closing without costing anything.
        brain(engine, e, ai.acc, cam);
        ai.acc = 0;
        farN++;
      }
    }
    M.awake = awake;
    M.farN = farN;
    M.activeN = active.length;
    M.pScan += now() - tPhase;

    // Cap the full-rate set on the megamaps: nearest first, the overflow
    // drops to the slow lane for this frame.
    if (nearList.length > TUNING.maxNear) {
      nearList.sort(function (a, b) {
        var pa = a.group.position, pb = b.group.position;
        return ((pa.x - cam.x) * (pa.x - cam.x) + (pa.z - cam.z) * (pa.z - cam.z))
             - ((pb.x - cam.x) * (pb.x - cam.x) + (pb.z - cam.z) * (pb.z - cam.z));
      });
      nearList.length = TUNING.maxNear;
    }

    // Flow field, rebuilt on a timer and only while somebody is using it.
    coordT += delta;
    var anyAwakeNear = false;
    for (var n = 0; n < nearList.length; n++) if (nearList[n].ai.alert) { anyAwakeNear = true; break; }
    tPhase = now();
    if (anyAwakeNear && (coordT - nav.fieldT) > TUNING.fieldPeriod) {
      nav.fieldT = coordT;
      buildField(engine, cam.x, cam.z);
    }
    M.pField += now() - tPhase;

    tPhase = now();
    if (anyAwakeNear && (coordT - (nav.coordT || -1e9)) > TUNING.coordPeriod) {
      nav.coordT = coordT;
      coordinate(engine, nearList, cam);
    }
    M.pCoord += now() - tPhase;

    tPhase = now();
    for (var k = 0; k < nearList.length; k++) {
      var en = nearList[k];
      brain(engine, en, en.ai.acc, cam);
      en.ai.acc = 0;
    }
    M.nearN = nearList.length;
    M.pBrain += now() - tPhase;

    tPhase = now();
    engine.separateEnemies();
    M.pSep += now() - tPhase;
    animate(engine, delta);

    var ms = now() - t0;
    M.aiMs = ms;
    M.aiSum += ms; M.aiN++;
    if (ms > M.aiMax) M.aiMax = ms;
  }

  /* CyberEnemies drives its own animation off a private requestAnimationFrame
     over EVERY enemy. Two problems with that here: it is 4,161 animate() calls
     a frame on the megamaps, and it races this module for group.position.y --
     flyers register a bob on the ROOT group whose rest height was baked before
     the engine ever positioned them, so it drags them down to y ~ 0 and they
     sit on the floor instead of hovering. Take the tick over through the
     documented autoDrive switch and run it AFTER placement, over the enemies
     near enough to see. The underlying baked-rest-height bug is still worth
     fixing in js/cyber-enemies.js. */
  var _frustum = null, _fm = null, _sphere = null;
  function animate(engine, delta) {
    var CE = (typeof window !== 'undefined') && window.CyberEnemies;
    if (!CE || !CE.animate) return;
    CE.autoDrive = false;
    var t0r = now();
    var t = now() / 1000;
    var NEAR2 = TUNING.animRadius * TUNING.animRadius;
    var slow = frameNo % TUNING.animSlowRate;
    var shown = 0;
    // A body behind the camera is drawn by nobody, so animating its rig is
    // pure cost. One matrix multiply builds the test for the whole frame.
    if (T && !_frustum) { _frustum = new T.Frustum(); _fm = new T.Matrix4(); _sphere = new T.Sphere(); }
    if (_frustum) {
      engine.camera.updateMatrixWorld();
      _fm.multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_fm);
    }
    for (var i = 0; i < animList.length; i++) {
      var e = animList[i];
      if (_frustum && !_frustum.containsPoint(e.group.position)) {
        // Its feet may still be inside the view even when the origin is not,
        // so allow a body's worth of slack before skipping.
        var cp = e.group.position;
        if (!_frustum.intersectsSphere(_sphere.set(cp, 1.6))) { reassert(e); continue; }
      }
      // Rig animation is the most expensive thing per body (limbs, jaws,
      // emissive pulses). Close bodies animate every frame; the rest of the
      // 40-unit set animates on a third of them, which nobody reads as choppy
      // at that distance.
      var pa = e.group.position;
      var adx = pa.x - engine.camera.position.x, adz = pa.z - engine.camera.position.z;
      if (adx * adx + adz * adz > NEAR2 && (!e.ai || (e.ai.phase % TUNING.animSlowRate) !== slow)) {
        reassert(e);
        continue;
      }
      shown++;
      try { CE.animate(e, t, delta); } catch (err) { /* one bad rig must not stop the frame */ }
      // A rig bob on the root writes an absolute world y from a rest height
      // baked before the engine placed the body, so re-assert the height this
      // module owns. Corpses are left to the death animation. No getFloorAt
      // here: floorY is already current from moveEnemy / place.
      reassert(e);
    }
    M.animN = shown;
    M.rigMs = now() - t0r;
    M.rigSum += M.rigMs; M.rigN++;
  }

  function reassert(e) {
    if (e.state === 'DEAD' || e.floorY === undefined || !e.ai) return;
    e.group.position.y = (e.stats && e.stats.fly)
      ? e.floorY + e.ai.hover + Math.sin(e.bobT || 0) * 0.18
      : e.floorY;
  }

  function stats() {
    return {
      navCells: nav ? nav.cells.size : 0,
      navMs: +M.navMs.toFixed(2),
      cellSize: TUNING.cellSize,
      fieldRebuilds: M.fieldRebuilds,
      fieldCells: M.fieldCells,
      awake: M.awake,
      aiMs: +M.aiMs.toFixed(3),
      aiMsAvg: M.aiN ? +(M.aiSum / M.aiN).toFixed(3) : 0,
      aiMsMax: +M.aiMax.toFixed(3),
      // The enemy rig animation tick, taken over from CyberEnemies' own rAF
      // (see animate()). Counted inside aiMs but broken out, because it is
      // model cost, not decision cost.
      rigMsAvg: M.rigN ? +(M.rigSum / M.rigN).toFixed(3) : 0,
      brainMsAvg: M.aiN ? +((M.aiSum - M.rigSum) / M.aiN).toFixed(3) : 0,
      animated: M.animN,
      phases: M.aiN ? {
        scan:  +(M.pScan / M.aiN).toFixed(3),   // sweep over every enemy + far-lane brains
        field: +(M.pField / M.aiN).toFixed(3),  // flow-field BFS
        coord: +(M.pCoord / M.aiN).toFixed(3),  // fan + attack budget
        brain: +(M.pBrain / M.aiN).toFixed(3),  // near-set decisions and movement
        sep:   +(M.pSep / M.aiN).toFixed(3),    // engine separateEnemies
        rig:   +(M.rigSum / M.aiN).toFixed(3)   // CyberEnemies.animate
      } : null,
      nearCount: M.nearN, farCount: M.farN, activeCount: M.activeN
    };
  }

  var API = {
    TUNING: TUNING,
    setDifficulty: setDifficulty,
    update: update,
    onDamage: onDamage,
    hear: hear,
    losBetween: losBetween,
    roleFor: roleFor,
    stats: stats,
    resetStats: resetStats
  };

  // Claimed at load, not on the first update: the rig driver's own rAF can
  // beat the engine's by a frame, and one stomped frame permanently misplaces
  // every enemy too far away for this module to ever correct.
  if (typeof window !== 'undefined' && window.CyberEnemies) window.CyberEnemies.autoDrive = false;

  if (typeof window !== 'undefined') window.CyberAI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
