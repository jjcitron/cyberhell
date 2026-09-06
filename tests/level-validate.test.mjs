// node --test tests/level-validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateLevel } = require('../js/shared/level_validate.js');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (o) => JSON.parse(JSON.stringify(o));

function allCanonicalLevels() {
  const out = [{ pack: 'map01', id: 'MAP01', level: loadMap01() }];
  const packsFile = path.join(ROOT, 'levelPacks', 'packs.json');
  for (const pk of JSON.parse(fs.readFileSync(packsFile, 'utf8'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pk.manifest), 'utf8'));
    for (const lv of manifest) {
      const level = JSON.parse(fs.readFileSync(path.join(ROOT, lv.file), 'utf8'));
      out.push({ pack: pk.id, id: lv.id, level });
    }
  }
  return out;
}

// A minimal, hand-built valid level -- one square sector, exit switch on one
// wall, nothing else -- so each synthetic-break test only exercises the one
// invariant it names instead of inheriting real-corpus noise.
function minimalLevel() {
  return {
    name: 'test level', skyColor: 0, fogColor: 0, fogDensity: 0.01, ambientLight: 0.5,
    sunLight: { color: 0xffffff, intensity: 1, pos: [0, 10, 0] },
    playerSpawn: { pos: [5, 0, 5], rot: 0 },
    sectors: [{
      id: 'sec_0', polys: [[[0, 0], [10, 0], [10, 10], [0, 10]]], area: 100,
      floorY: 0, ceilY: 6, floorTex: 'tech_floor', ceilTex: 'tech_panel', light: 0.5, isSky: false
    }],
    walls: [
      { p1: [0, 0], p2: [10, 0], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
      { p1: [10, 0], p2: [10, 10], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
      { p1: [10, 10], p2: [0, 10], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
      { p1: [0, 10], p2: [0, 0], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true, isSwitch: true, switchId: 'sw_exit_game', ai: 1 }
    ],
    triggers: [],
    entities: []
  };
}

function codes(list) { return list.map((e) => e.code); }

test('every canonical level validates with 0 errors in full mode (warnings allowed)', () => {
  const levels = allCanonicalLevels();
  const failures = [];
  for (const { pack, id, level } of levels) {
    const r = validateLevel(level, { quick: false });
    if (r.errors.length) failures.push({ pack, id, errors: r.errors });
  }
  if (failures.length) console.error(JSON.stringify(failures.slice(0, 10), null, 2));
  assert.equal(failures.length, 0, `${failures.length}/${levels.length} canonical levels have validator errors (see stderr)`);
});

test('perf: biggest level (dv/json2, ~20k walls) validates in full mode under 2s', () => {
  const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'levelPacks/dv/json2.json'), 'utf8'));
  const t0 = Date.now();
  const r = validateLevel(level, { quick: false });
  const ms = Date.now() - t0;
  assert.equal(r.errors.length, 0);
  assert.ok(ms < 2000, `full-mode validate took ${ms}ms, budget is 2000ms`);
});

test('quick mode skips reachability (no grid-based errors, no floor pct)', () => {
  const level = minimalLevel();
  level.sectors[0].polys = [[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]; // spawn far from a since-removed exit would be unreachable in full mode
  level.walls[3].isSwitch = false; delete level.walls[3].switchId; // no exit at all -- still an error either mode, but proves quick doesn't touch reachability
  const r = validateLevel(level, { quick: true });
  assert.equal(r.stats.reachableFloorPct, null);
  assert.ok(!codes(r.errors).includes('EXIT_UNREACHABLE'));
});

test('schema: missing required field', () => {
  const level = minimalLevel();
  delete level.fogDensity;
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('MISSING_FIELD'));
});

test('schema: malformed music', () => {
  const level = minimalLevel();
  level.music = { name: 'no source file or url' };
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('INVALID_MUSIC'));
});

test('synthetic: open poly (loop under 3 points)', () => {
  const level = minimalLevel();
  level.sectors[0].polys[0] = [[0, 0], [10, 0]];
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('OPEN_POLY'));
});

test('synthetic: self-intersecting poly is a warning (real shipping levels have small self-crossing loops that still play fine)', () => {
  const level = minimalLevel();
  level.sectors[0].polys[0] = [[0, 0], [10, 10], [10, 0], [0, 10]]; // bowtie
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.warnings).includes('SELF_INTERSECTION'));
});

