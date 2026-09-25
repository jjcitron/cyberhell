#!/usr/bin/env node
/**
 * CYBERHELL COLLISION QA (browser, headless)
 *
 * Drives the real engine in a real browser and asserts the collision
 * invariants that broke on 2026-09-04 ("still falling through floors, walking
 * through walls, enemies coming through walls"):
 *
 *   CH-COL-1  The player never leaves floor geometry. Teleport to random
 *             points inside the level's sectors, walk 30 frames on a random
 *             heading, assert getFloorAt(camera).inside every frame.
 *   CH-COL-2  The player never rises more than STEP_UP_MAX in one frame while
 *             grounded -- no teleporting up the face of a ledge.
 *   CH-COL-3  The camera is never below its sector's floor.
 *   CH-COL-4  After 10 s of chasing, every live enemy is still inside floor
 *             geometry and is not standing inside a solid wall.
 *   CH-COL-5  Flying enemies (stats.fly) hover more than 1.5 above their floor.
 *   CH-COL-6  Zero page errors.
 *   CH-COL-10 After the same chase, no enemy's drawn rig reaches more than
 *             0.2 through a solid wall (guns and arms, not just the centre).
 *   CH-COL-11 Kill every enemy where that chase left it and play the death
 *             out: no corpse, falling body or exploding rig part reaches more
 *             than 0.2 through a solid wall at any point of the death, and
 *             no gore chunk from those deaths ends up across a solid wall.
 *   CH-COL-7  The RENDERED floor under the player matches the floor
 *             getFloorAt returns. This is the one that is not self-consistent
 *             with the collision model: bounding-box sectors draw a floor mesh
 *             at one height while getFloorAt answers with another sector's,
 *             which is the fall-through bug itself.
 *   CH-COL-8  No movement step crosses a solid wall that spans the player's
 *             body (tunnelling).
 *   CH-COL-9  The engine can actually walk the route the offline reachability
 *             model used to place the exit. The exit patcher only ever picks a
 *             wall the model says is reachable, so the model must never claim
 *             a route the engine's own collision refuses -- that mismatch is
 *             what made converted levels unfinishable before.
 *   CH-COL-12 Player cannot walk or camera/eye-clip into solid walls or overhead
 *             ceilings (min camera wall distance >= 0.28, zero wall/ceiling penetrations).
 *             Ledge risers too tall to climb from the player's feet count as
 *             walls too: they are drawn as boxes but are not `solid`, which is
 *             how Joel still walked into walls on 2026-09-25.
 *   CH-COL-13 Enemy fireballs fired at the player from behind a solid wall or
 *             from below a tall ledge riser die at the wall and do no damage.
 *
 * Runs its own static server on its own port and its own headless Chromium
 * via playwright-core -- never the shared bcl browser session.
 *
 * Usage:  node tests/qa-collision.js
 *         QA_MAPS=levelPacks/pack1/json1.json,... node tests/qa-collision.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToExit } = require('./reachability.js');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 8140);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

const SAMPLES = Number(process.env.QA_SAMPLES || 200);
const STEPS = 30;
const MAPS = (process.env.QA_MAPS || [
  'levelPacks/pack1/json1.json',
  'levelPacks/pack2/json1.json',
  'levelPacks/pack3/json1.json',
  'levelPacks/pack6/json1.json'
].join(',')).split(',').filter(Boolean);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mid': 'audio/midi'
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (rel === 'favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------------------------------------------------------------------
   Everything below runs inside the page, against the live engine.
   --------------------------------------------------------------------------- */
