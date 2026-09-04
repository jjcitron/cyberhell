/* For every level, checks that wall geometry lines up with floor geometry:
   every wall endpoint should sit on the boundary of some sector's floor (an
   "orphan" wall floats in space, unrelated to any floor).

   Converted levels carry real sector boundary loops, so an endpoint must
   coincide with a loop vertex -- both come from the same WAD vertices, so
   anything else means the boundary walk lost an edge. The hand-built MAP01
   still uses rectangles and is measured against rectangle borders.
   Run: node tests/check-clipping.js [--json] */
const fs = require('fs');
const path = require('path');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.join(__dirname, '..');
const EPS = 0.1; // engine units of slack for float rounding

function onRectBorder(px, pz, r) {
  const halfW = r.width / 2, halfD = r.depth / 2;
  const x0 = r.x - halfW - EPS, x1 = r.x + halfW + EPS;
  const z0 = r.z - halfD - EPS, z1 = r.z + halfD + EPS;
  if (px < x0 || px > x1 || pz < z0 || pz > z1) return false; // not even inside
  const onVertEdge = Math.abs(px - (r.x - halfW)) <= EPS || Math.abs(px - (r.x + halfW)) <= EPS;
  const onHorizEdge = Math.abs(pz - (r.z - halfD)) <= EPS || Math.abs(pz - (r.z + halfD)) <= EPS;
  return onVertEdge || onHorizEdge;
}

function sectorRects(level) {
  // Sectors carry either a single flat rect (converted pack levels) or a
  // `floors` array of sub-rects (the hand-built MAP01) -- same shape
  // reachability.js's floorRects() and the engine's getFloorAt() expect.
  const rects = [];
  for (const s of level.sectors || []) {
    if (s.floors && s.floors.length) rects.push(...s.floors);
    else if (s.width !== undefined) rects.push({ x: s.x, z: s.z, width: s.width, depth: s.depth });
  }
  return rects;
}

// Vertices of every sector loop, bucketed on a 1-unit grid so an endpoint
// lookup is a handful of comparisons instead of a scan.
function polyVertexIndex(level) {
  const buckets = new Map();
  let n = 0;
  for (const s of level.sectors || []) {
    for (const loop of s.polys || []) {
      for (const [x, z] of loop) {
        const k = Math.floor(x) + ':' + Math.floor(z);
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = []));
        b.push([x, z]);
        n++;
      }
    }
  }
  return n ? buckets : null;
}

function nearVertex(buckets, px, pz) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const b = buckets.get((Math.floor(px) + dx) + ':' + (Math.floor(pz) + dz));
      if (!b) continue;
      for (const [x, z] of b) if (Math.abs(x - px) <= EPS && Math.abs(z - pz) <= EPS) return true;
    }
  }
  return false;
}

function checkLevel(level) {
  const verts = polyVertexIndex(level);
  if (verts) {
    let orphanWalls = 0;
    const orphanSample = [];
    for (const w of level.walls || []) {
      if (nearVertex(verts, w.p1[0], w.p1[1]) && nearVertex(verts, w.p2[0], w.p2[1])) continue;
      orphanWalls++;
      if (orphanSample.length < 3) orphanSample.push({ p1: w.p1, p2: w.p2 });
    }
    const degenerate = (level.sectors || []).filter(s =>
      s.polys && s.area > 0.5 && !s.polys.length).length;
    return {
      sectors: (level.sectors || []).length, walls: (level.walls || []).length,
      badSectors: degenerate, orphanWalls, orphanSample
    };
  }

  const rects = sectorRects(level);
  const badSectors = rects.filter(r =>
    !(r.width > 0) || !(r.depth > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.z));

  let orphanWalls = 0;
  const orphanSample = [];
  for (const w of level.walls || []) {
    const p1 = w.p1, p2 = w.p2;
    const onFloor = (px, pz) => rects.some(r => onRectBorder(px, pz, r));
    const ok = onFloor(p1[0], p1[1]) && onFloor(p2[0], p2[1]);
    if (!ok) {
      orphanWalls++;
      if (orphanSample.length < 3) orphanSample.push({ p1, p2 });
    }
  }

  return {
    sectors: rects.length, walls: (level.walls || []).length,
    badSectors: badSectors.length,
    orphanWalls, orphanSample
  };
}

const rows = [];
rows.push({ pack: 'map01', id: 'MAP01', ...checkLevel(loadMap01()) });

const packsFile = path.join(ROOT, 'levelPacks', 'packs.json');
for (const pk of JSON.parse(fs.readFileSync(packsFile, 'utf8'))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pk.manifest), 'utf8'));
  for (const lv of manifest) {
    const level = JSON.parse(fs.readFileSync(path.join(ROOT, lv.file), 'utf8'));
    rows.push({ pack: pk.id, id: lv.id, name: lv.name, ...checkLevel(level) });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const badSectorMaps = rows.filter(r => r.badSectors > 0);
  const totalWalls = rows.reduce((a, r) => a + r.walls, 0);
  const totalOrphans = rows.reduce((a, r) => a + r.orphanWalls, 0);
  console.log(`${rows.length} maps checked, ${totalWalls} walls total.`);
  console.log(`Sectors with area but no boundary loop: ${badSectorMaps.length} maps affected.`);
  console.log(`Orphan wall endpoints (not on any sector's floor boundary, within ${EPS}u): ` +
    `${totalOrphans}/${totalWalls} (${(100 * totalOrphans / totalWalls).toFixed(1)}%)`);
  const worst = [...rows].sort((a, b) => b.orphanWalls - a.orphanWalls).slice(0, 5);
  console.log('\nWorst 5 by orphan wall count:');
  for (const r of worst) console.log(`  [${r.pack}/${r.id}] ${r.orphanWalls}/${r.walls} orphan walls, ${r.badSectors} bad sectors`);
  process.exitCode = badSectorMaps.length ? 1 : 0; // degenerate sectors are a real bug; orphan walls are a known approximation
}
