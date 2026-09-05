/* ==========================================================================
   CYBERHELL WEAPON SYSTEM
   FPS viewmodels (3D primitives parented to the camera) + the WEAPONS table
   that drives firing.  Loaded before the inline engine script; THREE is only
   touched inside methods, which run after the CDN <script> has executed.
   ========================================================================== */

/* Ammo economy ----------------------------------------------------------- */
const AMMO_CAP = { bullets: 200, shells: 50, energy: 300 };
const AMMO_START = { bullets: 50, shells: 0, energy: 0 };

/* Canonical order: HUD slot order, key order and wheel-cycle order. */
const WEAPON_ORDER = ['chainsaw', 'pistol', 'machinegun', 'shotgun', 'energy_rifle', 'energy_repeater'];

/* -------------------------------------------------------------------------
   Shared materials.  Three colour zones on every weapon: dark gunmetal body,
   cyan energy, red/orange accents.
   ------------------------------------------------------------------------- */
function matGun(c = 0x1a2530) {
  return new THREE.MeshStandardMaterial({ color: c, metalness: 0.9, roughness: 0.25 });
}
function matDark() {
  return new THREE.MeshStandardMaterial({ color: 0x0d1117, roughness: 0.7 });
}
function matEnergy(intensity = 0.7) {
  return new THREE.MeshStandardMaterial({ color: 0x00ffee, emissive: 0x00ffff, emissiveIntensity: intensity });
}
function matAccent(c = 0xff6600, e = 0xff3300) {
  return new THREE.MeshStandardMaterial({ color: c, emissive: e, emissiveIntensity: 0.35, roughness: 0.4 });
}

/* Shared detail kit -------------------------------------------------------
   Everything here is geometry only: worn edges are darker chamfer strips,
   screws are tiny spheres, and every hidden helper (muzzle flashes, ejected
   cases, sparks) is tagged hideInPickup so buildPickupMesh leaves it off. */
let _detailGeo = null;
function detailGeo() {
  if (!_detailGeo) {
    _detailGeo = {
      rivet: new THREE.SphereGeometry(0.006, 5, 4),
      flashCone: new THREE.ConeGeometry(0.05, 0.20, 6),
      flashBlade: new THREE.BoxGeometry(0.12, 0.010, 0.016),
      flashRing: new THREE.TorusGeometry(0.05, 0.012, 4, 10),
      case_: new THREE.CylinderGeometry(0.011, 0.011, 0.032, 6)
    };
  }
  return _detailGeo;
}
function matWorn() {
  return new THREE.MeshStandardMaterial({ color: 0x090d12, metalness: 0.65, roughness: 0.45 });
}
function matSteel() {
  return new THREE.MeshStandardMaterial({ color: 0x7d8894, metalness: 0.95, roughness: 0.28 });
}
function matFlash(c = 0xffd27a) {
  return new THREE.MeshStandardMaterial({
    color: 0x100c04, emissive: c, emissiveIntensity: 1.9, transparent: true, opacity: 0.85, depthWrite: false
  });
}
/** A darker chamfer strip along an edge — reads as wear without a texture. */
function edge(parent, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matWorn());
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function rivets(parent, n, x, y, z, dz) {
  const g = detailGeo().rivet, mat = matSteel();
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z + i * dz);
    parent.add(m);
  }
}
/** Pooled muzzle flash. kind: 'star' | 'wide' | 'ring'. Hidden until fired. */
function muzzleFlash(kind, color) {
  const D = detailGeo(), g = new THREE.Group(), mat = matFlash(color);
  const cone = new THREE.Mesh(D.flashCone, mat);
  cone.rotation.x = -Math.PI / 2;
  g.add(cone);
  if (kind === 'star') {
    const b1 = new THREE.Mesh(D.flashBlade, mat);
    const b2 = new THREE.Mesh(D.flashBlade, mat);
    b2.rotation.z = Math.PI / 2;
    g.add(b1, b2);
  } else if (kind === 'wide') {
    cone.scale.set(1.7, 0.55, 1.7);
  } else if (kind === 'ring') {
    const r = new THREE.Mesh(D.flashRing, mat);
    g.add(r);
    cone.scale.set(0.6, 1.5, 0.6);
  }
  g.visible = false;
  g.traverse(o => { o.userData.hideInPickup = true; });
  g.userData.hideInPickup = true;
  return g;
}
/** Pooled ejected case: one mesh per weapon, flown on an arc after a shot. */
function ejectCase(color) {
  const m = new THREE.Mesh(detailGeo().case_, new THREE.MeshStandardMaterial({
    color: color, metalness: 0.85, roughness: 0.35
  }));
  m.visible = false;
  m.userData.hideInPickup = true;
  return m;
}

/* Chain path for the Cyber Ripper: a stadium (two straights + two arcs)
   traced around the guide bar.  s in [0,1) -> [y, z] in local bar space. */
function stadiumPoint(s, halfLen, r) {
  const straight = 2 * halfLen;
  const arc = Math.PI * r;
  const total = 2 * straight + 2 * arc;
  let d = ((s % 1) + 1) % 1 * total;
  if (d < straight) return [r, halfLen - d];                                  // top, travelling forward
  d -= straight;
  if (d < arc) { const a = d / r; return [r * Math.cos(a), -halfLen - r * Math.sin(a)]; } // nose
  d -= arc;
  if (d < straight) return [-r, -halfLen + d];                                // bottom, travelling back
  d -= straight;
  const a = d / r;
  return [-r * Math.cos(a), halfLen + r * Math.sin(a)];                       // tail
}

