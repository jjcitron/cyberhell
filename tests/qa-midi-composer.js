/**
 * Headless QA for the MIDI composer panel.
 *   node tests/qa-midi-composer.js            (expects a server on :5304)
 * Drives the standalone harness in isolated Chromium: presets must generate a
 * real multi-track song, the export must be a valid SMF the reader re-parses,
 * the piano roll must accept mouse edits, and Assign must write level.music.
 * Headless audio is silent, so playback is verified by the calls reaching the
 * synth (loadMIDI/playMIDI), not by sound.
 */
const path = require('path');
const { chromium } = require(process.env.PW || 'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core');

const PORT = process.env.QA_PORT || 5304;
const URL = `http://localhost:${PORT}/tests/midi-composer-harness.html`;
const SHOTS = path.join(__dirname, '..', 'prototype_artifacts');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.CyberMidiComposer, null, { timeout: 10000 });

  const fail = (m) => { throw new Error(m); };

  // Instrument the synth so playback is observable without audio.
  await page.evaluate(() => {
    const p = window.CyberMidi.player();
    window.__synthCalls = [];
    const s = p.synth;
    ['loadMIDI', 'playMIDI', 'stopMIDI'].forEach(fn => {
      const orig = s[fn].bind(s);
      s[fn] = (a) => { window.__synthCalls.push([fn, a && a.length ? a.length : 0]); return orig(a); };
    });
  });

  const panel = await page.evaluate(() => window.__panelSpec);
  if (panel.id !== 'midi-composer') fail('panel not registered: ' + JSON.stringify(panel));

  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_default.png') });

  // 1. Every style preset generates >= 4 tracks and a playable song.
  const presetKeys = ['industrial-cyber', 'dark-ambient', 'doom-metal', 'synthwave', 'gothic-organ'];
  for (const key of presetKeys) {
    const res = await page.evaluate((k) => {
      const C = window.CyberMidiComposer;
      C.generate(k, 4242);
      const bytes = C.exportBytes();
      const back = window.CyberMidiWriter.read(bytes);
      return {
        tracks: C.state.tracks.length,
        patterns: C.state.patterns.length,
        order: C.state.order.length,
        notes: C.state.patterns.reduce((n, p) => n + p.notes.length, 0),
        bytes: bytes.length,
        header: String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]),
        parsedTracks: back.tracks.length,
        parsedNotes: back.tracks.reduce((n, t) => n + t.notes.length, 0),
        tempo: back.tempo,
        drumChannel: back.tracks.some(t => t.channel === 9)
      };
    }, key);
    if (res.tracks < 4) fail(`${key}: only ${res.tracks} tracks`);
    if (res.notes < 40) fail(`${key}: only ${res.notes} notes`);
    if (res.header !== 'MThd') fail(`${key}: export is not an SMF`);
    if (res.parsedTracks < 4) fail(`${key}: reader got ${res.parsedTracks} tracks back`);
    if (res.parsedNotes < 40) fail(`${key}: reader got ${res.parsedNotes} notes back`);
    if (!res.drumChannel) fail(`${key}: no channel 10 drum track`);
    console.log(`  ${key.padEnd(18)} tracks=${res.tracks} patterns=${res.patterns} order=${res.order} ` +
      `notes=${res.notes} smf=${res.bytes}B reparsed=${res.parsedNotes} bpm=${res.tempo}`);
  }

  await page.evaluate(() => window.CyberMidiComposer.generate('industrial-cyber', 1337));
  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_preset.png') });

  // 2. Piano roll edits: click adds a note, clicking it again removes it.
  const canvas = await page.$('#panel-host canvas');
  const box = await canvas.boundingBox();
  const geom = await page.evaluate(() => {
    const g = window.CyberMidiComposer.geom;
    return { gutter: g.gutter, cellW: g.cellW, cellH: g.cellH, rows: g.rows };
  });
  const lastNote = () => page.evaluate(() => {
    const ns = window.CyberMidiComposer.state.patterns[0].notes;
    return ns[ns.length - 1];
  });
  const count = () => page.evaluate(() => window.CyberMidiComposer.state.patterns[0].notes.length);
  // Screen position of the middle of a note's given step, and of a pitch row.
  const stepX = (step) => box.x + geom.gutter + step * geom.cellW + geom.cellW / 2;
  const rowY = (row) => box.y + row * geom.cellH + geom.cellH / 2;

  const ROW = 8, STEP = 20;
  const before = await count();
  await page.mouse.click(stepX(STEP), rowY(ROW));
  const added = await count();
  if (added !== before + 1) fail(`click did not add a note (${before} -> ${added})`);
  const note = await lastNote();
  if (note.s !== STEP) fail(`note landed on step ${note.s}, expected ${STEP}`);

  // Drag the note's right edge to lengthen it.
  await page.mouse.move(box.x + geom.gutter + (note.s + note.l) * geom.cellW - 2, rowY(ROW));
  await page.mouse.down();
  await page.mouse.move(stepX(STEP + 6), rowY(ROW), { steps: 6 });
  await page.mouse.up();
  const lengthened = (await lastNote()).l;
  if (lengthened <= note.l) fail(`drag did not lengthen the note (${note.l} -> ${lengthened})`);

  // Shift-drag on the note body changes velocity.
  const v0 = (await lastNote()).v;
  await page.keyboard.down('Shift');
  await page.mouse.move(stepX(STEP + 2), rowY(ROW));
  await page.mouse.down();
  await page.mouse.move(stepX(STEP + 2), rowY(ROW) - 20, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const v1 = (await lastNote()).v;
  if (v1 === v0) fail(`shift-drag did not change velocity (stayed ${v0})`);

  // Clicking it again removes it.
  await page.mouse.click(stepX(STEP + 1), rowY(ROW));
  const removed = await count();
  if (removed !== added - 1) fail(`click did not remove the note (${added} -> ${removed})`);
  // Put it back so the screenshot shows an edit.
  await page.mouse.click(stepX(STEP), rowY(ROW));
  console.log(`  roll edits: add/remove ok, length ${note.l} -> ${lengthened} steps, velocity ${v0} -> ${v1}`);

  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_edit.png') });

  // 3. Preview: the exact bytes reach the synth sequencer.
  await page.evaluate(() => { window.__synthCalls.length = 0; window.CyberMidiComposer.play(); });
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__synthCalls.map(c => c[0]));
  if (!calls.includes('loadMIDI') || !calls.includes('playMIDI')) fail('preview never reached the sequencer: ' + calls.join(','));
  const loadLen = await page.evaluate(() => {
    const c = window.__synthCalls.find(x => x[0] === 'loadMIDI');
    return { given: c[1], expected: window.CyberMidiComposer.exportBytes().length };
  });
  if (loadLen.given !== loadLen.expected) fail(`synth got ${loadLen.given} bytes, song is ${loadLen.expected}`);
  const playing = await page.evaluate(() => window.CyberMidi.status().previewing);
  if (!playing) fail('player does not report a preview in progress');
  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_playing.png') });
  await page.evaluate(() => window.CyberMidiComposer.stop());
  console.log(`  preview: ${loadLen.given} bytes loaded + playMIDI, playhead armed`);

  // 4. Upload path: an existing shipped cue parses into the model.
  const imported = await page.evaluate(async () => {
    const buf = await (await fetch('../midi/ch-12-the-crucible.mid')).arrayBuffer();
    window.CyberMidiComposer.importBytes(new Uint8Array(buf));
    const C = window.CyberMidiComposer;
    return { tracks: C.state.tracks.length, notes: C.state.patterns[0].notes.length, tempo: C.state.tempo, bars: C.state.patternBars };
  });
  if (imported.tracks < 2 || imported.notes < 20) fail('import produced nothing: ' + JSON.stringify(imported));
  console.log(`  import ch-12: ${imported.tracks} tracks, ${imported.notes} notes, ${imported.tempo} bpm, ${imported.bars} bars`);
  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_import.png') });

  // 5. Assign writes level.music through CyberEditor.apply, and the player
  //    honours it ahead of the pack heuristic.
  await page.evaluate(() => { window.CyberMidiComposer.generate('doom-metal', 7); window.CyberMidiComposer.assign(); });
  const assigned = await page.evaluate(() => {
    const lv = window.CyberEditor.level;
    window.CyberMidi.player().attachLevel(lv);
    const p = window.CyberMidi.player();
    return {
      music: lv.music ? { name: lv.music.name, hasData: !!lv.music.data, file: lv.music.file || null } : null,
      label: window.__lastApply,
      lead: p.tracks[p.levelTrackIndices[0]].id,
      ids: p.levelAssignment.ids.join(','),
      saved: window.CyberEditor.__saved.length
    };
  });
  if (!assigned.music || !assigned.music.hasData) fail('assign did not write level.music: ' + JSON.stringify(assigned));
  if (assigned.lead !== 'level-custom') fail('player did not lead with the level cue: ' + assigned.ids);
  console.log(`  assign: "${assigned.music.name}" -> level.music (base64), player cue order ${assigned.ids}`);

  // 6. Built-in cue assignment.
  await page.evaluate(() => window.CyberMidiComposer.assignCue('ch-17'));
  const builtin = await page.evaluate(() => window.CyberEditor.level.music);
  if (!builtin.file || !builtin.file.includes('ch-17')) fail('built-in cue assign failed: ' + JSON.stringify(builtin));
  console.log(`  cue dropdown assign: ${builtin.file}`);

  await page.screenshot({ path: path.join(SHOTS, '_midi_composer_assigned.png') });

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  await browser.close();
  console.log('PASS qa-midi-composer: 5 presets, roll editing, preview, import, assignment');
})().catch(async (e) => {
  console.error('FAIL qa-midi-composer:', e.message);
  process.exit(1);
});
