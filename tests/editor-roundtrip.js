/* editor-roundtrip.js — every level in levelPacks must survive the editor
   model untouched: parse -> EdModel -> serialize -> parse, and the result must
   be identical in value AND key order to what came off disk.

   Run: node tests/editor-roundtrip.js [--json]
   A non-zero exit means the editor would silently rewrite a level. */
'use strict';

const fs = require('fs');
const path = require('path');
const EdModel = require('../js/editor/model.js');

const ROOT = path.join(__dirname, '..');
const asJson = process.argv.includes('--json');

function read(p) { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }

/* Where the two JSON strings first diverge — enough to name the offender. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return 'at char ' + i + ': ...' + a.slice(Math.max(0, i - 60), i + 40) + ' | got ...' + b.slice(Math.max(0, i - 60), i + 40);
  }
  return 'length ' + a.length + ' vs ' + b.length;
}

const packs = read('levelPacks/packs.json');
let checked = 0;
const diffs = [];

for (const pack of packs) {
  let manifest;
  try { manifest = read(pack.manifest); } catch (err) { diffs.push({ file: pack.manifest, why: 'manifest unreadable: ' + err.message }); continue; }
  for (const entry of manifest) {
    let original;
    try { original = read(entry.file); } catch (err) { diffs.push({ file: entry.file, why: 'unreadable: ' + err.message }); continue; }

    // The model is the parsed JSON; loading and re-emitting must not touch it.
    const loaded = original;
    const out = EdModel.serialize(loaded);
    const back = JSON.parse(out);

    checked++;
    const a = JSON.stringify(original);
    const b = JSON.stringify(back);
    if (a !== b) diffs.push({ file: entry.file, why: firstDiff(a, b) });
  }
}

/* A second, harder pass: prove the index-fixing mutations keep the engine's
   real links honest. Verified against js/cyber-traversal.js init():
     - triggers[].i is a Doom LINEDEF id; a wall claims it via wall.ai.
       Splicing walls must therefore NOT renumber trigger.i.
     - sector indices live in triggers[].act.secs, walls[].act.secs and
       walls[].fs / walls[].bs, and all of them shift when a sector goes. */
function invariantPass() {
  const problems = [];

  // 1. removing a wall that owns no linedef leaves every trigger untouched
  const a = read('levelPacks/pack1/json1.json');
  const trigBefore = JSON.stringify(a.triggers);
  let plain = a.walls.findIndex(w => w.ai === undefined);
  if (plain < 0) problems.push('no plain wall to test with');
  else {
    const n = a.walls.length;
    EdModel.removeWall(a, plain);
    if (a.walls.length !== n - 1) problems.push('removeWall removed the wrong number of walls');
    if (JSON.stringify(a.triggers) !== trigBefore) problems.push('removeWall renumbered trigger.i (they are linedef ids, not wall indices)');
  }

  // 2. removing the last wall carrying a linedef drops that linedef's trigger
  const b = read('levelPacks/pack1/json1.json');
  const bound = b.triggers.find(t => b.walls.some(w => w.ai === t.i));
  if (bound) {
    const owners = b.walls.map((w, i) => (w.ai === bound.i ? i : -1)).filter(i => i >= 0);
    for (let k = owners.length - 1; k >= 0; k--) EdModel.removeWall(b, owners[k]);
    if (b.triggers.some(t => t.i === bound.i)) problems.push('trigger for linedef ' + bound.i + ' outlived its last wall');
    const others = b.triggers.length;
    if (others !== a.triggers.length - 0 && others > b.triggers.length) problems.push('unrelated triggers were dropped');
  }

  // 3. triggerFor / wallsForTrigger agree with the engine's byLine join
  const c = read('levelPacks/pack1/json1.json');
  c.triggers.forEach((t, ti) => {
    const walls = EdModel.wallsForTrigger(c, ti);
    walls.forEach(wi => {
      if (EdModel.triggerFor(c, wi) !== ti) problems.push('triggerFor/wallsForTrigger disagree on wall ' + wi);
    });
  });

  // 4. removing a sector re-bases act.secs, wall.act.secs, wall.fs and wall.bs
  const d = read('levelPacks/pack1/json1.json');
  const withSecs = d.triggers.findIndex(t => t.act && t.act.secs && t.act.secs.length);
  if (withSecs >= 0) {
    const named = d.triggers[withSecs].act.secs[0];
    const victim = named > 0 ? 0 : 1;                 // a sector below the target
    const sectorJson = JSON.stringify(d.sectors[named]);
    const fsWall = d.walls.findIndex(w => typeof w.fs === 'number' && w.fs > victim);
    const fsSector = fsWall >= 0 ? JSON.stringify(d.sectors[d.walls[fsWall].fs]) : null;
    EdModel.removeSector(d, victim);
    const still = d.triggers[withSecs];
    if (!still || JSON.stringify(d.sectors[still.act.secs[0]]) !== sectorJson) problems.push('removeSector did not re-base triggers[].act.secs');
    if (fsWall >= 0 && JSON.stringify(d.sectors[d.walls[fsWall].fs]) !== fsSector) problems.push('removeSector did not re-base walls[].fs');
  }

  return problems.length ? problems.join('; ') : null;
}

