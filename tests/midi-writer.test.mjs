/**
 * Round-trip test for the editor's SMF writer/reader.
 *   node tests/midi-writer.test.mjs
 * write -> read -> write must yield identical bytes, and the reader must cope
 * with the real cues shipped under midi/ (running status, note-on vel 0, etc).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const W = (await import(pathToFileURL(path.join(ROOT, 'js', 'editor', 'midi_writer.js')).href)).default;

const PPQ = 480;

function generatedSong() {
  const scale = [0, 2, 3, 5, 7, 8, 10];
  const tracks = [];
  const specs = [
    { name: 'Lead', channel: 0, program: 81, volume: 104, pan: 74, root: 72, len: 240 },
    { name: 'Pad', channel: 1, program: 89, volume: 88, pan: 54, root: 60, len: 960 },
    { name: 'Bass', channel: 2, program: 38, volume: 110, pan: 64, root: 36, len: 480 },
    { name: 'Drums', channel: 9, program: 0, volume: 118, pan: 64, root: 36, len: 120 }
  ];
  specs.forEach((sp, ti) => {
    const notes = [];
    for (let i = 0; i < 64; i++) {
      const tick = i * 120 + (ti % 2) * 30;
      const deg = scale[(i * (ti + 2)) % scale.length];
      const pitch = sp.channel === 9 ? [36, 38, 42, 46][i % 4] : sp.root + deg + 12 * ((i >> 4) % 2);
      notes.push({ tick, dur: sp.len, pitch, vel: 40 + ((i * 7) % 80) });
    }
    // Chord stack on a free tick, to exercise same-tick ordering.
    notes.push({ tick: 990, dur: 930, pitch: sp.root + 19, vel: 90 });
    notes.push({ tick: 990, dur: 930, pitch: sp.root + 16, vel: 90 });
    tracks.push({ ...sp, notes });
  });
  return { ppq: PPQ, tempo: 138, timeSignature: [7, 8], name: 'Round Trip Cue', bars: 8, tracks };
}

// 1. write -> read -> write is byte-identical.
const song = generatedSong();
const a = W.write(song);
const parsed = W.read(a);
const b = W.write(parsed);
assert.equal(a.length, b.length, `byte length differs: ${a.length} vs ${b.length}`);
assert.ok(Buffer.from(a).equals(Buffer.from(b)), 'write -> read -> write is not byte-identical');

// 2. The model survives the trip.
assert.equal(parsed.tempo, 138);
assert.deepEqual(parsed.timeSignature, [7, 8]);
assert.equal(parsed.ppq, PPQ);
assert.equal(parsed.tracks.length, 4, 'expected 4 tracks back');
assert.equal(parsed.tracks[3].channel, 9, 'drums must stay on channel 10');
assert.equal(parsed.tracks[0].program, 81);
assert.equal(parsed.tracks[1].pan, 54);
song.tracks.forEach((t, i) => {
  assert.equal(parsed.tracks[i].notes.length, t.notes.length, `note count differs on track ${i}`);
});
const n0 = song.tracks[0].notes.slice().sort((x, y) => (x.tick - y.tick) || (x.pitch - y.pitch))[0];
const p0 = parsed.tracks[0].notes[0];
assert.equal(p0.tick, n0.tick);
assert.equal(p0.pitch, n0.pitch);
assert.equal(p0.vel, n0.vel);
assert.equal(p0.dur, n0.dur);

// 3. It is a real type-1 SMF header.
assert.equal(Buffer.from(a.subarray(0, 4)).toString('ascii'), 'MThd');
assert.equal((a[8] << 8) + a[9], 1, 'format must be 1');
assert.equal((a[10] << 8) + a[11], 5, 'conductor + 4 instrument tracks');

// 4. The 26 shipped cues parse, and re-writing what we parsed is stable.
const midiDir = path.join(ROOT, 'midi');
const files = fs.readdirSync(midiDir).filter(f => f.endsWith('.mid'));
assert.ok(files.length >= 26, `expected the 26 cues, found ${files.length}`);
let totalNotes = 0;
for (const f of files) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(midiDir, f)));
  const s = W.read(bytes);
  assert.ok(s.tracks.length > 0, `${f}: no tracks parsed`);
  const notes = s.tracks.reduce((n, t) => n + t.notes.length, 0);
  assert.ok(notes > 0, `${f}: no notes parsed`);
  totalNotes += notes;
  const once = W.write(s);
  const twice = W.write(W.read(once));
  assert.ok(Buffer.from(once).equals(Buffer.from(twice)), `${f}: re-write not stable`);
}

// 5. Overlapping same-pitch notes collapse rather than writing ambiguous bytes.
const dup = W.read(W.write({
  ppq: PPQ, tempo: 120, timeSignature: [4, 4], bars: 1,
  tracks: [{ name: 'Dup', channel: 0, program: 0, notes: [
    { tick: 0, dur: 960, pitch: 60, vel: 70 },
    { tick: 0, dur: 240, pitch: 60, vel: 100 },
    { tick: 480, dur: 480, pitch: 60, vel: 80 }
  ] }]
}));
assert.equal(dup.tracks[0].notes.length, 2, 'same-tick duplicates must merge');
assert.equal(dup.tracks[0].notes[0].dur, 480, 'held note must clip at the next strike');
assert.equal(dup.tracks[0].notes[0].vel, 100, 'merged note keeps the louder velocity');

// 6. base64 helpers round-trip.
assert.ok(Buffer.from(W.base64ToBytes(W.bytesToBase64(a))).equals(Buffer.from(a)), 'base64 round trip failed');

console.log(`PASS midi-writer: ${a.length} bytes round-tripped, ${files.length} shipped cues parsed (${totalNotes} notes)`);