class WeaponViewmodels {
  constructor(camera, engine) {
    this.camera = camera;
    this.engine = engine || null;
    this.holder = new THREE.Group();
    this.camera.add(this.holder);

    this.weapons = {};
    this.currentKey = 'pistol';
    this.recoilOffset = 0;
    this.bobTimer = 0;

    // Per-frame animation state, written by the engine's weapon tick.
    this.sawRunning = false;
    this.sawRev = false;
    this.sawEnergyFrac = 0;
    this.spinSpeed = 0;   // machinegun barrel spin, decays
    this.heat = 0;        // repeater vent glow, 0..1
    this.charge = 0;      // energy rifle capacitor, 0..1
    this.chainPhase = 0;
    this.flashT = 0;      // muzzle flash countdown, seconds
    this.ejectT = 0;      // ejected case flight, 1 -> 0
    this.pumpT = 0;       // shotgun pump cycle, 1 -> 0
    this.irisT = 0;       // energy rifle muzzle iris, 1 -> 0
    this.hammerT = 0;     // pistol hammer fall, 1 -> 0
    this.revKick = 0;     // chainsaw rev-up kick, 1 -> 0
    this._prevRev = false;
    this.emitterIdx = 0;  // repeater alternates its two emitters

    this.buildWeapons();
    this.setWeapon('pistol');
  }

  /* ======================================================================
     MODELS
     ====================================================================== */
  buildWeapons() {
    this.weapons['chainsaw'] = this.buildChainsaw();
    this.weapons['pistol'] = this.buildPistol();
    this.weapons['machinegun'] = this.buildMachinegun();
    this.weapons['shotgun'] = this.buildShotgun();
    this.weapons['energy_rifle'] = this.buildEnergyRifle();
    this.weapons['energy_repeater'] = this.buildEnergyRepeater();

    Object.keys(this.weapons).forEach(k => {
      const w = this.weapons[k];
      w.mesh.visible = false;
      this.holder.add(w.mesh);
    });

    // Muzzle Flash Dynamic Light
    this.muzzleLight = new THREE.PointLight(0x00ffff, 0, 10);
    this.muzzleLight.position.set(0.2, -0.1, -0.8);
    this.holder.add(this.muzzleLight);

    // Weapon key light: short range on purpose, so the viewmodel always reads
    // in a dark sector without spilling onto the level the lighting owns.
    this.keyLight = new THREE.PointLight(0xbfd8ff, 1.6, 1.6, 2);
    this.keyLight.position.set(0.55, 0.35, -0.15);
    this.holder.add(this.keyLight);
    this.fillLight = new THREE.PointLight(0x2a3f66, 0.9, 1.6, 2);
    this.fillLight.position.set(-0.4, -0.1, -0.5);
    this.holder.add(this.fillLight);
  }