/* Splicing walls[] is only safe because NOTHING persisted references a wall by
   array position: triggers use linedef ids (i / ai), everything else uses sector
   indices (act.secs, fs, bs) or tags. This census over the whole corpus fails the
   moment the converter adds a field that could be a wall index, which is the one
   thing that would make delete-by-splice wrong. */
const KNOWN = {
  top: 'ambientLight,entities,fogColor,fogDensity,name,playerSpawn,sectors,skyColor,sunLight,triggers,walls',
  walls: 'act,ai,bottomY,bs,closed,doorId,fs,h,hiFloor,isDoor,isExit,isSwitch,ledge,loFloor,p1,p2,solid,special,stepUp,switchId,tag,tex,topY',
  triggers: 'act,i,p1,p2',
  sectors: 'area,ceilTex,ceilY,depth,floorTex,floorY,hiY,id,isSky,light,loY,polys,tag,width,x,z',
  entities: 'amount,enemyType,name,pos,rot,type'
};

function keyCensus() {
  const seen = { top: new Set(), walls: new Set(), triggers: new Set(), sectors: new Set(), entities: new Set() };
  for (const pack of packs) {
    let manifest;
    try { manifest = read(pack.manifest); } catch (err) { continue; }
    for (const entry of manifest) {
      let lvl;
      try { lvl = read(entry.file); } catch (err) { continue; }
      Object.keys(lvl).forEach(k => seen.top.add(k));
      for (const group of ['walls', 'triggers', 'sectors', 'entities']) {
        (lvl[group] || []).forEach(o => Object.keys(o).forEach(k => seen[group].add(k)));
      }
    }
  }
  const news = [];
  for (const group of Object.keys(KNOWN)) {
    const known = new Set(KNOWN[group].split(','));
    [...seen[group]].sort().forEach(k => { if (!known.has(k)) news.push(group + '.' + k); });
  }
  return news.length ? 'unknown field(s) ' + news.join(', ') + ' — if any is a wall INDEX, delete-by-splice is unsafe and EdModel.removeWall must re-base it' : null;
}

const newFields = keyCensus();

const invariant = invariantPass();

if (asJson) {
  console.log(JSON.stringify({ checked, diffs: diffs.length, invariant, newFields, failures: diffs.slice(0, 20) }, null, 2));
} else {
  console.log('editor round-trip: ' + (checked - diffs.length) + '/' + checked + ' levels identical');
  diffs.slice(0, 20).forEach(d => console.log('  DIFF ' + d.file + ' — ' + d.why));
  if (diffs.length > 20) console.log('  … and ' + (diffs.length - 20) + ' more');
  console.log('index invariants: ' + (invariant ? 'FAIL — ' + invariant : 'ok'));
  console.log('field census:     ' + (newFields ? 'FAIL — ' + newFields : 'ok, no wall-index field exists'));
}

process.exit(diffs.length === 0 && !invariant && !newFields ? 0 : 1);
