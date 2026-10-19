(function () {
// Three-shape head construction (Joel, Oct 13 — "no more lego heads"), shared by every humanoid in the beat 'em up:
//  (1) cranium: a sphere with its side planes sliced flat (ear / temple) and a brow ridge across the front;
//  (2) jaw + face: a wedge hung off the front-bottom of the cranium so the chin comes forward and down;
//  (3) neck: a cylinder angled back and up into the base of the skull (never straight under the chin).
// The jaw and cranium are smooth deformed spheres that overlap, so the join reads blended; the neck top sinks into the
// skull base. Canonical frame: forward +X, up +Y, sideways Z, cranium radius R. `fwd: '-z'` rotates it for rigs that face -Z.
// Plain function of THREE so the same file runs as an ES module (Clash, Harrier) and as a script (Cyberhell: window.Head3).
const HEAD3_DEFAULT = { R: 0.15, crW: 0.86, crH: 1.0, crD: 0.98, flat: 0.68, brow: 0.12, jawW: 0.74, jawLen: 0.62, jawD: 0.62, chin: 0.58, chinFwd: 0.32, jawX: 0.34, jawY: -0.5, back: 1.08, seg: 1 };
function h3hash(s) { s = String(s); let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 10000) / 10000; }
// per-character variety: a seed nudges every proportion a little, explicit params override
function head3Params(seed, over) {
  const o = Object.assign({}, HEAD3_DEFAULT), r = (k) => h3hash(seed + ':' + k) - 0.5;
  o.crW *= 1 + r('cw') * 0.12; o.crH *= 1 + r('ch') * 0.08; o.jawW *= 1 + r('jw') * 0.22; o.jawLen *= 1 + r('jl') * 0.2;
  o.chin *= 1 + r('cn') * 0.3; o.chinFwd *= 1 + r('cf') * 0.4; o.brow *= 1 + r('br') * 0.5;
  if (over) for (const k in over) if (over[k] !== undefined) o[k] = over[k];
  return o;
}
function craniumGeo(THREE, p) {
  const g = new THREE.SphereGeometry(1, Math.round(22 * p.seg), Math.round(16 * p.seg)), a = g.attributes.position;
  for (let i = 0; i < a.count; i++) {
    let x = a.getX(i), y = a.getY(i), z = a.getZ(i);
    const az = Math.abs(z); if (az > p.flat) z = Math.sign(z) * (p.flat + (az - p.flat) * 0.3);        // side planes (ear / temple)
    if (x > 0.2) x += p.brow * Math.exp(-Math.pow((y - 0.36) / 0.14, 2)) * x * (1 - az * 0.6);               // brow line
    if (x < 0) x *= p.back;                                                                               // occiput
    if (y < -0.55 && x > 0) x *= 0.82;                                                                     // underside tucks in where the jaw takes over
    a.setXYZ(i, x * p.crD * p.R, y * p.crH * p.R, z * p.crW * p.R);
  }
  g.computeVertexNormals(); g.type = 'Head3Geometry'; return g;   // own type: the refine passes rebuild stock Sphere/Cylinder geometry from parameters
}
function jawGeo(THREE, p) {
  const g = new THREE.SphereGeometry(1, Math.round(18 * p.seg), Math.round(12 * p.seg)), a = g.attributes.position;
  for (let i = 0; i < a.count; i++) {
    let x = a.getX(i), y = a.getY(i), z = a.getZ(i);
    const t = (1 - y) / 2;                                    // 0 at the cheekbones, 1 at the chin
    z *= 1 - (1 - p.chin) * Math.pow(t, 1.2);                 // narrows toward the chin
    if (x < 0) x *= 0.55;                                     // flat behind (it hangs off the skull)
    x = x * (1 - t * 0.35) + t * p.chinFwd;                   // chin forward and down
    if (x > 0.5 && t > 0.75) y -= (t - 0.75) * 0.25;          // chin point
    a.setXYZ(i, (x * p.jawD + p.jawX) * p.R, (y * p.jawLen + p.jawY) * p.R, z * p.jawW * p.R);
  }
  g.computeVertexNormals(); g.type = 'Head3Geometry'; return g;
}
/** {group, cranium, jaw}. mat: the old skull material (textures/vertex colours kept); jawMat optional (beards, masks). */
function buildHead(THREE, mat, params, opts) {
  const p = Object.assign({}, HEAD3_DEFAULT, params || {}); opts = opts || {};
  const group = new THREE.Group(); group.name = 'head3';
  const cranium = new THREE.Mesh(craniumGeo(THREE, p), mat); cranium.name = 'head3-cranium';
  const jaw = new THREE.Mesh(jawGeo(THREE, p), opts.jawMat || mat); jaw.name = 'head3-jaw';
  for (const m of [cranium, jaw]) { m.castShadow = true; m.receiveShadow = true; m.userData.head3 = true; group.add(m); }
  const face = opts.face === false ? null : buildFace(THREE, group, cranium, jaw, mat, p, opts.face || {});
  if (opts.fwd === '-z') group.rotation.y = Math.PI / 2;
  if (opts.fwd === '+z') group.rotation.y = -Math.PI / 2;
  return { group, cranium, jaw, face, params: p };
}
/** Neck cylinder: base at the origin, rising `len` while leaning back by `tilt` rad, top sunk into the skull base. */
function buildNeck(THREE, mat, o) {
  o = o || {}; const r = o.r || 0.06, len = o.len || 0.2, tilt = o.tilt === undefined ? 0.3 : o.tilt;
  const geo = new THREE.CylinderGeometry(r * 0.92, r * 1.08, len, 16, 3); geo.translate(0, len / 2, 0); geo.type = 'Head3Geometry';
  const m = new THREE.Mesh(geo, mat); m.name = 'head3-neck'; m.castShadow = true; m.userData.head3 = true;
  const g = new THREE.Group(); g.add(m); m.rotation.z = tilt;                      // +tilt leans the top toward -X (back)
  if (o.fwd === '-z') g.rotation.y = Math.PI / 2;
  if (o.fwd === '+z') g.rotation.y = -Math.PI / 2;
  g.userData.top = new THREE.Vector3(-Math.sin(tilt) * len, Math.cos(tilt) * len, 0);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Sculpted face (Joel, Oct 13 pm): brow ridge + brows, eyeballs in sockets (ridge above, cheekbones below) with pupils,
// upper lids and a dark lash line, a nose from bridge to tip with nostril wings and holes, lips with a mouth line, ears on the
// flat side planes. Features are placed by ray-casting onto the cranium/jaw surface, merged per feature (few draw calls),
// skip ink outlines, and use materials flagged `keep` so slot tints never recolour eyes or lips. Dark eye/brow/mouth lines are
// what keep the face readable at game zoom and in the black-and-white ink style.
const FACE_DEFAULT = { eyeSp: 0.36, eyeR: 0.105, eyeY: 0.17, browY: 0.38, brow: 1, browTilt: 0.12, noseLen: 1, noseW: 1, noseHook: 0, lip: 1, mouthW: 1, mouthY: -0.5, cheek: 1, ear: 1, pupil: 0.62 };
function faceParams(seed, over) {
  const o = Object.assign({}, FACE_DEFAULT), r = (k) => h3hash(seed + ':f' + k) - 0.5;
  o.eyeSp *= 1 + r('es') * 0.14; o.noseLen *= 1 + r('nl') * 0.3; o.noseW *= 1 + r('nw') * 0.3; o.lip *= 1 + r('lp') * 0.4; o.brow *= 1 + r('bh') * 0.5; o.browTilt += r('bt') * 0.25;
  if (over) for (const k in over) if (over[k] !== undefined) o[k] = over[k];
  return o;
}
const FACE_MATS = {};
function faceMat(THREE, key, hex, rough, extra) {
  const k = key + hex; if (FACE_MATS[k]) return FACE_MATS[k];
  const m = new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: rough, metalness: 0 }, extra || {}));
  m.userData.keep = true; m.userData.refined = true; return (FACE_MATS[k] = m);
}
function mergeGeos(THREE, list) {   // [{geo, m: Matrix4}] -> one non-indexed geometry (position/normal/uv)
  const pos = [], nor = [], uv = [], nm = new THREE.Matrix3();
  for (const { geo, m } of list) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone(); g.applyMatrix4(m);
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    if (g.attributes.uv) uv.push(...g.attributes.uv.array); else for (let i = 0; i < g.attributes.position.count; i++) uv.push(0, 0);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.type = 'Head3Geometry'; return out;
}
function buildFace(THREE, group, cranium, jaw, skin, hp, fo) {
  const R = hp.R, f = Object.assign({}, FACE_DEFAULT, fo.params || {}), want = (k) => fo[k] !== false;
  group.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(), V = (x, y, z) => new THREE.Vector3(x, y, z);
  const surf = (y, z) => { rc.set(V(4 * R, y * R, z * R), V(-1, 0, 0)); const h = rc.intersectObjects([cranium, jaw], false)[0]; return h ? h.point.x : hp.crD * R; };
  const side = (y, x, s) => { rc.set(V(x * R, y * R, s * 4 * R), V(0, 0, -s)); const h = rc.intersectObject(cranium, false)[0]; return h ? h.point.z : s * hp.flat * hp.crW * R; };
  const SPH = new THREE.SphereGeometry(1, 9, 6), CYL = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const bins = {};
  const put = (bin, geo, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(sx, sy, sz));
    (bins[bin] = bins[bin] || []).push({ geo, m });
  };
  const dark = faceMat(THREE, 'dark', 0x120d0e, 0.6), white = faceMat(THREE, 'white', fo.eyeWhite || 0xe9e2d3, 0.35);
  const lipM = faceMat(THREE, 'lip', fo.lipColor || 0x8a4a3e, 0.55), browM = faceMat(THREE, 'brow', fo.brow || 0x1e1612, 0.85);
  const skinKeep = skin;
  const ex = f.eyeSp, ey = f.eyeY, er = f.eyeR;
  // brow ridge across the forehead (over the sockets) + cheekbones below them: the eyes sit in between
  if (want('ridge')) put('skin', SPH, surf(f.browY, 0) - 0.05 * R, f.browY * R, 0, 0.11 * R, 0.075 * R * (0.8 + 0.4 * f.brow), (ex + er * 1.9) * R);
  if (want('cheeks')) for (const s of [-1, 1]) put('skin', SPH, surf(-0.06, s * 0.42) - 0.07 * R, -0.06 * R, s * 0.43 * R, 0.13 * R * f.cheek, 0.085 * R * f.cheek, 0.15 * R * f.cheek, 0, 0, -0.2);
  if (want('eyes')) for (const s of [-1, 1]) {
    const z = s * ex * R, cx = surf(ey, s * ex) - er * R * 0.25, cy = ey * R;
    put('white', SPH, cx, cy, z, er * R, er * R * 0.92, er * R * 1.05);
    put('dark', SPH, cx + er * R * 0.9, cy - er * R * 0.08, z, er * R * 0.25, er * R * f.pupil, er * R * f.pupil * 0.95);             // iris/pupil
    put('skin', new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.36), cx - er * R * 0.05, cy + er * R * 0.12, z, er * R * 1.14, er * R * 1.0, er * R * 1.16, 0, 0, -0.3);   // upper lid
    put('dark', SPH, cx + er * R * 0.62, cy + er * R * 0.6, z, er * R * 0.26, er * R * 0.2, er * R * 1.15, 0, 0, -0.5);       // lash line
  }
  if (want('brows')) for (const s of [-1, 1]) put('brow', SPH, surf(f.browY + 0.04, s * ex) + 0.012 * R, (f.browY + 0.05) * R, s * ex * R, 0.06 * R, 0.055 * R * f.brow, 0.19 * R, s * f.browTilt, 0, 0);
  if (want('nose')) {
    const ty = -0.12 - 0.06 * (f.noseLen - 1), tx = surf(ty, 0) + 0.15 * R * f.noseLen, bx = surf(0.24, 0) - 0.01 * R, by = 0.24 * R;
    const top = V(bx, by, 0), tip = V(tx, ty * R, 0), mid = top.clone().lerp(tip, 0.5), len = top.distanceTo(tip);
    const ang = Math.atan2(tip.x - top.x, top.y - tip.y);                                          // lean of the bridge toward the tip
    put('nose', new THREE.CylinderGeometry(0.045 * R, 0.07 * R * f.noseW, 1, 8, 2), mid.x + f.noseHook * 0.02 * R, mid.y, 0, 1, len, 1, 0, 0, ang);
    put('nose', SPH, tip.x - 0.01 * R, tip.y, 0, 0.075 * R * f.noseW, 0.07 * R, 0.08 * R * f.noseW);
    for (const s of [-1, 1]) {
      put('nose', SPH, tip.x - 0.06 * R, tip.y - 0.02 * R, s * 0.075 * R * f.noseW, 0.055 * R, 0.048 * R, 0.045 * R);         // alar wings
      put('dark', SPH, tip.x - 0.035 * R, tip.y - 0.055 * R, s * 0.035 * R * f.noseW, 0.03 * R, 0.014 * R, 0.022 * R);         // nostrils
    }
  }
  if (want('mouth')) {
    const my = f.mouthY, mx = surf(my, 0);
    put('lip', SPH, surf(my + 0.06, 0) - 0.015 * R, (my + 0.055) * R, 0, 0.05 * R, 0.035 * R * f.lip, 0.19 * R * f.mouthW);
    put('lip', SPH, surf(my - 0.07, 0) - 0.02 * R, (my - 0.065) * R, 0, 0.055 * R, 0.045 * R * f.lip, 0.16 * R * f.mouthW);
    put('dark', SPH, mx + 0.02 * R, my * R, 0, 0.035 * R, 0.018 * R, 0.21 * R * f.mouthW);
  }
  if (want('ears')) for (const s of [-1, 1]) {
    const z = side(0.02, -0.12, s) + s * 0.025 * R;
    put('skin', SPH, -0.12 * R, 0.02 * R, z, 0.15 * R * f.ear, 0.24 * R * f.ear, 0.05 * R, 0, 0, 0.2);
    put('skin', SPH, -0.1 * R, -0.18 * R * f.ear, z, 0.06 * R, 0.07 * R, 0.045 * R);                                           // lobe
    put('dark', SPH, -0.1 * R, 0.03 * R, z + s * 0.035 * R, 0.07 * R * f.ear, 0.12 * R * f.ear, 0.012 * R);                       // concha shadow
  }
  const mats = { skin: skinKeep, nose: skinKeep, white, dark, lip: lipM, brow: browM }, out = {};
  for (const k in bins) {
    const m = new THREE.Mesh(mergeGeos(THREE, bins[k]), mats[k]); m.name = 'face-' + k; m.userData.noOutline = true; m.userData.head3 = true; m.userData.noRefine = k !== 'skin' && k !== 'nose';
    m.castShadow = false; group.add(m); out[k] = m;
  }
  return out;
}
window.Head3 = { buildFace: buildFace, faceParams: faceParams, buildHead: buildHead, buildNeck: buildNeck, head3Params: head3Params, HEAD3_DEFAULT: HEAD3_DEFAULT };
})();