  /* 1. CHAINSAW — "Cyber Ripper": energy-fed, always running while held. */
  buildChainsaw() {
    const g = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.5), matGun(0x232c38));
    body.position.set(0, -0.02, 0.12);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), matDark());
    grip.position.set(0, -0.17, 0.2);
    grip.rotation.x = -0.25;

    // Guide bar: long, flat, forward-reaching.
    const halfLen = 0.44, chainR = 0.075;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, halfLen * 2), matGun(0x8d9aa6));
    bar.position.set(0, 0, -0.55);

    // Chain of teeth travelling around the bar.
    const teeth = [];
    const toothGeo = new THREE.BoxGeometry(0.035, 0.05, 0.055);
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xd8dee6, metalness: 1.0, roughness: 0.15 });
    for (let i = 0; i < 26; i++) {
      const t = new THREE.Mesh(toothGeo, toothMat);
      t.position.z = -0.55;
      teeth.push(t);
      g.add(t);
    }

    // Cyan energy conduits feeding the bar.
    const conduitGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.55, 6);
    const c1 = new THREE.Mesh(conduitGeo, matEnergy(0.9));
    c1.rotation.x = Math.PI / 2;
    c1.position.set(0.075, 0.06, -0.16);
    const c2 = c1.clone();
    c2.position.x = -0.075;

    // Battery cell at the back — brightness tracks remaining energy.
    const battery = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.15), matEnergy(0.2));
    battery.position.set(0, -0.04, 0.35);
    const batteryShell = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.1), matGun(0x2b3644));
    batteryShell.position.set(0, -0.04, 0.41);

    // Exposed motor with a spinning flywheel.
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10), matAccent());
    motor.rotation.z = Math.PI / 2;
    motor.position.set(0.13, 0.0, 0.06);
    const flywheel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 8), matGun(0x445566));
    flywheel.rotation.z = Math.PI / 2;
    flywheel.position.set(0.19, 0.0, 0.06);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.02), matAccent(0xff2200, 0xff0000));
    flywheel.add(spoke);

    // Worn chamfer strips along the housing, screws, and a top vent bank.
    edge(g, 0.235, 0.02, 0.5, 0, 0.11, 0.12);
    edge(g, 0.235, 0.02, 0.5, 0, -0.15, 0.12);
    rivets(g, 4, 0.112, 0.02, -0.02, 0.09);
    const vents = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.03), matEnergy(0.5));
      v.position.set(0, 0.115, 0.0 + i * 0.06);
      vents.add(v);
    }
    // Bar detail: guide slot, nose sprocket cover, and a front handle bar.
    const barSlot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, halfLen * 1.5), matWorn());
    barSlot.position.set(0, 0, -0.55);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 8), matGun(0x6d7883));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0, -0.97);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 5, 12), matDark());
    handle.rotation.y = Math.PI / 2;
    handle.position.set(0, 0.02, -0.05);
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.09, 6), matGun(0x5a6470));
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(-0.12, 0.05, 0.3);
    // Sparks thrown off the bar under load.
    const sparks = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.07, 4), matFlash(0xfff0a0));
      sp.position.set((i % 2 ? 0.05 : -0.05), 0.02 + (i * 0.03), -0.9 - i * 0.03);
      sparks.add(sp);
    }
    sparks.visible = false;
    sparks.traverse(o => { o.userData.hideInPickup = true; });
    sparks.userData.hideInPickup = true;

    g.add(body, grip, bar, barSlot, nose, handle, exhaust, c1, c2, battery, batteryShell, motor, flywheel, vents, sparks);
    g.position.set(0.16, -0.25, -0.6);
    g.scale.setScalar(0.62);
    return { mesh: g, baseZ: -0.5, teeth, halfLen, chainR, battery, flywheel, conduits: [c1, c2],
             bar, sparks, sawVents: vents, recoil: 0.5, sway: { amp: 1.0, freq: 1.0, roll: 0.010 } };
  }

  /* 2. PISTOL — Cyber 9mm, unchanged behaviour, bullets. */
  buildPistol() {
    const g = new THREE.Group();
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.4), matGun());
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 8), matEnergy(0.4));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.03, -0.02);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.12), matDark());
    grip.rotation.x = -0.3;
    grip.position.set(0, -0.12, 0.1);
    const accent = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.02, 0.1), matAccent());
    accent.position.set(0, -0.05, 0.02);

    // Slide serrations, frame rail and worn top edges.
    for (let i = 0; i < 5; i++) {
      const ser = new THREE.Mesh(new THREE.BoxGeometry(0.084, 0.055, 0.008), matWorn());
      ser.position.set(0, 0.005, 0.12 + i * 0.022);
      slide.add(ser);
    }
    edge(slide, 0.082, 0.008, 0.4, 0, 0.05, 0);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.16), matWorn());
    rail.position.set(0, -0.06, -0.08);
    // Iron sights: rear notch and a glowing front post.
    const rear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.016), matDark());
    rear.position.set(0, 0.058, 0.17);
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.014), matEnergy(1.2));
    front.position.set(0, 0.058, -0.16);
    slide.add(rear, front);
    // Hammer, trigger and guard.
    const hammer = new THREE.Group();
    const hMesh = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.016), matSteel());
    hMesh.position.y = 0.025;
    hammer.add(hMesh);
    hammer.position.set(0, 0.01, 0.19);
    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.045, 0.012), matSteel());
    trigger.position.set(0, -0.06, 0.09);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.008, 4, 10, Math.PI), matDark());
    guard.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    guard.position.set(0, -0.08, 0.09);
    // Magazine base plate and a chamber-loaded indicator.
    const magPlate = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.12), matSteel());
    magPlate.position.set(0, -0.225, 0.14);
    magPlate.rotation.x = -0.3;
    const chamber = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.03), matEnergy(1.4));
    chamber.position.set(0.043, 0.02, 0.06);
    rivets(g, 3, 0.038, -0.1, 0.04, 0.05);

    const flash = muzzleFlash('star', 0xffd27a);
    flash.position.set(0, 0.03, -0.26);
    const shell = ejectCase(0xcaa24a);

    g.add(slide, barrel, grip, accent, rail, hammer, trigger, guard, magPlate, chamber, flash, shell);
    // The pistol sat unscaled and at the shallowest depth of the six, so it
    // filled a third of the screen as an unreadable slab. Matched to the rest.
    g.position.set(0.19, -0.2, -0.52);
    g.scale.setScalar(0.72);
    return { mesh: g, baseZ: -0.55, slide, hammer, flash, shell, ejectFrom: new THREE.Vector3(0.05, 0.04, 0.1),
             recoil: 1.0, sway: { amp: 0.85, freq: 1.15, roll: 0.006 } };
  }

  /* 3. MACHINEGUN — rotary cluster, belt-fed, bullets. */
  buildMachinegun() {
    const g = new THREE.Group();

    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.15, 0.4), matGun(0x1d2732));
    receiver.position.set(0, -0.02, 0.08);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.1), matDark());
    grip.position.set(0, -0.17, 0.16);
    grip.rotation.x = -0.2;

    // Spinning three-barrel cluster.
    const cluster = new THREE.Group();
    const bGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 8);
    const bMat = matGun(0x6d7b88);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(bGeo, bMat);
      b.rotation.x = Math.PI / 2;
      const a = (i / 3) * Math.PI * 2;
      b.position.set(Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0);
      cluster.add(b);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.07, 10), matAccent());
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.28;
    cluster.add(hub);
    cluster.position.set(0, 0.01, -0.35);

    // Ammo drum + belt of shells.
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12), matGun(0x2b3644));
    drum.rotation.z = Math.PI / 2;
    drum.position.set(-0.1, -0.1, 0.14);
    const belt = new THREE.Group();
    const shellGeo = new THREE.BoxGeometry(0.03, 0.045, 0.03);
    const shellMat = matAccent(0xffaa22, 0x883300);
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(shellGeo, shellMat);
      s.position.set(-0.055 - i * 0.008, -0.045 - i * 0.012, 0.13 - i * 0.012);
      belt.add(s);
    }

    const coolant = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.3), matEnergy(0.8));
    coolant.position.set(0.075, 0.04, -0.12);

    // Barrel shroud with vent slots, wrapped around the cluster.
    const shroud = new THREE.Group();
    const shroudBody = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.3, 10, 1, true), matGun(0x2f3a46));
    shroudBody.rotation.x = Math.PI / 2;
    shroud.add(shroudBody);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.18), matWorn());
      slot.position.set(Math.cos(a) * 0.072, Math.sin(a) * 0.072, 0);
      shroud.add(slot);
    }
    shroud.position.set(0, 0.01, -0.3);
    // Top rail, carry handle, foregrip and cooling fins.
    const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.014, 0.3), matWorn());
    topRail.position.set(0, 0.08, 0.03);
    const carry = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.01, 4, 10, Math.PI), matDark());
    carry.rotation.set(0, Math.PI / 2, 0);
    carry.position.set(0, 0.09, 0.05);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.11, 0.09), matDark());
    fore.position.set(0, -0.11, -0.13);
    fore.rotation.x = 0.18;
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.01), matGun(0x3a4653));
      fin.position.set(0, -0.02, -0.05 + i * 0.05);
      receiver.add(fin);
    }
    edge(g, 0.145, 0.014, 0.4, 0, 0.06, 0.08);
    edge(g, 0.145, 0.014, 0.4, 0, -0.1, 0.08);
    rivets(g, 4, 0.073, -0.02, -0.04, 0.06);
    // Belt feed cover over the drum.
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.12), matGun(0x36414d));
    cover.position.set(-0.09, -0.04, 0.13);

    const flash = muzzleFlash('star', 0xffc46a);
    flash.position.set(0, 0.01, -0.68);
    flash.scale.setScalar(0.9);

    g.add(receiver, grip, cluster, drum, belt, coolant, shroud, topRail, carry, fore, cover, flash);
    g.position.set(0.18, -0.24, -0.55);
    g.scale.setScalar(0.85);
    return { mesh: g, baseZ: -0.55, cluster, drum, belt, flash, receiver,
             recoil: 0.55, sway: { amp: 1.25, freq: 0.82, roll: 0.014 } };
  }

  /* 4. SHOTGUN — Trench Scattergun, shells. */
  buildShotgun() {
    const g = new THREE.Group();
    const b1 = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 12), matGun(0x111622));
    b1.rotation.x = Math.PI / 2;
    b1.position.set(0.025, 0.04, -0.3);
    const b2 = b1.clone();
    b2.position.set(-0.025, 0.04, -0.3);
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.22), matAccent());
    pump.position.set(0, 0.01, -0.28);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.4), matGun(0x222b38));
    body.position.set(0, -0.04, 0.1);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.015, 0.02), matEnergy(1.0));
    sight.position.set(0, 0.08, -0.62);

    // Ribbed heat shield over the barrels, and a rear notch to sight through.
    const shield = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.012, 0.02), matGun(0x39424f));
      rib.position.set(0, 0.075, -0.58 + i * 0.09);
      shield.add(rib);
    }
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.62), matGun(0x39424f));
    spine.position.set(0, 0.075, -0.3);
    shield.add(spine);
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.018), matDark());
    notch.position.set(0, 0.08, 0.02);
    // Pump ribs so the cycle reads, plus a wrist stock and shell loops.
    for (let i = 0; i < 4; i++) {
      const pr = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.012, 0.016), matWorn());
      pr.position.set(0, 0.048, -0.07 + i * 0.045);
      pump.add(pr);
    }
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.14, 0.2), matDark());
    stock.position.set(0, -0.09, 0.36);
    stock.rotation.x = -0.16;
    const loops = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.05, 6), matAccent(0xd4452a, 0x551000));
      sh.rotation.z = Math.PI / 2;
      sh.position.set(0.062, -0.02 + i * 0.001, 0.16 + i * 0.045);
      loops.add(sh);
    }
    edge(g, 0.105, 0.014, 0.4, 0, 0.035, 0.1);
    edge(g, 0.105, 0.014, 0.4, 0, -0.115, 0.1);
    rivets(g, 3, 0.052, -0.04, 0.02, 0.06);
    const breach = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.05), matEnergy(0.2));
    breach.position.set(0.045, 0.0, -0.05);

    const flash = muzzleFlash('wide', 0xffb454);
    flash.position.set(0, 0.04, -0.72);
    const shell = ejectCase(0xb03a22);

    g.add(b1, b2, pump, body, sight, shield, notch, stock, loops, breach, flash, shell);
    g.position.set(0.18, -0.22, -0.6);
    return { mesh: g, baseZ: -0.55, pump, flash, shell, breach, ejectFrom: new THREE.Vector3(0.06, 0.02, -0.02),
             recoil: 2.2, sway: { amp: 1.15, freq: 0.9, roll: 0.012 } };
  }

  /* 5. ENERGY RIFLE — single heavy bolt, scoped, capacitor coil. */
  buildEnergyRifle() {
    const g = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.45), matGun(0x172029));
    body.position.set(0, -0.02, 0.12);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.2), matDark());
    stock.position.set(0, -0.06, 0.42);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.09), matDark());
    grip.position.set(0, -0.16, 0.18);
    grip.rotation.x = -0.15;

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.9, 10), matGun(0x59677a));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -0.5);

    // Capacitor coil: rings around the barrel that light up as it charges.
    const coil = new THREE.Group();
    const ringGeo = new THREE.TorusGeometry(0.05, 0.012, 6, 14);
    for (let i = 0; i < 4; i++) {
      const r = new THREE.Mesh(ringGeo, matEnergy(0.5));
      r.position.set(0, 0.015, -0.28 - i * 0.13);
      coil.add(r);
    }

    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.03, 0.09, 8), matEnergy(1.0));
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.015, -0.94);

    // Scope.
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.22, 10), matGun(0x0f151c));
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.11, -0.05);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 10), matAccent(0xff3355, 0xff0033));
    lens.position.set(0, 0.11, 0.07);
    lens.rotation.y = Math.PI;

    // Scope mounts and a glowing reticle behind the lens.
    for (let i = 0; i < 2; i++) {
      const mount = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.02), matGun(0x2b3542));
      mount.position.set(0, 0.07, -0.12 + i * 0.14);
      g.add(mount);
    }
    // Capacitor cell with a window that tracks the charge.
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.09, 0.14), matGun(0x212b36));
    cell.position.set(0, -0.11, 0.02);
    const window_ = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.05), matEnergy(0.6));
    window_.position.set(0, -0.11, 0.02);
    // Cooling fins along the receiver, worn top and bottom edges.
    for (let i = 0; i < 5; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.01), matGun(0x2f3a47));
      fin.position.set(0, 0.02, 0.0 + i * 0.05);
      g.add(fin);
    }
    edge(g, 0.105, 0.012, 0.45, 0, 0.05, 0.12);
    edge(g, 0.105, 0.012, 0.45, 0, -0.09, 0.12);
    rivets(g, 3, 0.052, -0.02, 0.06, 0.06);
    // Muzzle iris: four petals that swing open on the shot.
    const iris = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.035), matGun(0x6f7f92));
      petal.position.set(Math.cos(a) * 0.038, Math.sin(a) * 0.038, 0);
      petal.rotation.z = a;
      petal.userData.a = a;
      iris.add(petal);
    }
    iris.position.set(0, 0.015, -0.96);
    // Vent that puffs after a shot.
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.07), matEnergy(0.3));
    vent.position.set(0.055, 0.06, 0.2);

    const flash = muzzleFlash('ring', 0x8ff6ff);
    flash.position.set(0, 0.015, -1.0);

    g.add(body, stock, grip, barrel, coil, muzzle, scope, lens, cell, window_, iris, vent, flash);
    g.position.set(0.17, -0.23, -0.55);
    g.scale.setScalar(0.64);
    return { mesh: g, baseZ: -0.5, coil, muzzle, iris, vent, cellWindow: window_, flash,
             recoil: 1.7, sway: { amp: 1.1, freq: 0.86, roll: 0.011 } };
  }

  /* 6. ENERGY REPEATER — compact twin emitters, vents glow with heat. */
  buildEnergyRepeater() {
    const g = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.13, 0.34), matGun(0x1b2430));
    body.position.set(0, -0.01, 0.06);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.19, 0.09), matDark());
    grip.position.set(0, -0.16, 0.14);
    grip.rotation.x = -0.22;

    const emitters = [];
    for (let i = 0; i < 2; i++) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.42, 8), matGun(0x53616e));
      tube.rotation.x = Math.PI / 2;
      tube.position.set(i ? 0.055 : -0.055, 0.02, -0.3);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), matEnergy(1.0));
      tip.position.set(i ? 0.055 : -0.055, 0.02, -0.5);
      emitters.push(tip);
      g.add(tube, tip);
    }

    // Heat vents down each flank.
    const vents = [];
    const ventGeo = new THREE.BoxGeometry(0.012, 0.05, 0.05);
    for (let i = 0; i < 6; i++) {
      const v = new THREE.Mesh(ventGeo, matAccent(0x552200, 0xff2200));
      v.material.emissiveIntensity = 0;
      v.position.set(i < 3 ? 0.092 : -0.092, 0.03, -0.02 + (i % 3) * 0.07);
      vents.push(v);
      g.add(v);
    }

    const core = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.12), matEnergy(0.8));
    core.position.set(0, 0.05, 0.14);

    // Coils spiralling up each emitter tube.
    for (let i = 0; i < 2; i++) {
      for (let r = 0; r < 3; r++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 4, 10), matEnergy(0.45));
        ring.position.set(i ? 0.055 : -0.055, 0.02, -0.2 - r * 0.1);
        g.add(ring);
      }
    }
    // Removable cell under the body, top rail, and worn edges.
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.1), matGun(0x232d39));
    cell.position.set(0, -0.09, -0.02);
    const cellGlow = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.022, 0.05), matEnergy(0.7));
    cellGlow.position.set(0, -0.09, -0.02);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.2), matWorn());
    rail.position.set(0, 0.075, 0.02);
    edge(g, 0.185, 0.014, 0.34, 0, 0.055, 0.06);
    edge(g, 0.185, 0.014, 0.34, 0, -0.075, 0.06);
    rivets(g, 3, 0.093, -0.03, -0.02, 0.06);

    const flashes = [];
    for (let i = 0; i < 2; i++) {
      const f = muzzleFlash('ring', 0x8ff6ff);
      f.scale.setScalar(0.72);
      f.position.set(i ? 0.055 : -0.055, 0.02, -0.56);
      flashes.push(f);
      g.add(f);
    }

    g.add(body, grip, core, cell, cellGlow, rail);
    g.position.set(0.18, -0.24, -0.52);
    g.scale.setScalar(0.88);
    return { mesh: g, baseZ: -0.55, emitters, vents, core, cellGlow, flashes,
             recoil: 0.35, sway: { amp: 0.95, freq: 1.05, roll: 0.008 } };
  }

  /* Pickup mesh: the viewmodel again, scaled up so it reads across a room. */
  buildPickupMesh(key) {
    const src = this.weapons[key] || this.weapons['pistol'];
    const clone = src.mesh.clone(true);
    // Muzzle flashes, sparks and ejected cases stay hidden on the floor model.
    clone.traverse(o => { o.visible = !o.userData.hideInPickup; });
    clone.position.set(0, 0, 0);
    clone.rotation.set(0.22, 0, 0.14);   // tipped up so it reads as a weapon, not a stick
    clone.scale.setScalar(1.9);
    const wrap = new THREE.Group();
    wrap.add(clone);
    // Centre it on the wrap so a spin turns about the weapon, not about its grip.
    const box = new THREE.Box3().setFromObject(clone);
    const c = box.getCenter(new THREE.Vector3());
    clone.position.sub(c);
    return wrap;
  }

  /* ======================================================================
     STATE & ANIMATION
     ====================================================================== */
  setWeapon(key) {
    if (!this.weapons[key]) return;
    this.currentKey = key;
    Object.keys(this.weapons).forEach(k => {
      this.weapons[k].mesh.visible = (k === key);
    });
  }

  triggerRecoil(intensity = 1.0) {
    this.recoilOffset = 0.15 * intensity;
    this.muzzleLight.intensity = 5 * intensity;
    const cur = this.weapons[this.currentKey];
    this.muzzleLight.color.setHex(
      this.currentKey === 'energy_rifle' || this.currentKey === 'energy_repeater' ? 0x66ffff : 0xffcc66
    );
    if (cur) {
      if (cur.cluster) this.spinSpeed = 28;
      if (cur.slide) cur.slide.position.z = 0.09;
      if (cur.pump) { cur.pump.position.z = -0.16; this.pumpT = 1; }
      if (cur.coil) { this.charge = 0; this.irisT = 1; }
      if (cur.vents) this.heat = Math.min(1, this.heat + 0.22);
      if (cur.hammer) this.hammerT = 1;
      if (cur.shell) this.ejectT = 1;
      if (cur.flashes) this.emitterIdx ^= 1;

      // Muzzle flash: a fresh roll and scale every shot so repeats differ.
      this.flashT = 0.06;
      const fl = cur.flashes ? cur.flashes[this.emitterIdx] : cur.flash;
      if (fl) {
        if (cur.flashes) cur.flashes.forEach(f => { f.visible = false; });
        fl.visible = true;
        fl.rotation.z = Math.random() * Math.PI * 2;
        const sc = (fl.userData.baseScale ??= fl.scale.x);
        fl.scale.setScalar(sc * (0.8 + Math.random() * 0.5 + intensity * 0.12));
      }
    }
    clearTimeout(this._muzzleTimer);
    this._muzzleTimer = setTimeout(() => { this.muzzleLight.intensity = 0; }, 60);
  }

  update(delta, isMoving) {
    // The engine's per-frame weapon tick rides along here: this is the one
    // call site that already runs exactly when the sim is running.
    if (this.engine && typeof this.engine.updateWeaponTick === 'function') {
      this.engine.updateWeaponTick(delta);
    }

    this.bobTimer += delta * (isMoving ? 10 : 2);
    const bobX = Math.cos(this.bobTimer) * 0.015;
    const bobY = Math.sin(this.bobTimer * 2) * 0.015;

    this.recoilOffset = THREE.MathUtils.lerp(this.recoilOffset, 0, delta * 12);
    this.spinSpeed = THREE.MathUtils.lerp(this.spinSpeed, 0, delta * 3);
    this.heat = Math.max(0, this.heat - delta * 0.5);
    this.charge = Math.min(1, this.charge + delta * 1.6);
    this.flashT = Math.max(0, this.flashT - delta);
    this.ejectT = Math.max(0, this.ejectT - delta * 2.6);
    this.pumpT = Math.max(0, this.pumpT - delta * 1.9);
    this.irisT = Math.max(0, this.irisT - delta * 5);
    this.hammerT = Math.max(0, this.hammerT - delta * 9);
    this.revKick = Math.max(0, this.revKick - delta * 4);
    if (this.sawRev && !this._prevRev) this.revKick = 1;
    this._prevRev = this.sawRev;

    const cur = this.weapons[this.currentKey];
    if (!cur) return;

    // Muzzle flash lives for a few frames only.
    if (!this.flashT) {
      if (cur.flash) cur.flash.visible = false;
      if (cur.flashes) cur.flashes.forEach(f => { f.visible = false; });
    }

    let jitterX = 0, jitterY = 0;
    if (this.currentKey === 'chainsaw' && this.sawRunning) {
      const amp = this.sawRev ? 0.012 : 0.005;
      jitterX = (Math.random() - 0.5) * amp;
      jitterY = (Math.random() - 0.5) * amp;
    }

    // Idle sway varies per weapon: heavy guns swing slower and wider, and
    // each one rolls a little as it settles.
    const sway = cur.sway || { amp: 1, freq: 1, roll: 0.008 };
    const sx = Math.cos(this.bobTimer * sway.freq) * 0.015 * sway.amp;
    const sy = Math.sin(this.bobTimer * sway.freq * 2) * 0.015 * sway.amp;
    cur.mesh.position.x = (cur.mesh.userData.baseX ??= cur.mesh.position.x) + jitterX + sx * 0.35;
    cur.mesh.position.y = -0.22 + sy - this.recoilOffset * 0.5 + jitterY;
    // Long weapons need a deeper base or their stock clips the near plane.
    cur.mesh.position.z = (cur.baseZ ?? -0.55) + sx + this.recoilOffset;
    cur.mesh.rotation.z = Math.sin(this.bobTimer * sway.freq * 0.5) * sway.roll;
    cur.mesh.rotation.x = -this.recoilOffset * 0.9 + Math.sin(this.bobTimer * sway.freq * 0.33) * sway.roll * 0.5;

    // Ejected case flies out on an arc and disappears.
    if (cur.shell && cur.ejectFrom) {
      const e = this.ejectT;
      cur.shell.visible = e > 0.02;
      if (cur.shell.visible) {
        const t = 1 - e;
        cur.shell.position.set(
          cur.ejectFrom.x + t * 0.22,
          cur.ejectFrom.y + t * 0.16 - t * t * 0.55,
          cur.ejectFrom.z + t * 0.10
        );
        cur.shell.rotation.set(t * 9, t * 6, t * 4);
      }
    }

    // Chainsaw: teeth travel the stadium path, flywheel spins, battery glows.
    if (cur.teeth) {
      if (this.sawRunning) this.chainPhase += delta * (this.sawRev ? 3.2 : 1.6);
      const n = cur.teeth.length;
      for (let i = 0; i < n; i++) {
        const [y, z] = stadiumPoint(this.chainPhase + i / n, cur.halfLen, cur.chainR);
        cur.teeth[i].position.set(0, y, z - 0.55);
        cur.teeth[i].rotation.x = Math.atan2(y, 0.2);
      }
      cur.flywheel.rotation.y += delta * (this.sawRunning ? (this.sawRev ? 40 : 22) : 0);
      // Rev kick when the trigger first bites, then a wobble under load.
      const load = this.sawRunning ? (this.sawRev ? 1 : 0.35) : 0;
      cur.mesh.rotation.x += this.revKick * 0.16;
      cur.mesh.rotation.z += this.revKick * -0.10;
      if (cur.bar) {
        cur.bar.rotation.z = Math.sin(this.bobTimer * 9) * 0.012 * load + this.revKick * 0.05;
        cur.bar.position.y = Math.sin(this.bobTimer * 14) * 0.006 * load;
      }
      if (cur.sparks) {
        cur.sparks.visible = this.sawRev && this.sawRunning;
        if (cur.sparks.visible) {
          cur.sparks.rotation.z = Math.random() * Math.PI * 2;
          cur.sparks.scale.setScalar(0.6 + Math.random() * 0.8);
        }
      }
      if (cur.sawVents) {
        cur.sawVents.children.forEach((v, i) => {
          v.material.emissiveIntensity = 0.2 + load * (0.5 + Math.abs(Math.sin(this.bobTimer * 6 + i)) * 0.8);
        });
      }
      const glow = this.sawEnergyFrac;
      cur.battery.material.emissiveIntensity = 0.08 + glow * 0.55;
      cur.battery.material.color.setRGB(0.0, glow * 0.55, glow * 0.5 + 0.05);
      cur.conduits.forEach(c => { c.material.emissiveIntensity = this.sawRunning ? 0.6 + Math.random() * 0.7 : 0.15; });
    }

    // Machinegun barrel spin-down, receiver shudder and creeping belt.
    if (cur.cluster) {
      cur.cluster.rotation.z += delta * this.spinSpeed;
      cur.drum.rotation.x += delta * this.spinSpeed * 0.3;
      const shud = Math.min(1, this.spinSpeed / 28);
      if (cur.receiver) {
        cur.receiver.position.x = (Math.random() - 0.5) * 0.006 * shud;
        cur.receiver.position.y = -0.02 + (Math.random() - 0.5) * 0.006 * shud;
      }
      if (cur.belt) {
        cur.belt.position.z = -((this.bobTimer * 0.02 * shud) % 0.024);
        cur.belt.position.y = -((this.bobTimer * 0.02 * shud) % 0.024) * 0.8;
      }
    }

    // Pistol slide blow-back and hammer fall.
    if (cur.slide) cur.slide.position.z = THREE.MathUtils.lerp(cur.slide.position.z, 0, delta * 14);
    if (cur.hammer) cur.hammer.rotation.x = -0.9 * (1 - this.hammerT);
    // Shotgun pump cycles back over the first half of the reload, then forward.
    if (cur.pump) {
      const c = this.pumpT;
      const stroke = c > 0.5 ? (1 - c) * 2 : c * 2;   // 0 -> 1 -> 0
      cur.pump.position.z = -0.28 + stroke * 0.14;
      if (cur.breach) cur.breach.material.emissiveIntensity = 0.1 + stroke * 1.6;
    }

    // Energy rifle: coils charge in sequence, iris opens on the shot, vent puffs.
    if (cur.coil) {
      const c = this.charge;
      cur.coil.children.forEach((r, i) => {
        r.material.emissiveIntensity = 0.15 + Math.max(0, c - i * 0.2) * 1.6;
      });
      cur.muzzle.material.emissiveIntensity = 0.2 + c * 1.4;
      if (cur.cellWindow) cur.cellWindow.material.emissiveIntensity = 0.2 + c * 1.3;
      if (cur.iris) {
        const open = this.irisT;
        cur.iris.children.forEach(pt => {
          pt.position.x = Math.cos(pt.userData.a) * (0.038 + open * 0.03);
          pt.position.y = Math.sin(pt.userData.a) * (0.038 + open * 0.03);
        });
      }
      if (cur.vent) cur.vent.material.emissiveIntensity = 0.15 + this.irisT * 1.8;
    }

    // Repeater heat vents; the emitter that just fired burns brighter.
    if (cur.vents) {
      const shimmer = 1 + Math.sin(this.bobTimer * 11) * 0.25 * this.heat;
      cur.vents.forEach(v => { v.material.emissiveIntensity = this.heat * 1.8 * shimmer; });
      cur.core.material.emissiveIntensity = 0.4 + this.heat;
      if (cur.cellGlow) cur.cellGlow.material.emissiveIntensity = 0.3 + this.heat * 1.1;
      cur.emitters.forEach((e, i) => {
        const hot = (i === this.emitterIdx && this.flashT > 0) ? 1.8 : 0;
        e.material.emissiveIntensity = 0.6 + this.heat * 1.2 + hot;
      });
    }
  }
}

