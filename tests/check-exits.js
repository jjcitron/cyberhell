/* Reports, for every level in every pack (plus MAP01), whether a player can
   walk from spawn to an exit switch. Run: node tests/check-exits.js [--json] */
const fs = require('fs');
const path = require('path');
const { analyze } = require('./reachability.js');
const { loadMap01 } = require('./loadMap01.js');

const ROOT = path.join(__dirname, '..');
const rows = [];

function record(pack, id, name, level) {
  let r;
  try { r = analyze(level); }
  catch (e) { r = { ok: false, reason: 'analyzer error: ' + e.message }; }
  rows.push({ pack, id, name, ok: r.ok, reason: r.reason, cells: r.reachableCells || 0 });
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
  const byPack = {};
  for (const r of rows) {
    (byPack[r.pack] = byPack[r.pack] || { ok: 0, bad: 0, reasons: {} });
    if (r.ok) byPack[r.pack].ok++;
    else { byPack[r.pack].bad++; byPack[r.pack].reasons[r.reason] = (byPack[r.pack].reasons[r.reason] || 0) + 1; }
  }
  for (const [p, s] of Object.entries(byPack)) {
    console.log(`${p.padEnd(7)} finishable ${String(s.ok).padStart(3)}/${s.ok + s.bad}` +
      (s.bad ? '   ' + Object.entries(s.reasons).map(([k, v]) => `${v}x "${k}"`).join(', ') : ''));
  }
  const bad = rows.filter(r => !r.ok).length;
  console.log(`\nTOTAL: ${rows.length - bad}/${rows.length} finishable, ${bad} broken`);
  process.exitCode = bad ? 1 : 0;
}
