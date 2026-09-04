/* ===========================================================================
   cyber-enemies.js — the 15 Cyberhell monsters.

   Classic script (no modules, no build step). Exposes:

     window.CyberEnemies.build(typeId, ent, THREE) -> THREE.Group
     window.CyberEnemies.animate(enemy, timeSeconds, delta)
     window.CyberEnemies.stats(typeId) -> { hp, speed, attack, range, cooldown, damage, scale }
     window.CyberEnemies.flash(group)

   Geometry only, no textures — the same toolkit shape as Clash of Steel's
   Costume.js: cached geometries, tiny box/cyl/sph/cone helpers, everything
   parented into named pivot groups so the animator never has to search.

   Budget per enemy: <= 60 meshes, <= 2500 triangles.

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

  /** Shared structural material. Never mutated, so it is safe to cache. */
  function M(color, metalness, roughness, opts) {
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
    return m;
  }

  // No environment map in this engine, so high metalness renders near-black.
  var metal = function (c) { return M(c, 0.55, 0.38); };
  var rough = function (c) { return M(c, 0.05, 0.85); };
  var flesh = function (c) { return M(c, 0.0, 0.72); };
  var rubber = function (c) { return M(c, 0.1, 0.95); };

  // Emissive accents are per-enemy clones (never cached) because flash()
  // mutates them — a shared material would flash every enemy on screen.
  var buildAccents = null; // collector, set for the duration of one build()

  function E(color, intensity, opts) {
    opts = opts || {};
    var def = {
      color: 0x101010, emissive: color,
      emissiveIntensity: intensity === undefined ? 1.6 : intensity,
      metalness: 0.0, roughness: 0.5
    };
    for (var k in opts) def[k] = opts[k];
    var m = new T.MeshStandardMaterial(def);
    if (buildAccents) buildAccents.push({ m: m, hex: color, base: def.emissiveIntensity });
    return m;
  }

  function mesh(g, m, noShadow) {
    var o = new T.Mesh(g, m);
    if (!noShadow) { o.castShadow = true; o.receiveShadow = true; }
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
    add(p.torso, box(tW, tH, tD, o.torsoMat), 0, tH / 2, 0);
    // pelvis
    add(p.torso, box(tW * 0.86, 0.16, tD * 0.92, o.legMat || o.torsoMat), 0, 0.02, 0);

    if (o.headSize) {
      p.neck = add(p.torso, cyl(tD * 0.2, tD * 0.22, 0.1, o.armMat || o.torsoMat, 6), 0, tH + 0.04, 0);
      p.head = grp(p.torso, 0, tH + 0.09 + o.headSize / 2, 0);
      add(p.head, box(o.headSize, o.headSize, o.headSize * 0.9, o.headMat || o.torsoMat), 0, 0, 0);
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
      legMat: trous, footMat: rough(0x151515), legR: 0.09
    });
    // flak vest with a torn shoulder and an exposed neural cable
    add(p.torso, box(0.50, 0.34, 0.34, vest), 0, 0.40, 0);
    add(p.torso, box(0.14, 0.10, 0.34, metal(0x6b7a80)), -0.24, 0.52, 0);
    add(p.torso, box(0.22, 0.05, 0.03, E(0x00e5ff, 1.4), true), 0.10, 0.30, -0.16);
    cable(p.torso, { mat: rubber(0x101418), x: 0.16, y: 0.56, z: -0.10, n: 3, len: 0.09, r: 0.022, tilt: 0.4 }, A.sway);
    // face: sunken red eyes, slack jaw, a graft plate over one cheek
    A.eyeMeshes = eyes(p.head, { mat: red, y: 0.03, z: -0.145, dx: 0.075, size: 0.075, tall: 0.75 });
    add(p.head, box(0.18, 0.06, 0.04, rough(0x140a0a), true), 0, -0.09, -0.14);
    add(p.head, box(0.10, 0.16, 0.03, metal(0x8a949a)), -0.11, -0.02, -0.145);
    add(p.head, box(0.26, 0.08, 0.26, rough(0x1e3318)), 0, 0.13, 0.01);
    // sidearm
    add(p.rightElbow, box(0.07, 0.13, 0.22, metal(0x1b1b1b)), 0, -0.34, -0.09);
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
      legMat: rough(0x4b3524), footMat: rough(0x191410), legR: 0.095
    });
    // bandolier of shells across the chest
    add(p.torso, box(0.52, 0.30, 0.36, plate), 0, 0.40, 0);
    for (var i = 0; i < 5; i++) {
      add(p.torso, cyl(0.028, 0.028, 0.07, E(0xff3b1f, 1.1), 6), -0.20 + i * 0.10, 0.52 - i * 0.045, -0.19, Math.PI / 2);
    }
    // helmet + visor band instead of eyes
    add(p.head, box(0.34, 0.14, 0.34, plate), 0, 0.14, 0);
    add(p.head, box(0.30, 0.06, 0.03, amber, true), 0, 0.01, -0.15);
    add(p.head, box(0.20, 0.07, 0.05, rough(0x241a12), true), 0, -0.10, -0.14);
    A.pulse.push({ m: amber, base: 2.0, amp: 0.7, f: 1.1, ph: 0 });
    // shotgun held two-handed, barrels forward
    var gun = grp(p.torso, 0.08, 0.19, -0.44, 0.10, 0, 0);
    add(gun, box(0.075, 0.075, 0.62, metal(0x22262a)), 0, 0.04, -0.10);
    add(gun, cyl(0.032, 0.032, 0.56, metal(0x0d0f11), 8), -0.035, 0.10, -0.14, Math.PI / 2);
    add(gun, cyl(0.032, 0.032, 0.56, metal(0x0d0f11), 8), 0.035, 0.10, -0.14, Math.PI / 2);
    add(gun, box(0.07, 0.16, 0.16, rough(0x3a2413)), 0, -0.04, 0.22, -0.3);
    add(gun, box(0.05, 0.03, 0.10, E(0x00e5ff, 1.2), true), 0, 0.12, 0.06);
    p.leftShoulder.rotation.set(0.95, 0, 0.42);
    p.rightShoulder.rotation.set(1.15, 0, -0.34);
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
      legMat: dark, footMat: rough(0x111416), legR: 0.13
    });
    // slab chest, ammo hoppers on the back, ribbed belly
    add(p.torso, box(1.00, 0.30, 0.56, dark), 0, 0.46, 0);
    add(p.torso, box(0.30, 0.42, 0.24, metal(0x585f64)), -0.34, 0.34, 0.30);
    add(p.torso, box(0.30, 0.42, 0.24, metal(0x585f64)), 0.34, 0.34, 0.30);
    for (var i = 0; i < 3; i++) add(p.torso, box(0.62, 0.05, 0.04, cy, true), 0, 0.14 + i * 0.09, -0.27);
    // squat helmeted head with one red targeting lens
    add(p.head, box(0.42, 0.16, 0.40, armor), 0, 0.13, 0);
    add(p.head, box(0.34, 0.07, 0.03, rough(0x0a0c0d), true), 0, 0.0, -0.18);
    var lens = add(p.head, sph(0.055, red, 8, 6, true), 0.09, 0.0, -0.20);
    A.pulse.push({ m: red, base: 2.0, amp: 1.1, f: 2.6, ph: 0 });
    // two rotary cannons, one per hand: hub + 4 barrels, hub spins
    ['left', 'right'].forEach(function (side, k) {
      var sgn = side === 'left' ? -1 : 1;
      var arm = p[side + 'Shoulder'];
      arm.rotation.set(1.35, 0, sgn * 0.12);
      var hub = grp(p[side + 'Elbow'], 0, -0.30, -0.10, -Math.PI / 2, 0, 0);
      add(hub, cyl(0.15, 0.15, 0.16, metal(0x2c3134), 10), 0, 0.10, 0);
      for (var b = 0; b < 4; b++) {
        var a = b / 4 * Math.PI * 2;
        add(hub, cyl(0.038, 0.038, 0.62, metal(0x0b0d0e), 6), Math.cos(a) * 0.085, 0.34, Math.sin(a) * 0.085);
      }
      add(hub, cyl(0.16, 0.13, 0.10, metal(0x6a7276), 10), 0, -0.02, 0);
      add(hub, tor(0.115, 0.02, cy, 4, 10, true), 0, 0.62, 0, Math.PI / 2);
      A.spin.push({ o: hub, axis: 'y', rate: 1.4 + k * 0.3 });
    });
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
      legMat: dark, footMat: horn, legR: 0.07
    });
    // ribs and a glowing furnace in the chest
    for (var i = 0; i < 4; i++) add(p.torso, box(0.40 - i * 0.02, 0.035, 0.28, dark), 0, 0.16 + i * 0.11, 0);
    add(p.torso, sph(0.10, org, 8, 6, true), 0, 0.34, -0.13);
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
    });
    // long snouted head, yellow eyes, horns
    add(p.head, box(0.18, 0.12, 0.16, dark), 0, -0.05, -0.16);
    teeth(p.head, { n: 4, w: 0.16, mat: rough(0xdedac8), h: 0.05, y: -0.08, z: -0.22 });
    A.eyeMeshes = eyes(p.head, { mat: ylw, y: 0.05, z: -0.13, dx: 0.075, size: 0.075, tall: 0.6 });
    add(p.head, cone(0.045, 0.24, horn, 5), -0.11, 0.20, 0.02, -0.35);
    add(p.head, cone(0.045, 0.24, horn, 5), 0.11, 0.20, 0.02, -0.35);
    A.pulse.push({ m: org, base: 2.0, amp: 0.8, f: 1.7, ph: 0.5 });
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
      legMat: deep, footMat: rough(0x3a1020), legR: 0.15
    });
    // hunched shoulder hump where the head should be
    var hump = add(p.torso, sph(0.34, deep, 10, 7), 0, 0.70, 0.10);
    hump.scale.set(1.45, 0.42, 1.0); // a shoulder ridge, deliberately not a head
    add(p.torso, box(0.22, 0.14, 0.26, deep), -0.36, 0.68, 0.02);
    add(p.torso, box(0.22, 0.14, 0.26, deep), 0.36, 0.68, 0.02);
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
    // gorilla arms: knuckles on the floor
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      p[side + 'Shoulder'].rotation.set(0.10, 0, sgn * 0.10);
      add(p[side + 'Elbow'], sph(0.18, deep, 8, 6), 0, -0.58, 0);
    });
    A.pulse.push({ m: ylw, base: 2.4, amp: 0.6, f: 2.0, ph: 0 });
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
    // ribcage read-through and a spine of cyan nodes
    for (var i = 0; i < 5; i++) {
      add(p.torso, box(0.30 - i * 0.015, 0.02, 0.20, deep, true), 0, 0.12 + i * 0.12, 0);
      add(p.torso, sph(0.022, cy, 6, 4, true), 0, 0.14 + i * 0.12, 0.10);
    }
    // shredded tail instead of legs
    var tail = grp(root, 0, 1.05, 0);
    for (var t = 0; t < 4; t++) {
      var w = 0.20 - t * 0.03;
      add(tail, box(w, 0.30, w * 0.7, deep, true), (t % 2 ? 0.04 : -0.04), -0.15 - t * 0.26, 0);
      A.sway.push({ o: tail, amp: 0.05, f: 0.9, ph: t });
    }
    add(tail, cone(0.09, 0.34, deep, 6, true), 0, -0.98, 0, Math.PI);
    // hollow face
    A.eyeMeshes = eyes(p.head, { mat: cy, y: 0.02, z: -0.115, dx: 0.062, size: 0.065, tall: 1.1 });
    add(p.head, box(0.14, 0.10, 0.03, M(0x06202a, 0, 0.5, { transparent: true, opacity: 0.6 }), true), 0, -0.08, -0.11);
    p.leftShoulder.rotation.set(0.2, 0, 0.25);
    p.rightShoulder.rotation.set(0.2, 0, -0.25);
    A.bob.push({ o: root, amp: 0.07, f: 0.8, ph: 0 });
    A.pulse.push({ m: cy, base: 2.6, amp: 1.4, f: 0.7, ph: 0 });
    p.tail = tail;
    return p;
  };

  // --- 7. Cacodemon (3005): round flying robot, red eye, lasers --------
  BUILDERS[3005] = function (root, A) {
    var shell = M(0xa52422, 0.3, 0.5), dark = M(0x3a1211, 0.3, 0.5), rim = metal(0x6d777c);
    var red = E(0xff1f1f, 2.6), cy = E(0x00e5ff, 1.8);
    var hull = grp(root, 0, 1.50, 0);
    add(hull, sph(0.72, shell, 12, 9), 0, 0, 0);
    // panel seams and armour plates
    add(hull, tor(0.70, 0.05, rim, 4, 14), 0, 0, 0, Math.PI / 2);
    add(hull, tor(0.66, 0.045, dark, 4, 14), 0, 0.16, 0, Math.PI / 2);
    for (var s = 0; s < 6; s++) {
      var a = s / 6 * Math.PI * 2;
      add(hull, cone(0.07, 0.22, rim, 5), Math.cos(a) * 0.60, 0.36, Math.sin(a) * 0.60, 0, 0, -Math.cos(a) * 0.5);
    }
    // single huge lens eye with an iris ring and a brow plate
    var socket = grp(hull, 0, 0.02, -0.58);
    add(socket, cyl(0.30, 0.34, 0.16, dark, 12), 0, 0, 0, Math.PI / 2);
    add(socket, tor(0.27, 0.035, rim, 4, 14), 0, 0, -0.06, 0);
    var iris = add(socket, sph(0.22, red, 10, 8, true), 0, 0, -0.11);
    add(socket, sph(0.08, E(0xffe0e0, 3.0), 6, 5, true), 0, 0, -0.24);
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
    A.spin.push({ o: rotor, axis: 'y', rate: 2.2 });
    A.bob.push({ o: root, amp: 0.13, f: 0.9, ph: 0 });
    A.pulse.push({ m: red, base: 2.6, amp: 1.3, f: 1.4, ph: 0 }, { m: cy, base: 1.8, amp: 0.5, f: 3.0, ph: 1 });
    A.eyeMeshes = [iris];
    return { hull: hull, rotor: rotor, limbs: null };
  };

  // --- 8/9. Hell Knight (69) and Baron of Hell (3003) ------------------

  function knight(root, A, o) {
    var plate = M(o.plate, 0.5, 0.40), under = M(o.under, 0.35, 0.55), dark = M(0x14181b, 0.3, 0.5);
    var accent = E(o.accent, 2.2);
    var p = humanoid(root, {
      hipY: 0.86, torsoW: 0.72, torsoH: 0.66, torsoD: 0.44, torsoMat: plate,
      headSize: 0.34, headMat: plate, shoulderW: 0.42, upper: 0.38, fore: 0.34,
      armMat: under, handMat: plate, armR: 0.10, thigh: 0.44, shin: 0.40,
      legMat: under, footMat: plate, legR: 0.13
    });
    // segmented cuirass, exhaust stacks, glowing chest core
    add(p.torso, box(0.78, 0.26, 0.48, plate), 0, 0.52, 0);
    add(p.torso, box(0.60, 0.18, 0.46, under), 0, 0.20, 0);
    add(p.torso, sph(0.10, accent, 8, 6, true), 0, 0.44, -0.24);
    add(p.torso, tor(0.13, 0.028, dark, 4, 10), 0, 0.44, -0.24, 0);
    add(p.torso, cyl(0.05, 0.05, 0.26, dark, 6), -0.22, 0.72, 0.22);
    add(p.torso, cyl(0.05, 0.05, 0.26, dark, 6), 0.22, 0.72, 0.22);
    // pauldrons
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      add(p[side + 'Shoulder'], sph(0.19, plate, 8, 6), 0, 0.02, 0);
      add(p[side + 'Shoulder'], cone(0.05, 0.18, dark, 5), sgn * 0.16, 0.14, 0, 0, 0, sgn * 0.9);
      add(p[side + 'Elbow'], box(0.22, 0.10, 0.22, plate), 0, 0.0, 0);
    });
    // oversized helmet, black visor with a scanline
    add(p.head, box(0.44, 0.24, 0.42, plate), 0, 0.16, 0);
    add(p.head, box(0.40, 0.16, 0.05, dark, true), 0, 0.06, -0.20);
    var scan = add(p.head, box(0.34, 0.035, 0.03, accent, true), 0, 0.06, -0.225);
    add(p.head, cone(0.06, 0.24, plate, 5), -0.20, 0.27, 0.0, -0.4, 0, -0.5);
    add(p.head, cone(0.06, 0.24, plate, 5), 0.20, 0.27, 0.0, -0.4, 0, 0.5);
    add(p.head, box(0.10, 0.20, 0.06, plate), 0, 0.26, -0.16);
    A.pulse.push({ m: accent, base: 2.2, amp: 0.9, f: 1.2, ph: 0 });
    A.eyeMeshes = [scan];
    return p;
  }

  BUILDERS[69] = function (root, A) {
    return knight(root, A, { plate: 0xa8b3ba, under: 0x4b5459, accent: 0x00e5ff });
  };
  BUILDERS[3003] = function (root, A) {
    var p = knight(root, A, { plate: 0xd9a520, under: 0x6b4a10, accent: 0xff2ec4 });
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
    // exposed rib cage over the dark chassis
    for (var i = 0; i < 4; i++) {
      add(p.torso, box(0.44, 0.035, 0.30, bone), 0, 0.14 + i * 0.13, 0);
    }
    add(p.torso, box(0.09, 0.56, 0.09, bone), 0, 0.28, 0.14);
    // shoulder rocket pods with visible warheads
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      var pod = grp(p.torso, sgn * 0.34, 0.56, 0.02);
      add(pod, box(0.20, 0.20, 0.34, dark), 0, 0, 0);
      add(pod, cone(0.05, 0.14, org, 5, true), -0.05, 0.05, -0.22, -Math.PI / 2);
      add(pod, cone(0.05, 0.14, org, 5, true), 0.05, 0.05, -0.22, -Math.PI / 2);
      add(pod, box(0.21, 0.04, 0.05, grn, true), 0, 0.11, -0.10);
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
    A.flame.push({ o: flame, s0: 1 });
    A.bob.push({ o: root, amp: 0.10, f: 1.3, ph: 0 });
    A.pulse.push({ m: org, base: 2.4, amp: 1.0, f: 6.0, ph: 0 });
    A.blink.push({ o: A.eyeMeshes[0] }, { o: A.eyeMeshes[1] });
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
      armMat: hull, handMat: hull, armR: 0.11
    });
    p.head.position.y += 0.10;
    // fat rolls, fuel tanks, feed pipes
    var r1 = add(p.torso, sph(0.36, fat, 10, 7), 0, 0.24, -0.08);
    var r2 = add(p.torso, sph(0.32, fat, 10, 7), 0, 0.52, -0.05);
    r1.scale.set(1.25, 0.62, 0.95); r2.scale.set(1.15, 0.58, 0.9);
    add(p.torso, cyl(0.15, 0.15, 0.46, rim, 8), -0.34, 0.44, 0.30);
    add(p.torso, cyl(0.15, 0.15, 0.46, rim, 8), 0.34, 0.44, 0.30);
    add(p.torso, box(0.30, 0.05, 0.05, grn, true), 0, 0.30, -0.44);
    cable(p.torso, { mat: rubber(0x14181b), x: -0.30, y: 0.62, z: 0.22, n: 4, len: 0.11, r: 0.028, tilt: -0.7 }, A.sway);
    cable(p.torso, { mat: rubber(0x14181b), x: 0.30, y: 0.62, z: 0.22, n: 4, len: 0.11, r: 0.028, tilt: -0.7 }, A.sway);
    // squashed head, breathing mask, green optic band
    add(p.head, box(0.30, 0.16, 0.16, hull), 0, -0.06, -0.14);
    add(p.head, box(0.30, 0.05, 0.03, grn, true), 0, 0.08, -0.17);
    add(p.head, cyl(0.045, 0.045, 0.22, rubber(0x14181b), 6), -0.18, -0.08, -0.06, 0, 0, 1.2);
    // arm flame cannons
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      p[side + 'Shoulder'].rotation.set(1.25, 0, sgn * 0.1);
      var c = grp(p[side + 'Elbow'], 0, -0.26, -0.16, -Math.PI / 2, 0, 0);
      add(c, cyl(0.14, 0.16, 0.46, hull, 10), 0, 0.20, 0);
      add(c, cyl(0.11, 0.13, 0.14, rim, 10), 0, 0.48, 0);
      add(c, cyl(0.09, 0.09, 0.08, org, 10, true), 0, 0.56, 0);
      add(c, box(0.06, 0.24, 0.06, rim), 0.14, 0.20, 0);
    });
    // tank bottom with two tread bands
    var base = grp(root, 0, 0, 0);
    add(base, box(1.10, 0.44, 1.10, hull), 0, 0.60, 0);
    add(base, box(0.90, 0.14, 0.90, rim), 0, 0.86, 0);
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
      armMat: flesh2, handMat: chas, armR: 0.06
    });
    add(p.torso, box(0.50, 0.22, 0.36, chas), 0, 0.14, 0);
    add(p.torso, box(0.34, 0.05, 0.04, cy, true), 0, 0.34, -0.18);
    add(p.head, box(0.30, 0.14, 0.30, chas), 0, 0.12, 0);
    A.eyeMeshes = eyes(p.head, { mat: cy, y: 0.0, z: -0.135, dx: 0.07, size: 0.07, tall: 0.7 });
    add(p.head, cyl(0.02, 0.02, 0.20, silver, 5), 0.14, 0.28, 0);
    add(p.head, sph(0.03, mag, 6, 4, true), 0.14, 0.40, 0);
    // abdomen dome + underslung plasma cannon
    var dome = grp(root, 0, 0.68, 0.06);
    add(dome, sph(0.46, chas, 12, 8), 0, 0, 0);
    add(dome, tor(0.42, 0.045, silver, 4, 12), 0, 0.06, 0, Math.PI / 2);
    add(dome, box(0.34, 0.05, 0.04, mag, true), 0, 0.24, -0.36);
    var gun = grp(dome, 0, -0.24, -0.34, 0.25, 0, 0);
    add(gun, cyl(0.09, 0.11, 0.40, silver, 8), 0, 0, -0.10, Math.PI / 2);
    add(gun, cyl(0.07, 0.07, 0.10, mag, 8, true), 0, 0, -0.32, Math.PI / 2);
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
      hipG.userData.lower = knee;
      hipG.userData.rest = hipG.position.y;
      hipG.userData.ry0 = -a;
      legs.push(hipG);
    }
    A.legs = legs;
    A.pulse.push({ m: mag, base: 2.4, amp: 1.0, f: 1.8, ph: 0 }, { m: cy, base: 2.0, amp: 0.6, f: 2.6, ph: 1 });
    p.limbs = null; // no bipedal walk cycle — spider legs are driven here
    p.dome = dome;
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
    for (var i = 0; i < 4; i++) {
      var a = i / 4 * Math.PI * 2 + 0.4;
      add(hips, cyl(0.022, 0.022, 0.50, rib, 5), Math.cos(a) * 0.15, 0.44, Math.sin(a) * 0.11, 0.12 * Math.sin(a), 0, -0.12 * Math.cos(a));
    }
    var core = add(hips, sph(0.15, ylw, 10, 8, true), 0, 0.44, 0);
    add(hips, tor(0.19, 0.025, org, 4, 12, true), 0, 0.44, 0, Math.PI / 2);
    // chest and shoulders
    add(p.torso, box(0.50, 0.26, 0.34, burnt), 0, 0.20, 0);
    add(p.torso, box(0.36, 0.05, 0.04, org, true), 0, 0.30, -0.18);
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
    A.spin.push({ o: headG, axis: 'y', rate: 0.6 });
    A.pulse.push({ m: ylw, base: 2.8, amp: 1.4, f: 3.2, ph: 0 }, { m: org, base: 2.4, amp: 1.0, f: 4.5, ph: 1 });
    p.core = core;
    return p;
  };

  // --- 14. Cyberdemon (16): cable body, arm guns, sliding legs ---------
  BUILDERS[16] = function (root, A) {
    var skin = flesh(0xc9a68a), silver = metal(0xb6c1c7), dark = M(0x1c2225, 0.35, 0.5);
    var red = E(0xff1f1f, 2.4), cy = E(0x00e5ff, 1.8);
    // human head on a machine
    var head = grp(root, 0, 2.02, 0);
    add(head, box(0.34, 0.36, 0.32, skin), 0, 0, 0);
    add(head, box(0.36, 0.10, 0.34, silver), 0, 0.20, 0);
    add(head, cone(0.055, 0.30, silver, 5), -0.16, 0.32, 0, -0.35, 0, -0.5);
    add(head, cone(0.055, 0.30, silver, 5), 0.16, 0.32, 0, -0.35, 0, 0.5);
    var ey = eyes(head, { mat: red, y: 0.04, z: -0.165, dx: 0.085, size: 0.075, tall: 0.7 });
    add(head, box(0.18, 0.06, 0.04, dark, true), 0, -0.12, -0.16);
    add(head, box(0.10, 0.22, 0.06, silver), 0.19, -0.02, 0);
    cable(head, { mat: rubber(0x101418), x: -0.16, y: -0.14, z: 0.14, n: 3, len: 0.14, r: 0.03, tilt: 0.5 }, A.sway);
    // torso: a stack of counter-rotating cable coils around a dark spine
    var spine = grp(root, 0, 1.30, 0);
    add(spine, cyl(0.16, 0.20, 1.10, dark, 8), 0, 0.16, 0);
    var coils = [];
    for (var i = 0; i < 5; i++) {
      var c = grp(spine, 0, -0.20 + i * 0.24, 0);
      add(c, tor(0.30 - i * 0.015, 0.055, silver, 4, 12), 0, 0, 0, Math.PI / 2);
      coils.push(c);
      A.spin.push({ o: c, axis: 'y', rate: (i % 2 ? -0.8 : 0.8) });
    }
    add(spine, box(0.44, 0.05, 0.05, cy, true), 0, 0.70, -0.20);
    add(spine, box(0.52, 0.24, 0.34, dark), 0, 0.74, 0.04);
    // arm gun barrels
    ['left', 'right'].forEach(function (side) {
      var sgn = side === 'left' ? -1 : 1;
      var arm = grp(spine, sgn * 0.50, 0.66, 0);
      add(arm, sph(0.17, silver, 8, 6), 0, 0, 0);
      add(arm, cyl(0.11, 0.13, 0.46, dark, 8), 0, -0.26, 0);
      var bar = grp(arm, 0, -0.46, -0.16, -Math.PI / 2, 0, 0);
      add(bar, cyl(0.13, 0.13, 0.66, silver, 10), 0, 0.28, 0);
      add(bar, cyl(0.10, 0.10, 0.10, dark, 10), 0, 0.64, 0);
      add(bar, tor(0.11, 0.022, red, 4, 10, true), 0, 0.68, 0, Math.PI / 2);
      add(bar, box(0.05, 0.30, 0.05, cy, true), 0.13, 0.24, 0);
    });
    // intertwined legs that slide past each other instead of stepping
    var legs = [];
    [-1, 1].forEach(function (sgn) {
      var lg = grp(root, sgn * 0.20, 1.10, 0);
      add(lg, cyl(0.13, 0.17, 0.62, silver, 8), 0, -0.31, 0, 0, 0, -sgn * 0.10);
      add(lg, cyl(0.11, 0.09, 0.44, dark, 8), sgn * 0.06, -0.82, 0);
      add(lg, box(0.24, 0.10, 0.42, silver), sgn * 0.08, -1.03, -0.06);
      for (var k = 0; k < 3; k++) add(lg, tor(0.15, 0.03, dark, 4, 10), 0, -0.14 - k * 0.22, 0, Math.PI / 2);
      lg.userData.rest = 1.10;
      legs.push(lg);
      A.slide.push({ o: lg, amp: 0.09, f: 2.2, ph: sgn > 0 ? Math.PI : 0, y0: 1.10 });
    });
    A.pulse.push({ m: red, base: 2.4, amp: 1.1, f: 1.6, ph: 0 }, { m: cy, base: 1.8, amp: 0.6, f: 2.2, ph: 1 });
    A.eyeMeshes = ey;
    A.blink.push({ o: ey[0] }, { o: ey[1] });
    return { head: head, spine: spine, coils: coils, legs: legs, limbs: null };
  };

  // --- 15. Spider Mastermind (7): giant brain in a jar on a tank -------
  BUILDERS[7] = function (root, A) {
    var hull = M(0x2b3439, 0.4, 0.5), rim = metal(0x8a949a), dark = rubber(0x14181b);
    var glass = M(0xa8e6f0, 0.1, 0.1, { transparent: true, opacity: 0.28, depthWrite: false });
    var brainM = flesh(0xe3aebd), cy = E(0x00e5ff, 1.8), mag = E(0xff2ec4, 2.4);
    // tank chassis
    var base = grp(root, 0, 0, 0);
    add(base, box(1.20, 0.40, 1.20, hull), 0, 0.46, 0);
    add(base, box(1.00, 0.12, 1.00, rim), 0, 0.70, 0);
    add(base, box(0.70, 0.06, 0.06, cy, true), 0, 0.60, -0.62);
    var treads = [];
    [-1, 1].forEach(function (sgn) {
      var band = grp(base, sgn * 0.66, 0.28, 0);
      add(band, box(0.26, 0.42, 1.30, dark), 0, 0, 0);
      for (var w = 0; w < 3; w++) treads.push(add(band, cyl(0.19, 0.19, 0.28, rim, 10), 0, -0.02, -0.42 + w * 0.42, 0, 0, Math.PI / 2));
      add(band, box(0.30, 0.06, 1.26, rim), 0, 0.23, 0);
    });
    treads.forEach(function (o) { A.spin.push({ o: o, axis: 'y', rate: 2.4, tread: true }); });
    // chin guns on the front of the chassis
    [-1, 1].forEach(function (sgn) {
      var g = grp(base, sgn * 0.34, 0.52, -0.62, -Math.PI / 2, 0, 0);
      add(g, cyl(0.07, 0.08, 0.44, rim, 8), 0, 0.18, 0);
      add(g, cyl(0.05, 0.05, 0.08, mag, 8, true), 0, 0.42, 0);
    });
    // the jar: collar, glass, cap, and cable feeds
    var jarG = grp(root, 0, 0.76, 0);
    add(jarG, cyl(0.56, 0.60, 0.14, rim, 14), 0, 0.05, 0);
    add(jarG, cyl(0.52, 0.52, 0.86, glass, 14, true), 0, 0.55, 0);
    add(jarG, cyl(0.56, 0.52, 0.12, rim, 14), 0, 1.02, 0);
    for (var b = 0; b < 4; b++) {
      var ba = b / 4 * Math.PI * 2 + 0.6;
      add(jarG, cyl(0.025, 0.025, 0.90, rim, 5), Math.cos(ba) * 0.52, 0.55, Math.sin(ba) * 0.52);
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
    return { base: base, jar: jarG, brain: brain, treads: treads, limbs: null };
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
    3005: { hp: 150,  speed: 3.2, attack: 'laser',   range: 26, cooldown: 1.8, damage: 15, scale: 1.0 },
    69:   { hp: 300,  speed: 3.4, attack: 'fireball', range: 24, cooldown: 2.0, damage: 22, scale: 1.0 },
    3003: { hp: 500,  speed: 3.2, attack: 'fireball', range: 26, cooldown: 1.8, damage: 28, scale: 1.25 },
    66:   { hp: 220,  speed: 4.2, attack: 'fireball', range: 28, cooldown: 2.0, damage: 20, scale: 1.0 },
    67:   { hp: 400,  speed: 2.4, attack: 'fireball', range: 22, cooldown: 1.6, damage: 24, scale: 1.0 },
    68:   { hp: 350,  speed: 3.0, attack: 'fireball', range: 24, cooldown: 1.0, damage: 14, scale: 1.0 },
    64:   { hp: 450,  speed: 3.8, attack: 'fireball', range: 26, cooldown: 2.6, damage: 30, scale: 1.0 },
    16:   { hp: 1000, speed: 2.5, attack: 'fireball', range: 30, cooldown: 1.6, damage: 40, scale: 1.0 },
    7:    { hp: 1200, speed: 2.5, attack: 'hitscan', range: 30, cooldown: 0.9, damage: 14, scale: 1.0 }
  };
  var DEFAULT_STATS = { hp: 50, speed: 3.5, attack: 'melee', range: 2.5, cooldown: 1.6, damage: 10, scale: 1.0 };

  function stats(typeId) {
    return STATS[parseInt(typeId, 10)] || DEFAULT_STATS;
  }

  // ---------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------

  function build(typeId, ent, THREE) {
    T = THREE || T || (typeof window !== 'undefined' ? window.THREE : null);
    if (!T) throw new Error('CyberEnemies.build needs THREE');

    var id = parseInt(typeId, 10);
    if (!BUILDERS[id]) id = (ent && ent.type === 'soldier') ? 3004 : 0;

    var root = new T.Group();
    var A = {
      bob: [], sway: [], spin: [], pulse: [], blink: [], flame: [], slide: [],
      jaw: null, legs: null, eyeMeshes: [], t: 0, flashT: 0
    };
    var accents = [];
    buildAccents = accents;
    var parts;
    try {
      parts = BUILDERS[id](root, A) || {};
    } finally {
      buildAccents = null;
    }

    // bake rest positions so animate() never accumulates drift
    A.bob.forEach(function (b) { b.y0 = b.o.position.y; });
    A.sway.forEach(function (s) { s.z0 = s.o.rotation.z; });
    A.flame.forEach(function (f) { f.y0 = f.o.position.y; });

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
  // animate
  // ---------------------------------------------------------------------

  function animate(enemy, t, delta) {
    if (!enemy) return;
    var g = enemy.group;
    if (!g) return;
    var A = g.userData && g.userData.anim;
    if (!A) return;
    if (enemy.state === 'DEAD') { decayFlash(g, A, delta); return; }

    var i, o;
    A.t = t;
    var moving = enemy.state === 'CHASE';

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
    // Pinky's chest jaw gapes when it is close enough to bite. The engine only
    // winds attackCooldown while the enemy is inside its melee ring.
    if (A.jaw) {
      var want = (enemy.attackCooldown > 0) ? A.jaw.open : A.jaw.closed;
      A.jaw.o.rotation.x += (want - A.jaw.o.rotation.x) * Math.min(1, delta * 9);
    }
    // spider gait for the Arachnotron
    if (A.legs) {
      for (i = 0; i < A.legs.length; i++) {
        var lg = A.legs[i];
        var ph = t * (moving ? 7 : 1.2) + i * (Math.PI / 3) * 2;
        var lift = Math.max(0, Math.sin(ph));
        lg.position.y = lg.userData.rest + lift * (moving ? 0.11 : 0.02);
        lg.rotation.y = lg.userData.ry0 + Math.cos(ph) * (moving ? 0.20 : 0.05);
        if (lg.userData.lower) lg.userData.lower.rotation.z = lift * (moving ? 0.28 : 0.05);
      }
    }
    // idle breathing for anything with a humanoid torso and no explicit bob
    var parts = g.userData.parts;
    if (parts && parts.torso && !A.bob.length) {
      parts.torso.rotation.z = Math.sin(t * 1.1) * 0.018;
      parts.torso.position.x = Math.sin(t * 0.9) * 0.01;
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
    autoDrive: true
  };

  if (typeof window !== 'undefined') window.CyberEnemies = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
