import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { console, performance: { now: () => 0 } };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'three.min.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'cyber-enemies.js'), 'utf8'), sandbox);

const { THREE, CyberEnemies: CE } = sandbox;

function chestDiamonds(group) {
  const found = [];
  group.traverse((o) => {
    if (!o.isMesh || o.geometry.type !== 'CylinderGeometry' || !o.material?.emissive) return;
    const hex = o.material.emissive.getHex();
    if (o.geometry.parameters.radialSegments === 8 && (hex === 0xff3a24 || hex === 0xc8202a) &&
        Math.abs(o.rotation.z - Math.PI / 4) < 1e-6) found.push(o);
  });
  return found;
}

test('CH-DAIMYO-VFX: idle, wind-up, strike, and reset keep the chest diamond under 25% of the torso', () => {
  const group = CE.build(3003, { type: 'monster' }, THREE);
  const enemy = {
    group,
    state: 'IDLE',
    attackT: 0,
    attackCooldown: 0,
    speed: CE.stats(3003).speed,
    stats: CE.stats(3003),
    floorY: 0
  };
  const diamonds = chestDiamonds(group);
  assert.equal(diamonds.length, 2, 'expected the inner core and its outer rim');

  const core = diamonds.find((o) => o.material.emissive.getHex() === 0xff3a24);
  const rim = diamonds.find((o) => o.material.emissive.getHex() === 0xc8202a);
  const base = core.scale.clone();
  const torsoWidth = 0.88;

  assert.ok(rim.scale.x <= torsoWidth * 0.25 + 1e-9, `idle rim ${rim.scale.x} exceeds 25% of torso`);
  assert.ok(core.scale.x < rim.scale.x, 'inner core should stay inside its rim');

  for (const attackT of [0.30, 0.45, 0.55, 0.70]) {
    enemy.state = 'ATTACK';
    enemy.attackT = attackT;
    CE.animate(enemy, attackT, 1 / 60);
    assert.ok(core.scale.x <= rim.scale.x, `core outgrew rim at attackT=${attackT}`);
    assert.ok(core.scale.y <= rim.scale.y, `core outgrew rim at attackT=${attackT}`);
    assert.ok(core.scale.z < 0.10, `core depth became a slab at attackT=${attackT}: ${core.scale.z}`);
    assert.ok(core.material.emissiveIntensity <= 3.7, `core overbright at attackT=${attackT}`);
  }

  enemy.state = 'IDLE';
  enemy.attackT = 0;
  CE.animate(enemy, 1, 1 / 60);
  assert.deepEqual(core.scale.toArray(), base.toArray(), 'post-attack reset must restore authored dimensions');
});

test('CH-DAIMYO-VFX: the Daimyo uses its compact fireball while other fireball enemies stay unchanged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(src, /daimyo_fireball:\s*\{[^}]*radius:\s*0\.14/);
  assert.match(src, /parseInt\(enemy\.enemyType,\s*10\)\s*===\s*3003[\s\S]*?\?\s*'daimyo_fireball'/);
  assert.match(src, /fireball:\s*\{[^}]*radius:\s*0\.32/, 'generic fireballs must keep their existing size');
});
