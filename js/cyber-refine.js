// Character refinement pass (Cyberhell) — authored in the Acidlemon beat 'em up, Oct 12 2026.
// Self-contained: depends only on three.js and the CC0 Poly Haven normal maps listed in TEXTURES.
// Classic script (load after three.js, before cyber-enemies.js). Turn off with REFINE.enabled = false (used for before/after captures).
(function () {
  'use strict';
  // ---- shared character-refinement core v2 (identical across the games) ----
  // 1) Boxes become rounded boxes (same size, same UV layout, 4x4 segments per face) so
  //    silhouettes stop reading as stacked bricks; cylinders/cones get 20 sides, spheres 24x16.
  // 2) Materials get CC0 Poly Haven texture maps chosen by what they are (metal -> plate/rust,
  //    cloth -> linen weave, everything else -> leather/skin grain): a GL normal map plus a
  //    near-white greyscale detail albedo (`*_alb.jpg`) multiplied over the original colour, so
  //    palettes, emissives and look slots still read, and a roughness floor.
  // 3) Silhouette detail: torso/limb-sized box parts get a raised trim band (a belt / armour
  //    lip in a darker shade of the part's own colour) so the outline breaks up.
  // Idempotent; skips meshes whose geometry carries vertex colours or morph targets.
  // T.level: 1 = round-3 pass (rounded boxes 3x3, 14 sides, normal maps), 2 = this pass.
  var geoCache = new Map(), texCache = new Map(), trimMats = new Map();
  function roundedBox(THREE, w, h, d, seg) {
    var r = Math.min(w, h, d) * 0.22;
    var g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
    var p = g.attributes.position, n = g.attributes.normal, v = new THREE.Vector3(), c = new THREE.Vector3();
    var hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
      v.sub(c); if (v.lengthSq() < 1e-12) continue; v.normalize();
      n.setXYZ(i, v.x, v.y, v.z); v.multiplyScalar(r).add(c); p.setXYZ(i, v.x, v.y, v.z);
    }
    return g;
  }
  function refineGeo(THREE, g, L) {
    if (!g || g.attributes.color || (g.morphAttributes && Object.keys(g.morphAttributes).length)) return null;
    var P = g.parameters || {}, key = L + g.type + JSON.stringify(P);
    if (geoCache.has(key)) return geoCache.get(key);
    var out = null, rs = L >= 2 ? 20 : 14;
    if (g.type === 'BoxGeometry' && P.width && Math.min(P.width, P.height, P.depth) > 0.012) out = roundedBox(THREE, P.width, P.height, P.depth, L >= 2 ? 4 : 3);
    else if (g.type === 'CylinderGeometry' && P.radialSegments < rs) out = new THREE.CylinderGeometry(P.radiusTop, P.radiusBottom, P.height, rs, Math.max(P.heightSegments, L >= 2 ? 2 : 1), P.openEnded, P.thetaStart, P.thetaLength);
    else if (g.type === 'ConeGeometry' && P.radialSegments < rs && P.radialSegments > 5) out = new THREE.ConeGeometry(P.radius, P.height, rs, Math.max(P.heightSegments, L >= 2 ? 2 : 1), P.openEnded, P.thetaStart, P.thetaLength);
    else if (g.type === 'SphereGeometry' && P.widthSegments < (L >= 2 ? 24 : 14)) out = new THREE.SphereGeometry(P.radius, L >= 2 ? 24 : 16, L >= 2 ? 16 : 12, P.phiStart, P.phiLength, P.thetaStart, P.thetaLength);
    geoCache.set(key, out); return out;
  }
  function tex(THREE, url, srgb) {
    if (texCache.has(url)) return texCache.get(url);
    var t = new THREE.TextureLoader().load(url);
    if (typeof document !== 'undefined' && !t.image) { var c = document.createElement('canvas'); c.width = c.height = 1; var x = c.getContext('2d'); x.fillStyle = srgb ? '#ffffff' : '#8080ff'; x.fillRect(0, 0, 1, 1); t.image = c; t.needsUpdate = true; }   // no black flash before load
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2);
    if (srgb) { if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = 3001; }
    texCache.set(url, t); return t;
  }
  function refineMat(THREE, m, T) {
    if (!m || m.userData.refined || !(m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial)) return;
    m.userData.refined = true;
    var metal = (m.metalness || 0) >= 0.45, cloth = !metal && (m.roughness === undefined || m.roughness >= 0.72);
    var pick = metal ? T.metal : cloth ? T.cloth : T.other;
    if (!pick) return;
    if (T.level >= 2 && !m.map && !m.vertexColors && !(m.emissiveIntensity > 0.6 && m.emissive && m.emissive.getHex() > 0)) {
      m.map = tex(THREE, T.base + pick.file.replace('_nor.jpg', '_alb.jpg'), true);   // works on Lambert too
    }
    if (!m.normalMap && !m.isMeshLambertMaterial) {
      m.normalMap = tex(THREE, T.base + pick.file);
      m.normalScale = new THREE.Vector2(pick.scale, pick.scale);
    }
    if (m.isMeshStandardMaterial) m.roughness = Math.max(m.roughness, metal ? 0.32 : 0.5);
    m.flatShading = false; m.needsUpdate = true;
  }
  function trimFor(THREE, m) {
    if (!m || !m.color || m.transparent) return null;
    if (trimMats.has(m)) return trimMats.get(m);
    var t = m.clone(); t.color = m.color.clone().multiplyScalar(0.55); t.userData = { refined: true, trim: true };
    trimMats.set(m, t); return t;
  }
  function addTrim(THREE, o, L) {
    if (L < 2 || o.userData.trimmed || Array.isArray(o.material)) return;
    var P = o.geometry.parameters || {};
    if (!P.width || o.geometry.type !== 'BoxGeometry' && !o.userData.wasBox) return;
    var w = P.width, h = P.height, d = P.depth;
    if (Math.min(w, d) < 0.1 || h < 0.22 || h < Math.max(w, d) * 0.6) return;   // upright torso / limb blocks only
    var mat = trimFor(THREE, o.material); if (!mat) return;
    o.userData.trimmed = true;
    var band = new THREE.Mesh(refineGeo(THREE, new THREE.BoxGeometry(w * 1.08, h * 0.13, d * 1.08), L) || new THREE.BoxGeometry(w * 1.08, h * 0.13, d * 1.08), mat);
    band.position.y = -h * 0.3; band.userData.noRefine = true; band.userData.refineTrim = true; band.castShadow = o.castShadow;
    o.add(band);
  }
  function refineTree(THREE, root, T) {
    var L = T.level || 2, list = [];
    root.traverse(function (o) { if (o.isMesh && !o.userData.noRefine && !o.userData.inkHull) list.push(o); });
    list.forEach(function (o) {
      var src = o.geometry;
      addTrim(THREE, o, L);
      var ng = refineGeo(THREE, src, L); if (ng) { o.geometry = ng; }
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < ms.length; i++) refineMat(THREE, ms[i], T);
    });
    if (T.taper !== false) taperTree(THREE, root);
    return root;
  }
  // 4) Round 7 taper pass (Joel: limbs read as ball + cylinder + cylinder). After rounding, any
  //    object tagged userData.taper = { prof: [[t, s], ...], wx, wz, y0?, len? } is reshaped along
  //    its local Y: t = 0 at y0 (top), 1 at y0 - len (bottom); X/Z are scaled by s(t) (weighted by
  //    wx/wz). A tagged MESH reshapes itself (and its trim band); a tagged GROUP reshapes every mesh
  //    under it down to the next tagged object / userData.taperStop / userData.noTaper. Pure vertex
  //    deformation (normals transformed analytically) on a per-mesh clone: triangle count unchanged.
  function taperS(prof, t) {
    if (t <= prof[0][0]) return prof[0][1];
    for (var i = 1; i < prof.length; i++) if (t <= prof[i][0]) {
      var a = prof[i - 1], b = prof[i], u = (t - a[0]) / (b[0] - a[0]); u = u * u * (3 - 2 * u);
      return a[1] + (b[1] - a[1]) * u;
    }
    return prof[prof.length - 1][1];
  }
  function taperMesh(THREE, m, frame, S) {
    if (m.userData.tapered || !m.geometry || !m.geometry.attributes.position || m.isInstancedMesh || m.isSkinnedMesh) return;
    var GP = m.geometry.parameters; if (GP && GP.openEnded) return;   // skirts / hakama / open greaves keep their flare
    m.userData.tapered = true;
    var M = new THREE.Matrix4().copy(frame.matrixWorld).invert().multiply(m.matrixWorld);
    var Mi = new THREE.Matrix4().copy(M).invert();
    var N = new THREE.Matrix3().getNormalMatrix(M), Ni = new THREE.Matrix3().getNormalMatrix(Mi);
    var g = m.geometry.clone(), p = g.attributes.position, n = g.attributes.normal;
    var v = new THREE.Vector3(), w = new THREE.Vector3(), e = 1e-3, wx = S.wx == null ? 1 : S.wx, wz = S.wz == null ? 1 : S.wz;
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(M);
      var t = (S.y0 - v.y) / S.len, s = taperS(S.prof, t), ds = -(taperS(S.prof, t + e) - taperS(S.prof, t - e)) / (2 * e) / S.len;
      var sx = 1 + (s - 1) * wx, sz = 1 + (s - 1) * wz, dx = ds * wx, dz = ds * wz;
      if (n) {
        w.fromBufferAttribute(n, i).applyMatrix3(N);
        var nx = w.x / sx, nz = w.z / sz, ny = w.y - v.x * dx * nx - v.z * dz * nz;
        w.set(nx, ny, nz).applyMatrix3(Ni).normalize(); n.setXYZ(i, w.x, w.y, w.z);
      }
      v.set(v.x * sx, v.y, v.z * sz).applyMatrix4(Mi); p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeBoundingBox(); g.computeBoundingSphere();
    m.geometry = g;
  }
  function taperTree(THREE, root) {
    var tagged = [];
    root.traverse(function (o) { if (o.userData.taper && !o.userData.taperDone) tagged.push(o); });
    if (!tagged.length) return;
    root.updateMatrixWorld(true);
    tagged.forEach(function (f) {
      f.userData.taperDone = true;
      var S = f.userData.taper;
      if (S.y0 == null && f.isMesh) {
        f.geometry.computeBoundingBox(); var bb = f.geometry.boundingBox;
        S = Object.assign({}, S, { y0: bb.max.y, len: bb.max.y - bb.min.y });
      }
      var list = [];
      (function walk(o, top) {
        if (!top && (o.userData.taper || o.userData.taperStop || o.userData.noTaper)) return;
        if (o.isMesh && !o.userData.inkHull) list.push(o);
        for (var c = 0; c < o.children.length; c++) walk(o.children[c], false);
      })(f, true);
      list.forEach(function (m) { taperMesh(THREE, m, f, S); });
    });
  }
  // ---- end shared core ----

  var TEXTURES = { metal: { file: 'rust_coarse_01_nor.jpg', scale: 0.7 }, cloth: { file: 'brown_leather_nor.jpg', scale: 0.8 }, other: { file: 'brown_leather_nor.jpg', scale: 0.6 } };
  var API = { enabled: true, level: 2, base: 'textures/refine/',
    /** Called by CyberEnemies.buildMesh() on every freshly built rig. */
    apply: function (g, THREE) {
      THREE = THREE || window.THREE;
      if (!API.enabled || !g || !THREE) return g;
      return refineTree(THREE, g, { base: API.base, level: API.level, metal: TEXTURES.metal, cloth: TEXTURES.cloth, other: TEXTURES.other });
    } };
  window.CyberRefine = API;
})();
