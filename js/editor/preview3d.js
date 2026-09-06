/* Cyberhell level editor -- live 3D preview panel.
 * Registers a 'preview3d' panel on window.CyberEditor and renders the level
 * JSON in its own THREE.Scene, matching index.html's floor/wall construction
 * (see buildSectorPolyGeometry / buildWall) closely enough to look right,
 * without touching the game's globals or classes.
 *
 * ponytail: flat colours by texture-family substring instead of the game's
 * canvas-painted TextureFactory. Upgrade path: port TextureFactory into a
 * standalone module both index.html and this file import, if the preview
 * ever needs to match texture detail 1:1.
 */
(function () {
  'use strict';
  if (window.__cyberPreview3DBooted) return;

  function boot(CE) {
    if (window.__cyberPreview3DBooted) return;
    window.__cyberPreview3DBooted = true;

    var THREE = window.THREE;

    // ---- geometry helpers copied/adapted from index.html's CyberDoomEngine ----
    // (see buildSectorPolyGeometry / shapesFromPolys) so floors line up with
    // the game's walls exactly. Self-contained copies -- not references into
    // the game's class, so this file never touches the game's globals.
    function shapesFromPolys(polys) {
      var rings = (polys || []).filter(function (l) { return l && l.length >= 3; }).map(function (loop) {
        var a = 0;
        for (var i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          a += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
        }
        return { loop: loop, area: Math.abs(a) / 2 };
      });
      function contains(outer, pt) {
        var inside = false;
        for (var i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          var xi = outer[i][0], zi = outer[i][1], xj = outer[j][0], zj = outer[j][1];
          if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) inside = !inside;
        }
        return inside;
      }
      rings.forEach(function (r) {
        var parent = null;
        rings.forEach(function (o) {
          if (o === r || o.area <= r.area) return;
          if (!contains(o.loop, r.loop[0])) return;
          if (!parent || o.area < parent.area) parent = o;
        });
        r.parent = parent;
      });
      rings.forEach(function (r) {
        var depth = 0;
        for (var p = r.parent; p; p = p.parent) depth++;
        r.isHole = depth % 2 === 1;
      });
      var shapes = [];
      rings.forEach(function (r) {
        if (r.isHole) return;
        var shape = new THREE.Shape(r.loop.map(function (pt) { return new THREE.Vector2(pt[0], -pt[1]); }));
        rings.forEach(function (h) {
          if (h.isHole && h.parent === r) shape.holes.push(new THREE.Path(h.loop.map(function (pt) { return new THREE.Vector2(pt[0], -pt[1]); })));
        });
        shapes.push(shape);
      });
      return shapes;
    }

    // ---- flat colours by texture family ----
    var FAMILY_COLORS = {
      tech_floor: 0x3a3f4a, tech_panel: 0x454b58, tech_wall: 0x40424c,
      toxic_ooze: 0x2f5c1c, toxic_rock: 0x54523a,
      hazard: 0x7a4a12, metal: 0x555b66, mainframe: 0x20303a,
      city_ruins: 0x5a544a, cyber_rust: 0x6b3a24, rust: 0x6b3a24,
      door_blast: 0x8f2a2a, door: 0x8f2a2a,
      switch_on: 0x3fae3f, switch_off: 0x666666, switch: 0x8a8a4a,
      sky: 0x0b0e18, brick: 0x6a4438, marble: 0x7a7868, wood: 0x5a4030,
      grate: 0x4a4d55, computer: 0x2a4a5a, blood: 0x7a1a1a, lava: 0x8a3a10
    };
    function hashColor(str) {
      var h = 0;
      for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
      var c = new THREE.Color();
      c.setHSL((h % 360) / 360, 0.3, 0.35);
      return c;
    }
    var _colorCache = {};
    function colorForTex(tex) {
      var key = String(tex || '').toLowerCase();
      if (_colorCache[key]) return _colorCache[key];
      var c = null;
      for (var fam in FAMILY_COLORS) {
        if (key.indexOf(fam) !== -1) { c = new THREE.Color(FAMILY_COLORS[fam]); break; }
      }
      if (!c) c = hashColor(key || 'unknown');
      _colorCache[key] = c;
      return c;
    }

    function makeCircleTexture(fill) {
      var c = document.createElement('canvas');
      c.width = c.height = 64;
      var ctx = c.getContext('2d');
      ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.stroke();
      var tex = new THREE.CanvasTexture(c);
      return tex;
    }

    // ================= panel state =================
    var state = {
      container: null, renderer: null, scene: null,
      persp: null, ortho: null, activeIsOrtho: false,
      wallMesh: null, wallInfo: [], sectorMeshes: [], entitySprites: [], spawnArrow: null,
      highlightGroup: null, level: null, bounds: null,
      keys: {}, yaw: 0, pitch: 0, dragging: false,
      lastX: 0, lastY: 0, clock: null
    };

    // Builds a WebGLRenderer wired with our context-loss/click/fly-cam
    // handlers. Broken out because the panel is mounted while its tab is
    // hidden (0-size) -- a renderer created and first-sized at 0 is left with
    // a stale/broken backbuffer in at least Chromium+swiftshader (renders
    // successfully, shows nothing, confirmed by rendering the same scene
    // through a freshly-created renderer and getting correct pixels). Cheapest
    // fix: build the real renderer lazily, once the container has an actual
    // visible size (see onResize's first-real-size branch).
    function createRenderer(container, w, h) {
      var r = new THREE.WebGLRenderer({ antialias: true });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.setSize(w, h, false);
      r.domElement.style.display = 'block';
      r.domElement.oncontextmenu = function (e) { e.preventDefault(); };
      r.domElement.addEventListener('webglcontextlost', function (e) { e.preventDefault(); }, false);
      r.domElement.addEventListener('webglcontextrestored', function () {
        if (state.level) buildLevel(state.level, false);
      }, false);
      wireFlyCamera(r.domElement, container);
      wireClickSelect(r.domElement);
      return r;
    }

    function init(container) {
      state.container = container;
      container.style.position = container.style.position || 'relative';
      container.style.overflow = 'hidden';
      // The shell hands us a bare <div> inside a plain `display:block` tab
      // panel (not a flex child), so it sizes to its own content height --
      // which is circular, since we size our canvas FROM the container. A
      // fixed min-height breaks the deadlock; flex:1 1 auto is a no-op today
      // but takes over for free if the shell ever makes .ed-panel a flex
      // column. Confirmed via DOM probe: without this the container reports
      // clientHeight 0 forever and our canvas gets stuck at 1x1.
      container.style.minHeight = '320px';
      container.style.flex = '1 1 auto';
      container.tabIndex = 0;

      var w = container.clientWidth || 400, h = container.clientHeight || 300;
      var renderer = createRenderer(container, w, h);
      container.appendChild(renderer.domElement);
      state.renderer = renderer;
      state.gotRealSize = false;

      var scene = new THREE.Scene();
      state.scene = scene;
      state.highlightGroup = new THREE.Group();
      scene.add(state.highlightGroup);

      var hemi = new THREE.HemisphereLight(0xbdd6ff, 0x1a1410, 0.9);
      scene.add(hemi);
      var sun = new THREE.DirectionalLight(0xffffff, 0.8);
      sun.position.set(30, 60, 20);
      scene.add(sun);
      state.sun = sun; state.hemi = hemi;

      var persp = new THREE.PerspectiveCamera(70, w / h, 0.1, 4000);
      persp.position.set(0, 12, 20);
      state.persp = persp;
      var ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 4000);
      ortho.up.set(0, 0, -1);
      state.ortho = ortho;

      buildToolbar(container);

      // ---- ResizeObserver keeps the renderer/cameras matched to the panel ----
      var ro = new ResizeObserver(function () { onResize(); });
      ro.observe(container);
      state.resizeObserver = ro;

      state.clock = new THREE.Clock();
      window.__cyberPreview3DDebug = state; // introspection hook for QA, harmless in prod
      requestAnimationFrame(animate);

      if (CE.level) buildLevel(CE.level, true);
      CE.on('level-loaded', function () { buildLevel(CE.level, true); });
      CE.on('level-changed', scheduleRebuild);
      CE.on('selection-changed', updateHighlight);
    }

    function onResize() {
      var w = state.container.clientWidth || 1, h = state.container.clientHeight || 1;
      // First time the panel gets an actual visible size (it mounts inside a
      // hidden tab), swap in a fresh renderer instead of resizing the one
      // built at 0-size -- see createRenderer's comment for why.
      if (!state.gotRealSize && w > 20 && h > 20) {
        state.gotRealSize = true;
        var fresh = createRenderer(state.container, w, h);
        state.container.replaceChild(fresh.domElement, state.renderer.domElement);
        state.renderer.dispose();
        state.renderer = fresh;
      } else {
        state.renderer.setSize(w, h, false);
      }
      state.persp.aspect = w / h;
      state.persp.updateProjectionMatrix();
      fitOrtho();
    }

    function fitOrtho() {
      var w = state.container.clientWidth || 1, h = state.container.clientHeight || 1;
      var aspect = w / h;
      var b = state.bounds || { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
      var halfW = Math.max(10, (b.maxX - b.minX) / 2 + 4);
      var halfD = Math.max(10, (b.maxZ - b.minZ) / 2 + 4);
      var half = Math.max(halfW, halfD / aspect);
      state.ortho.left = -half * aspect; state.ortho.right = half * aspect;
      state.ortho.top = half; state.ortho.bottom = -half;
      var cx = b ? (b.minX + b.maxX) / 2 : 0, cz = b ? (b.minZ + b.maxZ) / 2 : 0;
      state.ortho.position.set(cx, 500, cz);
      state.ortho.lookAt(cx, 0, cz);
      state.ortho.updateProjectionMatrix();
    }

    // ================= toolbar =================
    function buildToolbar(container) {
      var bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;top:4px;left:4px;z-index:2;display:flex;gap:4px;font:11px sans-serif;';
      function btn(label, fn) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:3px 6px;cursor:pointer;background:#222c;color:#eee;border:1px solid #555;border-radius:3px;';
        b.onmousedown = function (e) { e.stopPropagation(); };
        b.onclick = function (e) { e.stopPropagation(); fn(); };
        bar.appendChild(b);
        return b;
      }
      btn('Jump to spawn', jumpToSpawn);
      btn('Frame selection', frameSelection);
      state.orthoBtn = btn('Top-down', function () { setOrtho(!state.activeIsOrtho); });
      container.appendChild(bar);
    }

    function setOrtho(on) {
      state.activeIsOrtho = on;
      // Ground-level fog density reads as a near-solid wall of fog from 500
      // units up; the ortho view goes fog-free (see buildLevel's
      // state.levelFog comment).
      state.scene.fog = on ? null : state.levelFog;
      if (on) fitOrtho();
      if (state.orthoBtn) state.orthoBtn.style.background = on ? '#4b7fd5cc' : '#222c';
    }

    function jumpToSpawn() {
      var lvl = CE.level;
      if (!lvl || !lvl.playerSpawn) return;
      setOrtho(false);
      var p = lvl.playerSpawn.pos || [0, 0, 0];
      var rot = lvl.playerSpawn.rot || 0;
      state.persp.position.set(p[0], (p[1] || 0) + 5, p[2]);
      state.yaw = rot; state.pitch = -0.25;
      applyLook();
    }

    function boundsOf(kind, index) {
      var lvl = CE.level; if (!lvl) return null;
      if (kind === 'sector') {
        var sec = lvl.sectors && lvl.sectors[index]; if (!sec || !sec.polys) return null;
        var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        sec.polys.forEach(function (loop) { loop.forEach(function (pt) {
          minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
          minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
        }); });
        return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, y: sec.floorY || 0 };
      }
      if (kind === 'wall') {
        var w = state.wallInfo[index]; if (!w) return null;
        return { minX: Math.min(w.x1, w.x2), maxX: Math.max(w.x1, w.x2), minZ: Math.min(w.z1, w.z2), maxZ: Math.max(w.z1, w.z2), y: w.bottomY };
      }
      if (kind === 'entity') {
        var ent = lvl.entities && lvl.entities[index]; if (!ent) return null;
        return { minX: ent.pos[0] - 1, maxX: ent.pos[0] + 1, minZ: ent.pos[2] - 1, maxZ: ent.pos[2] + 1, y: ent.pos[1] };
      }
      return null;
    }

    function frameSelection() {
      var sel = CE.selection; if (!sel) return;
      var b = boundsOf(sel.kind, sel.index); if (!b) return;
      setOrtho(false);
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var size = Math.max(4, b.maxX - b.minX, b.maxZ - b.minZ);
      state.persp.position.set(cx + size, (b.y || 0) + size * 0.8, cz + size);
      var dir = new THREE.Vector3(cx, b.y || 0, cz).sub(state.persp.position).normalize();
      state.yaw = Math.atan2(dir.x, dir.z);
      state.pitch = Math.asin(dir.y);
      applyLook();
    }

    function applyLook() {
      var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'));
      state.persp.quaternion.copy(q);
    }

    // ================= fly camera =================
    function wireFlyCamera(dom, container) {
      container.addEventListener('keydown', function (e) {
        state.keys[e.code] = true;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].indexOf(e.code) !== -1) e.preventDefault();
      });
      container.addEventListener('keyup', function (e) { state.keys[e.code] = false; });
      dom.addEventListener('pointerdown', function (e) {
        container.focus();
        if (e.button === 2) {
          state.dragging = true; state.lastX = e.clientX; state.lastY = e.clientY;
          dom.setPointerCapture(e.pointerId);
        }
      });
      dom.addEventListener('pointermove', function (e) {
        if (!state.dragging) return;
        var dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
        state.lastX = e.clientX; state.lastY = e.clientY;
        state.yaw -= dx * 0.003;
        state.pitch -= dy * 0.003;
        state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch));
        applyLook();
      });
      ['pointerup', 'pointercancel'].forEach(function (evt) {
        dom.addEventListener(evt, function (e) { if (e.button === 2 || evt === 'pointercancel') state.dragging = false; });
      });
    }

    function updateFlyCamera(dt) {
      if (state.activeIsOrtho) return;
      var speed = (state.keys.ShiftLeft || state.keys.ShiftRight) ? 40 : 12;
      var forward = new THREE.Vector3(); state.persp.getWorldDirection(forward);
      var right = new THREE.Vector3().crossVectors(forward, state.persp.up).normalize();
      var move = new THREE.Vector3();
      if (state.keys.KeyW) move.add(forward);
      if (state.keys.KeyS) move.sub(forward);
      if (state.keys.KeyD) move.add(right);
      if (state.keys.KeyA) move.sub(right);
      if (state.keys.KeyE) move.y += 1;
      if (state.keys.KeyQ) move.y -= 1;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed * dt);
        state.persp.position.add(move);
      }
    }

    // ================= click to select =================
    function wireClickSelect(dom) {
      var raycaster = new THREE.Raycaster();
      var downPos = null;
      dom.addEventListener('pointerdown', function (e) {
        if (e.button === 0) downPos = { x: e.clientX, y: e.clientY };
      });
      dom.addEventListener('pointerup', function (e) {
        if (e.button !== 0 || !downPos) return;
        var moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
        downPos = null;
        if (moved > 4) return; // was a drag, not a click
        var rect = dom.getBoundingClientRect();
        var ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        var cam = state.activeIsOrtho ? state.ortho : state.persp;
        raycaster.setFromCamera(ndc, cam);
        var targets = [];
        if (state.wallMesh) targets.push(state.wallMesh);
        targets = targets.concat(state.sectorMeshes, state.entitySprites);
        var hits = raycaster.intersectObjects(targets, false);
        if (!hits.length) return;
        var hit = hits[0];
        if (hit.object === state.wallMesh) {
          CE.select('wall', hit.instanceId);
        } else if (hit.object.userData && hit.object.userData.kind) {
          CE.select(hit.object.userData.kind, hit.object.userData.index);
        }
      });
    }

    // ================= level build =================
    var rebuildTimer = null;
    function scheduleRebuild() {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(function () { buildLevel(CE.level); }, 60);
    }

    function disposeMesh(m) {
      if (!m) return;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) m.material.forEach(function (mm) { mm.dispose(); });
        else m.material.dispose();
      }
    }

    // Sector floor/ceiling materials are cached by (tex,side) and shared
    // across every sector using that texture, since a megamap has thousands
    // of sectors but only a handful of distinct textures. Cleared and
    // disposed at the start of each full rebuild, once the old scene no
    // longer references them.
    var _sectorMatCache = {};
    function sectorMaterial(tex, backSide) {
      var key = tex + '|' + (backSide ? 1 : 0);
      var mat = _sectorMatCache[key];
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ color: colorForTex(tex) });
        if (backSide) mat.side = THREE.BackSide;
        _sectorMatCache[key] = mat;
      }
      return mat;
    }
    function clearSectorMaterialCache() {
      for (var k in _sectorMatCache) _sectorMatCache[k].dispose();
      _sectorMatCache = {};
    }

    // Entity marker sprite materials: just two shared instances (enemy /
    // pickup), never disposed -- there is nothing level-specific about them.
    var _entityMat = {};
    function entityMaterial(isEnemy) {
      var key = isEnemy ? 'enemy' : 'pickup';
      if (!_entityMat[key]) {
        if (!circleTexRed) circleTexRed = makeCircleTexture('#ff4433');
        if (!circleTexGreen) circleTexGreen = makeCircleTexture('#44dd66');
        _entityMat[key] = new THREE.SpriteMaterial({ map: isEnemy ? circleTexRed : circleTexGreen, sizeAttenuation: true });
      }
      return _entityMat[key];
    }

    function clearLevelObjects() {
      if (state.wallMesh) { state.scene.remove(state.wallMesh); disposeMesh(state.wallMesh); state.wallMesh = null; }
      // Sector meshes share cached materials (see sectorMaterial) and, within
      // a sector, share one geometry between floor and ceiling -- dispose
      // geometry only here; materials are freed via clearSectorMaterialCache.
      state.sectorMeshes.forEach(function (m) { state.scene.remove(m); if (m.geometry) m.geometry.dispose(); });
      state.sectorMeshes = [];
      // Entity sprites share the two cached materials (see entityMaterial) --
      // nothing per-sprite to dispose.
      state.entitySprites.forEach(function (s) { state.scene.remove(s); });
      state.entitySprites = [];
      if (state.spawnArrow) { state.scene.remove(state.spawnArrow); state.spawnArrow = null; }
      state.wallInfo = [];
      state.highlightGroup.children.slice().forEach(function (c) {
        state.highlightGroup.remove(c); disposeMesh(c);
      });
    }

    var circleTexRed, circleTexGreen;

    function buildLevel(level, isFreshLoad) {
      var t0 = performance.now();
      clearLevelObjects();
      clearSectorMaterialCache();
      state.level = level;
      if (!level) return;

      var scene = state.scene;
      scene.background = (level.skyColor !== undefined) ? new THREE.Color(level.skyColor) : null;
      // Stashed rather than assigned straight to scene.fog: the top-down
      // ortho camera sits far above the map, and applying ground-level fog
      // density at that distance renders as a near-solid wall of fog (see
      // animate(), which only turns this on for the perspective fly camera).
      state.levelFog = level.fogDensity
        ? new THREE.FogExp2(level.fogColor !== undefined ? level.fogColor : 0x000000, level.fogDensity)
        : null;
      scene.fog = state.activeIsOrtho ? null : state.levelFog;
      if (level.sunLight) {
        state.sun.color.setHex(level.sunLight.color !== undefined ? level.sunLight.color : 0xffffff);
        state.sun.intensity = level.sunLight.intensity !== undefined ? level.sunLight.intensity : 0.8;
        if (level.sunLight.pos) state.sun.position.set(level.sunLight.pos[0], level.sunLight.pos[1], level.sunLight.pos[2]);
      }
      if (level.ambientLight !== undefined) {
        state.hemi.intensity = 0.5 + Math.min(1, (level.ambientLight / 0xffffff)) * 0.6;
      }

      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

      // ---- sectors: floor + ceiling meshes, one pair per sector (see
      // buildSectorPolyGeometry in index.html for the transform this mirrors) ----
      (level.sectors || []).forEach(function (sec, idx) {
        if (!sec.polys || !sec.polys.length) return;
        var shapes = shapesFromPolys(sec.polys);
        if (!shapes.length) return;
        var geo;
        try { geo = new THREE.ShapeGeometry(shapes); } catch (e) { return; }

        sec.polys.forEach(function (loop) { loop.forEach(function (pt) {
          minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
          minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
        }); });

        var floorMesh = new THREE.Mesh(geo, sectorMaterial(sec.floorTex, false));
        floorMesh.rotation.x = -Math.PI / 2;
        floorMesh.position.y = sec.floorY || 0;
        floorMesh.userData = { kind: 'sector', index: idx };
        scene.add(floorMesh);
        state.sectorMeshes.push(floorMesh);

        if (!sec.isSky) {
          // Same geometry as the floor (rotation/position live on the mesh,
          // not baked into the vertex data) -- sharing it instead of cloning
          // roughly halves the geometry allocation on a big megamap.
          var ceilMesh = new THREE.Mesh(geo, sectorMaterial(sec.ceilTex, true));
          ceilMesh.rotation.x = -Math.PI / 2;
          ceilMesh.position.y = sec.ceilY || 0;
          ceilMesh.userData = { kind: 'sector', index: idx };
          scene.add(ceilMesh);
          state.sectorMeshes.push(ceilMesh);
        }
      });

      // ---- walls: one InstancedMesh for all of them (see buildWall in
      // index.html) so a 20k-wall megamap stays one draw call. ----
      var walls = level.walls || [];
      if (walls.length) {
        var boxGeo = new THREE.BoxGeometry(1, 1, 1);
        var wallMat = new THREE.MeshLambertMaterial({ vertexColors: false });
        var mesh = new THREE.InstancedMesh(boxGeo, wallMat, walls.length);
        var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
        var euler = new THREE.Euler();
        walls.forEach(function (w, i) {
          var x1 = w.p1[0], z1 = w.p1[1], x2 = w.p2[0], z2 = w.p2[1];
          var dx = x2 - x1, dz = z2 - z1;
          var len = Math.max(0.01, Math.sqrt(dx * dx + dz * dz));
          var angle = Math.atan2(dz, dx);
          var bottomY = w.bottomY !== undefined ? w.bottomY : 0;
          var wallH = Math.max(0.1, w.h !== undefined ? w.h : ((w.topY !== undefined && w.bottomY !== undefined) ? w.topY - w.bottomY : 8));
          var midX = (x1 + x2) / 2, midZ = (z1 + z2) / 2;
          var centerY = bottomY + wallH / 2;
          pos.set(midX, centerY, midZ);
          euler.set(0, -angle, 0);
          q.setFromEuler(euler);
          scl.set(len, wallH, 0.4);
          m4.compose(pos, q, scl);
          mesh.setMatrixAt(i, m4);
          var c = colorForTex(w.tex);
          if (w.isDoor) c = c.clone().lerp(new THREE.Color(0x4fd0ff), 0.35);
          if (w.isSwitch) c = c.clone().lerp(new THREE.Color(0xffe14f), 0.45);
          mesh.setColorAt(i, c);
          minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
          minZ = Math.min(minZ, z1, z2); maxZ = Math.max(maxZ, z1, z2);
          state.wallInfo.push({ x1: x1, z1: z1, x2: x2, z2: z2, bottomY: bottomY, topY: bottomY + wallH, angle: angle, len: len, height: wallH, midX: midX, midZ: midZ, centerY: centerY });
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        scene.add(mesh);
        state.wallMesh = mesh;
      }

      // ---- entities: billboarded sprites, enemies red, pickups green ----
      (level.entities || []).forEach(function (ent, idx) {
        var isEnemy = ent.enemyType !== undefined && ent.enemyType !== null;
        var sprite = new THREE.Sprite(entityMaterial(isEnemy));
        var p = ent.pos || [0, 0, 0];
        sprite.position.set(p[0], (p[1] || 0) + 1.2, p[2]);
        sprite.scale.set(1.4, 1.4, 1.4);
        sprite.userData = { kind: 'entity', index: idx };
        scene.add(sprite);
        state.entitySprites.push(sprite);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      });

      // ---- player spawn: blue arrow ----
      if (level.playerSpawn) {
        var sp = level.playerSpawn.pos || [0, 0, 0];
        var rot = level.playerSpawn.rot || 0;
        // ponytail: approximate facing direction (rot=0 -> -Z), good enough
        // for "which way is spawn pointing" at a glance; exact convention
        // lives in the WAD converter if this ever needs to be exact.
        var dir = new THREE.Vector3(Math.sin(rot), 0, -Math.cos(rot)).normalize();
        var arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(sp[0], (sp[1] || 0) + 1.5, sp[2]), 2.5, 0x3fa9ff, 1, 0.6);
        scene.add(arrow);
        state.spawnArrow = arrow;
      }

      if (isFinite(minX)) {
        state.bounds = { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ };
      } else {
        state.bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
      }
      fitOrtho();
      updateHighlight();

      // A brand new level gets a useful default view (spawn, or the whole
      // map from an angle) instead of leaving the camera wherever it was --
      // an incremental edit (level-changed) never moves the camera, so the
      // person editing doesn't get yanked around mid-edit.
      if (isFreshLoad) {
        if (level.playerSpawn) {
          jumpToSpawn();
        } else {
          var b = state.bounds;
          var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
          var size = Math.max(20, b.maxX - b.minX, b.maxZ - b.minZ);
          setOrtho(false);
          state.persp.position.set(cx + size * 0.6, size * 0.6, cz + size * 0.6);
          var dir = new THREE.Vector3(cx, 0, cz).sub(state.persp.position).normalize();
          state.yaw = Math.atan2(dir.x, dir.z);
          state.pitch = Math.asin(dir.y);
          applyLook();
        }
      }

      var ms = performance.now() - t0;
      window.__cyberPreview3DLastRebuildMs = ms;
      window.dispatchEvent(new CustomEvent('preview3d-rebuilt', { detail: {
        ms: ms, sectors: (level.sectors || []).length, walls: walls.length, entities: (level.entities || []).length
      } }));
    }

    // ================= selection highlight =================
    function updateHighlight() {
      state.highlightGroup.children.slice().forEach(function (c) {
        state.highlightGroup.remove(c); disposeMesh(c);
      });
      var sel = CE.selection;
      if (!sel || sel.index === undefined || sel.index === null || sel.index < 0) return;
      var lvl = CE.level; if (!lvl) return;
      var mat = new THREE.LineBasicMaterial({ color: 0xffee55, linewidth: 2 });

      if (sel.kind === 'sector') {
        var sec = lvl.sectors && lvl.sectors[sel.index];
        if (sec && sec.polys) {
          sec.polys.forEach(function (loop) {
            var pts = loop.map(function (pt) { return new THREE.Vector3(pt[0], (sec.floorY || 0) + 0.05, pt[1]); });
            pts.push(pts[0]);
            var geo = new THREE.BufferGeometry().setFromPoints(pts);
            state.highlightGroup.add(new THREE.Line(geo, mat));
          });
        }
      } else if (sel.kind === 'wall') {
        var w = state.wallInfo[sel.index];
        if (w) {
          var boxGeo = new THREE.BoxGeometry(w.len, w.height, 0.4);
          var edges = new THREE.EdgesGeometry(boxGeo);
          boxGeo.dispose();
          var line = new THREE.LineSegments(edges, mat);
          line.position.set(w.midX, w.centerY, w.midZ);
          line.rotation.y = -w.angle;
          line.scale.set(1.05, 1.05, 1.5);
          state.highlightGroup.add(line);
        }
      } else if (sel.kind === 'entity') {
        var ent = lvl.entities && lvl.entities[sel.index];
        if (ent) {
          var ringGeo = new THREE.RingGeometry(1.0, 1.2, 24);
          var ringMat = new THREE.MeshBasicMaterial({ color: 0xffee55, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
          var ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(ent.pos[0], (ent.pos[1] || 0) + 0.1, ent.pos[2]);
          state.highlightGroup.add(ring);
        }
      }
    }

    // ================= render loop =================
    function animate() {
      requestAnimationFrame(animate);
      var dt = Math.min(0.1, state.clock.getDelta());
      updateFlyCamera(dt);
      var cam = state.activeIsOrtho ? state.ortho : state.persp;
      state.renderer.render(state.scene, cam);
    }

    // ---- register with the editor shell ----
    var mounted = false;
    var el = CE.registerPanel({
      id: 'preview3d', title: '3D', side: 'right',
      mount: function (mountEl) { mounted = true; init(mountEl); }
    });
    if (!mounted && el) init(el);
  }

  if (window.CyberEditor) {
    boot(window.CyberEditor);
  } else {
    window.addEventListener('cybereditor-ready', function once() {
      window.removeEventListener('cybereditor-ready', once);
      if (window.CyberEditor) boot(window.CyberEditor);
    });
    var pollIv = setInterval(function () {
      if (window.CyberEditor) { clearInterval(pollIv); boot(window.CyberEditor); }
    }, 50);
  }
})();
