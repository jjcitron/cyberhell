/* ===========================================================================
   model.js — the editable level model.

   The model IS the parsed level JSON. Nothing is transformed on load and
   nothing is added on save, so any level round-trips byte-for-byte in value
   (key order included) as long as nothing touched it. Unknown keys survive
   because they are never copied out.

   The invariants this file exists to protect (verified against
   js/cyber-traversal.js init(), NOT the research doc, which got this wrong):

     * triggers[].i is a Doom LINEDEF index, not a walls[] index. A wall joins
       its trigger through wall.ai === trigger.i (traversal builds byLine from
       trigger.i and looks it up with wall.ai). So splicing walls must NOT
       renumber trigger.i -- doing that silently rewires every lift and door.
     * data.walls[i] <-> engine.walls[i] IS positional, which is why wall order
       must not be shuffled: the runtime objects are found by index.
     * sector indices appear in three places and all three must be re-based
       together when a sector is removed: triggers[].act.secs, the duplicate
       walls[].act.secs, and walls[].fs / walls[].bs.

   Classic script. Exposes window.EdModel. Also usable from node (module.exports)
   so tests/editor-roundtrip.js can drive it.
   =========================================================================== */
(function () {
  'use strict';

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* Stable serialisation: 2-space JSON, the same shape the converter emits. */
  function serialize(level) { return JSON.stringify(level, null, 2); }

  /* Value + key-order equality. JSON.stringify preserves insertion order, so
     comparing the two strings catches a reordered key as well as a lost one. */
  function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function blankLevel(name) {
    return {
      name: name || 'NEW LEVEL (MAP01)',
      skyColor: 526613,
      fogColor: 724248,
      fogDensity: 0.015,
      ambientLight: 4478310,
      sunLight: { color: 7838173, intensity: 1, pos: [30, 80, -30] },
      playerSpawn: { pos: [0, 1.5, 0], rot: 0 },
      sectors: [],
      walls: [],
      triggers: [],
      entities: []
    };
  }

  function arr(level, key) {
    if (!level[key]) level[key] = [];
    return level[key];
  }

  /* ---- geometry helpers ------------------------------------------------- */

  function polyArea(poly) {
    var a = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  function pointInPoly(poly, x, z) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  function sectorPolys(sec) {
    if (sec.polys && sec.polys.length) return sec.polys;
    // Legacy rectangle-only sectors (hand-built MAP01) have no polys.
    if (typeof sec.x === 'number' && typeof sec.width === 'number') {
      var hw = sec.width / 2, hd = sec.depth / 2;
      return [[[sec.x - hw, sec.z - hd], [sec.x + hw, sec.z - hd],
               [sec.x + hw, sec.z + hd], [sec.x - hw, sec.z + hd]]];
    }
    return [];
  }

  function sectorBBox(sec) {
    var polys = sectorPolys(sec);
    var b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    for (var i = 0; i < polys.length; i++) {
      for (var j = 0; j < polys[i].length; j++) {
        var p = polys[i][j];
        if (p[0] < b.x0) b.x0 = p[0];
        if (p[0] > b.x1) b.x1 = p[0];
        if (p[1] < b.z0) b.z0 = p[1];
        if (p[1] > b.z1) b.z1 = p[1];
      }
    }
    return b;
  }

  /* Which sector contains (x,z)? Outer loop wins, inner loops (holes) punch out
     only when there is more than one loop, matching the converter's shape. */
  function sectorAt(level, x, z) {
    var secs = level.sectors || [];
    for (var i = 0; i < secs.length; i++) {
      var polys = sectorPolys(secs[i]);
      if (!polys.length) continue;
      if (!pointInPoly(polys[0], x, z)) continue;
      var hole = false;
      for (var k = 1; k < polys.length; k++) if (pointInPoly(polys[k], x, z)) hole = true;
      if (!hole) return i;
    }
    return -1;
  }

  function levelBounds(level) {
    var b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity }, i;
    var secs = level.sectors || [];
    for (i = 0; i < secs.length; i++) {
      var sb = sectorBBox(secs[i]);
      if (sb.x0 < b.x0) b.x0 = sb.x0;
      if (sb.z0 < b.z0) b.z0 = sb.z0;
      if (sb.x1 > b.x1) b.x1 = sb.x1;
      if (sb.z1 > b.z1) b.z1 = sb.z1;
    }
    var walls = level.walls || [];
    for (i = 0; i < walls.length; i++) {
      var w = walls[i];
      b.x0 = Math.min(b.x0, w.p1[0], w.p2[0]);
      b.x1 = Math.max(b.x1, w.p1[0], w.p2[0]);
      b.z0 = Math.min(b.z0, w.p1[1], w.p2[1]);
      b.z1 = Math.max(b.z1, w.p1[1], w.p2[1]);
    }
    if (!isFinite(b.x0)) return { x0: -20, z0: -20, x1: 20, z1: 20 };
    return b;
  }

  /* ---- mutations that must keep indices honest -------------------------- */

  function addWall(level, wall) {
    arr(level, 'walls').push(wall);
    return level.walls.length - 1;
  }

  /* Removes wall[idx] by splicing. Splicing is safe because nothing PERSISTED
     references a wall by array position -- a census over all 197 levels in
     tests/editor-roundtrip.js proves the only cross-references are linedef ids
     (trigger.i / wall.ai) and sector indices (act.secs, fs, bs, tag), and that
     gate fails if the converter ever adds one. The walls[i] <-> engine.walls[i]
     lockstep is rebuilt from the file on every load, so it survives a splice;
     what it would NOT survive is reordering walls in memory mid-load, which the
     editor never does. Marking-instead-of-deleting would be worse: a marked
     wall still builds as real geometry.

     Trigger indices are linedef ids, so they are left alone; the only cleanup is
     dropping a trigger whose last wall just went away. */
  function removeWall(level, idx) {
    if (!level.walls || idx < 0 || idx >= level.walls.length) return;
    var gone = level.walls[idx];
    level.walls.splice(idx, 1);
    if (!level.triggers || gone.ai === undefined) return;
    var stillLinked = level.walls.some(function (w) { return w.ai === gone.ai; });
    if (stillLinked) return;
    for (var t = level.triggers.length - 1; t >= 0; t--) {
      if (level.triggers[t].i === gone.ai) level.triggers.splice(t, 1);
    }
  }

  /* Removes sector[idx] and re-bases every sector index that points past it:
     triggers[].act.secs, walls[].act.secs, walls[].fs and walls[].bs. A trigger
     whose whole target list disappears is dropped with it. */
  function rebaseSecs(secs, idx) {
    var out = [];
    for (var s = 0; s < secs.length; s++) {
      if (secs[s] === idx) continue;
      out.push(secs[s] > idx ? secs[s] - 1 : secs[s]);
    }
    return out;
  }

  function removeSector(level, idx) {
    if (!level.sectors || idx < 0 || idx >= level.sectors.length) return;
    level.sectors.splice(idx, 1);

    var trs = level.triggers || [];
    for (var t = trs.length - 1; t >= 0; t--) {
      var secs = trs[t].act && trs[t].act.secs;
      if (!secs) continue;
      var out = rebaseSecs(secs, idx);
      if (!out.length) trs.splice(t, 1);
      else trs[t].act.secs = out;
    }

    var walls = level.walls || [];
    for (var w = 0; w < walls.length; w++) {
      if (walls[w].act && walls[w].act.secs) walls[w].act.secs = rebaseSecs(walls[w].act.secs, idx);
      ['fs', 'bs'].forEach(function (k) {
        var v = walls[w][k];
        if (v === undefined || v < 0) return;
        if (v === idx) walls[w][k] = -1;
        else if (v > idx) walls[w][k] = v - 1;
      });
    }
  }

  /* Next free linedef id, so an editor-made trigger cannot collide with a
     converted one (or with the ai of an untouched wall). */
  function nextLineId(level) {
    var max = -1;
    (level.walls || []).forEach(function (w) { if (typeof w.ai === 'number' && w.ai > max) max = w.ai; });
    (level.triggers || []).forEach(function (t) { if (typeof t.i === 'number' && t.i > max) max = t.i; });
    return max + 1;
  }

  /* Binds an action to wall[wallIndex], giving the wall an `ai` linedef id if
     it has none. The wall also carries the duplicate `act` the converter
     writes, so index.html's own use-handling sees the same thing. */
  function setTrigger(level, wallIndex, act) {
    var trs = arr(level, 'triggers');
    var w = level.walls[wallIndex];
    if (w.ai === undefined) w.ai = nextLineId(level);
    w.act = act;
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].i === w.ai) { trs[i].act = act; trs[i].p1 = w.p1.slice(); trs[i].p2 = w.p2.slice(); return i; }
    }
    trs.push({ i: w.ai, p1: w.p1.slice(), p2: w.p2.slice(), act: act });
    return trs.length - 1;
  }

  /* Index into triggers[] of the trigger bound to wall[wallIndex], via ai. */
  function triggerFor(level, wallIndex) {
    var w = (level.walls || [])[wallIndex];
    if (!w || w.ai === undefined) return -1;
    var trs = level.triggers || [];
    for (var i = 0; i < trs.length; i++) if (trs[i].i === w.ai) return i;
    return -1;
  }

  /* All wall indices bound to triggers[tIdx] (a split linedef has two). */
  function wallsForTrigger(level, tIdx) {
    var t = (level.triggers || [])[tIdx];
    if (!t) return [];
    var out = [];
    (level.walls || []).forEach(function (w, i) { if (w.ai === t.i) out.push(i); });
    return out;
  }

  function removeTrigger(level, tIdx) {
    if (level.triggers && tIdx >= 0) level.triggers.splice(tIdx, 1);
  }

  /* Wall endpoints moved -> the trigger's cached copy has to follow. */
  function syncTriggerEndpoints(level, wallIndex) {
    var t = triggerFor(level, wallIndex);
    if (t < 0) return;
    var w = level.walls[wallIndex];
    level.triggers[t].p1 = w.p1.slice();
    level.triggers[t].p2 = w.p2.slice();
  }

  /* Recomputes the cosmetic bbox/area fields the converter also writes, so an
     edited sector's metadata does not lie. Only called on sectors we edit. */
  function refreshSector(sec) {
    var polys = sectorPolys(sec);
    if (!polys.length) return;
    var b = sectorBBox(sec);
    var a = 0;
    for (var i = 0; i < polys.length; i++) a += (i === 0 ? 1 : -1) * polyArea(polys[i]);
    sec.area = Math.round(Math.abs(a) * 100) / 100;
    sec.x = Math.round(((b.x0 + b.x1) / 2) * 100) / 100;
    sec.z = Math.round(((b.z0 + b.z1) / 2) * 100) / 100;
    sec.width = Math.round((b.x1 - b.x0) * 100) / 100;
    sec.depth = Math.round((b.z1 - b.z0) * 100) / 100;
  }

  function exitWallIndex(level) {
    var walls = level.walls || [];
    for (var i = 0; i < walls.length; i++) {
      if (walls[i].isSwitch && walls[i].switchId === 'sw_exit_game') return i;
    }
    return -1;
  }

  var API = {
    clone: clone, serialize: serialize, sameJSON: sameJSON, blankLevel: blankLevel,
    polyArea: polyArea, pointInPoly: pointInPoly, sectorPolys: sectorPolys,
    sectorBBox: sectorBBox, sectorAt: sectorAt, levelBounds: levelBounds,
    addWall: addWall, removeWall: removeWall, removeSector: removeSector,
    setTrigger: setTrigger, triggerFor: triggerFor, removeTrigger: removeTrigger,
    wallsForTrigger: wallsForTrigger, nextLineId: nextLineId,
    syncTriggerEndpoints: syncTriggerEndpoints, refreshSector: refreshSector,
    exitWallIndex: exitWallIndex
  };

  if (typeof window !== 'undefined') window.EdModel = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
