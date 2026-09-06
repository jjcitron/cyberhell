/* ===========================================================================
   cyber-enemies.js — the 15 Cyberhell monsters.

   Classic script (no modules, no build step). Exposes:

     window.CyberEnemies.build(typeId, ent, THREE) -> THREE.Group
     window.CyberEnemies.animate(enemy, timeSeconds, delta)
     window.CyberEnemies.stats(typeId) -> { hp, speed, attack, range, cooldown, damage, scale, fly? }
     window.CyberEnemies.flash(group)

   Geometry only, no textures — the same toolkit shape as Clash of Steel's
   Costume.js: cached geometries, tiny box/cyl/sph/cone helpers, everything
   parented into named pivot groups so the animator never has to search.

   Budget per enemy: <= 80 meshes, <= 3500 triangles.

   Detail toolkit beyond box/cyl/cone/sph/tor:
     oct(w,h,d,m)        chamfered box (octagonal prism), 32 tris
     taper(wT,wB,h,m)    chamfered tapered prism — plates, pauldrons, brakes
     vgrad(mesh,top,bot) vertex-colour gradient, dark base -> lit top.
                         Never on an E() accent: flash() mutates those.
     cable(parent,o,A.sway)  segmented cable that sways

   State animation (see the pose layer): the AI writes enemy.state /
   attackT / flinchT / deathT and animate() poses the rig. A builder only
   picks its flavours with A.pose = { attack, death, attackDur, deathDur }
   (POSES has a per-type default) and may add A.attackFn(w, s, k, parts, A)
   for motion the generic pose cannot know about — a gun kick, a rotor
   flare, a muzzle glow. Anything the pose stack rotates must be listed in
   A.extraPivots if it is not a torso/head/shoulder/elbow/leg.

   Rig contract shared with the engine's walk cycle (index.html
   updateEnemies): a humanoid's group.userData.limbs is
   { leftLeg, rightLeg, leftArm, rightArm }, each a pivot Group whose
   userData.lower is the knee/elbow pivot below it. The engine rotates
   those on .x while chasing; everything else is driven by animate() here.
   =========================================================================== */