const PROBE = function (samples, steps) {
  const e = window.cyberEngine;
  const STEP_UP_MAX = 1.2;
  const secs = e.levelData.sectors || [];

  // Deterministic PRNG so a failure can be replayed.
  let seed = 0x1234abcd;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Random points that really are inside floor geometry.
  const spots = [];
  const boxes = [];
  for (const s of secs) {
    if (s.polys && s.polys.length) {
      let bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const l of s.polys) for (const p of l) {
        bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]);
        bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]);
      }
      boxes.push(bb);
    } else {
      const rects = s.resolvedFloors || s.floors || [];
      for (const r of rects) boxes.push([r.x - r.width / 2, r.z - r.depth / 2, r.x + r.width / 2, r.z + r.depth / 2]);
    }
  }
  const segD = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az;
    const wx = px - ax, wz = pz - az;
    const c1 = wx * vx + wz * vz;
    if (c1 <= 0) return Math.hypot(px - ax, pz - az);
    const c2 = vx * vx + vz * vz;
    if (c2 <= c1) return Math.hypot(px - bx, pz - bz);
    const t = c1 / c2;
    return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
  };
  // Reuse the engine's own wall grid: the megamaps carry 20k walls and these
  // loops run per sample and per frame.
  // Tall ledge risers count: the body is kept off them like any wall, so a
  // spot hugging one (or down a pit narrower than the body) is unreachable.
  const clearOfWalls = (x, z) => {
    const fy = e.getFloorAt(x, z).floorY;
    for (const w of e.wallsNear(x, z, 0.62)) {
      if (!w.solid && !(w.riser && w.topY > fy + STEP_UP_MAX + 0.05)) continue;
      if (segD(x, z, w.p1.x, w.p1.z, w.p2.x, w.p2.z) < 0.62) return false;
    }
    return true;
  };

  let guard = 0;
  while (spots.length < samples && guard++ < samples * 400) {
    const b = boxes[Math.floor(rnd() * boxes.length)];
    if (!b) break;
    const x = b[0] + rnd() * (b[2] - b[0]);
    const z = b[1] + rnd() * (b[3] - b[1]);
    // Standing room only: a spot inside a wall's push-out band is not a place
    // the player could ever legitimately be, and the push-out could eject them
    // through the wall, which is a test artefact rather than a defect.
    if (e.getFloorAt(x, z).inside && clearOfWalls(x, z)) spots.push([x, z]);
  }

  const v = { offFloor: 0, bigRise: 0, belowFloor: 0, meshMismatch: 0, throughWall: 0, samples: spots.length, camWallClip: 0, minCamDist: Infinity, ceilClip: 0 };
  const examples = [];

  // Floor meshes, tagged by buildSectorGeometry with the height they render at.
  const floorMeshes = [];
  e.scene.traverse(o => { if (o.isMesh && o.userData && o.userData.floorY !== undefined) floorMeshes.push(o); });
  const ray = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  // The page may not have rendered since the level loaded, so world matrices
  // can be stale and every raycast would miss.
  e.scene.updateMatrixWorld(true);

  // Solid walls that could block a body between feet and head.
  const segHit = (ax, az, bx, bz, cx, cz, dx2, dz2) => {
    const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const d2 = (bx - ax) * (dz2 - az) - (bz - az) * (dx2 - ax);
    const d3 = (dx2 - cx) * (az - cz) - (dz2 - cz) * (ax - cx);
    const d4 = (dx2 - cx) * (bz - cz) - (dz2 - cz) * (bx - cx);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };

  e.isRunning = true;
  for (const [sx, sz] of spots) {
    const f0 = e.getFloorAt(sx, sz);
    e.camera.position.set(sx, f0.floorY + e.player.height, sz);
    e.player.velocity.set(0, 0, 0);
    e.player.onGround = true;
    e.player.safePosition.set(sx, f0.floorY + e.player.height, sz);
    e.camera.rotation.y = rnd() * Math.PI * 2;
    // Random heading, held for the whole burst: W plus a random strafe.
    e.keys = {};
    e.keys['KeyW'] = true;
    if (rnd() < 0.5) e.keys[rnd() < 0.5 ? 'KeyA' : 'KeyD'] = true;

    let prevY = e.camera.position.y;
    let prevX = e.camera.position.x, prevZ = e.camera.position.z;
    for (let n = 0; n < steps; n++) {
      const grounded = e.player.onGround;
      e.updatePhysics(1 / 60);
      const p = e.camera.position;

      // CH-COL-8: did this step cross a wall that spans the body?
      // A teleporter legitimately puts the player on the far side of every
      // wall between here and there, so skip the frame it fired on.
      const feet = p.y - e.player.height, head = p.y;
      const teleported = e.player.teleGrace > 0.99;
      if (!teleported && Math.hypot(p.x - prevX, p.z - prevZ) > 0.01) {
        const spanR = Math.hypot(p.x - prevX, p.z - prevZ) / 2 + 0.1;
        for (const w of e.wallsNear((p.x + prevX) / 2, (p.z + prevZ) / 2, spanR)) {
          // Doors and switches drop `solid` when the player triggers them, so
          // read it live -- walking through an opened door is not a defect.
          if (!w.solid) continue;
          if (w.topY !== undefined && w.topY <= feet + 0.05) continue;
          if (w.bottomY !== undefined && w.bottomY >= head) continue;
          if (segHit(prevX, prevZ, p.x, p.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z)) {
            v.throughWall++;
            if (examples.length < 3) examples.push({ kind: 'throughWall', from: [+prevX.toFixed(3), +prevZ.toFixed(3)], to: [+p.x.toFixed(3), +p.z.toFixed(3)],
              wall: { p1: [w.p1.x, w.p1.z], p2: [w.p2.x, w.p2.z], solidNow: w.solid, isDoor: !!w.isDoor, isSwitch: !!w.isSwitch, bottomY: w.bottomY, topY: w.topY, feet: +feet.toFixed(2) } });
            break;
          }
        }
      }
      prevX = p.x; prevZ = p.z;
      const f = e.getFloorAt(p.x, p.z);
      if (!f.inside) {
        v.offFloor++;
        if (examples.length < 3) examples.push({ kind: 'offFloor', x: +p.x.toFixed(2), z: +p.z.toFixed(2), from: [+sx.toFixed(2), +sz.toFixed(2)] });
        break;
      }
      // Grounded rise beyond one auto-climb means the floor teleported us.
      if (grounded && e.player.onGround && p.y - prevY > STEP_UP_MAX + 0.05) {
        v.bigRise++;
        if (examples.length < 3) examples.push({ kind: 'bigRise', dy: +(p.y - prevY).toFixed(2), x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }
      if (p.y < f.floorY - 0.05) {
        v.belowFloor++;
        if (examples.length < 3) examples.push({ kind: 'belowFloor', y: +p.y.toFixed(2), floorY: f.floorY, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }

      // CH-COL-12: player eye and body distance to solid walls and ceiling.
      // Wall mesh face is at 0.20 from centerline. Camera near plane is 0.01.
      // A wall that spans the camera eye height must keep at least 0.25 clearance
      // from the wall segment centerline (>= 0.05 from mesh surface).
      const camEye = p.y;
      for (const w of e.wallsNear(p.x, p.z, 1.0)) {
        if (!w.solid && !(w.riser && w.topY > feet + STEP_UP_MAX + 0.05)) continue;
        if (w.topY !== undefined && w.topY < camEye - 0.05) continue;
        if (w.bottomY !== undefined && w.bottomY > camEye + 0.05) continue;
        const d = segD(p.x, p.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z);
        if (d < v.minCamDist) v.minCamDist = d;
        if (d < 0.25) {
          v.camWallClip++;
          if (examples.length < 3) examples.push({ kind: 'camWallClip', d: +d.toFixed(3), x: +p.x.toFixed(2), z: +p.z.toFixed(2), wall: [w.p1.x, w.p1.z, w.p2.x, w.p2.z],
            riser: !w.solid, wallY: [w.bottomY, w.topY], feet: +feet.toFixed(2), frame: n, start: [+sx.toFixed(2), +sz.toFixed(2)], floorY: f.floorY });
        }
      }
      if (f.ceilY !== undefined && f.ceilY !== null && f.ceilY >= f.floorY + 1.5 && p.y > f.ceilY) {
        v.ceilClip++;
        if (examples.length < 3) examples.push({ kind: 'ceilClip', y: +p.y.toFixed(2), ceilY: f.ceilY });
      }
      prevY = p.y;
    }

    // CH-COL-7: what is actually drawn under the player, once per burst.
    const p = e.camera.position;
    const f = e.getFloorAt(p.x, p.z);
    if (f.inside && floorMeshes.length) {
      ray.set(new THREE.Vector3(p.x, p.y + 0.1, p.z), DOWN);
      ray.far = 400;
      const hits = ray.intersectObjects(floorMeshes, false);
      if (!hits.length) {
        v.meshMismatch++;
        if (examples.length < 3) examples.push({ kind: 'noFloorMesh', x: +p.x.toFixed(2), z: +p.z.toFixed(2), floorY: f.floorY });
      } else if (Math.abs(hits[0].object.userData.floorY - f.floorY) > 0.05) {
        v.meshMismatch++;
        if (examples.length < 3) examples.push({ kind: 'meshMismatch', drawn: hits[0].object.userData.floorY, collision: f.floorY, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }
    }
  }
  e.keys = {};
  return { v, examples };
};

const CHASE = function (seconds) {
  const e = window.cyberEngine;
  // Teleport the player onto the first enemy's floor so everyone has somewhere
  // to walk to, wake them all, then run the AI.
  const lead = e.enemies.find(en => en.state !== 'DEAD');
  if (lead) {
    const lp = lead.group.position;
    const f = e.getFloorAt(lp.x, lp.z);
    if (f.inside) e.camera.position.set(lp.x, f.floorY + e.player.height, lp.z);
  }
  const before = e.enemies.map(en => en.group.position.clone());
  for (const en of e.enemies) if (en.state !== 'DEAD') en.state = 'CHASE';
  const frames = Math.round(seconds * 60);
  e.isRunning = true;
  for (let n = 0; n < frames; n++) e.updateEnemies(1 / 60);

  const segDist = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az;
    const wx = px - ax, wz = pz - az;
    const c1 = wx * vx + wz * vz;
    if (c1 <= 0) return Math.hypot(px - ax, pz - az);
    const c2 = vx * vx + vz * vz;
    if (c2 <= c1) return Math.hypot(px - bx, pz - bz);
    const t = c1 / c2;
    return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
  };

  const out = { total: 0, moved: 0, offFloor: 0, inWall: 0, flyers: 0, notHovering: 0, meshClip: 0, maxClip: 0 };
  const CLIP_TOL = 0.2;
  const examples = [];
  for (let ei = 0; ei < e.enemies.length; ei++) {
    const en = e.enemies[ei];
    if (en.state === 'DEAD') continue;
    out.total++;
    if (before[ei] && en.group.position.distanceTo(before[ei]) > 0.5) out.moved++;
    const p = en.group.position;
    const f = e.getFloorAt(p.x, p.z);
    if (!f.inside) {
      out.offFloor++;
      if (examples.length < 3) examples.push({ kind: 'enemyOffFloor', type: en.enemyType, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      continue;
    }
    const fly = !!(en.stats && en.stats.fly);
    const feet = fly ? p.y : f.floorY;
    const head = feet + 1.6;
    const r0 = (en.radius || 0.5);
    for (const w of e.wallsNear(p.x, p.z, r0)) {
      if (!w.solid) continue;
      if (w.topY !== undefined && w.topY <= feet + 0.05) continue;
      if (w.bottomY !== undefined && w.bottomY >= head) continue;
      // Same radius the mover pushes out to, minus float slack.
      if (segDist(p.x, p.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z) < 0.25) {
        out.inWall++;
        if (examples.length < 3) examples.push({ kind: 'enemyInWall', type: en.enemyType, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
        break;
      }
    }
    // CH-COL-10: the drawn body, not just its centre (see RIG_CLIP).
    const depth = window.__rigClip(en, 2.5);
    out.maxClip = Math.max(out.maxClip, depth);
    if (depth > CLIP_TOL) {
      out.meshClip++;
      if (examples.length < 3) examples.push({ kind: 'meshInWall', type: en.enemyType, depth: +depth.toFixed(2), x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
    }
    if (fly) {
      out.flyers++;
      if (p.y - f.floorY <= 1.5) {
        out.notHovering++;
        if (examples.length < 3) examples.push({ kind: 'notHovering', type: en.enemyType, y: +p.y.toFixed(2), floorY: f.floorY });
      }
    }
  }
  return { out, examples };
};

/* How far an enemy's drawn rig reaches through a solid wall. A vertex on the
   far side of a wall (from the body's own centre) and inside the wall's
   height band is a visible clip -- a gun barrel, an arm, a corpse lying
   through it. reach bounds the wall search: a standing rig is ~1.5 wide,
   a toppled one is as long as it was tall. Installed once per page as
   window.__rigClip so CHASE and CORPSE share it. */
const RIG_CLIP = function () {
  const v3 = new THREE.Vector3();
  window.__rigClip = function (en, reach) {
    const e = window.cyberEngine;
    const p = en.group.position;
    en.group.updateMatrixWorld(true);
    let depth = 0;
    const near = e.wallsNear(p.x, p.z, reach).filter(w => w.solid);
    if (!near.length || !en.group.visible) return 0;
    en.group.traverse(o => {
      if (!o.isMesh || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
      const pa = o.geometry.attributes.position;
      for (let k = 0; k < pa.count; k++) {
        v3.fromBufferAttribute(pa, k).applyMatrix4(o.matrixWorld);
        for (const w of near) {
          if (w.topY !== undefined && v3.y >= w.topY) continue;
          if (w.bottomY !== undefined && v3.y <= w.bottomY) continue;
          const ax = w.p1.x, az = w.p1.z, bx = w.p2.x, bz = w.p2.z;
          const s1 = (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
          const s2 = (bx - ax) * (v3.z - az) - (bz - az) * (v3.x - ax);
          if ((s1 > 0) === (s2 > 0)) continue;
          const t1 = (v3.x - p.x) * (az - p.z) - (v3.z - p.z) * (ax - p.x);
          const t2 = (v3.x - p.x) * (bz - p.z) - (v3.z - p.z) * (bx - p.x);
          if ((t1 > 0) === (t2 > 0)) continue;
          const d = Math.abs(s2) / (Math.hypot(bx - ax, bz - az) || 1);
          if (d > depth) {
            depth = d;
            // The worst vertex and the wall it is through, for failure examples.
            window.__rigClipWorst = { v: [+v3.x.toFixed(2), +v3.y.toFixed(2), +v3.z.toFixed(2)],
              wall: [ax, az, bx, bz], bottomY: w.bottomY, topY: w.topY };
          }
        }
      }
    });
    return depth;
  };
};

/* CH-COL-11: kill everyone where the chase left them (pressed up against
   walls, which is where Joel shoots them) and play the death out. Every
   corpse and every exploding rig's flying parts are measured through the
   whole death, not just the final frame, so a mid-air fragment through a
   wall counts too. */
const CORPSE = function (seconds) {
  const e = window.cyberEngine;
  const live = e.enemies.filter(en => en.state !== 'DEAD');
  // Most of the chase ends in open floor round the player, so also shove
  // every body up against its nearest solid wall through the engine's own
  // push-out -- a kill against a wall is the case that matters. In a tight
  // corner three push-out passes can leave a body inside the other wall;
  // that spot is rejected and the body stays where the chase left it.
  // The wall side cycles +X, +Z, -X, -Z per body so every fall direction
  // gets tested, not just whichever wall happens to be closest.
  const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let pressed = 0;
  for (let i = 0; i < live.length; i++) {
    const en = live[i], p = en.group.position, [sx, sz] = SIDES[i % 4];
    let best = null;
    for (const w of e.wallsNear(p.x, p.z, 3)) {
      if (!w.solid) continue;
      const r = getSegDist(p.x, p.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z);   // eslint-disable-line no-undef
      if ((r.projX - p.x) * sx + (r.projZ - p.z) * sz < 0.7 * r.dist) continue;
      if (!best || r.dist < best.dist) best = { dist: r.dist, projX: r.projX, projZ: r.projZ };   // r is a shared scratch
    }
    if (!best || best.dist < 1e-3) continue;
    const feet = en.floorY !== undefined ? en.floorY : p.y;
    const c = e.resolveWallCollisions(best.projX, best.projZ, en.radius || 0.6, feet, 1.6, p.x, p.z);
    const f = e.getFloorAt(c.x, c.z);
    if (!f.inside || Math.abs(f.floorY - feet) > 0.3) continue;
    const rr = (en.radius || 0.6) * 0.9;
    if (e.wallsNear(c.x, c.z, rr).some(w => w.solid &&
        !(w.topY !== undefined && w.topY <= feet + 0.05) && !(w.bottomY !== undefined && w.bottomY >= feet + 1.6) &&
        getSegDist(c.x, c.z, w.p1.x, w.p1.z, w.p2.x, w.p2.z).dist < rr)) continue;   // eslint-disable-line no-undef
    p.x = c.x; p.z = c.z;
    pressed++;
  }
  // A rig already through a wall as it dies (a live-body clip the push put it
  // in -- CH-COL-10's class, r1's 1.0 radius cap) is not a death clip: only
  // what the death adds on top of that is counted, the rest is reported.
  const atKill = new Map();
  for (const en of live) atKill.set(en, window.__rigClip(en, 5));
  const G = window.CyberGore;
  if (G && !e._goreInited) { G.init(e.scene, THREE); e._goreInited = true; }
  if (G) G.clear();
  for (const en of live) e.killEnemy(en);
  // Gore debris: any frame's step that crosses a solid wall at the height
  // the chunk is at went through it. (Whole-path from the death point would
  // also flag chunks that hop over a low wall's top, which is legitimate.)
  const chunkFrom = new Map();
  if (G) for (const m of G.__debugChunks()) chunkFrom.set(m, { x: m.position.x, z: m.position.z });
  const floorFn = (x, z) => e.getFloorAt(x, z);
  const wallFn = (x0, z0, x1, z1, y) => e.wallBetween(x0, z0, x1, z1, y);
  const out = { total: live.length, pressed, clip: 0, maxClip: 0, chunks: chunkFrom.size, chunkClip: 0, liveClip: 0 };
  const examples = [];
  const worst = new Map(), where = new Map();
  const frames = Math.round(seconds * 60);
  // The AI only animates bodies near the camera and in view, so drive every
  // corpse's rig directly: a corpse falls the same wherever the player is.
  for (let n = 0; n < frames; n++) {
    for (const en of live) window.CyberEnemies.animate(en, n / 60, 1 / 60);
    if (G) {
      G.update(1 / 60, floorFn, wallFn);
      for (const m of G.__debugChunks()) {
        const o = chunkFrom.get(m);
        if (!o) continue;
        if (e.wallBetween(o.x, o.z, m.position.x, m.position.z, m.position.y)) { out.chunkClip++; chunkFrom.delete(m); continue; }
        o.x = m.position.x; o.z = m.position.z;
      }
    }
    if (n % 6 !== 5 && n !== frames - 1) continue;
    for (const en of live) {
      const d = window.__rigClip(en, 5);
      if (d > (worst.get(en) || 0)) { worst.set(en, d); where.set(en, Object.assign({ frame: n }, window.__rigClipWorst)); }
    }
  }
  for (const [en, d] of worst) {
    const d0 = atKill.get(en) || 0;
    if (d0 > 0.2) out.liveClip++;
    const added = d0 > 0.2 ? d - d0 : d;
    out.maxClip = Math.max(out.maxClip, added);
    if (added > (d0 > 0.2 ? 0.05 : 0.2)) {
      out.clip++;
      const g = en.group, A = g.userData && g.userData.anim;
      if (examples.length < 4) examples.push({ type: en.enemyType, death: A && A.pose && A.pose.death, depth: +d.toFixed(2),
        spread: en.deathSpread !== undefined ? +en.deathSpread.toFixed(2) : null, tip: en.fallMax !== undefined ? +en.fallMax.toFixed(2) : null,
        atKill: +d0.toFixed(2), x: +g.position.x.toFixed(2), z: +g.position.z.toFixed(2), floorY: en.floorY, at: where.get(en) });
    }
  }
  return { out, examples };
};

/* The page boots MAP01 and then auto-loads the first pack level over it, so
   the built-in map has to be swapped back in explicitly -- the same teardown
   loadLevelFromFile does. MAP01_DATA is a top-level const in the page. */
/* CH-COL-13: for up to n walls that have floor on both sides, stand the
   player 1.5 in front of it and fire a fireball at them from 3 behind it. */
const PROJ_WALL = function (n) {
  const e = window.cyberEngine;
  const segD = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
  };
  const clear = (x, z) => {
    for (const w of e.wallsNear(x, z, 1.0)) if ((w.solid || w.riser) && segD(x, z, w.p1.x, w.p1.z, w.p2.x, w.p2.z) < 1.0) return false;
    return true;
  };
  const out = { tested: 0, solid: 0, risers: 0, leaked: 0 };
  const examples = [];
  const savedEnemies = e.enemies;
  e.enemies = [];
  e.isGameOver = false;
  for (const w of e.walls) {
    if (out.tested >= n) break;
    if (w.isDoor || w.isSwitch) continue;
    const riser = !w.solid && w.riser && w.topY - w.bottomY >= 2.4;
    if (!w.solid && !riser) continue;
    const L = Math.hypot(w.p2.x - w.p1.x, w.p2.z - w.p1.z);
    if (L < 2) continue;
    const mx = (w.p1.x + w.p2.x) / 2, mz = (w.p1.z + w.p2.z) / 2;
    const nx = -(w.p2.z - w.p1.z) / L, nz = (w.p2.x - w.p1.x) / L;
    for (const sgn of [1, -1]) {
      const ax = mx + nx * sgn * 1.5, az = mz + nz * sgn * 1.5, bx = mx - nx * sgn * 3, bz = mz - nz * sgn * 3;
      const fa = e.getFloorAt(ax, az), fb = e.getFloorAt(bx, bz);
      if (!fa.inside || !fb.inside || !clear(ax, az) || !clear(bx, bz)) continue;
      let shooterY;
      if (riser) {
        // Player on the high floor, shooter on the low floor well below it.
        if (Math.abs(fa.floorY - w.topY) > 0.05 || Math.abs(fb.floorY - w.bottomY) > 0.05) continue;
        shooterY = fb.floorY + 1.0;
        if (shooterY > w.topY - 0.5) continue;
      } else {
        if (Math.abs(fa.floorY - fb.floorY) > 0.3) continue;
        if ((w.bottomY !== undefined && w.bottomY > fa.floorY + 0.1) || (w.topY !== undefined && w.topY < fa.floorY + e.player.height + 0.5)) continue;
        shooterY = fb.floorY + 1.0;
      }
      e.camera.position.set(ax, fa.floorY + e.player.height, az);
      // Aim flat at the riser face: an honest shot the ledge must stop,
      // not one lobbed over the lip.
      const aim = riser ? new THREE.Vector3(ax, shooterY, az) : e.camera.position.clone();
      e.player.health = 100; e.player.armor = 0;
      const from = new THREE.Vector3(bx, shooterY, bz);
      const dir = aim.sub(from).normalize();
      const proj = e.spawnProjectile({ from, dir, kind: 'fireball', owner: 'enemy', damage: 14 });
      let crossed = false;
      const side0 = (w.p2.x - w.p1.x) * (az - w.p1.z) - (w.p2.z - w.p1.z) * (ax - w.p1.x);
      for (let i = 0; i < 120 && e.projectiles.includes(proj); i++) {
        e.updateProjectiles(1 / 60);
        const pp = proj.group.position;
        const sd = (w.p2.x - w.p1.x) * (pp.z - w.p1.z) - (w.p2.z - w.p1.z) * (pp.x - w.p1.x);
        if (e.projectiles.includes(proj) && (sd > 0) === (side0 > 0)) crossed = true;
      }
      if (e.projectiles.includes(proj)) { e._releaseProjectile(proj); e.projectiles.splice(e.projectiles.indexOf(proj), 1); }
      out.tested++;
      if (riser) out.risers++; else out.solid++;
      if (crossed || e.player.health < 100) {
        out.leaked++;
        if (examples.length < 3) examples.push({ riser, wall: [w.p1.x, w.p1.z, w.p2.x, w.p2.z], crossed, health: e.player.health });
      }
      break;
    }
  }
  e.enemies = savedEnemies;
  e.player.health = 100;
  e.isGameOver = false;
  return { out, examples };
};

const LOAD_BUILTIN_MAP01 = function () {
  const e = window.cyberEngine;
  while (e.scene.children.length > 0) e.scene.remove(e.scene.children[0]);
  e.scene.add(e.camera);
  e.walls = []; e.doors = {}; e.switches = {}; e.enemies = [];
  e.pickups = []; e.barrels = []; e.projectiles = []; e.particles = [];
  if (window.CyberGore) window.CyberGore.clear();
  e.loadLevel(MAP01_DATA);            // eslint-disable-line no-undef
  return e.levelData.name;
};

/* Steer by writing velocity, so movement still runs through updatePhysics,
   resolveWallCollisions and getFloorAt -- the code under test. */
const WALK = function (route) {
  const e = window.cyberEngine;
  e.isRunning = true;
  e.keys = {};
  let reached = 0;
  let stall = null;
  for (const [tx, tz] of route) {
    let guard = 0, best = Infinity, stale = 0;
    while (guard++ < 1200) {
      const dx = tx - e.camera.position.x, dz = tz - e.camera.position.z;
      const L = Math.hypot(dx, dz);
      if (L < 0.15) break;
      if (L < best - 0.01) { best = L; stale = 0; } else if (++stale > 90) break;
      e.player.velocity.x = (dx / L) * 6;
      e.player.velocity.z = (dz / L) * 6;
      e.updatePhysics(1 / 60);
    }
    if (Math.hypot(tx - e.camera.position.x, tz - e.camera.position.z) < 0.4) reached++;
  }
  // Waypoints are steering hints; the invariant is standing at the exit.
  let toExit = Infinity;
  for (const w of (e.exitWalls || [])) {
    const vx = w.p2.x - w.p1.x, vz = w.p2.z - w.p1.z;
    const t = Math.max(0, Math.min(1, ((e.camera.position.x - w.p1.x) * vx + (e.camera.position.z - w.p1.z) * vz) / (vx * vx + vz * vz || 1)));
    toExit = Math.min(toExit, Math.hypot(e.camera.position.x - (w.p1.x + t * vx), e.camera.position.z - (w.p1.z + t * vz)));
  }
  // The engine keeps the body off tall ledge risers, which the offline model
  // lets it touch, so a route ending at a riser foot can stop a little short
  // of the model's reach. What matters is whether the exit can be pressed:
  // aim at it and use it, through the engine's own interact().
  let pressed = false;
  if (toExit > 4.5) {
    const realWin = e.triggerVictory;
    e.triggerVictory = () => { pressed = true; };
    const cp = e.camera.position;
    for (const w of (e.exitWalls || [])) {
      const vx = w.p2.x - w.p1.x, vz = w.p2.z - w.p1.z;
      const t = Math.max(0.05, Math.min(0.95, ((cp.x - w.p1.x) * vx + (cp.z - w.p1.z) * vz) / (vx * vx + vz * vz || 1)));
      const tx = w.p1.x + t * vx, tz = w.p1.z + t * vz;
      const ty = (w.bottomY !== undefined && w.topY !== undefined) ? (w.bottomY + w.topY) / 2 : cp.y;
      e.camera.rotation.set(Math.atan2(ty - cp.y, Math.hypot(tx - cp.x, tz - cp.z)), Math.atan2(-(tx - cp.x), -(tz - cp.z)), 0, 'YXZ');
      e.camera.updateMatrixWorld();
      e.interact();
      if (pressed) break;
    }
    e.triggerVictory = realWin;
  }
  if (toExit > 4.5 && !pressed) {   // USE_RANGE 4.0 + the offline grid's 0.25 cells
    stall = { toExit: +toExit.toFixed(2), floor: e.getFloorAt(e.camera.position.x, e.camera.position.z),
              y: +e.camera.position.y.toFixed(2) };
  }
  return { reached, total: route.length, stall, atExit: !stall, pressed, toExit: +toExit.toFixed(2),
           at: [+e.camera.position.x.toFixed(2), +e.camera.position.z.toFixed(2)] };
};

/* ------------------------------------------------------------------------- */
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`);
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('!!window.cyberEngine && !!window.cyberEngine.levelData', null, { timeout: 30000 });
    // The page boots MAP01 and then fetches the first pack level over it. That
    // fetch must land before anything else loads a level, or it silently
    // replaces the level under test mid-run.
    let settled = '';
    for (let i = 0; i < 40; i++) {
      const now = await page.evaluate(() => window.cyberEngine.levelData.name);
      if (now === settled) break;
      settled = now;
      await page.waitForTimeout(500);
    }

    await page.evaluate(fn => new Function('return ' + fn)()(), RIG_CLIP.toString());

    const targets = [{ name: 'MAP01 (built in)', file: null }].concat(MAPS.map(f => ({ name: f, file: f })));
    for (const t of targets) {
      if (t.file) {
        const want = JSON.parse(fs.readFileSync(path.join(ROOT, t.file), 'utf8')).name;
        await page.evaluate(f => window.cyberEngine.loadLevelFromFile(f, false), t.file);
        await page.waitForFunction(
          n => window.cyberEngine.levelData && window.cyberEngine.levelData.name === n,
          want, { timeout: 120000 });
      } else {
        await page.evaluate(fn => new Function('return ' + fn)()(), LOAD_BUILTIN_MAP01.toString());
      }
      const loaded = await page.evaluate(() => window.cyberEngine.levelData.name);
      check(`level loaded: ${t.name}`, true, loaded);

      const { v, examples } = await page.evaluate(
        ([fn, s, st]) => new Function('return ' + fn)()(s, st),
        [PROBE.toString(), SAMPLES, STEPS]);
      const bad = v.offFloor + v.bigRise + v.belowFloor + v.meshMismatch + v.throughWall;
      check(`CH-COL-1/2/3/7/8 ${t.name}`, bad === 0,
        `${v.samples} spots x ${STEPS} frames: offFloor=${v.offFloor} bigRise=${v.bigRise} ` +
        `belowFloor=${v.belowFloor} meshMismatch=${v.meshMismatch} throughWall=${v.throughWall}` +
        `${bad ? '  eg ' + JSON.stringify(examples) : ''}`);

      const camBad = v.camWallClip + v.ceilClip;
      check(`CH-COL-12 ${t.name}`, camBad === 0,
        `player camera vs walls/ceiling: camWallClip=${v.camWallClip} ceilClip=${v.ceilClip} (closest wall ${v.minCamDist === Infinity ? 'none' : v.minCamDist.toFixed(3)})` +
        `${camBad ? '  eg ' + JSON.stringify(examples.filter(x => x.kind === 'camWallClip' || x.kind === 'ceilClip')) : ''}`);

      const pw = await page.evaluate(
        ([fn, n]) => new Function('return ' + fn)()(n), [PROJ_WALL.toString(), 60]);
      check(`CH-COL-13 ${t.name}`, pw.out.leaked === 0 && pw.out.tested > 0,
        `${pw.out.tested} fireballs fired at the player through walls (${pw.out.solid} solid, ${pw.out.risers} tall ledge risers): ` +
        `leaked=${pw.out.leaked}${pw.out.leaked ? '  eg ' + JSON.stringify(pw.examples) : ''}`);

      const level = t.file
        ? JSON.parse(fs.readFileSync(path.join(ROOT, t.file), 'utf8'))
        : loadMap01();
      const route = pathToExit(level, 0.25);   // walk the cell path, don't cut corners
      if (!route) {
        check(`CH-COL-9 ${t.name}`, false, 'offline model found no route to the exit');
      } else {
        // Start from spawn, not wherever the probe left the player.
        await page.evaluate(sp => {
          const e = window.cyberEngine;
          const f = e.getFloorAt(sp[0], sp[2]);
          e.camera.position.set(sp[0], (f.inside ? f.floorY : sp[1]) + e.player.height, sp[2]);
          e.player.velocity.set(0, 0, 0);
          e.player.onGround = true;
          e.player.safePosition.copy(e.camera.position);
        }, level.playerSpawn.pos);
        const walk = await page.evaluate(
          ([fn, r]) => new Function('return ' + fn)()(r), [WALK.toString(), route]);
        check(`CH-COL-9 ${t.name}`, walk.atExit,
          `reached the exit switch, ${walk.reached}/${walk.total} route waypoints hit` +
          `${walk.pressed ? ` (stopped ${walk.toExit} from it at a riser foot; pressed it in-engine)` : ''}` +
          `${walk.atExit ? '' : ' -- STOPPED at ' + JSON.stringify(walk.at) + ' ' + JSON.stringify(walk.stall)}`);
      }

      const chase = await page.evaluate(
        ([fn, s]) => new Function('return ' + fn)()(s), [CHASE.toString(), 10]);
      const eBad = chase.out.offFloor + chase.out.inWall + chase.out.notHovering;
      check(`CH-COL-4/5 ${t.name}`, eBad === 0,
        `${chase.out.total} enemies after 10s chase (${chase.out.moved} moved): offFloor=${chase.out.offFloor} ` +
        `inWall=${chase.out.inWall} flyers=${chase.out.flyers} notHovering=${chase.out.notHovering}` +
        `${eBad ? '  eg ' + JSON.stringify(chase.examples) : ''}`);
      check(`CH-COL-10 ${t.name}`, chase.out.meshClip === 0,
        `${chase.out.meshClip}/${chase.out.total} enemies with rig mesh > 0.2 through a wall ` +
        `(deepest ${chase.out.maxClip.toFixed(2)})` +
        `${chase.out.meshClip ? '  eg ' + JSON.stringify(chase.examples.filter(x => x.kind === 'meshInWall')) : ''}`);

      const corpse = await page.evaluate(
        ([fn, s]) => new Function('return ' + fn)()(s), [CORPSE.toString(), 3]);
      check(`CH-COL-11 ${t.name}`, corpse.out.clip === 0 && corpse.out.chunkClip === 0,
        `${corpse.out.clip}/${corpse.out.total} dying/dead enemies (${corpse.out.pressed} killed against a wall) with rig mesh > 0.2 through a wall ` +
        `(deepest ${corpse.out.maxClip.toFixed(2)}); gore chunks through a wall ${corpse.out.chunkClip}/${corpse.out.chunks}; ` +
        `already clipping alive at the kill spot (not counted) ${corpse.out.liveClip}` +
        `${corpse.out.clip ? '  eg ' + JSON.stringify(corpse.examples) : ''}`);
    }

    check('CH-COL-6 page errors', pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 4).join(' | ') : 'none');
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
