/* ===========================================================================
   cyber-trellis.js — TRELLIS stylized meshes for the Cyberhell monsters.

   Classic script, loaded before cyber-enemies.js. Exposes:
     window.CyberTrellis.preload(THREE)        fetch + parse every GLB (async)
     window.CyberTrellis.apply(id, root, parts, THREE) -> bool   (sync)

   build() stays synchronous: preload() starts at script load; until a type's
   GLB is parsed, apply() returns false and the procedural rig is used. When
   ready, the procedural meshes are hidden (their pivots keep driving the
   animation) and the TRELLIS mesh is cut into rigid pieces that ride those
   pivots: head / torso / upper+lower arms / thighs+shins. Pieces are split
   once per type and the geometry is shared by every instance.

   Disable with ?trellis=0.
   =========================================================================== */
(function () {
  'use strict';

  var FILES = {
    3001: 'cinderlimb', 3004: 'rotgreen', 3002: 'gutmaw', 9: 'rustcoat',
    65: 'twinbarrel', 64: 'hollowflame',
    3003: 'gilded_warlord', 66: 'bone_rocket', 16: 'coilspine',
    67: 'tankhulk', 68: 'silverleg', 58: 'glasswraith', 7: 'jarbrain'
  };
  // Joel 2026-11-17: Maw Oni (3005) and Tetsu Oni (69) keep their original
  // procedural rigs; they are deliberately absent from FILES.
  var LEGS = { 3001: 1, 3004: 1, 3002: 1, 9: 1, 65: 1, 3003: 1, 16: 1, 58: 1, 64: 1 };
  var ARMS = { 3001: 1, 3004: 1, 3002: 1, 9: 1, 65: 1, 3003: 1, 16: 1, 58: 1, 66: 1, 64: 1 };
  var GHOST = { 58: 0.55 };   // Spectre stays see-through
  var TINT = { 58: [0.75, 0.95, 1.15] }; // Glasswraith: slight cyan glass
  // Radians around Y applied when mapping the GLB into rig space (rigs face -Z).
  // Default is π (TRELLIS +Z → rig -Z). Meshes that came out facing +X use π/2.
  var YAW = { 64: Math.PI / 2, 16: Math.PI / 2, 7: Math.PI / 2 };

  var BASE = 'models/trellis/';
  var data = {};      // id -> { parts: [{geo, mat}], ready }
  var split = {};     // id -> { key: geometry in rig space }
  var started = false;

  function enabled() {
    try { return !/[?&]trellis=0\b/.test(location.search); } catch (e) { return true; }
  }

  // ---------------------------------------------------------------- GLB
  var CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  var NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  var NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

  function readAccessor(json, bin, idx, toFloat) {
    var a = json.accessors[idx], bv = json.bufferViews[a.bufferView];
    var Arr = CT[a.componentType], n = NC[a.type], el = Arr.BYTES_PER_ELEMENT;
    var off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    var stride = bv.byteStride || n * el;
    var out = toFloat ? new Float32Array(a.count * n) : new Arr(a.count * n);
    var dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    var get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
    var k = (toFloat && a.normalized) ? 1 / NORM[a.componentType] : 1;
    for (var i = 0; i < a.count; i++) {
      for (var c = 0; c < n; c++) {
        var v = dv[get](off + i * stride + c * el, true) * k;
        out[i * n + c] = (toFloat && a.normalized && (a.componentType === 5120 || a.componentType === 5122)) ? Math.max(v, -1) : v;
      }
    }
    return out;
  }

  function nodeMatrix(THREE, nd) {
    var m = new THREE.Matrix4();
    if (nd.matrix) return m.fromArray(nd.matrix);
    var t = nd.translation || [0, 0, 0], r = nd.rotation || [0, 0, 0, 1], s = nd.scale || [1, 1, 1];
    return m.compose(new THREE.Vector3(t[0], t[1], t[2]), new THREE.Quaternion(r[0], r[1], r[2], r[3]), new THREE.Vector3(s[0], s[1], s[2]));
  }

  function parseGLB(THREE, buf) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB');
    var jlen = dv.getUint32(12, true);
    var json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
    var bo = 20 + jlen, bin = null;
    if (bo < buf.byteLength) bin = new Uint8Array(buf, bo + 8, dv.getUint32(bo, true));
    var prims = [];
    function walk(ni, parentM) {
      var nd = json.nodes[ni], M = parentM.clone().multiply(nodeMatrix(THREE, nd));
      if (nd.mesh !== undefined) json.meshes[nd.mesh].primitives.forEach(function (p) { prims.push({ p: p, M: M }); });
      (nd.children || []).forEach(function (c) { walk(c, M); });
    }
    var scene = json.scenes[json.scene || 0];
    scene.nodes.forEach(function (n) { walk(n, new THREE.Matrix4()); });
    var tris = [], uvs = [], matIdx = null;
    var v = new THREE.Vector3();
    prims.forEach(function (pp) {
      var p = pp.p, at = p.attributes;
      var pos = readAccessor(json, bin, at.POSITION, true);
      var uv = at.TEXCOORD_0 !== undefined ? readAccessor(json, bin, at.TEXCOORD_0, true) : null;
      var ind = p.indices !== undefined ? readAccessor(json, bin, p.indices, false) : null;
      var count = ind ? ind.length : pos.length / 3;
      for (var i = 0; i < count; i++) {
        var j = ind ? ind[i] : i;
        v.set(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]).applyMatrix4(pp.M);
        tris.push(v.x, v.y, v.z);
        uvs.push(uv ? uv[j * 2] : 0, uv ? uv[j * 2 + 1] : 0);
      }
      if (matIdx === null && p.material !== undefined) matIdx = p.material;
    });
    var image = null, color = [1, 1, 1, 1];
    if (matIdx !== null) {
      var mt = json.materials[matIdx], pbr = mt.pbrMetallicRoughness || {};
      if (pbr.baseColorFactor) color = pbr.baseColorFactor;
      if (pbr.baseColorTexture) {
        var tex = json.textures[pbr.baseColorTexture.index];
        var src = tex.source !== undefined ? tex.source : (tex.extensions && tex.extensions.EXT_texture_webp && tex.extensions.EXT_texture_webp.source);
        var im = json.images[src], ibv = json.bufferViews[im.bufferView];
        image = new Blob([new Uint8Array(bin.buffer, bin.byteOffset + (ibv.byteOffset || 0), ibv.byteLength)], { type: im.mimeType || 'image/png' });
      }
    }
    return { pos: new Float32Array(tris), uv: new Float32Array(uvs), image: image, color: color };
  }

  function makeMaterial(THREE, d, id) {
    var tint = TINT[id] || [1, 1, 1];
    var opts = { color: new THREE.Color(d.color[0] * tint[0], d.color[1] * tint[1], d.color[2] * tint[2]), metalness: 0.05, roughness: 0.82 };
    if (GHOST[id]) { opts.transparent = true; opts.opacity = GHOST[id]; opts.depthWrite = false; }
    var m = new THREE.MeshStandardMaterial(opts);
    if (d.image) {
      var t = new THREE.Texture();
      t.flipY = false;
      var img = new Image();
      img.onload = function () { t.image = img; t.needsUpdate = true; };
      img.src = URL.createObjectURL(d.image);
      m.map = t;
    }
    m.userData.refined = true;
    return m;
  }

  var bufs = {};      // id -> ArrayBuffer (fetched at script load, parsed on first use)
  function preload() {
    if (started || !enabled() || typeof fetch !== 'function') return;
    started = true;
    Object.keys(FILES).forEach(function (id) {
      fetch(BASE + FILES[id] + '.glb').then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.arrayBuffer();
      }).then(function (buf) { bufs[id] = buf; })
        .catch(function (e) { console.warn('[trellis] ' + FILES[id] + ' failed, procedural kept:', e && e.message); });
    });
  }
  function get(THREE, id) {
    if (data[id]) return data[id];
    if (!bufs[id]) return null;
    try {
      var d = parseGLB(THREE, bufs[id]);
      d.mat = makeMaterial(THREE, d, +id);
      data[id] = d;
    } catch (e) { console.warn('[trellis] parse failed', FILES[id], e); }
    bufs[id] = null;
    return data[id] || null;
  }

  // ---------------------------------------------------------------- split
  // shoulder (0) / elbow (1): parts.leftShoulder/leftElbow, else the limbs
  // contract (limbs.leftArm and its userData.lower). An elbow must hang under
  // its shoulder or the forearm would stay behind when the arm swings.
  function armPiv(parts, side, lower) {
    var sh = parts[side + 'Shoulder'] || (parts.limbs && parts.limbs[side + 'Arm']) || null;
    if (!lower) return sh;
    var el = parts[side + 'Elbow'] || (sh && sh.userData && sh.userData.lower) || null;
    if (el && sh) { var o = el; while (o && o !== sh) o = o.parent; if (o !== sh) return null; }
    return el;
  }
  function wpos(THREE, o) { var v = new THREE.Vector3(); o.getWorldPosition(v); return v; }

  function doSplit(THREE, id, root, parts) {
    var d = data[id];
    // rig space: root with identity transform
    var sp = root.position.clone(), sq = root.quaternion.clone(), ss = root.scale.clone();
    root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
    root.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(root);
    var P = d.pos, n = P.length / 3;
    // GLB bbox
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], i, c;
    for (i = 0; i < n; i++) for (c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], P[i * 3 + c]); mx[c] = Math.max(mx[c], P[i * 3 + c]); }
    var H = box.max.y - box.min.y, s = H / Math.max(1e-6, mx[1] - mn[1]);
    var cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    var gx = (mn[0] + mx[0]) / 2, gz = (mn[2] + mx[2]) / 2;
    // Default yaw π: TRELLIS +Z → rig -Z. Per-id YAW overrides (π/2 for
    // meshes that came out facing +X). The inner body then turns another π
    // so visual front lands on the AI's +Z (direction of travel).
    var yaw = (YAW[id] != null) ? YAW[id] : Math.PI;
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var W = new Float32Array(P.length);
    for (i = 0; i < n; i++) {
      var px = (P[i * 3] - gx) * s, pz = (P[i * 3 + 2] - gz) * s;
      W[i * 3] = cx + cy * px + sy * pz;
      W[i * 3 + 1] = box.min.y + (P[i * 3 + 1] - mn[1]) * s;
      W[i * 3 + 2] = cz + (-sy * px + cy * pz);
    }
    var limbs = parts.limbs || {};
    var piv = {
      root: root, torso: parts.torso || root, head: parts.head || null,
      lS: ARMS[id] ? armPiv(parts, 'left', 0) : null, rS: ARMS[id] ? armPiv(parts, 'right', 0) : null,
      lE: ARMS[id] ? armPiv(parts, 'left', 1) : null, rE: ARMS[id] ? armPiv(parts, 'right', 1) : null,
      lL: LEGS[id] ? limbs.leftLeg : null, rL: LEGS[id] ? limbs.rightLeg : null
    };
    piv.lK = piv.lL && piv.lL.userData.lower || null;
    piv.rK = piv.rL && piv.rL.userData.lower || null;
    var at = {}; for (var k in piv) if (piv[k]) at[k] = wpos(THREE, piv[k]);
    var hipY = (at.lL && at.rL) ? (at.lL.y + at.rL.y) / 2 : -1e9;
    var kneeY = box.min.y + (hipY - box.min.y) * 0.5;
    var shX = (at.lS && at.rS) ? Math.abs(at.lS.x - at.rS.x) / 2 : 0;
    var torsoHalf = shX * 0.72;
    var headY = at.head ? at.head.y : 1e9;
    function sideKey(x, l, r) { if (!at[l] || !at[r]) return null; return Math.abs(x - at[l].x) < Math.abs(x - at[r].x) ? l : r; }
    var assign = new Array(n / 3), armMax = { lS: 0, rS: 0 };
    var t, x, y, z, key;
    function tcen(t3) { return [(W[t3 * 9] + W[t3 * 9 + 3] + W[t3 * 9 + 6]) / 3, (W[t3 * 9 + 1] + W[t3 * 9 + 4] + W[t3 * 9 + 7]) / 3, (W[t3 * 9 + 2] + W[t3 * 9 + 5] + W[t3 * 9 + 8]) / 3]; }
    // Arm cone per side: from the shoulder, the A-pose arm leaves the body at
    // an angle (measured to the farthest clearly-outside point, the hand);
    // anything outward of half that angle is arm, the flank stays torso.
    var cone = {};
    ['lS', 'rS'].forEach(function (k) {
      if (!at[k] || !shX) return;
      var sgn = Math.sign(at[k].x - cx) || 1, best = null, bd = 0;
      for (var q = 0; q < n / 3; q++) {
        var c3 = tcen(q), out = (c3[0] - cx) * sgn;
        if (out < shX * 1.15 || c3[1] < box.min.y + H * 0.12) continue;
        var dd = Math.hypot(c3[0] - at[k].x, c3[1] - at[k].y, c3[2] - at[k].z);
        if (dd > bd) { bd = dd; best = c3; }
      }
      if (!best) return;
      var ang = Math.atan2((best[0] - cx) * sgn - shX, Math.max(1e-4, at[k].y - best[1]));
      if (ang < 0.12) return;   // arms hugging the body: leave them on the torso
      cone[k] = { sgn: sgn, half: ang * 0.5 };
    });
    for (t = 0; t < n / 3; t++) {
      var c3 = tcen(t); x = c3[0]; y = c3[1]; z = c3[2];
      key = null;
      for (var kk in cone) {
        var C = cone[kk], o2 = (x - cx) * C.sgn;
        if (o2 <= 0) continue;
        var below = at[kk].y + H * 0.03 - y;
        var a2 = Math.atan2(o2 - shX * 0.85, Math.max(1e-4, below));
        if ((below > 0 && a2 > C.half && o2 > shX * 0.85) || (below <= 0 && o2 > shX * 1.05)) { key = kk; break; }
      }
      if (key) {
        var dd2 = Math.hypot(x - at[key].x, y - at[key].y, z - at[key].z);
        if (dd2 > armMax[key]) armMax[key] = dd2;
        assign[t] = { k: key, d: dd2 }; continue;
      }
      key = 'torso';
      if (at.lL && at.rL && y < hipY && Math.abs(x - cx) > shX * 0.04) {
        var lk = sideKey(x, 'lL', 'rL');
        key = y < kneeY ? (lk === 'lL' ? (piv.lK ? 'lK' : 'lL') : (piv.rK ? 'rK' : 'rL')) : lk;
      } else if (at.head && y > headY && Math.abs(x - cx) < Math.max(torsoHalf, H * 0.12)) {
        key = 'head';
      }
      assign[t] = { k: key };
    }
    var buckets = {};
    for (t = 0; t < n / 3; t++) {
      key = assign[t].k;
      if ((key === 'lS' || key === 'rS') && assign[t].d > armMax[key] * 0.48) {
        var ek = key === 'lS' ? 'lE' : 'rE'; if (piv[ek]) key = ek;
      }
      if (!piv[key] && (key === 'lE' || key === 'rE')) key = key[0] + 'S';
      if (!piv[key] && (key === 'lK' || key === 'rK')) key = key[0] + 'L';
      if (!piv[key]) key = piv.torso ? 'torso' : 'root';
      (buckets[key] = buckets[key] || []).push(t);
    }
    // joints measured on the mesh itself, so the procedural pivots can be
    // moved onto them and limbs swing about the mesh's own shoulders/hips.
    function cen(list, keep) {
      var sx = 0, sy = 0, sz = 0, m = 0;
      for (var q = 0; q < list.length; q++) { if (!keep(list[q])) continue; var b = list[q] * 9;
        sx += W[b] + W[b + 3] + W[b + 6]; sy += W[b + 1] + W[b + 4] + W[b + 7]; sz += W[b + 2] + W[b + 5] + W[b + 8]; m += 3; }
      return m ? new THREE.Vector3(sx / m, sy / m, sz / m) : null;
    }
    function tc(t3, c3) { return (W[t3 * 9 + c3] + W[t3 * 9 + 3 + c3] + W[t3 * 9 + 6 + c3]) / 3; }
    var joints = {};
    ['l', 'r'].forEach(function (sd) {
      var S = sd + 'S', E = sd + 'E', L = sd + 'L', K = sd + 'K';
      var arm = (buckets[S] || []).concat(buckets[E] || []);
      if (arm.length && at[S]) {
        var ax = arm.map(function (t3) { return Math.abs(tc(t3, 0) - cx); }).sort(function (a2, b2) { return a2 - b2; });
        var lim = ax[Math.floor(ax.length * 0.06)];
        joints[S] = cen(arm, function (t3) { return Math.abs(tc(t3, 0) - cx) <= lim; });
        if (buckets[E] && piv[E]) joints[E] = cen(arm, function (t3) { var dd = assign[t3].d; return dd > armMax[S] * 0.42 && dd < armMax[S] * 0.54; });
      }
      var leg = (buckets[L] || []).concat(buckets[K] || []);
      if (leg.length && at[L]) {
        joints[L] = cen(leg, function (t3) { return tc(t3, 1) > hipY - H * 0.05; });
        if (buckets[K] && piv[K]) joints[K] = cen(leg, function (t3) { return Math.abs(tc(t3, 1) - kneeY) < H * 0.03; });
      }
    });
    var out = { _joints: joints };
    for (key in buckets) {
      var list = buckets[key], g = new THREE.BufferGeometry();
      var pa = new Float32Array(list.length * 9), ua = new Float32Array(list.length * 6);
      for (i = 0; i < list.length; i++) {
        pa.set(W.subarray(list[i] * 9, list[i] * 9 + 9), i * 9);
        ua.set(d.uv.subarray(list[i] * 6, list[i] * 6 + 6), i * 6);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pa, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(ua, 2));
      g.computeVertexNormals();
      out[key] = { geo: g, pivotKey: key };
    }
    root.position.copy(sp); root.quaternion.copy(sq); root.scale.copy(ss);
    root.updateMatrixWorld(true);
    return out;
  }

  var PIVOT_OF = {
    root: function (r) { return r.root; }, torso: function (r) { return r.torso; }, head: function (r) { return r.head; },
    lS: function (r) { return r.lS; }, rS: function (r) { return r.rS; }, lE: function (r) { return r.lE; }, rE: function (r) { return r.rE; },
    lL: function (r) { return r.lL; }, rL: function (r) { return r.rL; }, lK: function (r) { return r.lK; }, rK: function (r) { return r.rK; }
  };

  function apply(id, root, parts, THREE) {
    if (!enabled() || !parts || !FILES[id]) return false;
    THREE = THREE || window.THREE;
    if (!get(THREE, id)) return false;
    try {
      if (!split[id]) split[id] = doSplit(THREE, id, root, parts);
      var limbs = parts.limbs || {};
      var piv = {
        root: root, torso: parts.torso || root, head: parts.head, lS: armPiv(parts, 'left', 0), rS: armPiv(parts, 'right', 0),
        lE: armPiv(parts, 'left', 1), rE: armPiv(parts, 'right', 1), lL: limbs.leftLeg, rL: limbs.rightLeg,
        lK: limbs.leftLeg && limbs.leftLeg.userData.lower, rK: limbs.rightLeg && limbs.rightLeg.userData.lower
      };
      root.traverse(function (o) { if (o.isMesh) { o.visible = false; o.userData.noRefine = true; } });
      var sp = root.position.clone(), sq = root.quaternion.clone(), ss = root.scale.clone();
      root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
      root.updateMatrixWorld(true);
      // move the pivots onto the mesh's joints (parents before children)
      var J = split[id]._joints || {};
      ['lS', 'rS', 'lE', 'rE', 'lL', 'rL', 'lK', 'rK'].forEach(function (k) {
        var pv = piv[k], w = J[k];
        if (!pv || !w || !pv.parent) return;
        pv.parent.updateMatrixWorld(true);
        pv.position.copy(pv.parent.worldToLocal(w.clone()));
        pv.updateMatrixWorld(true);
      });
      var meshes = [], dbg = [];
      for (var key in split[id]) {
        if (key === '_joints') continue;
        var pc = split[id][key], target = PIVOT_OF[key](piv) || root;
        if (!PIVOT_OF[key](piv)) dbg.push(key + ':root');
        var m = new THREE.Mesh(pc.geo, data[id].mat);
        m.userData.noRefine = true; m.userData.tapered = true; m.userData.noTaper = true; m.userData.trellis = true;
        m.castShadow = true;
        root.add(m);
        target.attach(m);
        meshes.push(m);
      }
      root.position.copy(sp); root.quaternion.copy(sq); root.scale.copy(ss);
      root.updateMatrixWorld(true);
      root.userData.trellis = { file: FILES[id], pieces: meshes.length, keys: Object.keys(split[id]).filter(function (k) { return k !== '_joints'; }), fallback: dbg };
      return true;
    } catch (e) {
      console.warn('[trellis] apply failed for', id, e);
      root.traverse(function (o) { if (o.isMesh && !o.userData.trellis) o.visible = true; });
      return false;
    }
  }

  function ready() { var n = 0; for (var k in FILES) if (data[k] || bufs[k]) n++; return { ready: n, total: Object.keys(FILES).length }; }

  window.CyberTrellis = { preload: preload, apply: apply, ready: ready, FILES: FILES, YAW: YAW, DEFAULT_YAW: Math.PI };
  preload();
})();
