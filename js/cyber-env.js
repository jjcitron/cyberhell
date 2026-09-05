/* ==========================================================================
   CyberEnv -- environment dressing (package T4, round 3).
   Classic script, exposes window.CyberEnv. No module system: init(scene,
   THREE) hands in the two things every other engine module already has.
   decorate(levelData, engine) runs once per level load, after geometry and
   entities exist, and places instanced props + sky/atmosphere for that map's
   theme. update(delta, camera) runs every frame for cheap animation/drift.
   ========================================================================== */
(function () {
  'use strict';

  var THREE = null;
  var scene = null;

  // Everything this module puts in the scene, so clear() can drop it without
  // walking scene.children itself (the engine already wipes scene.children
  // wholesale on level reload -- see loadLevelFromFile -- so clear() here
  // only needs to reset our own bookkeeping, same contract as CyberGore).
  var propMeshes = {};      // type -> { mesh, used, mat }
  var dustPoints = null;    // THREE.Points, themed atmosphere particles
  var dustVel = null;       // Float32Array parallel to dust positions
  var t = 0;

  var TOTAL_BUDGET = 300;
  var TYPE_BUDGET = { ceilLight: 60, pipe: 80, crate: 60, rack: 30, cable: 40, sign: 30 };

  // ---- theme detection -----------------------------------------------
  // No raw Doom texture names survive the converter, only the family
  // buckets it already sorts into (see TextureFactory). That's plenty to
  // guess a per-map mood without any converter change: tally which
  // families dominate this level's walls/floors and bucket into one of
  // four moods used for sky colour, fog tint and particle choice.
  function detectTheme(levelData) {
    var counts = { tech: 0, city: 0, hell: 0, cave: 0 };
    (levelData.walls || []).forEach(function (w) {
      if (w.tex === 'city_ruins') counts.city += 2;
      else if (w.tex === 'cyber_rust') counts.hell += 1;
      else if (w.tex === 'tech_wall' || w.tex === 'mainframe') counts.tech += 1;
      else if (w.tex === 'hazard') counts.hell += 0.5;
    });
    (levelData.sectors || []).forEach(function (sec) {
      if (sec.floorTex === 'toxic_rock') counts.cave += 2;
      else if (sec.floorTex === 'toxic_ooze') counts.hell += 1.5;
      else if (sec.floorTex === 'tech_floor' || sec.floorTex === 'metal_grate') counts.tech += 1;
      else if (sec.floorTex === 'dark_metal') counts.cave += 0.5;
    });
    // tech_wall/mainframe are the default Doom wall texture regardless of a
    // level's actual theme, so they dwarf the hell/cave accent count even on
    // clearly hellish or cavernous maps -- a raw max() picked "tech" for
    // nearly every map in the pack. Judge hell/cave by their share of the
    // tech count instead (a real secondary theme, not necessarily the
    // plurality of surface area); city already wins on a raw plurality often
    // enough (city_ruins is itself a wall family, not just an accent) to
    // keep that comparison as-is.
    var techBase = Math.max(counts.tech, 1);
    if (counts.hell / techBase >= 0.4) return 'hell';
    if (counts.cave / techBase >= 0.4) return 'cave';
    if (counts.city > counts.tech) return 'city';
    return 'tech';
  }

  var THEME = {
    tech: { zenith: '#0a1420', horizon: '#264a6e', ground: '#050a10', fogTint: 0x335577, particle: 'dust', particleColor: 0x8fd6ff },
    city: { zenith: '#160a20', horizon: '#7a1e5a', ground: '#08060c', fogTint: 0x552266, particle: 'ash', particleColor: 0xff6fb0 },
    hell: { zenith: '#1a0402', horizon: '#a3241a', ground: '#0c0100', fogTint: 0xaa2211, particle: 'ember', particleColor: 0xff6622 },
    cave: { zenith: '#060a0c', horizon: '#233238', ground: '#020304', fogTint: 0x1c2a2e, particle: 'dust', particleColor: 0x6fa0aa }
  };

  // ---- sky gradient (scene.background) --------------------------------
  // A screen-space gradient backdrop is a fraction of the cost of a dome
  // mesh (zero draw calls, no extra geometry) and reads fine behind fog.
  var _skyCache = {};
  function skyTexture(theme) {
    var cached = _skyCache[theme];
    if (cached) return cached;
    var canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 256;
    var ctx = canvas.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, 256);
    var c = THEME[theme];
    g.addColorStop(0, c.zenith);
    g.addColorStop(0.6, c.horizon);
    g.addColorStop(1, c.ground);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 256);
    var tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    _skyCache[theme] = tex;
    return tex;
  }

  // ---- distant city silhouettes ----------------------------------------
  var _skylineTex = null;
  function skylineTexture() {
    if (_skylineTex) return _skylineTex;
    var canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = '#0b0510';
    for (var bx = 0; bx < 512; bx += 24) {
      var bh = 30 + Math.random() * 90;
      ctx.fillRect(bx, 128 - bh, 20, bh);
      ctx.fillStyle = Math.random() > 0.5 ? '#ff2e88' : '#22e0ff';
      for (var wy = 128 - bh + 6; wy < 122; wy += 10) if (Math.random() > 0.5) ctx.fillRect(bx + 4, wy, 3, 4);
      ctx.fillStyle = '#0b0510';
    }
    var tex = new THREE.CanvasTexture(canvas);
    tex.transparent = true;
    _skylineTex = tex;
    return tex;
  }

  function buildSkyline(mapRadius) {
    var tex = skylineTexture();
    var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    var geo = new THREE.PlaneGeometry(mapRadius * 1.4, mapRadius * 0.45);
    var group = new THREE.Group();
    var sides = 6;
    for (var i = 0; i < sides; i++) {
      var a = (i / sides) * Math.PI * 2;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Math.cos(a) * mapRadius, mapRadius * 0.2, Math.sin(a) * mapRadius);
      mesh.rotation.y = -a + Math.PI / 2;
      mesh.renderOrder = -10;
      group.add(mesh);
    }
    return group;
  }

  // ---- atmosphere particles (dust / ash / ember) ------------------------
  var _dotTex = null;
  function dotTexture() {
    if (_dotTex) return _dotTex;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    var ctx = canvas.getContext('2d');
    var g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    g.addColorStop(0, '#fff'); g.addColorStop(1, '#fff0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 16);
    _dotTex = new THREE.CanvasTexture(canvas);
    return _dotTex;
  }

  function buildDust(theme) {
    var count = 220;
    var positions = new Float32Array(count * 3);
    dustVel = new Float32Array(count * 3);
    var spread = 26;
    for (var i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * spread * 2;
      positions[i * 3 + 1] = Math.random() * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
      var fall = theme.particle === 'ember' ? (0.6 + Math.random() * 0.8) : (theme.particle === 'ash' ? (0.3 + Math.random() * 0.4) : (0.05 + Math.random() * 0.1));
      dustVel[i * 3] = (Math.random() - 0.5) * 0.3;
      dustVel[i * 3 + 1] = theme.particle === 'ember' ? fall : -fall; // embers rise, dust/ash settle
      dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      size: theme.particle === 'ember' ? 0.14 : 0.09,
      map: dotTexture(), color: theme.particleColor, transparent: true,
      opacity: theme.particle === 'dust' ? 0.35 : 0.6, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  // ---- instanced prop helper ---------------------------------------------
  var _m = null, _pos = null, _quat = null, _scale = null, _up = null, _xAxis = null, _tiltQuat = null;

  function ensureType(type, geo, mat) {
    if (propMeshes[type]) return propMeshes[type];
    var max = TYPE_BUDGET[type] || 20;
    var mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
    var rec = { mesh: mesh, used: 0, max: max, mat: mat };
    propMeshes[type] = rec;
    return rec;
  }

  var budget = TOTAL_BUDGET;
  // tiltX: extra rotation (radians) around local X applied BEFORE the yaw,
  // e.g. -PI/2 to lay a cylinder (whose default axis is Y, vertical) flat so
  // its axis runs horizontally before rotY turns it to face the wall.
  function place(type, geo, mat, x, y, z, rotY, sx, sy, sz, tiltX) {
    if (budget <= 0) return false;
    var rec = ensureType(type, geo, mat);
    if (rec.used >= rec.max) return false;
    _pos.set(x, y, z);
    if (tiltX) {
      _tiltQuat.setFromAxisAngle(_xAxis, tiltX);
      _quat.setFromAxisAngle(_up, rotY || 0).multiply(_tiltQuat);
    } else {
      _quat.setFromAxisAngle(_up, rotY || 0);
    }
    _scale.set(sx || 1, sy || 1, sz || 1);
    _m.compose(_pos, _quat, _scale);
    rec.mesh.setMatrixAt(rec.used, _m);
    rec.used++;
    rec.mesh.count = rec.used;
    rec.mesh.instanceMatrix.needsUpdate = true;
    budget--;
    return true;
  }

  // ---- shared prop geometries/materials (built once, reused every level) --
  var _geo = {}, _mat = {};
  function fixtureAssets() {
    if (_geo.fixture) return;
    _geo.fixture = new THREE.CylinderGeometry(0.18, 0.22, 0.12, 8);
    _mat.fixture = new THREE.MeshStandardMaterial({ color: 0x1a2230, emissive: 0xbfe8ff, emissiveIntensity: 0.9, roughness: 0.4 });
    _geo.pipe = new THREE.CylinderGeometry(0.12, 0.12, 1, 6);
    _mat.pipe = new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: 0.6, metalness: 0.4 });
    _geo.crate = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    _mat.crate = new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 0.85 });
    _geo.barrel = new THREE.CylinderGeometry(0.35, 0.35, 0.9, 10);
    _mat.barrel = new THREE.MeshStandardMaterial({ color: 0x5a3a10, roughness: 0.7, metalness: 0.2 });
    _geo.rack = new THREE.BoxGeometry(0.6, 2.0, 0.5);
    _mat.rack = new THREE.MeshStandardMaterial({ color: 0x11151c, emissive: 0x22ff88, emissiveIntensity: 0.35, roughness: 0.5 });
    _geo.cable = new THREE.CylinderGeometry(0.04, 0.04, 1, 5);
    _mat.cable = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.9 });
    _geo.sign = new THREE.PlaneGeometry(0.5, 0.5);
    _mat.sign = new THREE.MeshStandardMaterial({ color: 0xffcc00, emissive: 0xff9900, emissiveIntensity: 0.6, roughness: 0.6, side: THREE.DoubleSide });
  }

  // Converted levels carry x/z/width/depth on the sector itself. The
  // hand-built MAP01_DATA sectors instead list several {x,z,width,depth}
  // rects under `floors`; buildSectorGeometry() already normalizes both into
  // `sec.resolvedFloors` before decorate() runs, so read through that (first
  // rect only, same simplification the loadLevel neon-light picker uses)
  // instead of trusting sec.x/z/width/depth to exist.
  function sectorRect(sec) {
    return (sec.resolvedFloors && sec.resolvedFloors[0]) || sec;
  }

  function wallLen(w) { var dx = w.p2[0] - w.p1[0], dz = w.p2[1] - w.p1[1]; return Math.sqrt(dx * dx + dz * dz); }
  function wallMid(w) { return [(w.p1[0] + w.p2[0]) / 2, (w.p1[1] + w.p2[1]) / 2]; }
  function wallNormal(w) { var dx = w.p2[0] - w.p1[0], dz = w.p2[1] - w.p1[1]; var len = Math.sqrt(dx * dx + dz * dz) || 1; return [-dz / len, dx / len]; }

  // ---- public API ---------------------------------------------------------
  var API = {
    init: function (sceneRef, THREERef) {
      scene = sceneRef;
      THREE = THREERef;
      _m = new THREE.Matrix4();
      _pos = new THREE.Vector3();
      _quat = new THREE.Quaternion();
      _scale = new THREE.Vector3(1, 1, 1);
      _up = new THREE.Vector3(0, 1, 0);
      _xAxis = new THREE.Vector3(1, 0, 0);
      _tiltQuat = new THREE.Quaternion();
      fixtureAssets();
    },

    detectTheme: detectTheme,

    // Called once per level load, after sectors/walls/entities exist.
    // engine gives us getFloorAt() (read-only) for prop ground height.
    decorate: function (levelData, engine) {
      if (!scene) return;
      API.clear();
      budget = TOTAL_BUDGET;

      var theme = THEME[detectTheme(levelData)];
      // Sky + fog: tasteful multiplier on the level's own fog, not a
      // structural override -- see loadLevel, which already sets base fog.
      scene.background = skyTexture(detectTheme(levelData));
      if (scene.fog) {
        scene.fog.color = new THREE.Color(scene.fog.color).lerp(new THREE.Color(theme.fogTint), 0.25);
      }

      var sectors = levelData.sectors || [];
      var walls = levelData.walls || [];
      var mapRadius = 0;
      sectors.forEach(function (sec) { var r = sectorRect(sec); mapRadius = Math.max(mapRadius, Math.abs(r.x || 0), Math.abs(r.z || 0)); });
      mapRadius = Math.max(60, mapRadius + 40);

      if (detectTheme(levelData) === 'city') {
        var skyline = buildSkyline(mapRadius);
        skyline.userData._cyberEnvSkyline = true;
        scene.add(skyline);
        propMeshes.__skyline = { mesh: skyline, used: 0, max: 0 };
      }

      dustPoints = buildDust(theme);
      scene.add(dustPoints);

      // Ceiling light fixtures in the brightest rooms.
      sectors.forEach(function (sec) {
        if (sec.isSky || (sec.light || 0) < 0.72) return;
        if (budget <= 0) return;
        var y = (sec.ceilY !== undefined ? sec.ceilY : sec.floorY + 6) - 0.3;
        var lr = sectorRect(sec);
        place('ceilLight', _geo.fixture, _mat.fixture, lr.x || 0, y, lr.z || 0, 0);
      });

      // Pipes along long straight utility/tech walls.
      walls.forEach(function (w) {
        if (budget <= 0) return;
        if (!(w.tex === 'dark_metal' || w.tex === 'tech_wall' || w.tex === 'mainframe')) return;
        var len = wallLen(w);
        if (len < 6 || len > 40) return;
        if (Math.random() > 0.35) return; // sample, don't paper every qualifying wall
        var mid = wallMid(w), n = wallNormal(w);
        var h = (w.bottomY !== undefined ? w.bottomY : 0) + Math.max(1.5, (w.h || 6) * 0.7);
        var angle = Math.atan2(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]);
        // Cylinder's default axis is vertical (Y); tiltX lays it flat before
        // rotY turns it to run along the wall, and the scale.y stretch (which
        // happens before either rotation, in local space) becomes its length.
        place('pipe', _geo.pipe, _mat.pipe, mid[0] + n[0] * 0.35, h, mid[1] + n[1] * 0.35, angle, 1, len, 1, -Math.PI / 2);
      });

      // Crates/barrels near ammo & weapon pickups.
      (levelData.entities || []).forEach(function (ent) {
        if (budget <= 0) return;
        if (ent.type.indexOf('ammo') !== 0 && ent.type !== 'weapon') return;
        if (Math.random() > 0.5) return;
        var floor = engine && engine.getFloorAt ? engine.getFloorAt(ent.pos[0] + 0.9, ent.pos[2] + 0.4) : null;
        var y = floor && floor.inside ? floor.floorY : ent.pos[1];
        var isBarrel = Math.random() > 0.5;
        if (isBarrel) place('crate', _geo.barrel, _mat.barrel, ent.pos[0] + 0.9, y + 0.45, ent.pos[2] + 0.4, Math.random() * Math.PI);
        else place('crate', _geo.crate, _mat.crate, ent.pos[0] + 0.9, y + 0.4, ent.pos[2] + 0.4, Math.random() * Math.PI);
      });

      // Server racks against a wall of tech-themed, well-lit sectors.
      sectors.forEach(function (sec) {
        if (budget <= 0) return;
        if (sec.floorTex !== 'tech_floor' && sec.floorTex !== 'metal_grate') return;
        if ((sec.light || 0) < 0.6) return;
        if (Math.random() > 0.3) return;
        var rr = sectorRect(sec);
        var w = rr.width || 6;
        var edgeX = (rr.x || 0) + (w / 2 - 0.4) * (Math.random() > 0.5 ? 1 : -1);
        place('rack', _geo.rack, _mat.rack, edgeX, sec.floorY + 1.0, rr.z || 0, Math.random() > 0.5 ? Math.PI / 2 : 0);
      });

      // Hanging cables in tall sectors.
      sectors.forEach(function (sec) {
        if (budget <= 0) return;
        var height = (sec.ceilY !== undefined ? sec.ceilY : sec.floorY + 6) - sec.floorY;
        if (height < 6 || sec.isSky) return;
        if (Math.random() > 0.4) return;
        var cr = sectorRect(sec);
        var cx = (cr.x || 0) + (Math.random() - 0.5) * (cr.width || 4) * 0.6;
        var cz = (cr.z || 0) + (Math.random() - 0.5) * (cr.depth || 4) * 0.6;
        var len = Math.min(height * 0.5, 3);
        place('cable', _geo.cable, _mat.cable, cx, sec.ceilY - len / 2, cz, 0, 1, len, 1);
      });

      // Warning signs beside doors.
      walls.forEach(function (w) {
        if (budget <= 0) return;
        if (!w.isDoor) return;
        var mid = wallMid(w), n = wallNormal(w);
        var angle = Math.atan2(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]);
        place('sign', _geo.sign, _mat.sign, mid[0] + n[0] * 0.25, (w.bottomY || 0) + (w.h || 6) * 0.65, mid[1] + n[1] * 0.25, angle);
      });
    },

    // Cheap per-frame drift/flicker. camera is optional (kept the container
    // fixed at the origin's local cloud rather than following the player --
    // 26-unit spread and 200ish points make re-centering unnecessary for a
    // single-arena Doom map; wrap-around keeps them from ever running out).
    update: function (delta) {
      t += delta;
      if (_mat.fixture) _mat.fixture.emissiveIntensity = 0.7 + Math.sin(t * 3) * 0.2;
      if (_mat.rack) _mat.rack.emissiveIntensity = 0.25 + Math.abs(Math.sin(t * 5)) * 0.25;
      if (_mat.sign) _mat.sign.emissiveIntensity = 0.5 + Math.sin(t * 2) * 0.15;

      if (dustPoints && dustVel) {
        var posAttr = dustPoints.geometry.attributes.position;
        var arr = posAttr.array;
        for (var i = 0; i < arr.length; i += 3) {
          arr[i] += dustVel[i] * delta;
          arr[i + 1] += dustVel[i + 1] * delta;
          arr[i + 2] += dustVel[i + 2] * delta;
          if (arr[i + 1] < 0) arr[i + 1] = 10;
          if (arr[i + 1] > 10) arr[i + 1] = 0;
        }
        posAttr.needsUpdate = true;
      }
    },

    // Reset bookkeeping for a fresh level. The engine already wipes
    // scene.children wholesale on reload (see loadLevelFromFile), so this
    // only needs to forget our own instanced-mesh handles and particle
    // system -- new ones get created fresh on the next decorate() call.
    clear: function () {
      propMeshes = {};
      dustPoints = null;
      dustVel = null;
    },

    __debugCounts: function () {
      var out = {};
      Object.keys(propMeshes).forEach(function (k) { out[k] = propMeshes[k].used; });
      return out;
    }
  };

  if (typeof window !== 'undefined') window.CyberEnv = API;
})();