test('synthetic: no exit', () => {
  const level = minimalLevel();
  level.walls[3].isSwitch = false;
  delete level.walls[3].switchId;
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('NO_EXIT'));
});

test('synthetic: two exits is a warning (engine treats every sw_exit_game wall as valid; 70/198 canonical levels have more than one)', () => {
  const level = minimalLevel();
  const dupe = clone(level.walls[3]);
  level.walls.push(dupe);
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.warnings).includes('MULTIPLE_EXIT_WALLS'));
  assert.ok(!codes(r.errors).includes('MULTIPLE_EXIT_WALLS'));
});

test('synthetic: unreachable exit (full mode)', () => {
  const level = minimalLevel();
  // A second, disconnected sector far from spawn carries the only exit switch.
  level.sectors.push({
    id: 'sec_1', polys: [[[1000, 1000], [1010, 1000], [1010, 1010], [1000, 1010]]], area: 100,
    floorY: 0, ceilY: 6, floorTex: 'tech_floor', ceilTex: 'tech_panel', light: 0.5, isSky: false
  });
  level.walls[3].isSwitch = false; delete level.walls[3].switchId; // remove the reachable exit
  level.walls.push(
    { p1: [1000, 1000], p2: [1010, 1000], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
    { p1: [1010, 1000], p2: [1010, 1010], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
    { p1: [1010, 1010], p2: [1000, 1010], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true },
    { p1: [1000, 1010], p2: [1000, 1000], bottomY: 0, topY: 6, h: 6, tex: 'cyber_rust', solid: true, isSwitch: true, switchId: 'sw_exit_game' }
  );
  const r = validateLevel(level, { quick: false });
  assert.ok(codes(r.errors).includes('EXIT_UNREACHABLE'));
});

test('synthetic: malformed trigger index', () => {
  const level = minimalLevel();
  level.triggers.push({ p1: [1, 0], p2: [2, 0], act: { kind: 'door', trig: 'use', rep: true } }); // no .i at all
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('TRIGGER_INVALID_INDEX'));
});

test('synthetic: orphaned trigger.i is a warning, not an error (matches real canonical data)', () => {
  const level = minimalLevel();
  level.triggers.push({ i: 999, p1: [1, 0], p2: [2, 0], act: { kind: 'door', trig: 'use', rep: true } });
  const r = validateLevel(level, { quick: true });
  assert.ok(!codes(r.errors).includes('TRIGGER_INVALID_INDEX'));
  assert.ok(codes(r.warnings).includes('TRIGGER_ORPHANED'));
});

test('synthetic: unknown numeric enemyType is a warning (STATS[id] || DEFAULT_STATS is a real graceful fallback)', () => {
  const level = minimalLevel();
  level.entities.push({ type: 'soldier', enemyType: 999999, pos: [5, 0, 5], rot: 0 });
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.warnings).includes('ENEMY_TYPE_UNKNOWN_FALLBACK'));
  assert.ok(!codes(r.errors).includes('UNKNOWN_ENEMY_TYPE'));
});

test('synthetic: unresolved custom:<id> enemyType', () => {
  const level = minimalLevel();
  level.entities.push({ type: 'custom', enemyType: 'custom:my-guy', pos: [5, 0, 5], rot: 0 });
  const r = validateLevel(level, { quick: true });
  assert.ok(codes(r.errors).includes('UNKNOWN_ENEMY_TYPE'));
});

test('custom enemyType resolves cleanly when customEnemies defines it', () => {
  const level = minimalLevel();
  level.customEnemies = { 'my-guy': { base: 3004, stats: {}, look: {}, role: 'skirmisher' } };
  level.entities.push({ type: 'custom', enemyType: 'custom:my-guy', pos: [5, 0, 5], rot: 0 });
  const r = validateLevel(level, { quick: true });
  assert.ok(!codes(r.errors).includes('UNKNOWN_ENEMY_TYPE'));
});

test('known Doom-id enemyType and non-enemy entities pass', () => {
  const level = minimalLevel();
  level.entities.push({ type: 'soldier', enemyType: 3004, pos: [5, 0, 5], rot: 0 });
  level.entities.push({ type: 'pickup', pos: [6, 0, 6], rot: 0 }); // no enemyType -- not an enemy spawn
  const r = validateLevel(level, { quick: true });
  assert.ok(!codes(r.errors).includes('UNKNOWN_ENEMY_TYPE'));
});