/* ==========================================================================
   WEAPONS TABLE — adding a weapon is one row.
   ammo: which pool it draws from · cost: per shot · cooldown: seconds
   auto: held fire repeats · fire(engine): what actually happens
   ========================================================================== */
function aimDir(engine, spread) {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion);
  if (spread) {
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
  }
  return dir.normalize();
}

// Energy weapons prefer the lighting agent's pooled projectiles; if that API
// has not landed they degrade to a hitscan of the same damage.
function energyShot(engine, opts, spread) {
  const dir = aimDir(engine, spread);
  if (typeof engine.spawnProjectile === 'function') {
    const from = engine.camera.position.clone().addScaledVector(dir, 0.6);
    engine.spawnProjectile(Object.assign({ from, dir, owner: 'player' }, opts));
  } else {
    engine.raycastHitscan(opts.damage, spread || 0.005);
  }
}

const WEAPONS = {
  chainsaw: {
    slot: 1, label: 'SAW', ammo: 'energy', cost: 0, cooldown: 0.15, auto: true,
    // The blade runs on its own (see updateWeaponTick); the trigger only revs.
    fire(engine) {
      if (engine.player.ammo.energy <= 0) engine.showHudMessage('NO ENERGY');
    }
  },
  pistol: {
    slot: 2, label: 'PISTOL', ammo: 'bullets', cost: 1, cooldown: 0.32, auto: false,
    fire(engine) {
      engine.sound.playPistol();
      engine.viewmodels.triggerRecoil(1.0);
      engine.raycastHitscan(15, 0.02);
    }
  },
  machinegun: {
    slot: 3, label: 'MACHINEGUN', ammo: 'bullets', cost: 1, cooldown: 1 / 9, auto: true,
    fire(engine) {
      engine.sound.playMachinegun();
      engine.viewmodels.triggerRecoil(0.55);
      // Spread opens from 0.045 to 0.09 over the first second of sustained fire.
      const bloom = Math.min(1, engine.sustainedFire / 1.0);
      engine.raycastHitscan(7, 0.045 + bloom * 0.045);
    }
  },
  shotgun: {
    slot: 4, label: 'SHOTGUN', ammo: 'shells', cost: 1, cooldown: 0.8, auto: false,
    fire(engine) {
      engine.sound.playShotgun();
      engine.viewmodels.triggerRecoil(2.2);
      for (let i = 0; i < 7; i++) engine.raycastHitscan(14, 0.09);
    }
  },
  energy_rifle: {
    slot: 5, label: 'RIFLE', ammo: 'energy', cost: 4, cooldown: 0.7, auto: false,
    fire(engine) {
      engine.sound.playEnergyRifle();
      engine.viewmodels.triggerRecoil(1.7);
      energyShot(engine, { speed: 38, kind: 'energy_bolt', damage: 45, radius: 0.35 }, 0);
    }
  },
  energy_repeater: {
    slot: 6, label: 'REPEATER', ammo: 'energy', cost: 1, cooldown: 1 / 12, auto: true,
    fire(engine) {
      engine.sound.playEnergyRepeater();
      engine.viewmodels.triggerRecoil(0.35);
      energyShot(engine, { speed: 55, kind: 'energy_burst', damage: 6, radius: 0.2 }, 0.03);
    }
  }
};

const AMMO_LABEL = { bullets: 'BULLETS', shells: 'SHELLS', energy: 'ENERGY' };

/* Floor pickups: display name, and the starter load a weapon comes with. */
const WEAPON_PICKUP_NAME = {
  chainsaw: 'CYBER RIPPER',
  pistol: 'CYBER 9MM',
  machinegun: 'ROTARY MACHINE GUN',
  shotgun: 'PUMP SHOTGUN',
  energy_rifle: 'ENERGY RIFLE',
  energy_repeater: 'ENERGY REPEATER'
};
const WEAPON_PICKUP_AMMO = {
  chainsaw: ['energy', 40],
  pistol: ['bullets', 12],
  machinegun: ['bullets', 30],
  shotgun: ['shells', 8],
  energy_rifle: ['energy', 40],
  energy_repeater: ['energy', 40]
};
/* Fallback when a converted map's ammo entity carries no amount. */
const AMMO_PICKUP_DEFAULT = { bullets: 10, shells: 4, energy: 20 };
