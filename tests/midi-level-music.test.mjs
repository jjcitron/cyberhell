/**
 * cyber-midi-player: level.music assignment + the editor preview API.
 *   node tests/midi-level-music.test.mjs
 *
 * Runs the player file in a vm with a stub window and a stub tinysynth, so the
 * assertions are about scheduling calls rather than sound (headless audio is
 * silent anyway).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const W = (await import(pathToFileURL(path.join(ROOT, 'js', 'editor', 'midi_writer.js')).href)).default;

function loadPlayer() {
  const calls = [];
  class StubSynth {
    constructor() { this.actx = { state: 'running', currentTime: 0, resume: async () => {}, suspend: async () => {} }; this.playing = 0; this.song = null; }
    setMasterVol(v) { calls.push(['vol', v]); }
    setLoop(f) { calls.push(['loop', f]); }
    stopMIDI() { this.playing = 0; calls.push(['stop']); }
    playMIDI() { this.playing = 1; calls.push(['play']); }
    loadMIDI(d) { this.song = { len: d.length }; calls.push(['load', d.length]); }
    getPlayStatus() { return { play: this.playing, maxTick: 1000, curTick: 250 }; }
  }
  const listeners = [];
  const win = { addEventListener: (e, f) => listeners.push([e, f]) };
  const sandbox = {
    window: win, console,
    WebAudioTinySynth: StubSynth,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    XMLHttpRequest: function () { this.open = () => {}; this.send = () => { this.status = 404; this.onerror && this.onerror(); }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'cyber-midi-player.js'), 'utf8'), sandbox);
  return { win, calls };
}

const { win, calls } = loadPlayer();
const player = new win.CyberMidiPlayer();

// 1. A level without music resolves exactly as before.
player.attachLevel('levelPacks/pack1/json2.json', 'Pack 1 (Doom II) - Level 2 (MAP02)');
assert.equal(player.levelKey, 'pack1:MAP02');
assert.equal(player.levelAssignment.ids.join(','), 'ch-08');
assert.equal(win.CYBER_MUSIC.tracks.length, 26, 'no custom slot for a level without music');

// 2. level.music leads the assignment, whichever call shape the caller uses.
const song = { ppq: 480, tempo: 120, timeSignature: [4, 4], bars: 2, tracks: [
  { name: 'Bass', channel: 0, program: 38, notes: [{ tick: 0, dur: 240, pitch: 40, vel: 100 }] }
] };
const b64 = W.bytesToBase64(W.write(song));
const level = { file: 'levelPacks/pack1/json2.json', name: 'Pack 1 (Doom II) - Level 2 (MAP02)', music: { name: 'My Cue', data: b64 } };

player.attachLevel(level);
assert.equal(win.CYBER_MUSIC.tracks.length, 27, 'custom cue occupies one appended slot');
assert.equal(player.levelTrackIndices[0], 26, 'the level cue leads');
assert.equal(player.levelAssignment.ids.join(','), 'level-custom,ch-08');
assert.ok(win.CYBER_MUSIC.isLevelEligible('level-custom'), 'the level cue must be pickable in the pause menu');

player.attachLevel('levelPacks/pack1/json2.json', 'Pack 1 (Doom II) - Level 2 (MAP02)', level);
assert.equal(player.levelTrackIndices[0], 26, '(file, name, level) must work too');

// 3. Inline base64 bytes load without any fetch.
const buf = await player.fetchTrack(26);
assert.ok(buf.byteLength > 20, 'inline cue bytes decode');
assert.equal(Buffer.from(new Uint8Array(buf).subarray(0, 4)).toString('ascii'), 'MThd');

// 4. Attaching a music-free level again drops the slot.
player.attachLevel('levelPacks/pack1/json3.json', 'Pack 1 (Doom II) - Level 3 (MAP03)');
assert.equal(win.CYBER_MUSIC.tracks.length, 26, 'custom slot is popped again');
assert.equal(player.levelAssignment.ids.join(','), 'ch-09');

// 5. Editor preview API: bytes reach the synth's sequencer.
calls.length = 0;
const bytes = W.write(song);
assert.equal(win.CyberMidi.playBytes(bytes), true);
const kinds = calls.map(c => c[0]);
assert.ok(kinds.includes('load') && kinds.includes('play'), `expected load+play, got ${kinds.join(',')}`);
assert.equal(calls.find(c => c[0] === 'load')[1], bytes.length, 'the exact bytes were handed to the synth');
assert.equal(win.CyberMidi.status().playing, true);

win.CyberMidi.stop();
assert.equal(win.CyberMidi.status().playing, false);
assert.equal(win.CyberMidi.status().previewing, false);

// 6. listCues() offers the 26 shipped cues and never the custom slot.
const cues = win.CyberMidi.listCues();
assert.equal(cues.length, 26);
assert.equal(cues[0].id, 'ch-01');
assert.ok(cues[0].file.endsWith('.mid'));
assert.equal(cues.filter(c => c.levelEligible).length, 20, '20 level-eligible cues');

console.log('PASS midi-level-music: level.music leads, slot is reversible, preview scheduled, 26 cues listed');
