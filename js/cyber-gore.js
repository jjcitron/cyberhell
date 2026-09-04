/* ==========================================================================
   CyberGore — blood + oil hit/death gore (package H, round 2).
   Classic script, exposes window.CyberGore. No module system: init(scene,
   THREE) hands in the two things every other engine module already has.
   ========================================================================== */
(function () {
  'use strict';

  var THREE = null;
  var scene = null;

  // Scratch objects (built in init(), once THREE exists).
  var _mat, _pos, _quat, _scale, _zeroScale, _color, _color2, _UP, _FORWARD, _tmpDir;

  var GRAVITY = 18;             // chunks, sparks (sparks use GRAVITY*0.4)
  var DROP_GRAVITY = 14;        // droplets hang longer so they spread further
  var DRAG = 1.6;               // velocity *= (1 - DRAG*delta), clamped >=0
  var DECAL_CAP = 400;          // per fluid type -> 800 total, per spec
  var FLOOR_EPS = 0.08;         // how close to the floor counts as "landed"

  // Enemy typeId -> fluid mix. Everything else defaults to 50/50.
  // ponytail: a lookup table beats asking cyber-enemies.js for a "fleshiness"
  // stat that doesn't exist yet; add one there if this list needs to grow.
  var OIL_HEAVY = { 16: 1, 68: 1, 67: 1, 66: 1, 7: 1 };      // Cyberdemon, Arachnotron, Mancubus, Revenant, Spider Mastermind
  var BLOOD_HEAVY = { 3001: 1, 3002: 1, 3004: 1 };            // Imp, Demon, Zombieman

  function oilRatioFor(enemy) {
    var id = enemy && (enemy.enemyType != null
      ? enemy.enemyType
      : (enemy.group && enemy.group.userData && enemy.group.userData.enemyTypeId));
    id = parseInt(id, 10);
    if (OIL_HEAVY[id]) return 0.7;
    if (BLOOD_HEAVY[id]) return 0.3;
    return 0.5;
  }

  // Darken/redden the enemy's body materials toward the fluid colour so a
  // beaten enemy visibly drips. Deliberately NOT group.userData.hitMaterials:
  // those are the emissive accents cyber-enemies.js's own flash()/decayFlash()
  // drive every hit (see js/cyber-enemies.js ~1000), so painting .emissive on
  // them would just get stomped next frame. .color on the body's standard
  // materials is untouched by that system, so it's safe to lerp permanently.
  function paintEnemy(enemy, tint) {
    var g = enemy && enemy.group;
    if (!g) return;
    var mats = g.userData._goreMats;
    if (!mats) {
      mats = [];
      g.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(function (m) {
          if (m && m.color && (m.emissiveIntensity === undefined || m.emissiveIntensity < 1) && mats.indexOf(m) === -1) {
            mats.push(m);
          }
        });
      });
      g.userData._goreMats = mats;
    }
    for (var i = 0; i < mats.length; i++) mats[i].color.lerp(tint, 0.15);
  }

  // ---- instanced particle pools (droplets + sparks share this) ----------
  var pools = {}; // name -> { mesh, max, free:[idx], active:[{idx,pos,vel,life,maxLife,r0,decal}] }

  function makePool(name, geo, mat, max) {
    var mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = max;
    for (var i = 0; i < max; i++) mesh.setMatrixAt(i, _zeroScale);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    var pool = { mesh: mesh, max: max, free: [], active: [] };
    for (var j = max - 1; j >= 0; j--) pool.free.push(j);
    pools[name] = pool;
    return pool;
  }

  function poolSpawn(pool, pos, vel, life, r0, color, decal) {
    var idx = pool.free.length ? pool.free.pop() : (pool.active.shift() || {}).idx;
    if (idx === undefined || idx === null) return; // pool fully empty edge case
    var rec = { idx: idx, pos: pos, vel: vel, life: life, maxLife: life, r0: r0, decal: decal };
    pool.active.push(rec);
    if (color) pool.mesh.setColorAt(idx, color);
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
  }

  // Advance one instanced pool. onLand(rec) fires once when a "decal" particle
  // reaches the floor (droplets only; sparks pass decal:false).
  function updatePool(pool, delta, floorAtFn, gravity, onLand) {
    var mesh = pool.mesh, dirty = false;
    for (var i = pool.active.length - 1; i >= 0; i--) {
      var rec = pool.active[i];
      rec.vel.y -= gravity * delta;
      var drag = Math.max(0, 1 - DRAG * delta);
      rec.vel.x *= drag; rec.vel.z *= drag;
      rec.pos.addScaledVector(rec.vel, delta);
      rec.life -= delta;

      var landed = false;
      if (rec.decal && floorAtFn) {
        var f = floorAtFn(rec.pos.x, rec.pos.z);
        if (f && f.inside && rec.pos.y <= f.floorY + FLOOR_EPS) {
          rec.pos.y = f.floorY;
          landed = true;
        }
      }

      if (landed || rec.life <= 0) {
        if (landed && onLand) onLand(rec);
        pool.free.push(rec.idx);
        mesh.setMatrixAt(rec.idx, _zeroScale);
        pool.active.splice(i, 1);
        dirty = true;
        continue;
      }

      var t = Math.max(0, rec.life / rec.maxLife);
      var scale = rec.r0 * (t > 0.25 ? 1 : t / 0.25); // hold size, shrink in last 25% of life
      _pos.copy(rec.pos);
      _mat.compose(_pos, _quat, _scale.setScalar(scale));
      mesh.setMatrixAt(rec.idx, _mat);
      dirty = true;
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  // Streaks fly oriented along their velocity and stretch/shrink with it,
  // so they need their own tiny update loop instead of updatePool's
  // isotropic scale -- everything else about pooling/recycling is identical.
  function updateStreaks(delta) {
    var pool = pools.streak;
    if (!pool) return;
    var mesh = pool.mesh, dirty = false;
    for (var i = pool.active.length - 1; i >= 0; i--) {
      var rec = pool.active[i];
      rec.vel.y -= DROP_GRAVITY * 0.5 * delta;
      rec.pos.addScaledVector(rec.vel, delta);
      rec.life -= delta;
      if (rec.life <= 0) {
        pool.free.push(rec.idx);
        mesh.setMatrixAt(rec.idx, _zeroScale);
        pool.active.splice(i, 1);
        dirty = true;
        continue;
      }
      var t = Math.max(0, rec.life / rec.maxLife);
      var len = Math.min(0.5, rec.vel.length() * 0.045) * t;
      var speedSq = rec.vel.lengthSq();
      if (speedSq > 1e-6) { _tmpDir.copy(rec.vel).multiplyScalar(1 / Math.sqrt(speedSq)); } else { _tmpDir.copy(_FORWARD); }
      _quat.setFromUnitVectors(_FORWARD, _tmpDir);
      _pos.copy(rec.pos);
      _mat.compose(_pos, _quat, _scale.set(0.03, 0.03, Math.max(0.02, len)));
      mesh.setMatrixAt(rec.idx, _mat);
      dirty = true;
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- decals: fixed-size ring buffer per fluid, oldest overwritten ------
  var decalRings = {}; // name -> { mesh, cap, next, filled }
  var growingPools = []; // death "pool grows under the corpse" decals

  function makeDecalRing(name, geo, mat, cap) {
    var mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0; // grows as decals are placed, caps at `cap`
    for (var i = 0; i < cap; i++) mesh.setMatrixAt(i, _zeroScale);
    scene.add(mesh);
    var ring = { mesh: mesh, cap: cap, next: 0, filled: 0 };
    decalRings[name] = ring;
    return ring;
  }

  function allocDecalSlot(ring) {
    var idx = ring.next;
    ring.next = (ring.next + 1) % ring.cap;
    ring.filled = Math.min(ring.cap, ring.filled + 1);
    ring.mesh.count = ring.filled;
    return idx;
  }

  // Main splat + 2-4 smaller satellites around it, so a landing droplet
  // reads as a spray hitting the floor rather than one clean blob.
  function placeSplatCluster(ring, x, y, z, colorFn) {
    placeDecal(ring, x, y, z, 0.6, 1.4, colorFn());
    var n = 2 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * Math.PI * 2;
      var dist = 0.2 + Math.random() * 0.6;
      placeDecal(ring, x + Math.cos(ang) * dist, y, z + Math.sin(ang) * dist, 0.2, 0.5, colorFn());
    }
  }

  function placeDecal(ring, x, y, z, sizeMin, sizeMax, color) {
    var idx = allocDecalSlot(ring);
    var s = sizeMin + Math.random() * (sizeMax - sizeMin);
    var sx = s * (0.75 + Math.random() * 0.5);
    var sz = s * (0.75 + Math.random() * 0.5);
    _pos.set(x, y + 0.01 + Math.random() * 0.01, z);
    _quat.setFromAxisAngle(_UP, Math.random() * Math.PI * 2);
    _mat.compose(_pos, _quat, _scale.set(sx, 1, sz));
    ring.mesh.setMatrixAt(idx, _mat);
    ring.mesh.setColorAt(idx, color);
    ring.mesh.instanceMatrix.needsUpdate = true;
    if (ring.mesh.instanceColor) ring.mesh.instanceColor.needsUpdate = true;
  }

  // A pool decal that grows in place over `dur` seconds instead of appearing
  // at full size, for the "pool spreads under the corpse" death effect.
  // ponytail: if the ring wraps back onto this slot mid-growth (very heavy
  // simultaneous carnage only) the animation just starts drawing whatever
  // new decal landed there -- rare, cosmetically harmless, not worth a
  // generation counter for a floor stain.
  function placeGrowingPool(ring, x, y, z, color, maxScale, dur) {
    var idx = allocDecalSlot(ring);
    ring.mesh.setColorAt(idx, color);
    if (ring.mesh.instanceColor) ring.mesh.instanceColor.needsUpdate = true;
    growingPools.push({ ring: ring, idx: idx, x: x, y: y + 0.006, z: z, rotY: Math.random() * Math.PI * 2, t: 0, dur: dur, maxScale: maxScale });
  }

  // ---- chunks (death debris): a handful of plain meshes, no pooling ----
  var chunks = [];

  // ---- mist sprites (death only): quick expanding fade -------------------
  var mists = [];
  var mistTexture = null;

  // ---- hit-splash sprites: instant camera-facing flash at the impact point
  var splashes = [];
  var splashTexture = null;

  function makeMistTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(40,20,50,0.85)');
    g.addColorStop(0.5, 'rgba(20,10,25,0.4)');
    g.addColorStop(1, 'rgba(10,5,15,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // Plain white soft blob so any splash colour can be applied via
  // SpriteMaterial.color without baking a hue into the texture.
  function makeSplashTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  function spawnSplash(pos, color, size) {
    var mat = new THREE.SpriteMaterial({
      map: splashTexture, color: color, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.95
    });
    var sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.setScalar(size);
    scene.add(sprite);
    splashes.push({ sprite: sprite, life: 0.25, maxLife: 0.25 });
  }

  // ---- colour helpers ------------------------------------------------
  // Bright arterial red (~0xc41022) with variance toward darker/dried.
  function bloodColor() {
    var t = Math.random();
    return _color.setRGB(0.66 + t * 0.16, 0.03 + t * 0.05, 0.09 + t * 0.07).clone();
  }
  function oilColor() {
    var t = Math.random();
    return _color.setRGB(0.03 + t * 0.02, 0.03, 0.04 + t * 0.03).clone();
  }
  function sparkColor() {
    return (Math.random() < 0.5 ? _color.setHex(0x66ffff) : _color.setHex(0xffaa33)).clone();
  }

  // ---- spray: shared by hit() and death() --------------------------------
  // dir: unit Vector3 (spray axis); spread: 0..1 half-angle-ish fudge factor.
  function spray(pos, dir, count, oilRatio, speedMin, speedMax, spread) {
    for (var i = 0; i < count; i++) {
      var isOil = Math.random() < oilRatio;
      var pool = pools[isOil ? 'oil' : 'blood'];
      var v = dir.clone();
      v.x += (Math.random() - 0.5) * spread;
      v.y += (Math.random() - 0.5) * spread * 0.7 + spread * 0.25; // slight upward bias
      v.z += (Math.random() - 0.5) * spread;
      v.normalize().multiplyScalar(speedMin + Math.random() * (speedMax - speedMin));
      var life = 1.2 + Math.random() * 0.8;
      var r0 = 0.06 + Math.random() * 0.08;
      poolSpawn(pool, pos.clone(), v, life, r0, isOil ? oilColor() : bloodColor(), true);
    }
  }

  function sparks(pos, dir, count) {
    var pool = pools.spark;
    if (!pool) return;
    for (var i = 0; i < count; i++) {
      var v = dir.clone();
      v.x += (Math.random() - 0.5) * 0.9;
      v.y += (Math.random() - 0.5) * 0.6 + 0.15;
      v.z += (Math.random() - 0.5) * 0.9;
      v.normalize().multiplyScalar(4 + Math.random() * 6);
      poolSpawn(pool, pos.clone(), v, 0.15 + Math.random() * 0.25, 0.025 + Math.random() * 0.02, sparkColor(), false);
    }
  }

  // Elongated quads flying along with the spray so the jet itself is
  // visible in the air, not just the droplets it's made of.
  function streaks(pos, dir, oilRatio, count) {
    var pool = pools.streak;
    if (!pool) return;
    for (var i = 0; i < count; i++) {
      var isOil = Math.random() < oilRatio;
      var v = dir.clone();
      v.x += (Math.random() - 0.5) * 0.9;
      v.y += (Math.random() - 0.5) * 0.6 + 0.2;
      v.z += (Math.random() - 0.5) * 0.9;
      v.normalize().multiplyScalar(5 + Math.random() * 6);
      poolSpawn(pool, pos.clone(), v, 0.2 + Math.random() * 0.2, 1, isOil ? oilColor() : bloodColor(), false);
    }
  }

  // ============================== PUBLIC API ==============================
  var API = {
    init: function (sceneRef, THREERef) {
      THREE = THREERef;
      scene = sceneRef;
      _mat = new THREE.Matrix4();
      _pos = new THREE.Vector3();
      _quat = new THREE.Quaternion();
      _scale = new THREE.Vector3(1, 1, 1);
      _zeroScale = new THREE.Matrix4().makeScale(0, 0, 0);
      _color = new THREE.Color();
      _color2 = new THREE.Color();
      _UP = new THREE.Vector3(0, 1, 0);
      _FORWARD = new THREE.Vector3(0, 0, 1);
      _tmpDir = new THREE.Vector3();
      mistTexture = makeMistTexture();
      splashTexture = makeSplashTexture();

      var dropGeo = new THREE.SphereGeometry(1, 4, 3);
      // Emissive floor is ~0.25 of the 0xc41022 base colour so blood still
      // reads as red in unlit corridors instead of going near-black.
      var bloodMat = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0x310409, emissiveIntensity: 1,
        roughness: 0.5, metalness: 0.05
      });
      var oilMat = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0x5a2a80, emissiveIntensity: 0.9,
        roughness: 0.25, metalness: 0.6
      });
      makePool('blood', dropGeo, bloodMat, 2000);
      makePool('oil', dropGeo, oilMat, 2000);

      var sparkGeo = new THREE.SphereGeometry(1, 3, 2);
      var sparkMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      makePool('spark', sparkGeo, sparkMat, 300);

      var streakGeo = new THREE.BoxGeometry(1, 1, 1);
      var streakMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      makePool('streak', streakGeo, streakMat, 300);

      var decalGeo = new THREE.CircleGeometry(0.5, 8);
      decalGeo.rotateX(-Math.PI / 2);
      var bloodDecalMat = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0x310409, emissiveIntensity: 1,
        roughness: 0.5, metalness: 0.05,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      var oilDecalMat = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0x2a6a70, emissiveIntensity: 0.8,
        roughness: 0.15, metalness: 0.7,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      makeDecalRing('bloodDecal', decalGeo, bloodDecalMat, DECAL_CAP);
      makeDecalRing('oilDecal', decalGeo, oilDecalMat, DECAL_CAP);
    },

    // pos: Vector3 hit point. dir: unit Vector3 away from the shooter.
    // amount: damage dealt (scales droplet count). enemy: the hit record,
    // used to pick the blood/oil mix.
    hit: function (pos, dir, amount, enemy) {
      if (!scene) return;
      var d = (dir && dir.lengthSq() > 1e-6) ? dir.clone().normalize() : new THREE.Vector3(0, 0.3, 1);
      var count = Math.min(84, Math.max(35, Math.round((25 + (amount || 10) * 0.6) * 1.4)));
      var oilRatio = oilRatioFor(enemy);
      spray(pos, d, count, oilRatio, 3, 9, 0.9);
      sparks(pos, d, 6 + Math.floor(Math.random() * 7));
      streaks(pos, d, oilRatio, 6 + Math.floor(Math.random() * 5));

      var splashColor = oilRatio > 0.5 ? _color2.setHex(0x1a1420) : _color2.setHex(0xc41022);
      spawnSplash(pos, splashColor.clone(), 0.8 + Math.random() * 0.7);

      if (enemy) paintEnemy(enemy, Math.random() < oilRatio ? oilColor() : bloodColor());
    },

    death: function (pos, enemy) {
      if (!scene) return;
      var oilRatio = oilRatioFor(enemy);
      var count = 150 + Math.floor(Math.random() * 100);
      // Omni-directional burst: reuse spray() with a mostly-upward axis and a
      // wide spread so it reads as an explosion rather than a directional jet.
      spray(pos, new THREE.Vector3(0, 1, 0), count, oilRatio, 4, 11, 2.2);

      // Fan a few faster, tighter jets out toward where walls/ceiling would
      // be so the mess reads as "all over the place", not just a floor pool.
      // ponytail: no wall-collision data in this region (see round-2 notes),
      // so these just fly further/faster and land on the real floor same as
      // everything else -- true wall splats are the upgrade, owned by
      // whoever has cheap access to resolveWallCollisions-style data.
      var fanDirs = [
        new THREE.Vector3(1, 0.3, 0), new THREE.Vector3(-1, 0.3, 0),
        new THREE.Vector3(0, 0.3, 1), new THREE.Vector3(0, 0.3, -1),
        new THREE.Vector3(0, 1, 0.15)
      ];
      fanDirs.forEach(function (fd) {
        spray(pos, fd, 12 + Math.floor(Math.random() * 10), oilRatio, 7, 14, 1.4);
      });

      // Expanding dark mist sprite.
      var mat = new THREE.SpriteMaterial({ map: mistTexture, transparent: true, depthWrite: false, opacity: 0.9 });
      var sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.setScalar(0.3);
      scene.add(sprite);
      mists.push({ sprite: sprite, life: 0.9, maxLife: 0.9 });

      // Growing pool under the corpse.
      var poolRing = oilRatio > 0.5 ? decalRings.oilDecal : decalRings.bloodDecal;
      var poolColor = oilRatio > 0.5 ? oilColor() : bloodColor();
      placeGrowingPool(poolRing, pos.x, pos.y, pos.z, poolColor, 2 + Math.random(), 1.5);

      // Tumbling chunks, gravity + one bounce, ~6s life.
      var chunkCount = 3 + Math.floor(Math.random() * 3);
      var chunkMat = new THREE.MeshStandardMaterial({ color: oilRatio > 0.5 ? 0x1a1a1e : 0x3a0a0e, roughness: 0.7 });
      for (var i = 0; i < chunkCount; i++) {
        var size = 0.08 + Math.random() * 0.1;
        var mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), chunkMat);
        mesh.position.copy(pos);
        scene.add(mesh);
        chunks.push({
          mesh: mesh,
          vel: new THREE.Vector3((Math.random() - 0.5) * 5, 3 + Math.random() * 3, (Math.random() - 0.5) * 5),
          rot: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
          life: 6,
          bounced: false
        });
      }
    },

    // delta: seconds since last frame. floorAtFn(x,z) -> {inside, floorY}.
    update: function (delta, floorAtFn) {
      if (!scene) return;

      updatePool(pools.blood, delta, floorAtFn, DROP_GRAVITY, function (rec) {
        placeSplatCluster(decalRings.bloodDecal, rec.pos.x, rec.pos.y, rec.pos.z, bloodColor);
      });
      updatePool(pools.oil, delta, floorAtFn, DROP_GRAVITY, function (rec) {
        placeSplatCluster(decalRings.oilDecal, rec.pos.x, rec.pos.y, rec.pos.z, oilColor);
      });
      updatePool(pools.spark, delta, null, GRAVITY * 0.4, null);
      updateStreaks(delta);

      for (var i = chunks.length - 1; i >= 0; i--) {
        var c = chunks[i];
        c.vel.y -= GRAVITY * delta;
        c.mesh.position.addScaledVector(c.vel, delta);
        c.mesh.rotation.x += c.rot.x * delta;
        c.mesh.rotation.y += c.rot.y * delta;
        c.mesh.rotation.z += c.rot.z * delta;
        c.life -= delta;
        if (floorAtFn) {
          var f = floorAtFn(c.mesh.position.x, c.mesh.position.z);
          if (f && f.inside && c.mesh.position.y <= f.floorY + 0.05) {
            c.mesh.position.y = f.floorY + 0.05;
            if (!c.bounced) {
              c.bounced = true;
              c.vel.y *= -0.3;
              c.vel.x *= 0.5; c.vel.z *= 0.5;
            } else {
              c.vel.set(0, 0, 0);
            }
          }
        }
        if (c.life <= 0) {
          scene.remove(c.mesh);
          chunks.splice(i, 1);
        }
      }

      for (var m = mists.length - 1; m >= 0; m--) {
        var mi = mists[m];
        mi.life -= delta;
        var t = Math.max(0, mi.life / mi.maxLife);
        mi.sprite.scale.setScalar(0.3 + (1 - t) * 3.2);
        mi.sprite.material.opacity = t * 0.7;
        if (mi.life <= 0) {
          scene.remove(mi.sprite);
          mi.sprite.material.dispose();
          mists.splice(m, 1);
        }
      }

      for (var s = splashes.length - 1; s >= 0; s--) {
        var sp = splashes[s];
        sp.life -= delta;
        var st = Math.max(0, sp.life / sp.maxLife);
        sp.sprite.material.opacity = st * 0.95;
        if (sp.life <= 0) {
          scene.remove(sp.sprite);
          sp.sprite.material.dispose();
          splashes.splice(s, 1);
        }
      }

      for (var g = growingPools.length - 1; g >= 0; g--) {
        var gp = growingPools[g];
        gp.t += delta;
        var frac = Math.min(1, gp.t / gp.dur);
        var sc = gp.maxScale * frac;
        _pos.set(gp.x, gp.y, gp.z);
        _quat.setFromAxisAngle(_UP, gp.rotY);
        _mat.compose(_pos, _quat, _scale.set(sc, 1, sc));
        gp.ring.mesh.setMatrixAt(gp.idx, _mat);
        gp.ring.mesh.instanceMatrix.needsUpdate = true;
        if (frac >= 1) growingPools.splice(g, 1);
      }
    },

    // Called on level reload to drop all live gore state. The meshes
    // themselves are removed for free when the engine clears the scene;
    // this just resets our own bookkeeping (free lists, decal rings, debris)
    // so a fresh level starts with empty pools instead of stale indices.
    clear: function () {
      Object.keys(pools).forEach(function (name) {
        var p = pools[name];
        p.active = [];
        p.free = [];
        for (var i = p.max - 1; i >= 0; i--) p.free.push(i);
      });
      Object.keys(decalRings).forEach(function (name) {
        var r = decalRings[name];
        r.next = 0;
        r.filled = 0;
        r.mesh.count = 0;
      });
      chunks = [];
      mists = [];
      splashes = [];
      growingPools = [];
    },

    // QA/debug only: live counts per pool and decal ring.
    __debugCounts: function () {
      var out = {};
      Object.keys(pools).forEach(function (n) { out[n] = pools[n].active.length; });
      Object.keys(decalRings).forEach(function (n) { out[n] = decalRings[n].filled; });
      out.chunks = chunks.length;
      out.mists = mists.length;
      out.splashes = splashes.length;
      out.growingPools = growingPools.length;
      return out;
    }
  };

  if (typeof window !== 'undefined') window.CyberGore = API;
})();