(function () {
  'use strict';

  var T = null; // THREE, captured on the first build() call

  // ---------------------------------------------------------------------
  // toolkit
  // ---------------------------------------------------------------------

  var geoCache = new Map();
  var matCache = new Map();

  function geo(key, make) {
    var g = geoCache.get(key);
    if (!g) { g = make(); geoCache.set(key, g); }
    return g;
  }

  // ---------------------------------------------------------------------
  // look parameterisation (the enemy editor)
  //
  // Builders keep their hard-coded colours. During buildMesh() the material
  // factories below give every distinct (kind, colour) pair a slot name
  // (metal1, flesh2, glow1 ...); a `look` may recolour a slot, hide the meshes
  // wearing it, scale the whole rig, or scale emissive intensity. With no look
  // active (the engine's own build()) the factories behave exactly as before,
  // so the 15 stock rigs are byte-identical.
  //
  // ponytail: slots come from materials, not hand-named parts — two parts
  // sharing a colour share a slot. Hand-name per type if that ever bites.
  // ---------------------------------------------------------------------
  var curLook = null;     // look active for the build in progress, or null
  var curSlots = null;    // { byKey, list } collected during that build
  var slotSeq = null;     // per-kind counter
  var slotOfMat = new WeakMap();

  function slotFor(kind, color) {
    if (!curSlots) return null;
    var key = kind + ':' + color;
    var name = curSlots.byKey[key];
    if (!name) {
      slotSeq[kind] = (slotSeq[kind] || 0) + 1;
      name = kind + slotSeq[kind];
      curSlots.byKey[key] = name;
      curSlots.list.push({ name: name, kind: kind, hex: color });
    }
    return name;
  }

  /** '#ff8800' | '0xff8800' | 0xff8800 -> 0xff8800 */
  function hexOf(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'number') return v;
    var n = parseInt(String(v).replace('#', '').replace(/^0x/i, ''), 16);
    return isNaN(n) ? fallback : n;
  }

  /** Slot assignment + colour override for one material request. */
  function look1(kind, color) {
    var slot = slotFor(kind, color);
    if (slot && curLook && curLook.colors && curLook.colors[slot] !== undefined) {
      color = hexOf(curLook.colors[slot], color);
    }
    return { color: color, slot: slot };
  }

  /** Shared structural material. Never mutated, so it is safe to cache. */
  function Mk(kind, color, metalness, roughness, opts) {
    var lk = look1(kind, color);
    color = lk.color;
    metalness = metalness === undefined ? 0.1 : metalness;
    roughness = roughness === undefined ? 0.7 : roughness;
    opts = opts || {};
    var key = color + '|' + metalness + '|' + roughness + '|' + JSON.stringify(opts);
    var m = matCache.get(key);
    if (!m) {
      var def = { color: color, metalness: metalness, roughness: roughness };
      for (var k in opts) def[k] = opts[k];
      m = new T.MeshStandardMaterial(def);
      matCache.set(key, m);
    }
    if (lk.slot) slotOfMat.set(m, lk.slot);
    return m;
  }
  function M(color, metalness, roughness, opts) { return Mk('mat', color, metalness, roughness, opts); }

  // No environment map in this engine, so high metalness renders near-black.
  var metal = function (c) { return Mk('metal', c, 0.55, 0.38); };
  var rough = function (c) { return Mk('rough', c, 0.05, 0.85); };
  var flesh = function (c) { return Mk('flesh', c, 0.0, 0.72); };
  var rubber = function (c) { return Mk('rubber', c, 0.1, 0.95); };

  // Emissive accents are per-enemy clones (never cached) because flash()
  // mutates them — a shared material would flash every enemy on screen.
  var buildAccents = null; // collector, set for the duration of one build()

  function E(color, intensity, opts) {
    opts = opts || {};
    var lk = look1('glow', color);
    color = lk.color;
    var inten = intensity === undefined ? 1.6 : intensity;
    if (curLook && curLook.emissive) inten *= (Number(curLook.emissive) || 1);
    var def = {
      color: 0x101010, emissive: color,
      emissiveIntensity: inten,
      metalness: 0.0, roughness: 0.5
    };
    for (var k in opts) def[k] = opts[k];
    var m = new T.MeshStandardMaterial(def);
    if (lk.slot) slotOfMat.set(m, lk.slot);
    if (buildAccents) buildAccents.push({ m: m, hex: color, base: def.emissiveIntensity });
    return m;
  }

  function mesh(g, m, noShadow) {
    var o = new T.Mesh(g, m);
    if (!noShadow) { o.castShadow = true; o.receiveShadow = true; }
    if (curSlots) { var sl = slotOfMat.get(m); if (sl) o.userData.lookSlot = sl; }
    return o;
  }
  function box(w, h, d, m, ns) {
    return mesh(geo('b' + w + ',' + h + ',' + d, function () { return new T.BoxGeometry(w, h, d); }), m, ns);
  }
  function cyl(rt, rb, h, m, s, ns) {
    s = s || 8;
    return mesh(geo('c' + rt + ',' + rb + ',' + h + ',' + s, function () { return new T.CylinderGeometry(rt, rb, h, s); }), m, ns);
  }
  function cone(r, h, m, s, ns) {
    s = s || 8;
    return mesh(geo('n' + r + ',' + h + ',' + s, function () { return new T.ConeGeometry(r, h, s); }), m, ns);
  }
  function sph(r, m, ws, hs, ns) {
    ws = ws || 8; hs = hs || 6;
    return mesh(geo('s' + r + ',' + ws + ',' + hs, function () { return new T.SphereGeometry(r, ws, hs); }), m, ns);
  }
  function tor(r, t, m, rs, ts, ns) {
    rs = rs || 4; ts = ts || 10;
    return mesh(geo('t' + r + ',' + t + ',' + rs + ',' + ts, function () { return new T.TorusGeometry(r, t, rs, ts); }), m, ns);
  }

  /** Chamfered box: an octagonal prism, flats facing +/-X and +/-Z.
      Drop-in for box() wherever a bevelled silhouette matters (heads,
      shoulders, weapon bodies). 32 tris against box()'s 12. */
  // Corners are cut inside the w*h*d box, so an oct() is a drop-in for a
  // box() of the same size: the silhouette never grows.
  function oct(w, h, d, m, ns) {
    var o = mesh(geo('oct8', function () {
      return new T.CylinderGeometry(0.5, 0.5, 1, 8);
    }), m, ns);
    o.scale.set(w, h, d);
    return o;
  }

  /** Tapered chamfered prism — plate armour, pauldrons, muzzle brakes. */
  function taper(wTop, wBot, h, m, ns) {
    return mesh(geo('tap' + wTop + ',' + wBot + ',' + h, function () {
      return new T.CylinderGeometry(wTop / 2, wBot / 2, h, 8);
    }), m, ns);
  }

  /** Vertex-colour gradient over a mesh: dark at its base, lit at its top.
      Gives forms depth with no texture and no extra draw call.
      Never call it on an E() accent — flash() mutates those materials and
      this swaps in a shared clone. */
  var vgradMats = new Map();
  function vgrad(o, topHex, botHex) {
    // A gradient bakes its two colours into a vertex attribute and whites out
    // the material, so the material's own slot cannot recolour it. Give the
    // gradient its own slots and let the top one own the mesh.
    var lt = look1('grad', topHex), lb = look1('grad', botHex);
    topHex = lt.color; botHex = lb.color;
    if (lt.slot) o.userData.lookSlot = lt.slot;
    if (lb.slot) o.userData.lookSlotAlso = lb.slot;
    var src = o.material;
    var vm = vgradMats.get(src.uuid);
    if (!vm) {
      vm = src.clone();
      vm.color.setHex(0xffffff);
      vm.vertexColors = true;
      vgradMats.set(src.uuid, vm);
    }
    o.material = vm;
    var key = 'vg' + o.geometry.uuid + '|' + topHex + '|' + botHex;
    var g = geoCache.get(key);
    if (!g) {
      g = o.geometry.clone();
      g.computeBoundingBox();
      var y0 = g.boundingBox.min.y, span = Math.max(1e-6, g.boundingBox.max.y - y0);
      var pos = g.attributes.position, col = new Float32Array(pos.count * 3);
      var ct = new T.Color(topHex), cb = new T.Color(botHex), c = new T.Color();
      for (var i = 0; i < pos.count; i++) {
        c.copy(cb).lerp(ct, (pos.getY(i) - y0) / span);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      geoCache.set(key, g);
    }
    o.geometry = g;
    return o;
  }

  function add(p, o, x, y, z, rx, ry, rz) {
    o.position.set(x || 0, y || 0, z || 0);
    o.rotation.set(rx || 0, ry || 0, rz || 0);
    p.add(o);
    return o;
  }
  function grp(p, x, y, z, rx, ry, rz) {
    var g = new T.Group();
    g.position.set(x || 0, y || 0, z || 0);
    g.rotation.set(rx || 0, ry || 0, rz || 0);
    if (p) p.add(g);
    return g;
  }

  /** A run of cable: short cylinders chained through groups so it can sway. */
  function cable(parent, o, sway) {
    var m = o.mat, n = o.n || 4, len = o.len || 0.16, r = o.r || 0.035;
    var j = grp(parent, o.x || 0, o.y || 0, o.z || 0, o.tilt || 0, 0, o.roll || 0);
    var root = j;
    for (var i = 0; i < n; i++) {
      add(j, cyl(r, r, len, m, 6), 0, -len / 2, 0);
      j = grp(j, 0, -len, 0);
      if (sway && i < n - 1) sway.push({ o: j, amp: (o.amp || 0.09) * (i + 1) / n, f: o.f || 1.5, ph: i * 0.9 + (o.x || 0) * 5 });
    }
    return root;
  }

  // ---------------------------------------------------------------------
  // humanoid rig — torso, head, two arms, two legs, engine-compatible limbs
  // ---------------------------------------------------------------------
  //
  // o: { hipY, torsoW/H/D, torsoMat, headY, headSize, headMat,
  //      shoulderW, upper, fore, armMat, handMat,
  //      thigh, shin, legMat, legR, footMat, armZ }

  function humanoid(root, o) {
    var p = {};
    var hipY = o.hipY, tW = o.torsoW, tH = o.torsoH, tD = o.torsoD;

    p.torso = grp(root, 0, hipY, 0);
    var chest = add(p.torso, o.torsoOct ? oct(tW, tH, tD, o.torsoMat) : box(tW, tH, tD, o.torsoMat), 0, tH / 2, 0);
    if (o.torsoGrad) vgrad(chest, o.torsoGrad[0], o.torsoGrad[1]);
    p.chest = chest;
    // pelvis
    add(p.torso, box(tW * 0.86, 0.16, tD * 0.92, o.legMat || o.torsoMat), 0, 0.02, 0);

    if (o.headSize) {
      p.neck = add(p.torso, cyl(tD * 0.2, tD * 0.22, 0.1, o.armMat || o.torsoMat, 6), 0, tH + 0.04, 0);
      p.head = grp(p.torso, 0, tH + 0.09 + o.headSize / 2, 0);
      var skull = add(p.head, oct(o.headSize, o.headSize, o.headSize * 0.9, o.headMat || o.torsoMat), 0, 0, 0);
      if (o.headGrad) vgrad(skull, o.headGrad[0], o.headGrad[1]);
      p.skull = skull;
    }

    var limbs = {};
    var sw = o.shoulderW, uA = o.upper, fA = o.fore, aR = o.armR || 0.075;
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      var sh = grp(p.torso, sgn * sw, tH - 0.08, o.armZ || 0);
      add(sh, cyl(aR * 1.35, aR * 1.15, uA, o.armMat, 6), 0, -uA / 2, 0);
      var el = grp(sh, 0, -uA, 0);
      add(el, cyl(aR * 1.05, aR * 0.9, fA, o.armMat, 6), 0, -fA / 2, 0);
      var hand = add(el, box(aR * 2.2, aR * 2.0, aR * 2.4, o.handMat || o.armMat), 0, -fA - aR * 0.8, 0);
      sh.userData.lower = el;
      el.userData.hand = hand;
      limbs[side + 'Arm'] = sh;
      p[side + 'Hand'] = hand;
      p[side + 'Elbow'] = el;
      p[side + 'Shoulder'] = sh;
    });

    var th = o.thigh, sn = o.shin, lR = o.legR || 0.1;
    if (th) {
      ['left', 'right'].forEach(function (side) {
        var sgn = side === 'left' ? -1 : 1;
        var hp = grp(root, sgn * (tW * 0.26), hipY, 0);
        add(hp, cyl(lR * 1.2, lR, th, o.legMat, 6), 0, -th / 2, 0);
        var kn = grp(hp, 0, -th, 0);
        add(kn, cyl(lR * 0.95, lR * 0.8, sn, o.legMat, 6), 0, -sn / 2, 0);
        add(kn, box(lR * 2.1, 0.09, lR * 3.2, o.footMat || o.legMat), 0, -sn - 0.04, -lR * 0.6);
        hp.userData.lower = kn;
        limbs[side + 'Leg'] = hp;
        p[side + 'Hip'] = hp;
      });
    }

    p.limbs = limbs.leftLeg ? limbs : null;
    return p;
  }

  /** Two glowing eyes on the -Z face. Returns the mesh array. */
  function eyes(parent, o) {
    var m = o.mat, s = o.size || 0.07, dx = o.dx || 0.1;
    var l = add(parent, box(s, s * (o.tall || 0.7), s * 0.5, m, true), -dx, o.y || 0, o.z);
    var r = add(parent, box(s, s * (o.tall || 0.7), s * 0.5, m, true), dx, o.y || 0, o.z);
    return [l, r];
  }

  /** Row of teeth across a jaw or mouth slot. */
  function teeth(parent, o) {
    var n = o.n || 5, w = o.w || 0.32, m = o.mat, h = o.h || 0.06;
    for (var i = 0; i < n; i++) {
      add(parent, cone(w / n * 0.42, h, m, 4), -w / 2 + (i + 0.5) * (w / n), o.y || 0, o.z || 0,
        o.down ? Math.PI : 0);
    }
  }

  // ---------------------------------------------------------------------
  // per-enemy builders
  // ---------------------------------------------------------------------
  //
  // Every builder gets (root, A) where A is the animation manifest that
  // animate() reads back off group.userData.anim:
  //   A.bob    [{ o, amp, f, ph, y0 }]      vertical float
  //   A.sway   [{ o, amp, f, ph }]          cable / limb wobble on .rotation.z
  //   A.spin   [{ o, axis, rate }]          rotors, treads, coils
  //   A.pulse  [{ m, base, amp, f, ph }]    emissive breathing
  //   A.blink  [{ o }]                      eyes that shut on a beat
  //   A.flame  [{ o, s0 }]                  flicker scale + emissive jitter
  //   A.jaw    { o, closed, open }          opens when the enemy is on you
  //   A.slide  [{ o, amp, f, ph, y0 }]      Cyberdemon's intertwined legs

  var BUILDERS = {};

  // --- 1. Zombieman (3004): man shape, green with red eyes -------------
  BUILDERS[3004] = function (root, A) {
    var skin = flesh(0x4c8a3f), trous = rough(0x22301c), vest = M(0x39474d, 0.5, 0.55);
    var red = E(0xff1a1a, 2.2);
    var p = humanoid(root, {
      hipY: 0.80, torsoW: 0.46, torsoH: 0.56, torsoD: 0.30, torsoMat: skin,
      headSize: 0.30, headMat: skin, shoulderW: 0.30, upper: 0.32, fore: 0.30,
      armMat: skin, handMat: rough(0x2c2c2c), thigh: 0.42, shin: 0.38,
      legMat: trous, footMat: rough(0x151515), legR: 0.09,
      torsoGrad: [0x63a552, 0x24401d], headGrad: [0x5f9e50, 0x2c4a24]
    });
    // flak vest with a torn shoulder and an exposed neural cable
    vgrad(add(p.torso, oct(0.50, 0.34, 0.34, vest), 0, 0.40, 0), 0x6f818a, 0x1c262b);
    add(p.torso, box(0.14, 0.10, 0.34, metal(0x6b7a80)), -0.24, 0.52, 0);
    add(p.torso, box(0.22, 0.05, 0.03, E(0x00e5ff, 1.4), true), 0.10, 0.30, -0.16);
    cable(p.torso, { mat: rubber(0x101418), x: 0.16, y: 0.56, z: -0.10, n: 3, len: 0.09, r: 0.022, tilt: 0.4 }, A.sway);
    // face: sunken red eyes, slack jaw, a graft plate over one cheek
    A.eyeMeshes = eyes(p.head, { mat: red, y: 0.03, z: -0.145, dx: 0.075, size: 0.075, tall: 0.75 });
    add(p.head, box(0.18, 0.06, 0.04, rough(0x140a0a), true), 0, -0.09, -0.14);
    add(p.head, box(0.10, 0.16, 0.03, metal(0x8a949a)), -0.11, -0.02, -0.145);
    add(p.head, box(0.26, 0.08, 0.26, rough(0x1e3318)), 0, 0.13, 0.01);
    // shoulder actuators, spine plating up the back, battle damage
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      add(p.torso, cyl(0.055, 0.055, 0.13, metal(0x6b7a80), 6), sgn * 0.27, 0.46, 0, 0, 0, Math.PI / 2);
      add(p[side + 'Shoulder'], cyl(0.018, 0.018, 0.15, metal(0x8a949a), 5), sgn * 0.055, -0.11, 0.05, 0.35);
    });
    for (var v = 0; v < 4; v++) add(p.torso, box(0.09, 0.045, 0.035, metal(0x5e6a70)), 0, 0.20 + v * 0.10, 0.145);
    add(p.torso, box(0.15, 0.19, 0.02, rough(0x2a1410), true), 0.18, 0.33, -0.18, 0, 0, 0.28);
    add(p.torso, box(0.11, 0.13, 0.03, metal(0x7d878c)), -0.17, 0.24, -0.17, 0, 0, -0.20);
    // slack jaw, a few teeth left in it
    var jaw = grp(p.head, 0, -0.09, -0.05, 0.28, 0, 0);
    add(jaw, box(0.16, 0.07, 0.15, skin), 0, -0.04, -0.05);
    teeth(jaw, { n: 4, w: 0.13, mat: rough(0xcfc9b4), h: 0.04, y: 0.01, z: -0.10 });
    // sidearm, raised and kicked by attackFn
    var gun = grp(p.rightElbow, 0, -0.34, -0.09);
    add(gun, oct(0.07, 0.13, 0.22, metal(0x1b1b1b)), 0, 0, 0);
    add(gun, cyl(0.017, 0.017, 0.10, metal(0x0c0e10), 6), 0, 0.03, -0.06, Math.PI / 2);
    add(gun, box(0.05, 0.02, 0.04, E(0x00e5ff, 1.4), true), 0, 0.08, 0.02);
    var zflash = add(gun, cone(0.055, 0.17, E(0xffab3d, 1.9), 5, true), 0, 0.03, -0.28, -Math.PI / 2);
    zflash.visible = false;
    A.extraPivots = [gun];
    A.attackFn = function (w, s) {
      addRot(gun, -0.55 * w + 0.40 * s, 0, 0);
      zflash.visible = s > 0.5;
      zflash.scale.set(0.7 + s * 0.7, 0.6 + s * 0.8, 0.7 + s * 0.7);
      zflash.rotation.z = s * 9.1;
    };
    A.blink.push({ o: A.eyeMeshes[0] }, { o: A.eyeMeshes[1] });
    return p;
  };

  // --- 2. Shotgun Guy (9): brown, holding a shotgun --------------------
  BUILDERS[9] = function (root, A) {
    var coat = rough(0x6d4c33), tan = rough(0x9a7a4e), plate = M(0x4a3a28, 0.6, 0.5);
    var amber = E(0xff8c1a, 2.0);
    var p = humanoid(root, {
      hipY: 0.80, torsoW: 0.50, torsoH: 0.56, torsoD: 0.32, torsoMat: coat,
      headSize: 0.30, headMat: tan, shoulderW: 0.32, upper: 0.32, fore: 0.30,
      armMat: coat, handMat: rough(0x2a2118), thigh: 0.42, shin: 0.38,
      legMat: rough(0x4b3524), footMat: rough(0x191410), legR: 0.095,
      torsoGrad: [0x8b6444, 0x2d1f14], headGrad: [0xc09a63, 0x503c22]
    });
    // bandolier of shells across the chest
    vgrad(add(p.torso, oct(0.52, 0.30, 0.36, plate), 0, 0.40, 0), 0x6b5539, 0x1e160e);
    for (var i = 0; i < 5; i++) {
      add(p.torso, cyl(0.028, 0.028, 0.07, E(0xff3b1f, 1.1), 6), -0.20 + i * 0.10, 0.52 - i * 0.045, -0.19, Math.PI / 2);
    }
    // leather loops holding the bandolier, and a scuffed shoulder cop
    add(p.torso, box(0.54, 0.03, 0.03, rough(0x36251a)), 0, 0.50, -0.20, 0, 0, 0.42);
    add(p.torso, box(0.54, 0.03, 0.03, rough(0x36251a)), 0, 0.34, -0.20, 0, 0, 0.42);
    vgrad(add(p.leftShoulder, taper(0.14, 0.18, 0.14, plate), 0, 0.02, 0), 0x8a6d48, 0x2b2116);
    add(p.torso, box(0.13, 0.15, 0.02, rough(0x2b1a10), true), -0.20, 0.30, -0.19, 0, 0, 0.2);
    // helmet + visor band instead of eyes
    vgrad(add(p.head, oct(0.34, 0.14, 0.34, plate), 0, 0.14, 0), 0x8d6f4a, 0x2b2116);
    add(p.head, box(0.32, 0.10, 0.02, rough(0x0b0a08), true), 0, 0.01, -0.155);
    add(p.head, box(0.30, 0.06, 0.03, amber, true), 0, 0.01, -0.16);
    add(p.head, cyl(0.03, 0.03, 0.09, metal(0x6f6255), 6), 0.17, 0.10, 0, 0, 0, Math.PI / 2);
    add(p.head, box(0.20, 0.07, 0.05, rough(0x241a12), true), 0, -0.10, -0.14);
    A.pulse.push({ m: amber, base: 2.0, amp: 0.7, f: 1.1, ph: 0 });
    // shotgun held two-handed, barrels forward
    var gun = grp(p.torso, 0.08, 0.19, -0.44, 0.10, 0, 0);
    add(gun, box(0.075, 0.075, 0.62, metal(0x22262a)), 0, 0.04, -0.10);
    add(gun, cyl(0.032, 0.032, 0.56, metal(0x0d0f11), 8), -0.035, 0.10, -0.14, Math.PI / 2);
    add(gun, cyl(0.032, 0.032, 0.56, metal(0x0d0f11), 8), 0.035, 0.10, -0.14, Math.PI / 2);
    add(gun, box(0.07, 0.16, 0.16, rough(0x3a2413)), 0, -0.04, 0.22, -0.3);
    add(gun, box(0.05, 0.03, 0.10, E(0x00e5ff, 1.2), true), 0, 0.12, 0.06);
    // pump, top rail and a bead sight
    var pump = add(gun, oct(0.10, 0.08, 0.16, rough(0x2e2620)), 0, 0.07, -0.20);
    add(gun, box(0.03, 0.02, 0.34, metal(0x555f66)), 0, 0.15, -0.02);
    add(gun, sph(0.014, E(0xff8c1a, 2.4), 6, 4, true), 0, 0.17, -0.38);
    add(gun, cyl(0.012, 0.012, 0.12, metal(0x9aa3a8), 5), 0, 0.10, 0.10, Math.PI / 2);
    var sflash = add(gun, cone(0.10, 0.26, E(0xffa02a, 2.0), 6, true), 0, 0.10, -0.50, -Math.PI / 2);
    sflash.visible = false;
    p.leftShoulder.rotation.set(0.95, 0, 0.42);
    p.rightShoulder.rotation.set(1.15, 0, -0.34);
    A.extraPivots = [gun];
    A.attackFn = function (w, s) {
      addRot(gun, -0.12 * w + 0.26 * s, 0, 0);
      pump.position.z = -0.20 + Math.max(0, s - 0.3) * 0.16;
      sflash.visible = s > 0.45;
      sflash.scale.set(0.8 + s * 0.5, 0.7 + s * 0.9, 0.8 + s * 0.5);
      sflash.rotation.z = s * 5.3;
    };
    p.gun = gun;
    return p;
  };

  // --- 3. Chaingunner (65): wide, stout, two big barrel guns -----------
  BUILDERS[65] = function (root, A) {
    var armor = M(0x40464a, 0.4, 0.5), dark = M(0x22282c, 0.4, 0.45), skin = flesh(0x8a6a52);
    var cy = E(0x00e5ff, 1.8), red = E(0xff2a2a, 2.0);
    var p = humanoid(root, {
      hipY: 0.68, torsoW: 0.92, torsoH: 0.60, torsoD: 0.52, torsoMat: armor,
      headSize: 0.34, headMat: skin, shoulderW: 0.52, upper: 0.26, fore: 0.22,
      armMat: dark, handMat: dark, thigh: 0.34, shin: 0.32,
      legMat: dark, footMat: rough(0x111416), legR: 0.13,
      torsoGrad: [0x5c666c, 0x1b2124], headGrad: [0xa07c60, 0x3f2f24]
    });
    // slab chest, ammo hoppers on the back, ribbed belly
    vgrad(add(p.torso, oct(1.00, 0.30, 0.56, dark), 0, 0.46, 0), 0x39434a, 0x10161a);
    vgrad(add(p.torso, oct(0.30, 0.42, 0.24, metal(0x585f64)), -0.34, 0.34, 0.30), 0x79848a, 0x272e32);
    vgrad(add(p.torso, oct(0.30, 0.42, 0.24, metal(0x585f64)), 0.34, 0.34, 0.30), 0x79848a, 0x272e32);
    for (var i = 0; i < 3; i++) add(p.torso, box(0.62, 0.05, 0.04, cy, true), 0, 0.14 + i * 0.09, -0.27);
    // hip and shoulder actuators, chest status strips
    [-1, 1].forEach(function (sgn) {
      add(p.torso, cyl(0.07, 0.07, 0.16, metal(0x6d777c), 6), sgn * 0.46, 0.44, 0, 0, 0, Math.PI / 2);
      add(p.torso, cyl(0.05, 0.05, 0.20, metal(0x8a949a), 5), sgn * 0.26, 0.02, 0.18, 0.5);
      add(p.torso, box(0.16, 0.03, 0.03, cy, true), sgn * 0.40, 0.60, 0.16);
    });
    // squat helmeted head with one red targeting lens
    vgrad(add(p.head, oct(0.42, 0.16, 0.40, armor), 0, 0.13, 0), 0x5b6367, 0x1d2225);
    add(p.head, box(0.34, 0.07, 0.03, rough(0x0a0c0d), true), 0, 0.0, -0.18);
    var lens = add(p.head, sph(0.055, red, 8, 6, true), 0.09, 0.0, -0.20);
    A.pulse.push({ m: red, base: 2.0, amp: 1.1, f: 2.6, ph: 0 });
    // two rotary cannons, one per hand: hub + 4 barrels, hub spins
    var hubs = [], flashes = [];
    ['left', 'right'].forEach(function (side, k) {
      var sgn = side === 'left' ? -1 : 1;
      var arm = p[side + 'Shoulder'];
      arm.rotation.set(1.35, 0, sgn * 0.12);
      // Net pitch is shoulder + hub, so the hub cancels the shoulder's 1.35
      // and leaves the barrels level, tipped 12 degrees up.
      var hub = grp(p[side + 'Elbow'], 0, -0.30, -0.10, -2.70, 0, 0);
      add(hub, cyl(0.15, 0.15, 0.16, metal(0x2c3134), 10), 0, 0.10, 0);
      for (var b = 0; b < 4; b++) {
        var a = b / 4 * Math.PI * 2;
        add(hub, cyl(0.038, 0.038, 0.62, metal(0x0b0d0e), 6), Math.cos(a) * 0.085, 0.34, Math.sin(a) * 0.085);
      }
      add(hub, cyl(0.16, 0.13, 0.10, metal(0x6a7276), 10), 0, -0.02, 0);
      add(hub, tor(0.115, 0.02, cy, 4, 10, true), 0, 0.62, 0, Math.PI / 2);
      // muzzle brake, and a belt of rounds feeding out of the back hopper
      add(hub, taper(0.20, 0.30, 0.09, metal(0x4d565b)), 0, 0.60, 0);
      cable(p.torso, { mat: rubber(0x2a2216), x: sgn * 0.30, y: 0.30, z: 0.12, n: 4, len: 0.12, r: 0.032, tilt: -0.5, roll: sgn * 0.4 }, A.sway);
      hubs.push(hub);
      var fl = add(hub, cone(0.09, 0.26, E(0xffa02a, 2.0), 6, true), 0, 0.82, 0);
      fl.visible = false;
      flashes.push(fl);
      A.spin.push({ o: hub, axis: 'y', rate: 1.4 + k * 0.3, base: 1.4 + k * 0.3 });
    });
    A.extraPivots = hubs;
    A.attackFn = function (w, s, k, pp) {
      addRot(pp.leftShoulder, -0.14 * w - 0.10 * s, 0, 0);
      addRot(pp.rightShoulder, -0.14 * w - 0.10 * s, 0, 0);
      for (var i = 0; i < hubs.length; i++) {
        addRot(hubs[i], 0.10 * s, 0, 0);
        hubs[i].position.z = hubs[i].userData.p0.z + s * 0.07;
        flashes[i].visible = s > (i ? 0.35 : 0.45);
        flashes[i].scale.setScalar(0.7 + s * 0.8);
      }
      // barrels wind up hard and stay hot through the burst
      for (var j = 0; j < A.spin.length; j++) {
        if (A.spin[j].base) A.spin[j].rate = A.spin[j].base * (1 + w * 6 + s * 9);
      }
    };
    return p;
  };

  // --- 4. Imp (3001): reddish brown, tall, skinny, long arms -----------
  BUILDERS[3001] = function (root, A) {
    var hide = flesh(0x8a4b32), dark = flesh(0x5a2e1d), horn = rough(0x2b1a12);
    var org = E(0xff6a00, 2.0), ylw = E(0xffd21a, 2.2);
    var p = humanoid(root, {
      hipY: 0.92, torsoW: 0.38, torsoH: 0.62, torsoD: 0.26, torsoMat: hide,
      headSize: 0.28, headMat: hide, shoulderW: 0.26, upper: 0.52, fore: 0.50,
      armMat: dark, handMat: dark, armR: 0.055, thigh: 0.50, shin: 0.44,
      legMat: dark, footMat: horn, legR: 0.07,
      torsoGrad: [0xa85e3c, 0x3d2013], headGrad: [0xa85e3c, 0x421f12]
    });
    // ribs and a glowing furnace in the chest
    for (var i = 0; i < 4; i++) add(p.torso, box(0.40 - i * 0.02, 0.035, 0.28, dark), 0, 0.16 + i * 0.11, 0);
    var core = add(p.torso, sph(0.10, org, 8, 6, true), 0, 0.34, -0.13);
    // furnace vents cut into the belly, and a spine of small plates
    for (var vv = 0; vv < 3; vv++) {
      add(p.torso, box(0.16, 0.022, 0.03, org, true), 0, 0.14 + vv * 0.06, -0.12);
      add(p.torso, box(0.10, 0.05, 0.04, horn), 0, 0.24 + vv * 0.13, 0.12);
    }
    add(p.torso, box(0.30, 0.05, 0.03, org, true), 0, 0.52, -0.14);
    // long clawed hands
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      var el = p[side + 'Elbow'];
      p[side + 'Shoulder'].rotation.set(0.35, 0, sgn * 0.30);
      el.rotation.set(0.55, 0, 0);
      for (var c = -1; c <= 1; c++) {
        add(el, cone(0.022, 0.16, horn, 4), c * 0.05, -0.60, -0.03, Math.PI * 0.92);
      }
      // elbow spur, forearm ridge, shoulder spike
      add(el, cone(0.035, 0.13, horn, 4), 0, 0.02, 0.05, -1.9);
      add(el, box(0.03, 0.34, 0.03, horn), sgn * 0.045, -0.26, 0.02);
      add(p[side + 'Shoulder'], cone(0.05, 0.16, horn, 5), sgn * 0.06, 0.04, 0, 0, 0, sgn * 0.7);
      add(p[side + 'Hip'], cone(0.04, 0.12, horn, 4), sgn * 0.05, -0.46, -0.02, -0.6);
    });
    // long snouted head, yellow eyes, horns
    add(p.head, box(0.18, 0.12, 0.16, dark), 0, -0.05, -0.16);
    teeth(p.head, { n: 4, w: 0.16, mat: rough(0xdedac8), h: 0.05, y: -0.08, z: -0.22 });
    A.eyeMeshes = eyes(p.head, { mat: ylw, y: 0.05, z: -0.13, dx: 0.075, size: 0.075, tall: 0.6 });
    add(p.head, cone(0.045, 0.24, horn, 5), -0.11, 0.20, 0.02, -0.35);
    add(p.head, cone(0.045, 0.24, horn, 5), 0.11, 0.20, 0.02, -0.35);
    // ridge of small horns down the skull, and a scorched cheek plate
    for (var hr = 0; hr < 3; hr++) add(p.head, cone(0.022, 0.09, horn, 4), 0, 0.14 - hr * 0.02, 0.06 - hr * 0.06, -0.5);
    add(p.head, box(0.09, 0.11, 0.02, rough(0x3a1c10), true), 0.10, -0.02, -0.145);
    A.pulse.push({ m: org, base: 2.0, amp: 0.8, f: 1.7, ph: 0.5 });
    // the furnace winds up before it throws
    A.attackFn = function (w, s) {
      var g2 = 1 + w * 0.9 + s * 0.3;
      core.scale.setScalar(g2);
      core.material.emissiveIntensity = 2.0 + w * 3.4 + s * 1.2;
    };
    A.blink.push({ o: A.eyeMeshes[0] }, { o: A.eyeMeshes[1] });
    return p;
  };

  // --- 5. Demon / Pinky (3002): no head, face in chest, gorilla arms ---
  BUILDERS[3002] = function (root, A) {
    var pink = flesh(0xe0537d), deep = flesh(0x9c2f52), gum = flesh(0x6d1030);
    var ylw = E(0xffe11a, 2.4);
    var p = humanoid(root, {
      hipY: 0.62, torsoW: 0.84, torsoH: 0.78, torsoD: 0.62, torsoMat: pink,
      headSize: 0, shoulderW: 0.52, upper: 0.52, fore: 0.50,
      armMat: deep, handMat: deep, armR: 0.13, thigh: 0.30, shin: 0.30,
      legMat: deep, footMat: rough(0x3a1020), legR: 0.15,
      torsoGrad: [0xf2749a, 0x64152f]
    });
    // hunched shoulder hump where the head should be
    var hump = add(p.torso, sph(0.34, deep, 10, 7), 0, 0.70, 0.10);
    hump.scale.set(1.45, 0.42, 1.0); // a shoulder ridge, deliberately not a head
    vgrad(add(p.torso, oct(0.22, 0.14, 0.26, deep), -0.36, 0.68, 0.02), 0xb84266, 0x4c1026);
    vgrad(add(p.torso, oct(0.22, 0.14, 0.26, deep), 0.36, 0.68, 0.02), 0xb84266, 0x4c1026);
    // scar plating over the shoulders and a ridge of spines down the back
    [-1, 1].forEach(function (sg) {
      vgrad(add(p.torso, taper(0.26, 0.34, 0.10, gum), sg * 0.30, 0.62, 0.04, 0, 0, sg * 0.3), 0xa03050, 0x40101f);
      add(p.torso, box(0.13, 0.02, 0.19, rough(0x741430), true), sg * 0.24, 0.52, 0.06, 0, 0, sg * 0.35);
    });
    for (var sp = 0; sp < 4; sp++) add(p.torso, cone(0.045, 0.15, gum, 4), 0, 0.30 + sp * 0.13, 0.28, -0.35);
    // the face: two eyes high on the chest, hinged jaw below
    A.eyeMeshes = eyes(p.torso, { mat: ylw, y: 0.58, z: -0.32, dx: 0.16, size: 0.11, tall: 0.8 });
    add(p.torso, box(0.44, 0.06, 0.05, gum, true), 0, 0.44, -0.31);
    var mouth = grp(p.torso, 0, 0.42, -0.28);
    add(mouth, box(0.46, 0.26, 0.10, gum, true), 0, -0.13, 0.0);
    teeth(mouth, { n: 6, w: 0.42, mat: rough(0xf0ead6), h: 0.09, y: -0.03, z: -0.05, down: true });
    var jaw = grp(p.torso, 0, 0.28, -0.28);
    add(jaw, box(0.46, 0.16, 0.20, deep), 0, -0.08, 0.06);
    teeth(jaw, { n: 6, w: 0.42, mat: rough(0xf0ead6), h: 0.09, y: -0.02, z: -0.02 });
    A.jaw = { o: jaw, closed: 0, open: 0.55 };
    // upper gums and two tusks that clear the lower jaw
    add(p.torso, cone(0.05, 0.20, rough(0xf0ead6), 4), -0.16, 0.34, -0.30, Math.PI);
    add(p.torso, cone(0.05, 0.20, rough(0xf0ead6), 4), 0.16, 0.34, -0.30, Math.PI);
    // gorilla arms: knuckles on the floor, spiked
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      p[side + 'Shoulder'].rotation.set(0.10, 0, sgn * 0.10);
      var knu = add(p[side + 'Elbow'], sph(0.18, deep, 8, 6), 0, -0.58, 0);
      knu.scale.set(1, 0.9, 1.1);
      for (var kb = -1; kb <= 1; kb++) add(p[side + 'Elbow'], cone(0.03, 0.11, rough(0x3a1020), 4), kb * 0.07, -0.70, -0.06, 2.4);
      add(p[side + 'Elbow'], cyl(0.05, 0.05, 0.14, gum, 6), 0, 0.0, 0, 0, 0, Math.PI / 2);
    });
    A.pulse.push({ m: ylw, base: 2.4, amp: 0.6, f: 2.0, ph: 0 });
    A.extraPivots = [hump];
    A.attackFn = function (w, s, k, pp) {
      addRot(hump, -0.25 * w + 0.45 * s, 0, 0);
      hump.position.z = hump.userData.p0.z + 0.06 * w - 0.10 * s;
    };
    return p;
  };

  // --- 6. Spectre (58): semi-transparent, tall, very skinny ------------
  BUILDERS[58] = function (root, A) {
    var ghost = M(0x8fd8e6, 0.0, 0.35, { transparent: true, opacity: 0.42, depthWrite: false });
    var deep = M(0x3f8fa6, 0.0, 0.4, { transparent: true, opacity: 0.34, depthWrite: false });
    var cy = E(0x2ffcff, 2.6, { transparent: true, opacity: 0.9 });
    var p = humanoid(root, {
      hipY: 1.05, torsoW: 0.30, torsoH: 0.66, torsoD: 0.22, torsoMat: ghost,
      headSize: 0.24, headMat: ghost, shoulderW: 0.22, upper: 0.44, fore: 0.42,
      armMat: ghost, handMat: ghost, armR: 0.04
      // no legs: it floats on a tattered tail
    });
    p.torso.children.forEach(function (c) { c.castShadow = false; });
    // ribcage read-through, a spine of cyan nodes, and a shoulder lattice
    for (var i = 0; i < 5; i++) {
      add(p.torso, box(0.30 - i * 0.015, 0.02, 0.20, deep, true), 0, 0.12 + i * 0.12, 0);
      add(p.torso, sph(0.022, cy, 6, 4, true), 0, 0.14 + i * 0.12, 0.10);
      add(p.torso, box(0.02, 0.13, 0.02, deep, true), (i % 2 ? 0.13 : -0.13), 0.16 + i * 0.12, -0.02, 0, 0, (i % 2 ? 0.2 : -0.2));
    }
    // clavicle struts and long wrist claws
    [-1, 1].forEach(function (sg) {
      add(p.torso, cyl(0.016, 0.016, 0.22, deep, 5, true), sg * 0.11, 0.60, 0, 0, 0, sg * 1.2);
      var el = p[(sg < 0 ? 'left' : 'right') + 'Elbow'];
      for (var cw = -1; cw <= 1; cw++) add(el, cone(0.016, 0.20, deep, 4, true), cw * 0.035, -0.55, -0.02, Math.PI * 0.94);
    });
    // shredded tail instead of legs
    var tail = grp(root, 0, 1.05, 0);
    for (var t = 0; t < 4; t++) {
      var w = 0.20 - t * 0.03;
      add(tail, box(w, 0.30, w * 0.7, deep, true), (t % 2 ? 0.04 : -0.04), -0.15 - t * 0.26, 0);
      A.sway.push({ o: tail, amp: 0.05, f: 0.9, ph: t });
    }
    add(tail, cone(0.09, 0.34, deep, 6, true), 0, -0.98, 0, Math.PI);
    // shredded strands trailing off the tail
    for (var sd = 0; sd < 3; sd++) {
      var strand = grp(tail, (sd - 1) * 0.06, -0.86, 0.02);
      add(strand, box(0.035, 0.26, 0.03, deep, true), 0, -0.13, 0);
      A.sway.push({ o: strand, amp: 0.22, f: 1.4 + sd * 0.3, ph: sd * 1.7 });
    }
    // hollow face
    A.eyeMeshes = eyes(p.head, { mat: cy, y: 0.02, z: -0.115, dx: 0.062, size: 0.065, tall: 1.1 });
    add(p.head, box(0.14, 0.10, 0.03, M(0x06202a, 0, 0.5, { transparent: true, opacity: 0.6 }), true), 0, -0.08, -0.11);
    p.leftShoulder.rotation.set(0.2, 0, 0.25);
    p.rightShoulder.rotation.set(0.2, 0, -0.25);
    A.bob.push({ o: root, amp: 0.07, f: 0.8, ph: 0 });
    A.pulse.push({ m: cy, base: 2.6, amp: 1.4, f: 0.7, ph: 0 });
    // it sharpens as it comes in and washes out again
    A.attackFn = function (w, s) {
      cy.emissiveIntensity += w * 1.6 + s * 2.4;
      ghost.opacity = 0.42 + w * 0.30 + s * 0.22;
      deep.opacity = 0.34 + w * 0.26 + s * 0.20;
    };
    p.tail = tail;
    return p;
  };

  // --- 7. Cacodemon (3005): round flying robot, red eye, lasers --------
  BUILDERS[3005] = function (root, A) {
    var shell = M(0xa52422, 0.3, 0.5), dark = M(0x3a1211, 0.3, 0.5), rim = metal(0x6d777c);
    var red = E(0xff1f1f, 2.6), cy = E(0x00e5ff, 1.8);
    var hull = grp(root, 0, 1.50, 0);
    vgrad(add(hull, sph(0.72, shell, 12, 9), 0, 0, 0), 0xd4544f, 0x340f0e);
    // panel seams and armour plates
    add(hull, tor(0.70, 0.05, rim, 4, 14), 0, 0, 0, Math.PI / 2);
    add(hull, tor(0.66, 0.045, dark, 4, 14), 0, 0.16, 0, Math.PI / 2);
    for (var s = 0; s < 6; s++) {
      var a = s / 6 * Math.PI * 2;
      add(hull, cone(0.07, 0.22, rim, 5), Math.cos(a) * 0.60, 0.36, Math.sin(a) * 0.60, 0, 0, -Math.cos(a) * 0.5);
      // riveted armour scales around the equator, with vent slots between
      var sc = add(hull, oct(0.30, 0.10, 0.16, dark), Math.cos(a) * 0.62, -0.10, Math.sin(a) * 0.62, 0, -a, 0);
      vgrad(sc, 0x6a2321, 0x1c0908);
      add(hull, box(0.16, 0.025, 0.03, E(0xff6a00, 1.2), true), Math.cos(a) * 0.68, 0.06, Math.sin(a) * 0.68, 0, -a, 0);
    }
    // single huge lens eye with an iris ring and a brow plate
    var socket = grp(hull, 0, 0.02, -0.58);
    add(socket, cyl(0.30, 0.34, 0.16, dark, 12), 0, 0, 0, Math.PI / 2);
    add(socket, tor(0.27, 0.035, rim, 4, 14), 0, 0, -0.06, 0);
    var iris = add(socket, sph(0.22, red, 10, 8, true), 0, 0, -0.11);
    add(socket, sph(0.08, E(0xffe0e0, 3.0), 6, 5, true), 0, 0, -0.24);
    // socket shroud: four hooded plates and a lens ring
    for (var sh = 0; sh < 4; sh++) {
      var sa = sh / 4 * Math.PI * 2 + Math.PI / 4;
      add(socket, taper(0.10, 0.16, 0.12, rim), Math.cos(sa) * 0.30, Math.sin(sa) * 0.30, -0.04, Math.PI / 2, 0, -sa);
    }
    add(socket, tor(0.20, 0.022, E(0xff6a00, 1.4), 4, 12, true), 0, 0, -0.16, 0);
    add(hull, box(0.62, 0.09, 0.10, rim), 0, 0.30, -0.56, 0.35);
    // grinning vent mouth
    add(hull, box(0.46, 0.10, 0.08, E(0xff6a00, 1.6), true), 0, -0.34, -0.55, -0.3);
    teeth(hull, { n: 5, w: 0.42, mat: rim, h: 0.09, y: -0.30, z: -0.60, down: true });
    // thruster ring that spins, keeping it airborne
    var rotor = grp(hull, 0, -0.62, 0);
    for (var r = 0; r < 4; r++) {
      var ra = r / 4 * Math.PI * 2;
      add(rotor, cyl(0.10, 0.07, 0.18, rim, 8), Math.cos(ra) * 0.34, 0, Math.sin(ra) * 0.34);
      add(rotor, cyl(0.07, 0.02, 0.16, cy, 8, true), Math.cos(ra) * 0.34, -0.16, Math.sin(ra) * 0.34);
    }
    // thruster shrouds around the ring
    for (var ts = 0; ts < 4; ts++) {
      var ta = ts / 4 * Math.PI * 2;
      add(rotor, taper(0.26, 0.20, 0.10, dark), Math.cos(ta) * 0.34, 0.05, Math.sin(ta) * 0.34);
    }
    A.spin.push({ o: rotor, axis: 'y', rate: 2.2, base: 2.2 });
    A.bob.push({ o: root, amp: 0.13, f: 0.9, ph: 0 });
    A.pulse.push({ m: red, base: 2.6, amp: 1.3, f: 1.4, ph: 0 }, { m: cy, base: 1.8, amp: 0.5, f: 3.0, ph: 1 });
    A.eyeMeshes = [iris];
    // no limbs, so the whole hull does the attack: rear back, then lunge
    A.extraPivots = [hull];
    A.attackFn = function (w, s) {
      addRot(hull, 0.30 * w - 0.55 * s, 0, 0);
      hull.position.z = hull.userData.p0.z + 0.16 * w - 0.30 * s;
      iris.scale.setScalar(1 - w * 0.35 + s * 0.55);
      red.emissiveIntensity += w * 1.2 + s * 3.0;
      A.spin[0].rate = A.spin[0].base * (1 + w * 2.5 + s * 4);
    };
    return { hull: hull, rotor: rotor, socket: socket, iris: iris, limbs: null };
  };

  // --- 8/9. Hell Knight (69) and Baron of Hell (3003) ------------------

  function knight(root, A, o) {
    var plate = M(o.plate, 0.5, 0.40), under = M(o.under, 0.35, 0.55), dark = M(0x14181b, 0.3, 0.5);
    var accent = E(o.accent, 2.2);
    var p = humanoid(root, {
      hipY: 0.86, torsoW: 0.72, torsoH: 0.66, torsoD: 0.44, torsoMat: plate,
      headSize: 0.34, headMat: plate, shoulderW: 0.42, upper: 0.38, fore: 0.34,
      armMat: under, handMat: plate, armR: 0.10, thigh: 0.44, shin: 0.40,
      legMat: under, footMat: plate, legR: 0.13,
      torsoGrad: o.grad, headGrad: o.grad
    });
    // segmented cuirass, exhaust stacks, glowing chest core
    vgrad(add(p.torso, oct(0.78, 0.26, 0.48, plate), 0, 0.52, 0), o.grad[0], o.grad[1]);
    vgrad(add(p.torso, oct(0.60, 0.18, 0.46, under), 0, 0.20, 0), o.grad[0], o.grad[1]);
    var core = add(p.torso, sph(0.10, accent, 8, 6, true), 0, 0.44, -0.24);
    // layered plate seams down the cuirass and a scorched flank panel
    for (var sm = 0; sm < 3; sm++) {
      add(p.torso, box(0.70 - sm * 0.06, 0.03, 0.44, dark), 0, 0.36 - sm * 0.10, 0);
    }
    add(p.torso, box(0.03, 0.24, 0.42, dark), -0.36, 0.46, 0);
    add(p.torso, box(0.03, 0.24, 0.42, dark), 0.36, 0.46, 0);
    add(p.torso, box(0.14, 0.16, 0.02, rough(0x241713), true), 0.22, 0.32, -0.235, 0, 0, 0.25);
    add(p.torso, tor(0.13, 0.028, dark, 4, 10), 0, 0.44, -0.24, 0);
    add(p.torso, cyl(0.05, 0.05, 0.26, dark, 6), -0.22, 0.72, 0.22);
    add(p.torso, cyl(0.05, 0.05, 0.26, dark, 6), 0.22, 0.72, 0.22);
    // exhaust stacks vent heat out of the top
    add(p.torso, cyl(0.045, 0.045, 0.06, accent, 6, true), -0.22, 0.86, 0.22);
    add(p.torso, cyl(0.045, 0.045, 0.06, accent, 6, true), 0.22, 0.86, 0.22);
    // pauldrons, banner spike, elbow cops and knee pistons
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      vgrad(add(p[side + 'Shoulder'], sph(0.19, plate, 8, 6), 0, 0.02, 0), o.grad[0], o.grad[1]);
      add(p[side + 'Shoulder'], cone(0.05, 0.18, dark, 5), sgn * 0.16, 0.14, 0, 0, 0, sgn * 0.9);
      add(p[side + 'Shoulder'], taper(0.30, 0.38, 0.07, plate), 0, -0.05, 0);
      add(p[side + 'Shoulder'], cyl(0.022, 0.022, 0.14, dark, 5), sgn * 0.10, -0.16, -0.05, 0.4);
      add(p[side + 'Elbow'], oct(0.22, 0.10, 0.22, plate), 0, 0.0, 0);
      add(p[side + 'Elbow'], box(0.05, 0.03, 0.10, accent, true), sgn * 0.10, 0.0, -0.06);
      add(p.limbs[side + 'Leg'].userData.lower, cyl(0.025, 0.025, 0.18, dark, 5), sgn * 0.10, -0.12, -0.06, 0.25);
    });
    add(p.torso, cone(0.035, 0.34, dark, 5), -0.30, 0.86, 0.10, -0.25);
    // oversized helmet, black visor with a scanline
    add(p.head, box(0.44, 0.24, 0.42, plate), 0, 0.16, 0);
    add(p.head, box(0.40, 0.16, 0.05, dark, true), 0, 0.06, -0.20);
    var scan = add(p.head, box(0.34, 0.035, 0.03, accent, true), 0, 0.06, -0.225);
    add(p.head, cone(0.06, 0.24, plate, 5), -0.20, 0.27, 0.0, -0.4, 0, -0.5);
    add(p.head, cone(0.06, 0.24, plate, 5), 0.20, 0.27, 0.0, -0.4, 0, 0.5);
    add(p.head, box(0.10, 0.20, 0.06, plate), 0, 0.26, -0.16);
    // jaw grille with teeth behind the visor line
    teeth(p.head, { n: 5, w: 0.26, mat: plate, h: 0.05, y: -0.13, z: -0.19, down: true });
    add(p.head, box(0.30, 0.05, 0.03, dark, true), 0, -0.17, -0.19);
    A.pulse.push({ m: accent, base: 2.2, amp: 0.9, f: 1.2, ph: 0 });
    A.eyeMeshes = [scan];
    // the chest core spools up through the cast
    A.attackFn = function (w, s) {
      core.scale.setScalar(1 + w * 0.7 + s * 0.25);
      accent.emissiveIntensity += w * 2.2 + s * 1.0;
    };
    p.core = core;
    return p;
  }

  BUILDERS[69] = function (root, A) {
    return knight(root, A, { plate: 0xa8b3ba, under: 0x4b5459, accent: 0x00e5ff, grad: [0xcfd8dd, 0x3c454a] });
  };
  BUILDERS[3003] = function (root, A) {
    var p = knight(root, A, { plate: 0xd9a520, under: 0x6b4a10, accent: 0xff2ec4, grad: [0xffcc3d, 0x4d3208] });
    root.scale.setScalar(1.25);
    return p;
  };

  // --- 10. Revenant (66): humanoid torso on a rocket bottom, flying ----
  BUILDERS[66] = function (root, A) {
    var bone = rough(0xcfd3c8), dark = M(0x2b343a, 0.4, 0.5), rim = metal(0x8a949a);
    var grn = E(0x7dff2f, 2.2), org = E(0xff8a00, 2.4);
    var p = humanoid(root, {
      hipY: 1.32, torsoW: 0.42, torsoH: 0.56, torsoD: 0.30, torsoMat: dark,
      headSize: 0.30, headMat: bone, shoulderW: 0.30, upper: 0.36, fore: 0.34,
      armMat: bone, handMat: bone, armR: 0.055
    });
    // exposed rib cage over the dark chassis, vertebrae up the back
    for (var i = 0; i < 4; i++) {
      add(p.torso, box(0.44, 0.035, 0.30, bone), 0, 0.14 + i * 0.13, 0);
      add(p.torso, box(0.05, 0.04, 0.05, bone), 0, 0.16 + i * 0.13, 0.155);
    }
    add(p.torso, box(0.09, 0.56, 0.09, bone), 0, 0.28, 0.14);
    add(p.torso, box(0.26, 0.05, 0.04, grn, true), 0, 0.06, -0.16);
    // shoulder rocket pods with visible warheads
    var pods = [];
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      var pod = grp(p.torso, sgn * 0.34, 0.56, 0.02);
      vgrad(add(pod, oct(0.20, 0.20, 0.34, dark), 0, 0, 0), 0x4a565e, 0x161c20);
      add(pod, cone(0.05, 0.14, org, 5, true), -0.05, 0.05, -0.22, -Math.PI / 2);
      add(pod, cone(0.05, 0.14, org, 5, true), 0.05, 0.05, -0.22, -Math.PI / 2);
      add(pod, box(0.21, 0.04, 0.05, grn, true), 0, 0.11, -0.10);
      // launch rails, a pair of loaded warheads and a shoulder mount
      add(pod, box(0.02, 0.02, 0.30, rim), -0.09, 0.09, 0);
      add(pod, box(0.02, 0.02, 0.30, rim), 0.09, 0.09, 0);
      add(pod, cyl(0.035, 0.035, 0.20, rim, 6), -0.05, -0.05, -0.06, Math.PI / 2);
      add(pod, cyl(0.035, 0.035, 0.20, rim, 6), 0.05, -0.05, -0.06, Math.PI / 2);
      add(pod, cyl(0.04, 0.04, 0.14, rim, 6), sgn * -0.11, -0.02, 0.06, 0, 0, Math.PI / 2);
      pods.push(pod);
      p[side + 'Shoulder'].rotation.set(0.3, 0, sgn * 0.2);
    });
    // skull head, green sockets
    add(p.head, box(0.22, 0.12, 0.14, bone), 0, -0.10, -0.12);
    teeth(p.head, { n: 5, w: 0.20, mat: bone, h: 0.05, y: -0.12, z: -0.16, down: true });
    A.eyeMeshes = eyes(p.head, { mat: grn, y: 0.04, z: -0.14, dx: 0.075, size: 0.08, tall: 0.85 });
    // rocket bottom: nozzle, fins, flame
    var eng = grp(root, 0, 1.32, 0);
    add(eng, cyl(0.24, 0.30, 0.42, dark, 10), 0, -0.21, 0);
    add(eng, tor(0.27, 0.035, rim, 4, 12), 0, -0.40, 0, Math.PI / 2);
    add(eng, cyl(0.28, 0.18, 0.30, rim, 10), 0, -0.57, 0);
    for (var f = 0; f < 3; f++) {
      var fa = f / 3 * Math.PI * 2;
      add(eng, box(0.04, 0.26, 0.20, rim), Math.cos(fa) * 0.26, -0.34, Math.sin(fa) * 0.26, 0, -fa, 0);
    }
    var flame = add(eng, cone(0.15, 0.46, org, 8, true), 0, -0.92, 0, Math.PI);
    add(eng, cone(0.08, 0.26, E(0xfff2b0, 3.0, { transparent: true, opacity: 0.85 }), 6, true), 0, -0.84, 0, Math.PI);
    // engine plumbing feeding the nozzle
    cable(p.torso, { mat: rubber(0x14181b), x: -0.20, y: 0.10, z: 0.12, n: 3, len: 0.12, r: 0.026, tilt: -0.5 }, A.sway);
    cable(p.torso, { mat: rubber(0x14181b), x: 0.20, y: 0.10, z: 0.12, n: 3, len: 0.12, r: 0.026, tilt: -0.5 }, A.sway);
    A.flame.push({ o: flame, s0: 1 });
    A.bob.push({ o: root, amp: 0.10, f: 1.3, ph: 0 });
    A.pulse.push({ m: org, base: 2.4, amp: 1.0, f: 6.0, ph: 0 });
    A.blink.push({ o: A.eyeMeshes[0] }, { o: A.eyeMeshes[1] });
    // pods pitch up, then kick back as the volley goes out
    A.extraPivots = pods;
    A.attackFn = function (w, s) {
      for (var pi = 0; pi < pods.length; pi++) {
        addRot(pods[pi], -0.55 * w + 0.30 * s, 0, 0);
        pods[pi].position.z = pods[pi].userData.p0.z + s * 0.09;
      }
      org.emissiveIntensity += w * 1.0 + s * 3.2;
    };
    p.pods = pods;
    p.engine = eng;
    return p;
  };

  // --- 11. Mancubus (67): cyborg torso on a tank bottom ----------------
  BUILDERS[67] = function (root, A) {
    var fat = flesh(0x8f6144), hull = M(0x2e3a40, 0.4, 0.5), rim = metal(0x717c82);
    var grn = E(0x7dff2f, 1.6), org = E(0xff5a00, 2.2);
    var p = humanoid(root, {
      hipY: 1.00, torsoW: 0.92, torsoH: 0.66, torsoD: 0.62, torsoMat: fat,
      headSize: 0.40, headMat: fat, shoulderW: 0.50, upper: 0.28, fore: 0.26,
      armMat: hull, handMat: hull, armR: 0.11,
      torsoGrad: [0xb37f5c, 0x3f2a1c], headGrad: [0xb37f5c, 0x442e1f]
    });
    p.head.position.y += 0.10;
    // fat rolls, fuel tanks, feed pipes
    var r1 = add(p.torso, sph(0.36, fat, 10, 7), 0, 0.24, -0.08);
    var r2 = add(p.torso, sph(0.32, fat, 10, 7), 0, 0.52, -0.05);
    r1.scale.set(1.25, 0.62, 0.95); r2.scale.set(1.15, 0.58, 0.9);
    add(p.torso, cyl(0.15, 0.15, 0.46, rim, 8), -0.34, 0.44, 0.30);
    add(p.torso, cyl(0.15, 0.15, 0.46, rim, 8), 0.34, 0.44, 0.30);
    add(p.torso, box(0.30, 0.05, 0.05, grn, true), 0, 0.30, -0.44);
    // belly plating seams and a set of staples across the gut
    for (var bs = 0; bs < 4; bs++) {
      add(p.torso, box(0.52 - bs * 0.05, 0.03, 0.04, rim), 0, 0.12 + bs * 0.11, -0.36);
      add(p.torso, box(0.04, 0.05, 0.03, metal(0x9aa3a8)), (bs % 2 ? 0.18 : -0.18), 0.16 + bs * 0.11, -0.38);
    }
    cable(p.torso, { mat: rubber(0x14181b), x: -0.30, y: 0.62, z: 0.22, n: 4, len: 0.11, r: 0.028, tilt: -0.7 }, A.sway);
    cable(p.torso, { mat: rubber(0x14181b), x: 0.30, y: 0.62, z: 0.22, n: 4, len: 0.11, r: 0.028, tilt: -0.7 }, A.sway);
    // squashed head, breathing mask, green optic band
    add(p.head, box(0.30, 0.16, 0.16, hull), 0, -0.06, -0.14);
    add(p.head, box(0.30, 0.05, 0.03, grn, true), 0, 0.08, -0.17);
    add(p.head, cyl(0.045, 0.045, 0.22, rubber(0x14181b), 6), -0.18, -0.08, -0.06, 0, 0, 1.2);
    // arm flame cannons
    var cannons = [], mflash = [];
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      p[side + 'Shoulder'].rotation.set(1.25, 0, sgn * 0.1);
      var c = grp(p[side + 'Elbow'], 0, -0.26, -0.16, -2.60, 0, 0);
      add(c, cyl(0.14, 0.16, 0.46, hull, 10), 0, 0.20, 0);
      add(c, cyl(0.11, 0.13, 0.14, rim, 10), 0, 0.48, 0);
      add(c, cyl(0.09, 0.09, 0.08, org, 10, true), 0, 0.56, 0);
      add(c, box(0.06, 0.24, 0.06, rim), 0.14, 0.20, 0);
      // igniter ring, drip nozzle and a fuel line back to the tank
      add(c, tor(0.12, 0.02, org, 4, 10, true), 0, 0.54, 0, Math.PI / 2);
      add(c, cyl(0.03, 0.02, 0.10, rim, 6), 0.10, 0.50, 0, 0, 0, 0.5);
      add(c, box(0.05, 0.30, 0.04, rim), -0.14, 0.22, 0);
      cable(p.torso, { mat: rubber(0x14181b), x: sgn * 0.34, y: 0.24, z: 0.26, n: 4, len: 0.12, r: 0.026, tilt: -0.8, roll: sgn * 0.5 }, A.sway);
      cannons.push(c);
      var mf = add(c, cone(0.15, 0.40, E(0xff8a20, 2.0), 7, true), 0, 0.78, 0);
      mf.visible = false;
      mflash.push(mf);
    });
    A.extraPivots = cannons;
    A.attackFn = function (w, s) {
      for (var ci = 0; ci < cannons.length; ci++) {
        addRot(cannons[ci], -0.18 * w + 0.34 * s, 0, 0);
        cannons[ci].position.y = cannons[ci].userData.p0.y + s * 0.07;
        mflash[ci].visible = s > 0.35;
        mflash[ci].scale.set(0.6 + s * 0.8, 0.5 + s * 1.1, 0.6 + s * 0.8);
      }
      org.emissiveIntensity += w * 1.4 + s * 2.6;
    };
    // tank bottom with two tread bands
    var base = grp(root, 0, 0, 0);
    vgrad(add(base, oct(1.10, 0.44, 1.10, hull), 0, 0.60, 0), 0x47585f, 0x151b1e);
    vgrad(add(base, oct(0.90, 0.14, 0.90, rim), 0, 0.86, 0), 0x9aa5ab, 0x333b3f);
    for (var hb = 0; hb < 4; hb++) {
      var ha = hb / 4 * Math.PI * 2 + Math.PI / 4;
      add(base, cyl(0.035, 0.035, 0.22, metal(0x8a949a), 5), Math.cos(ha) * 0.42, 0.72, Math.sin(ha) * 0.42, 0.3, 0, 0.3);
    }
    var treads = [];
    [-1, 1].forEach(function (sgn) {
      var band = grp(base, sgn * 0.62, 0.30, 0);
      add(band, box(0.26, 0.44, 1.24, rubber(0x0d0f10)), 0, 0, 0);
      for (var w = 0; w < 3; w++) {
        var rl = add(band, cyl(0.20, 0.20, 0.28, rim, 10), 0, -0.02, -0.40 + w * 0.40, 0, 0, Math.PI / 2);
        treads.push(rl);
      }
      add(band, box(0.30, 0.06, 1.20, rim), 0, 0.24, 0);
    });
    treads.forEach(function (o, i) { A.spin.push({ o: o, axis: 'y', rate: 3.0, tread: true, i: i }); });
    A.pulse.push({ m: org, base: 2.2, amp: 0.9, f: 2.4, ph: 0 });
    A.treads = treads;
    return p;
  };

  // --- 12. Arachnotron (68): human torso, spider bottom, silver legs ---
  BUILDERS[68] = function (root, A) {
    var flesh2 = flesh(0x9a6f55), chas = M(0x30393f, 0.4, 0.5), silver = metal(0xb6c1c7);
    var cy = E(0x00e5ff, 2.0), mag = E(0xff2ec4, 2.4);
    var p = humanoid(root, {
      hipY: 0.86, torsoW: 0.46, torsoH: 0.50, torsoD: 0.32, torsoMat: flesh2,
      headSize: 0.28, headMat: flesh2, shoulderW: 0.28, upper: 0.30, fore: 0.28,
      armMat: flesh2, handMat: chas, armR: 0.06,
      torsoGrad: [0xbd8a6b, 0x3f2c21], headGrad: [0xbd8a6b, 0x3f2c21]
    });
    vgrad(add(p.torso, oct(0.50, 0.22, 0.36, chas), 0, 0.14, 0), 0x49555c, 0x161b1f);
    add(p.torso, box(0.34, 0.05, 0.04, cy, true), 0, 0.34, -0.18);
    add(p.head, box(0.30, 0.14, 0.30, chas), 0, 0.12, 0);
    A.eyeMeshes = eyes(p.head, { mat: cy, y: 0.0, z: -0.135, dx: 0.07, size: 0.07, tall: 0.7 });
    add(p.head, cyl(0.02, 0.02, 0.20, silver, 5), 0.14, 0.28, 0);
    add(p.head, sph(0.03, mag, 6, 4, true), 0.14, 0.40, 0);
    // abdomen dome + underslung plasma cannon
    var dome = grp(root, 0, 0.68, 0.06);
    vgrad(add(dome, sph(0.46, chas, 12, 8), 0, 0, 0), 0x4d5a61, 0x14191c);
    add(dome, tor(0.42, 0.045, silver, 4, 12), 0, 0.06, 0, Math.PI / 2);
    add(dome, box(0.34, 0.05, 0.04, mag, true), 0, 0.24, -0.36);
    // ribbed abdomen with vent slots between the ribs
    for (var rb = 0; rb < 3; rb++) {
      add(dome, tor(0.40 - rb * 0.07, 0.028, silver, 4, 12), 0, -0.10 - rb * 0.09, 0, Math.PI / 2);
      add(dome, box(0.05, 0.03, 0.14, E(0xff2ec4, 1.2), true), 0, -0.06 - rb * 0.09, 0.36 - rb * 0.05);
    }
    var gun = grp(dome, 0, -0.24, -0.34, 0.25, 0, 0);
    add(gun, cyl(0.09, 0.11, 0.40, silver, 8), 0, 0, -0.10, Math.PI / 2);
    add(gun, cyl(0.07, 0.07, 0.10, mag, 8, true), 0, 0, -0.32, Math.PI / 2);
    // charge chamber, coils and a shroud over the emitter
    var chamber = add(gun, sph(0.10, mag, 8, 6, true), 0, 0.02, 0.12);
    add(gun, cyl(0.12, 0.12, 0.12, chas, 8), 0, 0.02, 0.12, Math.PI / 2);
    for (var cc = 0; cc < 3; cc++) add(gun, tor(0.10, 0.018, silver, 4, 10), 0, 0, -0.06 - cc * 0.09, 0);
    add(gun, taper(0.22, 0.16, 0.08, silver), 0, 0, -0.36, Math.PI / 2);
    // Six silver legs ringed around the abdomen. Each hip group is turned so its
    // local +X points radially outward: the femur rises out to a knee above the
    // body, then the tibia drops to the floor. They step in animate().
    var legs = [];
    for (var i = 0; i < 6; i++) {
      var a = i / 6 * Math.PI * 2 + Math.PI / 6;
      var hipG = grp(root, Math.cos(a) * 0.40, 0.60, Math.sin(a) * 0.34, 0, -a, 0);
      add(hipG, cyl(0.05, 0.04, 0.42, silver, 6), 0.18, 0.11, 0, 0, 0, -1.02);
      add(hipG, sph(0.06, chas, 6, 5), 0, 0.02, 0);
      var knee = grp(hipG, 0.36, 0.22, 0);
      add(knee, sph(0.055, chas, 6, 5), 0, 0, 0);
      add(knee, cyl(0.04, 0.025, 0.80, silver, 6), 0.06, -0.40, 0, 0, 0, 0.15);
      add(knee, cone(0.035, 0.11, chas, 4), 0.12, -0.83, 0, Math.PI);
      // knee piston and a hooked foot claw
      add(knee, cyl(0.018, 0.018, 0.26, chas, 5), -0.02, -0.16, 0, 0, 0, 0.1);
      add(knee, cone(0.038, 0.12, chas, 4), 0.11, -0.86, 0, 2.6);
      hipG.userData.lower = knee;
      hipG.userData.rest = hipG.position.y;
      hipG.userData.ry0 = -a;
      legs.push(hipG);
    }
    A.legs = legs;
    A.pulse.push({ m: mag, base: 2.4, amp: 1.0, f: 1.8, ph: 0 }, { m: cy, base: 2.0, amp: 0.6, f: 2.6, ph: 1 });
    p.limbs = null; // no bipedal walk cycle — spider legs are driven here
    // the chamber charges, then the whole gun recoils into the dome
    A.extraPivots = [gun];
    A.attackFn = function (w, s) {
      addRot(gun, -0.22 * w + 0.30 * s, 0, 0);
      gun.position.z = gun.userData.p0.z + s * 0.10;
      chamber.scale.setScalar(0.6 + w * 0.9 - s * 0.4);
      mag.emissiveIntensity += w * 2.6 + s * 1.4;
    };
    p.dome = dome;
    p.gun = gun;
    return p;
  };

  // --- 13. Archvile (64): hollow glowing stomach, flaming head ---------
  BUILDERS[64] = function (root, A) {
    var burnt = flesh(0xe2661a), char = flesh(0x6a2a08), rib = rough(0xd8c9a8);
    var ylw = E(0xffe11a, 2.8), org = E(0xff7a00, 2.4);
    var p = humanoid(root, {
      hipY: 0.86, torsoW: 0.44, torsoH: 0.30, torsoD: 0.30, torsoMat: burnt,
      headSize: 0, shoulderW: 0.30, upper: 0.46, fore: 0.44,
      armMat: char, handMat: char, armR: 0.055, thigh: 0.46, shin: 0.42,
      legMat: char, footMat: rough(0x2a1206), legR: 0.075
    });
    // The torso sits high; the belly between hips and chest is an open cage.
    var hips = grp(root, 0, 0.86, 0);
    add(hips, box(0.42, 0.22, 0.30, char), 0, 0.10, 0);
    p.torso.position.y = 1.44;
    // rib struts bridging the hollow, with a furnace core floating inside
    for (var i = 0; i < 6; i++) {
      var a = i / 6 * Math.PI * 2 + 0.4;
      add(hips, cyl(0.022, 0.022, 0.50, rib, 5), Math.cos(a) * 0.15, 0.44, Math.sin(a) * 0.11, 0.12 * Math.sin(a), 0, -0.12 * Math.cos(a));
      // vertebral knuckles where each strut meets the pelvis
      add(hips, sph(0.032, rib, 6, 4), Math.cos(a) * 0.15, 0.21, Math.sin(a) * 0.11);
    }
    var core = add(hips, sph(0.15, ylw, 10, 8, true), 0, 0.44, 0);
    add(hips, tor(0.19, 0.025, org, 4, 12, true), 0, 0.44, 0, Math.PI / 2);
    // chest and shoulders
    vgrad(add(p.torso, oct(0.50, 0.26, 0.34, burnt), 0, 0.20, 0), 0xff8a3a, 0x4a1c05);
    add(p.torso, box(0.36, 0.05, 0.04, org, true), 0, 0.30, -0.18);
    // charred cracks across the chest and shoulders
    for (var cr = 0; cr < 3; cr++) {
      add(p.torso, box(0.03, 0.14, 0.02, rough(0x2a0f03), true), -0.14 + cr * 0.14, 0.20, -0.175, 0, 0, 0.4 - cr * 0.35);
      add(p.torso, box(0.22, 0.02, 0.02, rough(0x2a0f03), true), 0, 0.08 + cr * 0.10, 0.175);
    }
    // long arms, glowing hands held out
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      p[side + 'Shoulder'].rotation.set(1.15, 0, sgn * 0.26);
      var el = p[side + 'Elbow'];
      el.rotation.set(-0.45, 0, 0);
      el.userData.hand.visible = false;
      add(el, sph(0.13, ylw, 8, 6, true), 0, -0.50, 0);
      for (var c = -1; c <= 1; c++) add(el, cone(0.022, 0.14, ylw, 4, true), c * 0.055, -0.66, -0.02, Math.PI);
    });
    // flaming head: stacked cones that flicker and twist
    var headG = grp(p.torso, 0, 0.40, 0);
    add(headG, box(0.20, 0.18, 0.20, char), 0, 0.06, 0);
    A.eyeMeshes = eyes(headG, { mat: ylw, y: 0.06, z: -0.10, dx: 0.055, size: 0.055, tall: 0.9 });
    var f1 = add(headG, cone(0.19, 0.42, org, 7, true), 0, 0.30, 0);
    var f2 = add(headG, cone(0.13, 0.34, E(0xffc21a, 2.8, { transparent: true, opacity: 0.9 }), 6, true), 0, 0.44, 0);
    var f3 = add(headG, cone(0.07, 0.24, E(0xfff6c0, 3.2, { transparent: true, opacity: 0.85 }), 5, true), 0, 0.58, 0);
    A.flame.push({ o: f1, s0: 1 }, { o: f2, s0: 1 }, { o: f3, s0: 1 });
    // tendrils licking off the main flame
    for (var td = 0; td < 3; td++) {
      var ta2 = td / 3 * Math.PI * 2;
      var tf = add(headG, cone(0.045, 0.30, E(0xffb02a, 2.6, { transparent: true, opacity: 0.8 }), 4, true),
        Math.cos(ta2) * 0.13, 0.40, Math.sin(ta2) * 0.13, Math.sin(ta2) * 0.4, 0, -Math.cos(ta2) * 0.4);
      A.flame.push({ o: tf, s0: 1 });
    }
    A.spin.push({ o: headG, axis: 'y', rate: 0.6, base: 0.6 });
    A.pulse.push({ m: ylw, base: 2.8, amp: 1.4, f: 3.2, ph: 0 }, { m: org, base: 2.4, amp: 1.0, f: 4.5, ph: 1 });
    // the furnace swells and the hands go white through the cast
    A.attackFn = function (w, s) {
      core.scale.setScalar(1 + w * 1.1 + s * 0.4);
      ylw.emissiveIntensity += w * 3.0 + s * 2.0;
      A.spin[0].rate = A.spin[0].base * (1 + w * 5);
    };
    p.core = core;
    return p;
  };

  // --- 14. Cyberdemon (16): cable body, arm guns, sliding legs ---------
  BUILDERS[16] = function (root, A) {
    var skin = flesh(0xc9a68a), silver = metal(0xb6c1c7), dark = M(0x1c2225, 0.35, 0.5);
    var red = E(0xff1f1f, 2.4), cy = E(0x00e5ff, 1.8);
    // human head on a machine
    var head = grp(root, 0, 2.02, 0);
    vgrad(add(head, oct(0.34, 0.36, 0.32, skin), 0, 0, 0), 0xe2c3a8, 0x5b4234);
    vgrad(add(head, oct(0.36, 0.10, 0.34, silver), 0, 0.20, 0), 0xd3dce1, 0x424b50);
    add(head, cone(0.055, 0.30, silver, 5), -0.16, 0.32, 0, -0.35, 0, -0.5);
    add(head, cone(0.055, 0.30, silver, 5), 0.16, 0.32, 0, -0.35, 0, 0.5);
    var ey = eyes(head, { mat: red, y: 0.04, z: -0.165, dx: 0.085, size: 0.075, tall: 0.7 });
    add(head, box(0.18, 0.06, 0.04, dark, true), 0, -0.12, -0.16);
    add(head, box(0.10, 0.22, 0.06, silver), 0.19, -0.02, 0);
    cable(head, { mat: rubber(0x101418), x: -0.16, y: -0.14, z: 0.14, n: 3, len: 0.14, r: 0.03, tilt: 0.5 }, A.sway);
    // torso: a stack of counter-rotating cable coils around a dark spine
    var spine = grp(root, 0, 1.30, 0);
    add(spine, cyl(0.16, 0.20, 1.10, dark, 8), 0, 0.16, 0);
    // cable loom running the length of the spine into the coil stack
    cable(spine, { mat: rubber(0x101418), x: -0.13, y: 0.72, z: 0.13, n: 5, len: 0.15, r: 0.028, tilt: 0.15 }, A.sway);
    cable(spine, { mat: rubber(0x101418), x: 0.13, y: 0.72, z: 0.13, n: 5, len: 0.15, r: 0.028, tilt: 0.15 }, A.sway);
    var coils = [];
    for (var i = 0; i < 5; i++) {
      var c = grp(spine, 0, -0.20 + i * 0.24, 0);
      add(c, tor(0.30 - i * 0.015, 0.055, silver, 4, 12), 0, 0, 0, Math.PI / 2);
      coils.push(c);
      A.spin.push({ o: c, axis: 'y', rate: (i % 2 ? -0.8 : 0.8) });
    }
    add(spine, box(0.44, 0.05, 0.05, cy, true), 0, 0.70, -0.20);
    vgrad(add(spine, oct(0.52, 0.24, 0.34, dark), 0, 0.74, 0.04), 0x3c464b, 0x0f1315);
    // arm gun barrels
    var bars = [], brakes = [];
    ['left', 'right'].forEach(function (side, bi) {
      var sgn = side === 'left' ? -1 : 1;
      var arm = grp(spine, sgn * 0.50, 0.66, 0);
      add(arm, sph(0.17, silver, 8, 6), 0, 0, 0);
      add(arm, cyl(0.11, 0.13, 0.46, dark, 8), 0, -0.26, 0);
      // shoulder ram driving the gun arm
      add(arm, cyl(0.03, 0.03, 0.26, silver, 5), sgn * 0.12, -0.20, 0.10, 0.3);
      var bar = grp(arm, 0, -0.46, -0.16, -Math.PI / 2, 0, 0);
      add(bar, cyl(0.13, 0.13, 0.66, silver, 10), 0, 0.28, 0);
      add(bar, cyl(0.10, 0.10, 0.10, dark, 10), 0, 0.64, 0);
      var ring = add(bar, tor(0.11, 0.022, red, 4, 10, true), 0, 0.68, 0, Math.PI / 2);
      add(bar, box(0.05, 0.30, 0.05, cy, true), 0.13, 0.24, 0);
      // heavy muzzle brake with side ports
      add(bar, taper(0.30, 0.24, 0.12, silver), 0, 0.61, 0);
      add(bar, box(0.34, 0.05, 0.05, dark), 0, 0.61, 0);
      bars.push(bar); brakes.push(ring);
    });
    // intertwined legs that slide past each other instead of stepping
    var legs = [];
    [-1, 1].forEach(function (sgn) {
      var lg = grp(root, sgn * 0.20, 1.10, 0);
      add(lg, cyl(0.13, 0.17, 0.62, silver, 8), 0, -0.31, 0, 0, 0, -sgn * 0.10);
      add(lg, cyl(0.11, 0.09, 0.44, dark, 8), sgn * 0.06, -0.82, 0);
      vgrad(add(lg, oct(0.24, 0.10, 0.42, silver), sgn * 0.08, -1.03, -0.06), 0xd3dce1, 0x424b50);
      // hydraulic rams down the shin, and an ankle collar
      add(lg, cyl(0.028, 0.028, 0.40, silver, 5), sgn * 0.11, -0.60, 0.08, 0.12);
      add(lg, cyl(0.022, 0.022, 0.30, dark, 5), sgn * 0.11, -0.84, 0.08);
      add(lg, tor(0.09, 0.022, dark, 4, 10), sgn * 0.06, -0.98, 0, Math.PI / 2);
      for (var k = 0; k < 3; k++) add(lg, tor(0.15, 0.03, dark, 4, 10), 0, -0.14 - k * 0.22, 0, Math.PI / 2);
      lg.userData.rest = 1.10;
      legs.push(lg);
      A.slide.push({ o: lg, amp: 0.09, f: 2.2, ph: sgn > 0 ? Math.PI : 0, y0: 1.10 });
    });
    A.pulse.push({ m: red, base: 2.4, amp: 1.1, f: 1.6, ph: 0 }, { m: cy, base: 1.8, amp: 0.6, f: 2.2, ph: 1 });
    A.eyeMeshes = ey;
    A.blink.push({ o: ey[0] }, { o: ey[1] });
    // the two cannons fire out of phase; the coil stack spools with them
    A.extraPivots = bars;
    A.attackFn = function (w, s) {
      for (var i = 0; i < bars.length; i++) {
        var off = i ? Math.max(0, s - 0.25) / 0.75 : s;
        addRot(bars[i], -0.10 * w + 0.20 * off, 0, 0);
        bars[i].position.y = bars[i].userData.p0.y + off * 0.10;
        brakes[i].scale.setScalar(1 + off * 1.4);
      }
      red.emissiveIntensity += w * 0.8 + s * 3.0;
      for (var j = 0; j < A.spin.length; j++) A.spin[j].rate *= (1 + w * 3);
    };
    return { head: head, spine: spine, coils: coils, legs: legs, bars: bars, limbs: null };
  };

  // --- 15. Spider Mastermind (7): giant brain in a jar on a tank -------
  BUILDERS[7] = function (root, A) {
    var hull = M(0x2b3439, 0.4, 0.5), rim = metal(0x8a949a), dark = rubber(0x14181b);
    var glass = M(0xa8e6f0, 0.1, 0.1, { transparent: true, opacity: 0.28, depthWrite: false });
    var brainM = flesh(0xe3aebd), cy = E(0x00e5ff, 1.8), mag = E(0xff2ec4, 2.4);
    // tank chassis
    var base = grp(root, 0, 0, 0);
    vgrad(add(base, oct(1.20, 0.40, 1.20, hull), 0, 0.46, 0), 0x45535a, 0x141a1d);
    vgrad(add(base, oct(1.00, 0.12, 1.00, rim), 0, 0.70, 0), 0xa4aeb3, 0x353d41);
    add(base, box(0.70, 0.06, 0.06, cy, true), 0, 0.60, -0.62);
    // armoured corner blocks on the chassis
    [-1, 1].forEach(function (cx) {
      [-1, 1].forEach(function (cz) {
        add(base, taper(0.22, 0.30, 0.16, rim), cx * 0.44, 0.72, cz * 0.44);
      });
    });
    var treads = [];
    [-1, 1].forEach(function (sgn) {
      var band = grp(base, sgn * 0.66, 0.28, 0);
      add(band, box(0.26, 0.42, 1.30, dark), 0, 0, 0);
      for (var w = 0; w < 3; w++) treads.push(add(band, cyl(0.19, 0.19, 0.28, rim, 10), 0, -0.02, -0.42 + w * 0.42, 0, 0, Math.PI / 2));
      add(band, box(0.30, 0.06, 1.26, rim), 0, 0.23, 0);
      // tread links across the top run and a drive sprocket cover
      for (var tl = 0; tl < 5; tl++) {
        add(band, box(0.28, 0.04, 0.11, metal(0x4a5257)), 0, 0.20, -0.50 + tl * 0.25);
      }
      add(band, cyl(0.09, 0.09, 0.30, metal(0x99a3a8), 8), 0, -0.02, 0.42, 0, 0, Math.PI / 2);
    });
    treads.forEach(function (o) { A.spin.push({ o: o, axis: 'y', rate: 2.4, tread: true }); });
    // chin guns on the front of the chassis, in armoured housings
    var chin = [], chinFlash = [];
    [-1, 1].forEach(function (sgn) {
      var g = grp(base, sgn * 0.34, 0.52, -0.62, -Math.PI / 2, 0, 0);
      add(g, cyl(0.07, 0.08, 0.44, rim, 8), 0, 0.18, 0);
      add(g, cyl(0.05, 0.05, 0.08, mag, 8, true), 0, 0.42, 0);
      add(g, oct(0.20, 0.18, 0.20, hull), 0, -0.02, 0);
      add(g, taper(0.16, 0.13, 0.07, metal(0x99a3a8)), 0, 0.40, 0);
      add(g, box(0.04, 0.14, 0.04, cy, true), 0.10, 0.10, 0);
      var cf = add(g, cone(0.08, 0.24, E(0xff5cd6, 2.0), 6, true), 0, 0.58, 0);
      cf.visible = false;
      chin.push(g); chinFlash.push(cf);
    });
    // the jar: collar, glass, cap, and cable feeds
    var jarG = grp(root, 0, 0.76, 0);
    add(jarG, cyl(0.56, 0.60, 0.14, rim, 14), 0, 0.05, 0);
    add(jarG, cyl(0.52, 0.52, 0.86, glass, 14, true), 0, 0.55, 0);
    add(jarG, cyl(0.56, 0.52, 0.12, rim, 14), 0, 1.02, 0);
    for (var b = 0; b < 4; b++) {
      var ba = b / 4 * Math.PI * 2 + 0.6;
      add(jarG, cyl(0.025, 0.025, 0.90, rim, 5), Math.cos(ba) * 0.52, 0.55, Math.sin(ba) * 0.52);
      // bubbles rising through the fluid
      add(jarG, sph(0.03, glass, 6, 4, true), Math.cos(ba) * 0.30, 0.30 + b * 0.16, Math.sin(ba) * 0.30);
      cable(jarG, { mat: dark, x: Math.cos(ba) * 0.5, y: 1.04, z: Math.sin(ba) * 0.5, n: 3, len: 0.14, r: 0.028, tilt: 0.5, roll: ba }, A.sway);
    }
    // the brain itself: two lobes, a stem, and probe electrodes
    var brain = grp(jarG, 0, 0.56, 0);
    var lobeL = add(brain, sph(0.26, brainM, 10, 8), -0.13, 0.04, 0);
    var lobeR = add(brain, sph(0.26, brainM, 10, 8), 0.13, 0.04, 0);
    lobeL.scale.set(1, 0.82, 1.12); lobeR.scale.set(1, 0.82, 1.12);
    add(brain, sph(0.17, flesh(0xc98da0), 8, 6), 0, -0.20, 0.06);
    add(brain, cyl(0.06, 0.05, 0.22, flesh(0xc98da0), 6), 0, -0.32, 0.02);
    for (var e = 0; e < 3; e++) {
      add(brain, cyl(0.012, 0.012, 0.34, rim, 4), -0.22 + e * 0.22, 0.26, -0.06, 0.3);
      add(brain, sph(0.03, mag, 6, 4, true), -0.22 + e * 0.22, 0.42, -0.11);
      // probe wiring looping back to the collar
      add(brain, cyl(0.008, 0.008, 0.26, dark, 4), -0.22 + e * 0.22, 0.30, 0.10, -0.5);
    }
    // a single big sensor eye on the jar collar so the thing has a face
    var socket = grp(jarG, 0, 0.50, -0.54);
    add(socket, cyl(0.16, 0.18, 0.10, hull, 10), 0, 0, 0, Math.PI / 2);
    var iris = add(socket, sph(0.12, mag, 8, 6, true), 0, 0, -0.06);
    A.eyeMeshes = [iris];
    A.bob.push({ o: brain, amp: 0.035, f: 0.7, ph: 0 });
    A.sway.push({ o: brain, amp: 0.06, f: 0.5, ph: 1.4 });
    A.pulse.push({ m: mag, base: 2.4, amp: 1.2, f: 1.0, ph: 0 }, { m: cy, base: 1.8, amp: 0.7, f: 0.6, ph: 2 });
    A.treads = treads;
    // chin guns alternate; the brain throbs with every burst
    A.extraPivots = chin;
    A.attackFn = function (w, s) {
      for (var i = 0; i < chin.length; i++) {
        var off = i ? Math.max(0, s - 0.2) / 0.8 : s;
        addRot(chin[i], 0.14 * off, 0, 0);
        chin[i].position.z = chin[i].userData.p0.z + off * 0.07;
        chinFlash[i].visible = off > 0.3;
        chinFlash[i].scale.setScalar(0.7 + off * 0.7);
      }
      brain.scale.setScalar(1 + w * 0.10 + s * 0.06);
      mag.emissiveIntensity += w * 1.2 + s * 2.4;
    };
    return { base: base, jar: jarG, brain: brain, treads: treads, chin: chin, limbs: null };
  };

  // --- fallback --------------------------------------------------------
  BUILDERS[0] = function (root, A) {
    var m = flesh(0x8b3a2b);
    var p = humanoid(root, {
      hipY: 0.80, torsoW: 0.48, torsoH: 0.56, torsoD: 0.32, torsoMat: m,
      headSize: 0.30, headMat: m, shoulderW: 0.30, upper: 0.32, fore: 0.30,
      armMat: m, handMat: m, thigh: 0.42, shin: 0.38, legMat: m, legR: 0.09
    });
    A.eyeMeshes = eyes(p.head, { mat: E(0xff2a2a, 2.0), y: 0.03, z: -0.15, dx: 0.075, size: 0.07 });
    return p;
  };

  // ---------------------------------------------------------------------
  // stats — hp values are the engine's original hpMap, unchanged
  // ---------------------------------------------------------------------

  var STATS = {
    3004: { hp: 30,   speed: 3.5, attack: 'hitscan', range: 22, cooldown: 1.6, damage: 6,  scale: 1.0 },
    9:    { hp: 40,   speed: 3.4, attack: 'hitscan', range: 20, cooldown: 1.8, damage: 12, scale: 1.0 },
    65:   { hp: 70,   speed: 3.0, attack: 'hitscan', range: 24, cooldown: 1.1, damage: 9,  scale: 1.0 },
    3001: { hp: 60,   speed: 3.6, attack: 'fireball', range: 20, cooldown: 2.2, damage: 12, scale: 1.0 },
    3002: { hp: 120,  speed: 4.6, attack: 'melee',   range: 2.2, cooldown: 1.2, damage: 18, scale: 1.0 },
    58:   { hp: 120,  speed: 5.0, attack: 'melee',   range: 2.4, cooldown: 1.1, damage: 16, scale: 1.0 },
    3005: { hp: 150,  speed: 3.2, attack: 'laser',   range: 26, cooldown: 1.8, damage: 15, scale: 1.0, fly: true },
    69:   { hp: 300,  speed: 3.4, attack: 'fireball', range: 24, cooldown: 2.0, damage: 22, scale: 1.0 },
    3003: { hp: 500,  speed: 3.2, attack: 'fireball', range: 26, cooldown: 1.8, damage: 28, scale: 1.25 },
    66:   { hp: 220,  speed: 4.2, attack: 'fireball', range: 28, cooldown: 2.0, damage: 20, scale: 1.0, fly: true },
    67:   { hp: 400,  speed: 2.4, attack: 'fireball', range: 22, cooldown: 1.6, damage: 24, scale: 1.0 },
    68:   { hp: 350,  speed: 3.0, attack: 'fireball', range: 24, cooldown: 1.0, damage: 14, scale: 1.0 },
    64:   { hp: 450,  speed: 3.8, attack: 'fireball', range: 26, cooldown: 2.6, damage: 30, scale: 1.0 },
    16:   { hp: 1000, speed: 2.5, attack: 'fireball', range: 30, cooldown: 1.6, damage: 40, scale: 1.0 },
    7:    { hp: 1200, speed: 2.5, attack: 'hitscan', range: 30, cooldown: 0.9, damage: 14, scale: 1.0 }
  };
  // fly: hovers above the floor, crosses ledges freely, still stopped by walls
  // (index.html: moveEnemy / ENEMY_HOVER). Cacodemon and Revenant only; the
  // converter does not spawn Lost Souls (3006) or Pain Elementals (71).
  var DEFAULT_STATS = { hp: 50, speed: 3.5, attack: 'melee', range: 2.5, cooldown: 1.6, damage: 10, scale: 1.0 };

  var NAMES = {
    3004: 'Zombieman', 9: 'Shotgun Guy', 65: 'Chaingunner', 3001: 'Imp',
    3002: 'Demon', 58: 'Spectre', 3005: 'Cacodemon', 69: 'Hell Knight',
    3003: 'Baron of Hell', 66: 'Revenant', 67: 'Mancubus', 68: 'Arachnotron',
    64: 'Archvile', 16: 'Cyberdemon', 7: 'Spider Mastermind'
  };

  // -------------------------------------------------------------------
  // custom enemy defs
  //
  //   { id, name, base: <thing id>, stats: {...overrides}, look: {...},
  //     role: 'rusher'|'skirmisher'|'caster'|'bruiser' }
  //
  // They live in level JSON under `customEnemies: { id: def }` (and the same
  // key on a pack). The engine registers both tables before spawning and
  // entities reference them as enemyType "custom:<id>". An id nobody
  // registered warns once and falls back to the generic body.
  // -------------------------------------------------------------------
  var CUSTOM = {};
  var warned = {};

  function isCustom(t) { return typeof t === 'string' && t.slice(0, 7) === 'custom:'; }
  function customIdOf(t) { return String(t).slice(7); }

  /** registerCustom(packTable, levelTable, ...) — later tables win. */
  function registerCustom() {
    for (var i = 0; i < arguments.length; i++) {
      var tbl = arguments[i];
      if (!tbl || typeof tbl !== 'object') continue;
      for (var k in tbl) {
        if (!Object.prototype.hasOwnProperty.call(tbl, k)) continue;
        var def = tbl[k];
        if (!def || typeof def !== 'object') continue;
        CUSTOM[k] = def;
        delete warned[k];
        if (def.role && typeof window !== 'undefined' && window.CyberAI && window.CyberAI.setRole) {
          window.CyberAI.setRole('custom:' + k, def.role);
        }
      }
    }
    return CUSTOM;
  }

  function customDef(typeId) {
    if (!isCustom(typeId)) return null;
    var id = customIdOf(typeId);
    var def = CUSTOM[id];
    if (!def) {
      if (!warned[id]) {
        warned[id] = 1;
        if (typeof console !== 'undefined') {
          console.warn('[CyberEnemies] unknown custom enemy "' + id + '" - falling back to the generic body');
        }
      }
      return null;
    }
    return def;
  }

  function baseStats(typeId) { return STATS[parseInt(typeId, 10)] || DEFAULT_STATS; }

  function stats(typeId) {
    if (!isCustom(typeId)) return baseStats(typeId);
    var def = customDef(typeId);
    if (!def) return DEFAULT_STATS;
    var out = {}, b = baseStats(def.base), k;
    for (k in b) out[k] = b[k];
    if (def.stats) for (k in def.stats) {
      if (def.stats[k] !== undefined && def.stats[k] !== null && def.stats[k] !== '') out[k] = def.stats[k];
    }
    return out;
  }

  function roleOf(typeId) {
    if (typeof window !== 'undefined' && window.CyberAI && window.CyberAI.roleFor) {
      return window.CyberAI.roleFor(stats(typeId), typeId);
    }
    var st = stats(typeId);
    if (st.attack === 'melee' || st.range < 4) return 'rusher';
    if (st.hp >= 300) return 'bruiser';
    if (st.attack === 'hitscan') return 'skirmisher';
    return 'caster';
  }

  function listTypes() {
    return Object.keys(STATS).map(function (k) {
      var id = parseInt(k, 10);
      return { id: id, name: NAMES[id] || ('Type ' + id), role: roleOf(id), stats: stats(id) };
    });
  }

  /** Build with a look applied. look = { colors, scale, emissive, parts }. */
  function buildMesh(id, look, ent, THREE) {
    curLook = look || null;
    curSlots = { byKey: {}, list: [] };
    slotSeq = {};
    var g, slots;
    try {
      g = buildBase(id, ent || {}, THREE);
    } finally {
      slots = curSlots.list;
      curLook = null; curSlots = null; slotSeq = null;
    }
    g.userData.lookSlots = slots;
    if (look) {
      if (look.parts) {
        g.traverse(function (o) {
          if (o.isMesh && o.userData.lookSlot && look.parts[o.userData.lookSlot] === false) o.visible = false;
        });
      }
      var sc = Number(look.scale);
      if (sc && sc > 0 && sc !== 1) {
        g.scale.multiplyScalar(sc);
        if (g.userData.anim) g.userData.anim.s0 = g.scale.x;
      }
    }
    return g;
  }

  /** The look a stock type renders with today: every slot at its own colour. */
  var lookCache = {};
  function getDefaultLook(id, THREE) {
    var key = String(parseInt(id, 10) || 0);
    if (!lookCache[key]) {
      var g = buildMesh(key, null, null, THREE);
      // Only slots a mesh actually wears are knobs. vgrad() replaces a mesh's
      // material with a whited-out clone and bakes the colour into vertex
      // colours, so the original material's slot renders nowhere — offering it
      // in a colour picker would be a control that does nothing.
      var worn = {};
      g.traverse(function (o) {
        if (!o.isMesh) return;
        if (o.userData.lookSlot) worn[o.userData.lookSlot] = 1;
        if (o.userData.lookSlotAlso) worn[o.userData.lookSlotAlso] = 1;
      });
      var slots = g.userData.lookSlots.filter(function (sl) { return worn[sl.name]; });
      var colors = {}, parts = {};
      for (var i = 0; i < slots.length; i++) { colors[slots[i].name] = slots[i].hex; parts[slots[i].name] = true; }
      lookCache[key] = { slots: slots, colors: colors, parts: parts };
    }
    var d = lookCache[key];
    var out = { colors: {}, parts: {}, scale: 1, emissive: 1, slots: d.slots };
    for (var c in d.colors) out.colors[c] = d.colors[c];
    for (var p in d.parts) out.parts[p] = d.parts[p];
    return out;
  }

  /** Public build: resolves custom:<id> to its base + look, else the stock rig. */
  function build(typeId, ent, THREE) {
    if (!isCustom(typeId)) return buildBase(typeId, ent, THREE);
    var def = customDef(typeId);
    if (!def) return buildBase(0, ent, THREE);
    var look = null, k;
    if (def.look) { look = {}; for (k in def.look) look[k] = def.look[k]; }
    // A stat-panel `scale` scales the rig relative to its base's own scale.
    if (def.stats && def.stats.scale) {
      var b = baseStats(def.base).scale || 1;
      look = look || {};
      look.scale = (Number(look.scale) || 1) * (Number(def.stats.scale) / b);
    }
    var g = buildMesh(def.base, look, ent, THREE);
    g.userData.customEnemyId = customIdOf(typeId);
    return g;
  }

  // ---------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------

  function buildBase(typeId, ent, THREE) {
    T = THREE || T || (typeof window !== 'undefined' ? window.THREE : null);
    if (!T) throw new Error('CyberEnemies.build needs THREE');

    var id = parseInt(typeId, 10);
    if (!BUILDERS[id]) id = (ent && ent.type === 'soldier') ? 3004 : 0;

    var root = new T.Group();
    var A = {
      bob: [], sway: [], spin: [], pulse: [], blink: [], flame: [], slide: [],
      jaw: null, legs: null, eyeMeshes: [], t: 0, flashT: 0,
      // pose-layer state
      pose: null, pivots: [], walk: 0, gait: 0, prevCd: 0,
      ownAtk: 0, ownPain: 0, deadT: 0, frag: null, attackFn: null
    };
    var accents = [];
    buildAccents = accents;
    var parts;
    try {
      parts = BUILDERS[id](root, A) || {};
    } finally {
      buildAccents = null;
    }

    // A bob on the ROOT group would write an absolute world y over whatever
    // the engine placed the body at this frame — the baked rest height is 0,
    // so flyers got dragged to the floor and through walls. Wrap the body in
    // an inner group and bob that: the root stays owned by whoever places it,
    // and the bob is a local offset that needs no ordering with the AI.
    if (A.bob.some(function (b) { return b.o === root; })) {
      var body = new T.Group();
      while (root.children.length) body.add(root.children[0]);
      root.add(body);
      A.bob.forEach(function (b) { if (b.o === root) b.o = body; });
      A.bobRoot = body;
    }

    // bake rest positions so animate() never accumulates drift
    A.bob.forEach(function (b) { b.y0 = b.o.position.y; });
    A.sway.forEach(function (s) { s.z0 = s.o.rotation.z; });
    A.flame.forEach(function (f) { f.y0 = f.o.position.y; });

    // pose defaults, and the pivots the pose stack drives (rest baked so
    // every layer is additive over whatever stance the builder posed)
    var base = {};
    for (var bk in POSE_BASE) base[bk] = POSE_BASE[bk];
    var pd = POSES[id] || {};
    for (var pk in pd) base[pk] = pd[pk];
    if (A.pose) for (var ak in A.pose) base[ak] = A.pose[ak];
    A.pose = base;
    A.s0 = root.scale.x;

    var pv = A.pivots;
    ['torso', 'head', 'leftShoulder', 'rightShoulder'].forEach(function (k) {
      if (parts[k]) pv.push(parts[k]);
    });
    if (parts.leftElbow) pv.push(parts.leftElbow);
    if (parts.rightElbow) pv.push(parts.rightElbow);
    if (parts.limbs) {
      ['leftLeg', 'rightLeg'].forEach(function (k) {
        var lg = parts.limbs[k];
        if (!lg) return;
        pv.push(lg);
        if (lg.userData.lower) pv.push(lg.userData.lower);
      });
    }
    if (A.extraPivots) A.extraPivots.forEach(function (o) { pv.push(o); });
    pv.forEach(bake);

    root.userData.anim = A;
    root.userData.hitMaterials = accents.map(function (a) { return a.m; });
    root.userData.accents = accents;
    root.userData.limbs = parts.limbs || null;
    root.userData.eyes = A.eyeMeshes;
    root.userData.jaw = A.jaw ? A.jaw.o : null;
    root.userData.arms = parts.leftShoulder ? [parts.leftShoulder, parts.rightShoulder] : [];
    root.userData.rotor = A.spin.length ? A.spin[0].o : null;
    root.userData.tankTreads = A.treads || null;
    root.userData.cables = A.sway.map(function (s) { return s.o; });
    root.userData.flame = A.flame.length ? A.flame[0].o : null;
    root.userData.parts = parts;
    root.userData.enemyTypeId = id;

    startDriver();
    return root;
  }

  // ---------------------------------------------------------------------
  // pose layer
  //
  // State animation is driven by flags the AI writes onto the enemy object:
  //   enemy.state    'IDLE' | 'CHASE' | 'ATTACK' | 'PAIN' | 'DEAD'
  //   enemy.attackT  0..1 across one attack
  //   enemy.flinchT  0..1 across one pain flinch
  //   enemy.deathT   0..1 across the death
  // All four are optional. Without them the poses self-drive: an attack fires
  // whenever attackCooldown is reset, a flinch whenever flash() is called, and
  // a death whenever state goes DEAD — so this works against today's engine
  // and gets tighter when the AI starts writing the flags.
  //
  // A builder picks its poses with A.pose = { attack, death, ... }; POSES below
  // is the per-type default so a builder never has to. Extra per-type motion
  // (gun kick, rotor flare, jaw) goes in A.attackFn(w, s, k, parts, A), which
  // runs on top of the generic pose.
  // ---------------------------------------------------------------------

  var POSES = {
    3004: { attack: 'gun',    death: 'crumple', aim: 1.25 },
    9:    { attack: 'gun',    death: 'crumple' },
    65:   { attack: 'gun',    death: 'crumple', attackDur: 0.5 },
    3001: { attack: 'cast',   death: 'crumple' },
    3002: { attack: 'lunge',  death: 'crumple', attackDur: 0.5 },
    58:   { attack: 'lunge',  death: 'fade',    attackDur: 0.5 },
    3005: { attack: 'none',   death: 'explode' },
    69:   { attack: 'cast',   death: 'topple' },
    3003: { attack: 'cast',   death: 'topple' },
    66:   { attack: 'volley', death: 'explode' },
    67:   { attack: 'cannon', death: 'crumple' },
    68:   { attack: 'cannon', death: 'explode' },
    64:   { attack: 'cast',   death: 'crumple', attackDur: 0.9 },
    16:   { attack: 'cannon', death: 'topple',  deathDur: 1.8 },
    7:    { attack: 'cannon', death: 'explode', deathDur: 1.6 },
    0:    { attack: 'claw',   death: 'crumple' }
  };
  var POSE_BASE = { attack: 'claw', death: 'crumple', attackDur: 0.6, deathDur: 1.2 };

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** Remember a pivot's rest transform so poses can be additive. */
  function bake(o) {
    if (!o || o.userData.r0) return o;
    o.userData.r0 = { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z };
    o.userData.p0 = { x: o.position.x, y: o.position.y, z: o.position.z };
    return o;
  }

  // Rotation accumulator: every layer adds its own delta, one flush writes the
  // sum back over the rest pose, so layers never overwrite each other.
  var _frame = 0, _touched = [];
  function addRot(o, dx, dy, dz) {
    if (!o || !o.userData.r0) return;
    var u = o.userData;
    if (u._f !== _frame) { u._f = _frame; u._ax = 0; u._ay = 0; u._az = 0; _touched.push(o); }
    u._ax += dx || 0; u._ay += dy || 0; u._az += dz || 0;
  }
  function flushRot() {
    for (var i = 0; i < _touched.length; i++) {
      var o = _touched[i], r = o.userData.r0, u = o.userData;
      o.rotation.set(r.x + u._ax, r.y + u._ay, r.z + u._az);
    }
    _touched.length = 0;
  }
  function lower(o) { return o && o.userData ? o.userData.lower : null; }

  /** Wind-up / strike envelopes for one attack, k in 0..1. */
  function windup(k) { return k < 0.45 ? k / 0.45 : Math.max(0, 1 - (k - 0.45) / 0.18); }
  function strike(k) {
    if (k < 0.45) return 0;
    return k < 0.62 ? (k - 0.45) / 0.17 : Math.max(0, 1 - (k - 0.62) / 0.38);
  }

  function attackPose(A, P, L, k, out) {
    var w = windup(k), s = strike(k), kind = A.pose.attack;
    var AL = P.leftShoulder, AR = P.rightShoulder;
    if (kind === 'claw') {
      addRot(AR, -1.5 * w + 1.5 * s, 0, -0.5 * w + 0.9 * s);
      addRot(lower(AR), -0.8 * w + 0.3 * s, 0, 0);
      addRot(AL, -0.5 * w + 0.4 * s, 0, 0.3 * w);
      addRot(P.torso, 0.12 * w - 0.10 * s, -0.35 * w + 0.5 * s, 0);
      out.x += 0.05 * s;
    } else if (kind === 'gun' || kind === 'cannon') {
      var big = kind === 'cannon' ? 2.0 : 1;
      // aim: how far the firing arm has to come up before it can shoot. A
      // hip-carried sidearm needs it; a gunner already holding the weapon
      // level does not.
      var aim = (A.pose.aim || 0) * Math.min(1, w * 2 + s);
      addRot(AR, aim - 0.22 * w - 0.14 * s * big, 0, 0);
      addRot(lower(AR), -aim * 0.35, 0, 0);
      addRot(AL, aim * 0.45 - 0.18 * w - 0.12 * s * big, 0, 0);
      addRot(P.torso, -0.06 * w + 0.10 * s * big, 0, 0);
      addRot(P.head, -0.05 * w, 0, 0);
      out.x += -0.05 * s * big;
    } else if (kind === 'cast') {
      addRot(AL, -1.45 * w + 0.95 * s, 0, 0.5 * w - 0.35 * s);
      addRot(AR, -1.45 * w + 0.95 * s, 0, -0.5 * w + 0.35 * s);
      addRot(lower(AL), -0.85 * w + 0.7 * s, 0, 0);
      addRot(lower(AR), -0.85 * w + 0.7 * s, 0, 0);
      addRot(P.torso, -0.18 * w + 0.26 * s, 0, 0);
      addRot(P.head, -0.20 * w + 0.16 * s, 0, 0);
      out.x += 0.06 * s;
    } else if (kind === 'lunge') {
      addRot(AL, -0.9 * w + 1.2 * s, 0, 0.45 * w);
      addRot(AR, -0.9 * w + 1.2 * s, 0, -0.45 * w);
      if (L) {
        addRot(L.leftLeg, 0.45 * s, 0, 0);
        addRot(L.rightLeg, -0.45 * s, 0, 0);
      }
      addRot(P.torso, 0.10 * w + 0.22 * s, 0, 0);
      out.x += 0.12 * w + 0.30 * s;
      if (A.jaw) A.jaw.bite = Math.max(w, s);
    } else if (kind === 'volley') {
      addRot(P.torso, -0.14 * w + 0.06 * s, 0, 0);
      addRot(AL, -0.4 * w, 0, 0.25 * w);
      addRot(AR, -0.4 * w, 0, -0.25 * w);
      out.x += -0.11 * s;
    }
    if (A.attackFn) A.attackFn(w, s, k, P, A);
  }

  function deathPose(enemy, g, A, P, L, k) {
    var e = k * k * (3 - 2 * k);
    if (A.deathY === undefined) A.deathY = num(enemy.floorY) || g.position.y;
    var kind = A.pose.death, s0 = A.s0 || 1;

    if (kind === 'explode') {
      if (!A.frag) {
        A.frag = [];
        var host = A.bobRoot || g;
        for (var i = 0; i < host.children.length; i++) {
          var c = bake(host.children[i]);
          var a = i * 2.399, r = 0.55 + (i % 5) * 0.2;
          A.frag.push({ o: c, dx: Math.cos(a) * r, dy: 0.6 + (i % 3) * 0.45, dz: Math.sin(a) * r,
                        sx: (i % 7 - 3) * 1.7, sy: (i % 5 - 2) * 2.1 });
        }
      }
      var fall = e * e * 2.4;
      for (var j = 0; j < A.frag.length; j++) {
        var f = A.frag[j], p0 = f.o.userData.p0, r0 = f.o.userData.r0;
        f.o.position.set(p0.x + f.dx * e * 1.9, p0.y + f.dy * e * 1.7 - fall, p0.z + f.dz * e * 1.9);
        f.o.rotation.set(r0.x + f.sx * e, r0.y + f.sy * e, r0.z + f.sx * e * 0.6);
      }
      g.position.y = A.deathY;
      g.scale.setScalar(Math.max(0.001, s0 * (1 - e * 0.6)));
      if (k >= 1) g.visible = false;
      return;
    }
    if (kind === 'fade') {
      g.rotation.x = e * 0.5;
      g.position.y = A.deathY + e * 0.9;
      g.scale.set(s0 * (1 - e * 0.4), s0 * (1 - e * 0.85), s0 * (1 - e * 0.4));
      if (k >= 1) g.visible = false;
      return;
    }
    // crumple (soft, folds) / topple (stiff, falls in one piece with a bounce)
    // ponytail: the fall is around the world X axis like the engine's old
    // snap, not around the enemy's facing — reordering the euler is the
    // upgrade if corpses ever need to fall away from the shot.
    var over = Math.sin(e * Math.PI) * (kind === 'topple' ? 0.20 : 0.05);
    g.rotation.x = e * (Math.PI / 2) + over;
    g.position.y = A.deathY + e * 0.28;
    if (kind === 'crumple') {
      addRot(P.torso, -0.5 * e, 0, 0.18 * e);
      addRot(P.head, 0.7 * e, 0, 0);
      addRot(P.leftShoulder, -0.6 * e, 0, -0.45 * e);
      addRot(P.rightShoulder, -0.5 * e, 0, 0.45 * e);
      if (L) {
        addRot(L.leftLeg, 0.9 * e, 0, 0);
        addRot(L.rightLeg, 0.7 * e, 0, 0);
        addRot(lower(L.leftLeg), 1.5 * e, 0, 0);
        addRot(lower(L.rightLeg), 1.2 * e, 0, 0);
      }
    }
  }

  // ---------------------------------------------------------------------
  // animate
  // ---------------------------------------------------------------------

  function animate(enemy, t, delta) {
    if (!enemy) return;
    var g = enemy.group;
    if (!g) return;
    var A = g.userData && g.userData.anim;
    if (!A) return;
    delta = Math.min(num(delta) || 1 / 60, 0.1);
    _frame++;

    var P = g.userData.parts || {};
    var L = g.userData.limbs;
    var raw = enemy.state || 'IDLE';
    var dead = raw === 'DEAD';

    // ---- resolve the four drivers, defensively -------------------------
    if (dead) A.deadT = Math.min(1, (A.deadT || 0) + delta / A.pose.deathDur);
    else if (A.deadT) { A.deadT = 0; A.frag = null; A.deathY = undefined; g.visible = true; g.scale.setScalar(A.s0 || 1); }
    var deathK = Math.max(num(enemy.deathT), A.deadT || 0);

    // Either cooldown jumping back up means a shot just went off. The AI winds
    // its own (enemy.ai.cool); the pre-AI engine wound enemy.attackCooldown.
    var cd = num(enemy.attackCooldown) + (enemy.ai ? num(enemy.ai.cool) : 0);
    if (!dead && cd > A.prevCd + 1e-3) A.ownAtk = 1e-3;
    A.prevCd = cd;
    if (raw === 'ATTACK' && !num(enemy.attackT) && !A.ownAtk) A.ownAtk = 1e-3;
    if (A.ownAtk > 0) { A.ownAtk += delta / A.pose.attackDur; if (A.ownAtk >= 1) A.ownAtk = 0; }
    var atkK = clamp01(num(enemy.attackT) || A.ownAtk);

    // Pain: attackT-style 0..1 if the AI ever sends one, otherwise our own
    // envelope started by any flinch signal — a PAIN state, a flinch timer
    // counting down in seconds, or a flash() from a hit.
    if (!A.ownPain && (raw === 'PAIN' || num(enemy.flinchT) > 0)) A.ownPain = 1e-3;
    if (A.ownPain > 0) { A.ownPain += delta / 0.34; if (A.ownPain >= 1) A.ownPain = 0; }
    var painK = clamp01(A.ownPain);

    if (deathK > 0) {
      for (var q = 0; q < A.pivots.length; q++) addRot(A.pivots[q], 0, 0, 0);
      deathPose(enemy, g, A, P, L, deathK);
      flushRot();
      decayFlash(g, A, delta);
      return;
    }

    var i, o;
    A.t = t;
    A.gait += ((raw === 'CHASE' && atkK < 0.05 ? 1 : 0) - A.gait) * Math.min(1, delta * 7);
    var moving = A.gait > 0.35;

    for (i = 0; i < A.bob.length; i++) {
      o = A.bob[i];
      o.o.position.y = o.y0 + Math.sin(t * o.f * 2 + o.ph) * o.amp;
    }
    for (i = 0; i < A.sway.length; i++) {
      o = A.sway[i];
      o.o.rotation.z = o.z0 + Math.sin(t * o.f + o.ph) * o.amp;
    }
    for (i = 0; i < A.spin.length; i++) {
      o = A.spin[i];
      // treads only roll while the thing is actually driving at you
      var rate = o.tread ? (moving ? o.rate : 0) : o.rate;
      o.o.rotation[o.axis] += rate * delta;
    }
    for (i = 0; i < A.slide.length; i++) {
      o = A.slide[i];
      o.o.position.y = o.y0 + Math.sin(t * o.f * (moving ? 2.2 : 0.6) + o.ph) * o.amp;
    }
    for (i = 0; i < A.flame.length; i++) {
      o = A.flame[i];
      var s = 0.78 + Math.abs(Math.sin(t * 17 + i * 2.1)) * 0.34 + Math.sin(t * 41 + i) * 0.07;
      o.o.scale.set(0.9 + (s - 0.9) * 0.5, s, 0.9 + (s - 0.9) * 0.5);
      o.o.position.y = o.y0 + (s - 1) * 0.05;
    }
    if (!A.flashT) {
      for (i = 0; i < A.pulse.length; i++) {
        o = A.pulse[i];
        o.m.emissiveIntensity = o.base + Math.sin(t * o.f * 2 + o.ph) * o.amp;
      }
    }
    // blink: a short shut on an irregular beat, per enemy phase
    if (A.blink.length) {
      var phase = (t * 0.9 + (g.id % 17) * 0.37) % 1;
      var shut = phase > 0.94;
      for (i = 0; i < A.blink.length; i++) A.blink[i].o.scale.y = shut ? 0.12 : 1;
    }
    // spider gait for the Arachnotron, amplitude riding the walk blend
    if (A.legs) {
      var gt = A.gait;
      for (i = 0; i < A.legs.length; i++) {
        var lg = A.legs[i];
        var ph = t * (1.2 + gt * 5.8) + i * (Math.PI / 3) * 2;
        var lift = Math.max(0, Math.sin(ph));
        lg.position.y = lg.userData.rest + lift * (0.02 + gt * 0.09);
        lg.rotation.y = lg.userData.ry0 + Math.cos(ph) * (0.05 + gt * 0.15);
        if (lg.userData.lower) lg.userData.lower.rotation.z = lift * (0.05 + gt * 0.23);
      }
    }

    // ---- pose stack: rest -> idle -> walk -> attack -> flinch ----------
    for (i = 0; i < A.pivots.length; i++) addRot(A.pivots[i], 0, 0, 0);
    var root = { x: 0, z: 0 };

    // idle breathing / shift of weight, faded out as the gait comes up
    var idle = 1 - A.gait;
    addRot(P.torso, Math.sin(t * 1.15) * 0.022 * idle, Math.sin(t * 0.53) * 0.05 * idle,
      Math.sin(t * 0.9) * 0.02 * idle);
    addRot(P.head, Math.sin(t * 1.15 + 1.2) * 0.03 * idle, Math.sin(t * 0.41) * 0.12 * idle, 0);

    // walk cycle — legs from the shared rig, arms counter-swinging
    if (A.gait > 0.01) {
      var spd = num(enemy.speed) || (enemy.stats && enemy.stats.speed) || 3.5;
      A.walk += delta * spd * 2.3 * A.gait;
      var sw = Math.sin(A.walk), amp = A.gait;
      if (L) {
        addRot(L.leftLeg, sw * 0.62 * amp, 0, 0);
        addRot(L.rightLeg, -sw * 0.62 * amp, 0, 0);
        addRot(lower(L.leftLeg), Math.max(0, sw) * 0.85 * amp, 0, 0);
        addRot(lower(L.rightLeg), Math.max(0, -sw) * 0.85 * amp, 0, 0);
      }
      addRot(P.leftShoulder, -sw * 0.34 * amp, 0, 0);
      addRot(P.rightShoulder, sw * 0.34 * amp, 0, 0);
      addRot(lower(P.leftShoulder), Math.max(0, -sw) * 0.4 * amp, 0, 0);
      addRot(lower(P.rightShoulder), Math.max(0, sw) * 0.4 * amp, 0, 0);
      // torso counter-rotates and the whole body rocks on each footfall
      addRot(P.torso, Math.abs(Math.cos(A.walk)) * 0.05 * amp, -sw * 0.10 * amp, 0);
      root.z += Math.sin(A.walk * 2) * 0.03 * amp;
    }

    if (A.jaw) A.jaw.bite = 0;
    if (atkK > 0) attackPose(A, P, L, atkK, root);
    else if (A.wasAtk && A.attackFn) A.attackFn(0, 0, 0, P, A);   // clear muzzle flashes etc.
    A.wasAtk = atkK > 0;

    // pain flinch: head snaps back, arms fly out, body recoils
    if (painK > 0) {
      var fl = Math.sin(painK * Math.PI);
      addRot(P.head, -0.42 * fl, 0.18 * fl, 0);
      addRot(P.torso, -0.24 * fl, 0, 0.10 * fl);
      addRot(P.leftShoulder, -0.35 * fl, 0, 0.30 * fl);
      addRot(P.rightShoulder, -0.35 * fl, 0, -0.30 * fl);
      root.x += -0.16 * fl;
      root.z += 0.05 * fl * Math.sin(t * 47);
    }

    g.rotation.x = root.x;
    g.rotation.z = root.z;
    flushRot();

    // Jaws gape to bite: driven by the attack pose, or by the melee ring the
    // engine already tracks when nothing has set attackT yet.
    if (A.jaw) {
      var want = A.jaw.bite ? A.jaw.open
        : (enemy.attackCooldown > 0 ? A.jaw.open * 0.7 : A.jaw.closed);
      if (A.jaw.bite) A.jaw.o.rotation.x = A.jaw.closed + (A.jaw.open - A.jaw.closed) * A.jaw.bite;
      else A.jaw.o.rotation.x += (want - A.jaw.o.rotation.x) * Math.min(1, delta * 9);
    }

    decayFlash(g, A, delta);
  }

  function decayFlash(g, A, delta) {
    if (!A.flashT) return;
    A.flashT -= delta;
    var accents = g.userData.accents || [];
    if (A.flashT <= 0) {
      A.flashT = 0;
      for (var i = 0; i < accents.length; i++) {
        accents[i].m.emissive.setHex(accents[i].hex);
        accents[i].m.emissiveIntensity = accents[i].base;
      }
    }
  }

  /** Briefly whites out every emissive accent on a hit. */
  function flash(group) {
    if (!group || !group.userData) return;
    var A = group.userData.anim;
    var accents = group.userData.accents;
    if (!A || !accents) return;
    A.flashT = 0.12;
    if (!A.ownPain) A.ownPain = 1e-3;   // every hit reads as a flinch
    for (var i = 0; i < accents.length; i++) {
      accents[i].m.emissive.setHex(0xffffff);
      accents[i].m.emissiveIntensity = 4.0;
    }
  }

  // ---------------------------------------------------------------------
  // self-driving frame loop
  //
  // The engine's per-frame loop lives outside the enemy region, so rather
  // than reach into it this drives itself off window.cyberEngine. Set
  // CyberEnemies.autoDrive = false and call animate() from the engine's
  // animate() instead if you would rather own the tick.
  // ---------------------------------------------------------------------

  var driving = false;

  function startDriver() {
    if (driving || !API.autoDrive) return;
    if (typeof requestAnimationFrame !== 'function') return;
    driving = true;
    var last = performance.now();
    var step = function (now) {
      requestAnimationFrame(step);
      var dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!API.autoDrive) return;
      var eng = window.cyberEngine;
      if (!eng || !eng.isRunning || !eng.enemies) return;
      var t = now / 1000;
      for (var i = 0; i < eng.enemies.length; i++) animate(eng.enemies[i], t, dt);
    };
    requestAnimationFrame(step);
  }

  var API = {
    build: build,
    animate: animate,
    stats: stats,
    flash: flash,
    autoDrive: true,
    // --- enemy editor surface ---
    STATS: STATS,
    NAMES: NAMES,
    DEFAULT_STATS: DEFAULT_STATS,
    buildMesh: buildMesh,
    getDefaultLook: getDefaultLook,
    listTypes: listTypes,
    roleOf: roleOf,
    isCustom: isCustom,
    registerCustom: registerCustom,
    customDefs: function () { return CUSTOM; },
    clearCustom: function () { CUSTOM = {}; warned = {}; }
  };

  if (typeof window !== 'undefined') window.CyberEnemies = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
