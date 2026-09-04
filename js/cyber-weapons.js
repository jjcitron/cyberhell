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

    g.add(body, grip, bar, c1, c2, battery, batteryShell, motor, flywheel);
    g.position.set(0.16, -0.25, -0.6);
    g.scale.setScalar(0.62);
    return { mesh: g, baseZ: -0.5, teeth, halfLen, chainR, battery, flywheel, conduits: [c1, c2], recoil: 0.5 };
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
    g.add(slide, barrel, grip, accent);
    g.position.set(0.2, -0.2, -0.5);
    return { mesh: g, baseZ: -0.55, slide, recoil: 1.0 };
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

    g.add(receiver, grip, cluster, drum, belt, coolant);
    g.position.set(0.18, -0.24, -0.55);
    g.scale.setScalar(0.85);
    return { mesh: g, baseZ: -0.55, cluster, drum, recoil: 0.55 };
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
    g.add(b1, b2, pump, body, sight);
    g.position.set(0.18, -0.22, -0.6);
    return { mesh: g, baseZ: -0.55, pump, recoil: 2.2 };
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

    g.add(body, stock, grip, barrel, coil, muzzle, scope, lens);
    g.position.set(0.17, -0.23, -0.55);
    g.scale.setScalar(0.64);
    return { mesh: g, baseZ: -0.5, coil, muzzle, recoil: 1.7 };
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

    g.add(body, grip, core);
    g.position.set(0.18, -0.24, -0.52);
    g.scale.setScalar(0.88);
    return { mesh: g, baseZ: -0.55, emitters, vents, core, recoil: 0.35 };
  }

  /* Pickup mesh: the viewmodel again, scaled up so it reads across a room. */
  buildPickupMesh(key) {
    const src = this.weapons[key] || this.weapons['pistol'];
    const clone = src.mesh.clone(true);
    clone.traverse(o => { o.visible = true; });
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.scale.setScalar(1.9);
    const wrap = new THREE.Group();
    wrap.add(clone);
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
      if (cur.pump) cur.pump.position.z = -0.16;
      if (cur.coil) this.charge = 0;
      if (cur.vents) this.heat = Math.min(1, this.heat + 0.22);
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

    const cur = this.weapons[this.currentKey];
    if (!cur) return;

    let jitterX = 0, jitterY = 0;
    if (this.currentKey === 'chainsaw' && this.sawRunning) {
      const amp = this.sawRev ? 0.012 : 0.005;
      jitterX = (Math.random() - 0.5) * amp;
      jitterY = (Math.random() - 0.5) * amp;
    }

    cur.mesh.position.x = (cur.mesh.userData.baseX ??= cur.mesh.position.x) + jitterX;
    cur.mesh.position.y = -0.22 + bobY - this.recoilOffset * 0.5 + jitterY;
    // Long weapons need a deeper base or their stock clips the near plane.
    cur.mesh.position.z = (cur.baseZ ?? -0.55) + bobX + this.recoilOffset;

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
      const glow = this.sawEnergyFrac;
      cur.battery.material.emissiveIntensity = 0.08 + glow * 0.55;
      cur.battery.material.color.setRGB(0.0, glow * 0.55, glow * 0.5 + 0.05);
      cur.conduits.forEach(c => { c.material.emissiveIntensity = this.sawRunning ? 0.6 + Math.random() * 0.7 : 0.15; });
    }

    // Machinegun barrel spin-down.
    if (cur.cluster) {
      cur.cluster.rotation.z += delta * this.spinSpeed;
      cur.drum.rotation.x += delta * this.spinSpeed * 0.3;
    }

    // Pistol slide / shotgun pump return.
    if (cur.slide) cur.slide.position.z = THREE.MathUtils.lerp(cur.slide.position.z, 0, delta * 14);
    if (cur.pump) cur.pump.position.z = THREE.MathUtils.lerp(cur.pump.position.z, -0.28, delta * 10);

    // Energy rifle capacitor charge glow between shots.
    if (cur.coil) {
      const c = this.charge;
      cur.coil.children.forEach((r, i) => {
        r.material.emissiveIntensity = 0.15 + Math.max(0, c - i * 0.2) * 1.6;
      });
      cur.muzzle.material.emissiveIntensity = 0.2 + c * 1.4;
    }

    // Repeater heat vents.
    if (cur.vents) {
      cur.vents.forEach(v => { v.material.emissiveIntensity = this.heat * 1.8; });
      cur.core.material.emissiveIntensity = 0.4 + this.heat;
      cur.emitters.forEach(e => { e.material.emissiveIntensity = 0.6 + this.heat * 1.2; });
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
