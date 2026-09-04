/* For every level in every pack (plus MAP01), reports the fraction of walkable
   floor reachable from spawn and the size of any pockets sealed off from it.
   Run: node tests/check-floor-coverage.js [--json]

   Thresholds (the known defect this guards against: convert_all_wads.py used
   to turn any two-sided linedef with a >=32-unit floor-height difference into
   a full-height solid wall, sealing stairs/lifts/ledges into small pockets):
     - exit reachable (reuses tests/check-exits.js's analyze())
     - reachable floor fraction >= MIN_FRACTION, or spawn area >= MIN_AREA sq
       units (a small but fully-open map can legitimately have a low fraction
       if most of its floor is a big open area elsewhere -- area is the
       correctness bar, fraction is the diagnostic)
     - spawn's reachable region is never under MIN_AREA sq units */
const fs = require('fs');
const path = require('path');
const { analyze, floorMetrics } = require('./reachability.js');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.join(__dirname, '..');
const MIN_FRACTION = 0.6;
const MIN_AREA = 200; // sq units

const rows = [];
function record(pack, id, name, level) {
  let exit, floor;
  try { exit = analyze(level); } catch (e) { exit = { ok: false, reason: 'analyzer error: ' + e.message }; }
  try { floor = floorMetrics(level); } catch (e) { floor = { spawnOnFloor: false, reachableArea: 0, reachableFraction: 0, pockets: [], error: e.message }; }

  const okFraction = floor.reachableFraction >= MIN_FRACTION;
  const okArea = floor.reachableArea >= MIN_AREA;
  // Small fully-open maps can legitimately fall under the fraction target;
  // the area floor is the one that must always hold.
  const pass = exit.ok && okArea && (okFraction || floor.totalFloorArea < MIN_AREA * 1.5);

  rows.push({
    pack, id, name,
    exitOk: exit.ok, exitReason: exit.reason,
    reachableArea: floor.reachableArea, totalFloorArea: floor.totalFloorArea,
    reachableFraction: +floor.reachableFraction.toFixed(3),
    pockets: floor.pockets.length, largestPocket: floor.pockets[0] || 0,
    pass
  });
}

record('map01', 'MAP01', 'Entryway (Cyberpunk Edition)', loadMap01());

const packsFile = path.join(ROOT, 'levelPacks', 'packs.json');
for (const pk of JSON.parse(fs.readFileSync(packsFile, 'utf8'))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pk.manifest), 'utf8'));
  for (const lv of manifest) {
    const level = JSON.parse(fs.readFileSync(path.join(ROOT, lv.file), 'utf8'));
    record(pk.id, lv.id, lv.name, level);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const fractions = rows.map(r => r.reachableFraction).sort((a, b) => a - b);
  const median = fractions[Math.floor(fractions.length / 2)];
  const failing = rows.filter(r => !r.pass);

  console.log(`Median reachable-floor fraction: ${(median * 100).toFixed(1)}%`);
  console.log(`Maps with a pocket under ${MIN_AREA} sq units at spawn: ${rows.filter(r => r.reachableArea < MIN_AREA).length}/${rows.length}`);
  console.log(`Exit reachable: ${rows.filter(r => r.exitOk).length}/${rows.length}`);
  console.log('');
  for (const r of failing) {
    console.log(`FAIL [${r.pack}/${r.id}] ${r.name}`);
    console.log(`     exitOk=${r.exitOk} (${r.exitReason}) reachableArea=${r.reachableArea} ` +
      `totalFloorArea=${r.totalFloorArea} fraction=${(r.reachableFraction * 100).toFixed(1)}% pockets=${r.pockets}`);
  }
  console.log(`\n${rows.length - failing.length}/${rows.length} pass (exit reachable, spawn area >= ${MIN_AREA}, ` +
    `fraction >= ${MIN_FRACTION * 100}% unless the whole map is smaller than ${MIN_AREA * 1.5} sq units)`);
  process.exitCode = failing.length ? 1 : 0;
}
