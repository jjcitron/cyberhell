/* Sector polygon integrity, for every converted level.
 *
 * convert_all_wads.py used to store each Doom sector as one axis-aligned
 * bounding rectangle. Doom sectors are arbitrary polygons, so those rectangles
 * overlapped heavily: getFloorAt picked whichever one came first in the array,
 * which is why the player fell through floors and stood on nothing. Sectors
 * now carry their real boundary loops. This checks that they are real:
 *
 *   1. every sector with any area has at least one closed loop of >= 3 points
 *   2. the area of the chained loops matches `sector.area`, which the
 *      converter computes straight from the WAD's directed boundary edges
 *      without chaining anything -- so a chaining bug shows up as a mismatch
 *   3. no two sectors overlap: SAMPLES random points per map, each inside at
 *      most one sector (Doom sectors never overlap in plan)
 *
 * Run: node tests/check-polys.js [--json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLES = 2000;
const AREA_TOLERANCE = 0.20;

// Deterministic sampling, so a failure is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function loopArea(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    a += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
  }
  return a / 2;
}

function bounds(polys) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const loop of polys) for (const [x, z] of loop) {
    if (x < b[0]) b[0] = x;
    if (z < b[1]) b[1] = z;
    if (x > b[2]) b[2] = x;
    if (z > b[3]) b[3] = z;
  }
  return b;
}

function pointInPolys(x, z, polys) {
  let inside = false;
  for (const loop of polys) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, zi] = loop[i], [xj, zj] = loop[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

function checkLevel(level) {
  const sectors = level.sectors || [];
  const withPolys = sectors.filter(s => s.polys);
  if (!withPolys.length) return null; // hand-built MAP01: rectangles by design

  let missingLoops = 0, shortLoops = 0, emptySectors = 0;
  let polyArea = 0, wadArea = 0;
  const boxes = [];
  for (const s of sectors) {
    const polys = s.polys || [];
    const declared = s.area || 0;
    wadArea += declared;
    if (!polys.length) {
      // A sector with no boundary at all is unused geometry in the WAD; one
      // that claims area but has no loop is a chaining failure.
      if (declared > 0.5) missingLoops++; else emptySectors++;
      continue;
    }
    for (const loop of polys) if (loop.length < 3) shortLoops++;
    polyArea += Math.abs(polys.reduce((a, l) => a + loopArea(l), 0));
    boxes.push({ bb: bounds(polys), polys });
  }

  const areaDev = wadArea > 0 ? Math.abs(polyArea - wadArea) / wadArea : 0;

  let overlaps = 0, hits = 0;
  if (boxes.length) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.bb[0]); minZ = Math.min(minZ, b.bb[1]);
      maxX = Math.max(maxX, b.bb[2]); maxZ = Math.max(maxZ, b.bb[3]);
    }
    const rnd = rng(0x5eed);
    for (let n = 0; n < SAMPLES; n++) {
      const x = minX + rnd() * (maxX - minX);
      const z = minZ + rnd() * (maxZ - minZ);
      let count = 0;
      for (const b of boxes) {
        if (x < b.bb[0] || x > b.bb[2] || z < b.bb[1] || z > b.bb[3]) continue;
        if (pointInPolys(x, z, b.polys)) count++;
        if (count > 1) break;
      }
      if (count) hits++;
      if (count > 1) overlaps++;
    }
  }

  return {
    sectors: sectors.length, emptySectors, missingLoops, shortLoops,
    polyArea: +polyArea.toFixed(1), wadArea: +wadArea.toFixed(1),
    areaDev: +areaDev.toFixed(4), overlaps, sampleHits: hits,
    pass: missingLoops === 0 && shortLoops === 0 && areaDev <= AREA_TOLERANCE && overlaps === 0
  };
}

const rows = [];
const packsFile = path.join(ROOT, 'levelPacks', 'packs.json');
for (const pk of JSON.parse(fs.readFileSync(packsFile, 'utf8'))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pk.manifest), 'utf8'));
  for (const lv of manifest) {
    const level = JSON.parse(fs.readFileSync(path.join(ROOT, lv.file), 'utf8'));
    const r = checkLevel(level);
    if (r) rows.push(Object.assign({ pack: pk.id, id: lv.id }, r));
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const bad = rows.filter(r => !r.pass);
  const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
  console.log(`${rows.length} converted maps checked, ${tot('sectors')} sectors.`);
  console.log(`Sectors with area but no closed loop: ${tot('missingLoops')}`);
  console.log(`Loops with fewer than 3 points:       ${tot('shortLoops')}`);
  console.log(`Unused sectors (no boundary at all):  ${tot('emptySectors')}`);
  const worstArea = rows.slice().sort((a, b) => b.areaDev - a.areaDev)[0];
  console.log(`Worst area deviation from the WAD:    ${(worstArea.areaDev * 100).toFixed(2)}% ` +
    `[${worstArea.pack}/${worstArea.id}]  (tolerance ${AREA_TOLERANCE * 100}%)`);
  console.log(`Overlapping sample points:            ${tot('overlaps')}/${tot('sampleHits')} inside-a-sector samples`);
  for (const r of bad.slice(0, 10)) {
    console.log(`  FAIL [${r.pack}/${r.id}] missingLoops=${r.missingLoops} shortLoops=${r.shortLoops} ` +
      `areaDev=${(r.areaDev * 100).toFixed(1)}% overlaps=${r.overlaps}`);
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} maps pass.`);
  process.exitCode = bad.length ? 1 : 0;
}
