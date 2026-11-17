/**
 * Forward-axis / travel tests for every stylized TRELLIS mesh.
 *
 * The rigs face -Z; CyberAI.face() points the root's +Z at the target, and an
 * inner body group turns π so the visual front meets travel. cyber-trellis.js
 * first yaws the GLB into rig space (default π, TRELLIS +Z → rig -Z; π/2 when
 * a mesh came out facing +X). This file applies the same yaw plus the body's
 * π and checks that the mesh then faces +Z — the direction of travel.
 *
 *   CH-TRELLIS-YAW  YAW table in this file matches js/cyber-trellis.js
 *   CH-TRELLIS-MAP  recorded raw forward, after yaw+π, lands on +Z
 *   CH-TRELLIS-TOE  bipeds with a decisive foot axis have toes at +Z (travel)
 *                   after the same transform — the Glasswraith class of bug
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'models', 'trellis');
const require = createRequire(import.meta.url);
// three.min.js is a classic script; load it in a tiny vm with a fake window.
import vm from 'node:vm';
const threeSrc = fs.readFileSync(path.join(ROOT, 'js', 'three.min.js'), 'utf8');
const sandbox = { console, self: {}, window: {} };
sandbox.self = sandbox.window = sandbox;
vm.runInNewContext(threeSrc, sandbox);
const THREE = sandbox.THREE;

const FILES = {
  3001: 'cinderlimb', 3004: 'rotgreen', 3002: 'gutmaw', 9: 'rustcoat',
  65: 'twinbarrel', 64: 'hollowflame',
  3003: 'gilded_warlord', 66: 'bone_rocket', 16: 'coilspine',
  67: 'tankhulk', 68: 'silverleg', 58: 'glasswraith', 7: 'jarbrain'
};
// Must match js/cyber-trellis.js. Default (missing) is π.
const YAW = { 64: Math.PI / 2, 16: Math.PI / 2, 7: Math.PI / 2 };
// Kept on their original procedural rigs (Joel 2026-11-17).
const PROCEDURAL = { 3005: 'crimson_eye', 69: 'chrome_warden' };
const DEFAULT_YAW = Math.PI;
// Visual front of the raw TRELLIS GLB, from studio stills (front = +Z camera).
const RAW_FORWARD = {
  cinderlimb: [0, 0, 1], rotgreen: [0, 0, 1], gutmaw: [0, 0, 1], rustcoat: [0, 0, 1],
  twinbarrel: [0, 0, 1], hollowflame: [1, 0, 0],
  gilded_warlord: [0, 0, 1], bone_rocket: [0, 0, 1],
  coilspine: [1, 0, 0], tankhulk: [0, 0, 1], silverleg: [0, 0, 1],
  glasswraith: [0, 0, 1], jarbrain: [1, 0, 0]
};
const BIPEDS = [3001, 3004, 3002, 9, 65, 64, 3003, 58]; // toe axis: fail only if flipped
const APOSE = [3001, 3004, 3002, 9, 64, 3003, 58, 66]; // A-pose: after travel, arms span X more than Z

function yawOf(id) { return YAW[id] != null ? YAW[id] : DEFAULT_YAW; }

// yaw around Y, then the body's extra π, takes rig -Z to travel +Z.
function toTravel(x, y, z, id, gx, gz) {
  const yaw = yawOf(id) + Math.PI;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const px = x - gx, pz = z - gz;
  return [gx + cy * px + sy * pz, y, gz + (-sy * px + cy * pz)];
}

const CT = { 5120: 'Int8', 5121: 'Uint8', 5122: 'Int16', 5123: 'Uint16', 5125: 'Uint32', 5126: 'Float32' };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

function readPositions(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString().replace(/\0+$/u, ''));
  const binOff = 20 + jsonLen + 8;
  const bin = buf.subarray(binOff);
  const mat4 = (n, parent) => {
    if (n.matrix) {
      const m = new THREE.Matrix4().fromArray(n.matrix);
      return parent ? m.premultiply(parent) : m;
    }
    const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], sc = n.scale || [1, 1, 1];
    const te = new THREE.Matrix4().compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...sc));
    return parent ? te.premultiply(parent) : te;
  };
  const world = new Map();
  const walk = (i, parent) => { const n = json.nodes[i], m = mat4(n, parent); world.set(i, m); for (const c of n.children || []) walk(c, m); };
  for (const sc of json.scenes || []) for (const i of sc.nodes || []) walk(i, null);
  json.nodes.forEach((n, i) => { if (!world.has(i)) walk(i, null); });

  const out = [];
  const v = new THREE.Vector3();
  for (let ni = 0; ni < json.nodes.length; ni++) {
    const n = json.nodes[ni]; if (n.mesh == null) continue;
    const wm = world.get(ni) || new THREE.Matrix4();
    for (const prim of json.meshes[n.mesh].primitives) {
      const a = json.accessors[prim.attributes.POSITION], bv = json.bufferViews[a.bufferView];
      const nComp = NC[a.type], el = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
      const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
      const stride = bv.byteStride || nComp * el;
      const dv = new DataView(bin.buffer, bin.byteOffset + off, bin.byteLength - off);
      const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
      const k = a.normalized ? 1 / NORM[a.componentType] : 1;
      const le = a.componentType !== 5120 && a.componentType !== 5121;
      for (let i = 0; i < a.count; i++) {
        const x = dv[get](i * stride, le) * k;
        const y = dv[get](i * stride + el, le) * k;
        const z = dv[get](i * stride + 2 * el, le) * k;
        const nx = (a.normalized && (a.componentType === 5120 || a.componentType === 5122)) ? Math.max(x, -1) : x;
        const ny = (a.normalized && (a.componentType === 5120 || a.componentType === 5122)) ? Math.max(y, -1) : y;
        const nz = (a.normalized && (a.componentType === 5120 || a.componentType === 5122)) ? Math.max(z, -1) : z;
        v.set(nx, ny, nz).applyMatrix4(wm);
        out.push([v.x, v.y, v.z]);
      }
    }
  }
  return out;
}

function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  return c;
}

function toeSign(pts, thresh = 0.02) {
  let minY = 1e9, maxY = -1e9;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const H = maxY - minY; if (H < 0.05) return 0;
  const band = pts.filter((p) => p[1] <= minY + 0.08 * H); if (band.length < 20) return 0;
  let z0 = 1e9, z1 = -1e9; for (const p of band) { z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
  const mid = (z0 + z1) / 2, high = band.filter((p) => p[2] > mid), low = band.filter((p) => p[2] <= mid);
  if (!high.length || !low.length) return 0;
  const avgY = (a) => a.reduce((s, p) => s + p[1], 0) / a.length;
  const d = avgY(low) - avgY(high);
  if (Math.abs(d) < thresh * H) return 0;
  return d > 0 ? 1 : -1;
}

test('CH-TRELLIS-YAW: test table matches js/cyber-trellis.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'cyber-trellis.js'), 'utf8');
  for (const [id, name] of Object.entries(FILES)) {
    const re = new RegExp(String.raw`\b${id}:\s*'${name}'`);
    assert.match(src, re, `FILES ${id}:${name} missing from cyber-trellis.js`);
  }
  assert.match(src, /DEFAULT_YAW:\s*Math\.PI/);
  for (const id of [64, 16, 7]) {
    const re = new RegExp(String.raw`\b${id}:\s*Math\.PI\s*/\s*2`);
    assert.match(src, re, `YAW[${id}] should be π/2 in cyber-trellis.js`);
  }
  // Default-π meshes must not appear in the YAW override object as another value
  const yawBlock = src.match(/var YAW = \{([^}]*)\}/);
  assert.ok(yawBlock, 'YAW block missing');
  for (const id of Object.keys(FILES)) {
    if (YAW[id] != null) continue;
    const re = new RegExp(String.raw`\b${id}:`);
    assert.equal(re.test(yawBlock[1]), false, `YAW unexpectedly overrides ${id}`);
  }
});

test('CH-TRELLIS-MAP: each mesh\'s recorded raw forward becomes travel +Z', () => {
  for (const [id, name] of Object.entries(FILES)) {
    const [x, y, z] = RAW_FORWARD[name];
    const [tx, ty, tz] = toTravel(x, y, z, +id, 0, 0);
    const len = Math.hypot(tx, ty, tz);
    assert.ok(len > 0.5, `${name}: mapped forward vanished`);
    const nz = tz / len;
    assert.ok(nz > 0.95, `${name}: raw forward [${x},${y},${z}] maps to [${tx.toFixed(2)},${ty.toFixed(2)},${tz.toFixed(2)}] (want +Z travel)`);
  }
});

test('CH-TRELLIS-TOE: when a biped has a decisive foot axis, toes point along travel +Z (Glasswraith-class flip)', () => {
  const signs = {};
  for (const id of BIPEDS) {
    const name = FILES[id];
    const pts = readPositions(name + '.glb');
    const c = centroid(pts);
    const traveled = pts.map((p) => toTravel(p[0], p[1], p[2], id, c[0], c[2]));
    const sign = toeSign(traveled);
    signs[name] = sign;
    // Stylized block feet are often flat (inconclusive = 0). A -1 is the backwards-walk bug.
    assert.notEqual(sign, -1, `${name}: toes point -Z after the travel transform (mesh would walk backwards). Revisit YAW[${id}].`);
  }
  // Organic / sloped feet that do have a decisive axis.
  assert.equal(signs.glasswraith, 1, 'Glasswraith must have a decisive +Z toe axis after the travel transform');
  assert.equal(signs.hollowflame, 1, 'Hollowflame (π/2 yaw) must have a decisive +Z toe axis after the travel transform');
});

function midSpanRatio(pts) {
  let minY = 1e9, maxY = -1e9;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const H = maxY - minY;
  const mid = pts.filter((p) => p[1] >= minY + 0.45 * H && p[1] <= minY + 0.80 * H);
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of mid) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
  return (x1 - x0) / Math.max(1e-6, z1 - z0);
}

test('CH-TRELLIS-APOSE: A-pose meshes are wider on X than Z after the travel transform (catches a 90° yaw miss)', () => {
  for (const id of APOSE) {
    const name = FILES[id];
    const pts = readPositions(name + '.glb');
    const c = centroid(pts);
    const traveled = pts.map((p) => toTravel(p[0], p[1], p[2], id, c[0], c[2]));
    const ratio = midSpanRatio(traveled);
    assert.ok(ratio > 1.5, `${name}: mid-body X/Z span ratio ${ratio.toFixed(2)} (want > 1.5; a ~0.5 ratio means the mesh is still sideways)`);
  }
});

test('every stylized mesh file is present and parseable', () => {
  for (const name of Object.values(FILES)) {
    const pts = readPositions(name + '.glb');
    assert.ok(pts.length > 100, `${name}: only ${pts.length} verts`);
  }
});

test('CH-TRELLIS-KEEP: Maw Oni (3005) and Tetsu Oni (69) stay procedural', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'cyber-trellis.js'), 'utf8');
  const filesBlock = src.match(/var FILES = \{([^}]*)\}/);
  assert.ok(filesBlock, 'FILES block missing');
  for (const [id, name] of Object.entries(PROCEDURAL)) {
    assert.equal(new RegExp(String.raw`\b${id}:`).test(filesBlock[1]), false, `${id} must not map to a TRELLIS mesh`);
    assert.equal(src.includes(`'${name}'`), false, `${name} still referenced in cyber-trellis.js`);
    assert.equal(fs.existsSync(path.join(DIR, name + '.glb')), false, `${name}.glb should be removed`);
  }
  assert.equal(Object.keys(FILES).length, 13);
});
