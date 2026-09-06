/**
 * CYBERHELL EDITOR - MIDI COMPOSER PANEL
 *
 * Authors a level cue in the browser and assigns it to the level being edited.
 * Song model is pattern-based (the way a tracker works, not a 200-bar linear
 * roll): instrument tracks are song-level, notes live in patterns, and an order
 * strip says which pattern plays when. flatten() turns that into the linear
 * model js/editor/midi_writer.js writes, and the bytes go straight to tinysynth
 * through CyberMidi.playBytes() for preview.
 *
 * Style presets follow Clash of Steel's tools/compose_midi.py: one small set of
 * section builders (chord pad, bass pattern, arp, drum pattern, scale-degree
 * random-walk melody) reused across every style, with the flavour coming from
 * the per-style scale / programs / rhythm table and a seeded RNG.
 *
 * Owns nothing outside this panel: everything reaching the level goes through
 * CyberEditor.apply().
 */
(function () {
  'use strict';

  const W = () => globalThis.CyberMidiWriter;
  const PPQ = 480;
  const STEPS_PER_BEAT = 4;          // grid resolution: 16th notes
  const STEP_TICKS = PPQ / STEPS_PER_BEAT;
  const DRUM_CHANNEL = 9;

  /* ------------------------------------------------------------- GM tables */
  const GM_NAMES = ('Acoustic Grand,Bright Acoustic,Electric Grand,Honky-tonk,Electric Piano 1,Electric Piano 2,' +
    'Harpsichord,Clavi,Celesta,Glockenspiel,Music Box,Vibraphone,Marimba,Xylophone,Tubular Bells,Dulcimer,' +
    'Drawbar Organ,Percussive Organ,Rock Organ,Church Organ,Reed Organ,Accordion,Harmonica,Tango Accordion,' +
    'Nylon Guitar,Steel Guitar,Jazz Guitar,Clean Guitar,Muted Guitar,Overdriven Guitar,Distortion Guitar,Guitar Harmonics,' +
    'Acoustic Bass,Finger Bass,Pick Bass,Fretless Bass,Slap Bass 1,Slap Bass 2,Synth Bass 1,Synth Bass 2,' +
    'Violin,Viola,Cello,Contrabass,Tremolo Strings,Pizzicato,Orchestral Harp,Timpani,' +
    'String Ensemble 1,String Ensemble 2,Synth Strings 1,Synth Strings 2,Choir Aahs,Voice Oohs,Synth Voice,Orchestra Hit,' +
    'Trumpet,Trombone,Tuba,Muted Trumpet,French Horn,Brass Section,Synth Brass 1,Synth Brass 2,' +
    'Soprano Sax,Alto Sax,Tenor Sax,Baritone Sax,Oboe,English Horn,Bassoon,Clarinet,' +
    'Piccolo,Flute,Recorder,Pan Flute,Blown Bottle,Shakuhachi,Whistle,Ocarina,' +
    'Lead Square,Lead Sawtooth,Lead Calliope,Lead Chiff,Lead Charang,Lead Voice,Lead Fifths,Lead Bass+Lead,' +
    'Pad New Age,Pad Warm,Pad Polysynth,Pad Choir,Pad Bowed,Pad Metallic,Pad Halo,Pad Sweep,' +
    'FX Rain,FX Soundtrack,FX Crystal,FX Atmosphere,FX Brightness,FX Goblins,FX Echoes,FX Sci-Fi,' +
    'Sitar,Banjo,Shamisen,Koto,Kalimba,Bagpipe,Fiddle,Shanai,' +
    'Tinkle Bell,Agogo,Steel Drums,Woodblock,Taiko Drum,Melodic Tom,Synth Drum,Reverse Cymbal,' +
    'Guitar Fret Noise,Breath Noise,Seashore,Bird Tweet,Telephone,Helicopter,Applause,Gunshot').split(',');

  const PERC = { 35: 'Kick 2', 36: 'Kick', 37: 'Rimshot', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Floor Tom', 42: 'Hi-Hat', 43: 'Floor Tom Hi', 44: 'Pedal Hat', 45: 'Low Tom', 46: 'Open Hat', 47: 'Mid Tom', 48: 'Hi Tom', 49: 'Crash', 50: 'Hi Tom 2', 51: 'Ride', 52: 'China', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2' };

  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    harmonic: [0, 2, 3, 5, 7, 8, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentatonic: [0, 3, 5, 7, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11]
  };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* --------------------------------------------------------------- helpers */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const el = (tag, css, text) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const degreePitch = (root, scale, idx) => {
    const n = scale.length;
    const oct = Math.floor(idx / n);
    const deg = ((idx % n) + n) % n;
    return root + 12 * oct + scale[deg];
  };
  const noteLabel = (p) => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);

  /* --------------------------------------------------------------- the song */
  const state = {
    name: 'New Cue',
    tempo: 128,
    ts: [4, 4],
    patternBars: 4,
    key: { root: 2, scale: 'phrygian' },
    tracks: [],
    patterns: [],
    order: [],
    selPattern: 0,
    selTrack: 0,
    loop: true,
    volume: 0.6,
    lastLen: 2,
    baseOctave: 3,
    assigned: null
  };

  const stepsPerBar = () => Math.max(1, Math.round(state.ts[0] * 16 / state.ts[1]));
  const patternSteps = () => stepsPerBar() * state.patternBars;
  const isDrum = (t) => t.channel === DRUM_CHANNEL;

  function newTrack(name, program, channel) {
    return { name: name, program: program, channel: channel, volume: 100, pan: 64, muted: false };
  }
  function newPattern(name) { return { name: name || ('PAT ' + (state.patterns.length + 1)), notes: [] }; }

  /** Pattern model -> the writer's linear song model. */
  function flatten() {
    const barTicks = stepsPerBar() * STEP_TICKS;
    const tracks = state.tracks.map(t => ({
      name: t.name, channel: t.channel, program: t.program, volume: t.volume, pan: t.pan, notes: []
    }));
    const order = state.order.length ? state.order : [state.selPattern];
    order.forEach((pi, slot) => {
      const pat = state.patterns[pi];
      if (!pat) return;
      const off = slot * state.patternBars * barTicks;
      pat.notes.forEach(n => {
        const tr = tracks[n.t];
        if (!tr || state.tracks[n.t].muted) return;
        tr.notes.push({
          tick: off + n.s * STEP_TICKS,
          dur: Math.max(1, n.l) * STEP_TICKS,
          pitch: n.p,
          vel: n.v
        });
      });
    });
    return {
      ppq: PPQ, tempo: state.tempo, timeSignature: state.ts.slice(), name: state.name,
      bars: Math.max(1, order.length * state.patternBars), tracks: tracks
    };
  }

  /* ------------------------------------------------------------- generators
     Section builders, one set reused by every style (compose_midi.py pattern). */
  function addNote(pat, t, s, l, p, v) {
    if (s < 0 || p < 0 || p > 127) return;
    pat.notes.push({ t: t, s: Math.round(s), l: Math.max(1, Math.round(l)), p: Math.round(p), v: clamp(Math.round(v), 1, 127) });
  }
  function chordSection(pat, ti, root, scale, bars, spb, degrees, vel, holdBars) {
    const hold = holdBars || 1;
    for (let bar = 0; bar < bars; bar += hold) {
      const deg = degrees[(bar / hold | 0) % degrees.length];
      [0, 2, 4].forEach(off => addNote(pat, ti, bar * spb, hold * spb - 1, degreePitch(root, scale, deg + off), vel));
    }
  }
  function bassSection(pat, ti, root, scale, bars, spb, degrees, pattern, vel, octave) {
    for (let bar = 0; bar < bars; bar++) {
      const deg = degrees[bar % degrees.length];
      pattern.forEach(([s, l, d]) => {
        if (s >= spb) return;
        addNote(pat, ti, bar * spb + s, Math.min(l, spb - s), degreePitch(root, scale, deg + d) + 12 * (octave || -1), vel);
      });
    }
  }
  function arpSection(pat, ti, root, scale, bars, spb, degrees, vel, every) {
    const stride = every || 1;
    for (let bar = 0; bar < bars; bar++) {
      const deg = degrees[bar % degrees.length];
      const shape = [0, 2, 4, 6, 4, 2];
      for (let i = 0; i * stride < spb; i++) {
        addNote(pat, ti, bar * spb + i * stride, stride, degreePitch(root, scale, deg + shape[i % shape.length]), vel);
      }
    }
  }
  function percSection(pat, ti, bars, spb, rows, rng) {
    for (let bar = 0; bar < bars; bar++) {
      rows.forEach(row => {
        for (let s = 0; s < spb; s++) {
          const hit = row.steps[s % row.steps.length];
          if (!hit) continue;
          if (row.chance !== undefined && rng() > row.chance) continue;
          addNote(pat, ti, bar * spb + s, 1, row.note, row.vel + Math.floor(rng() * 12) - 6);
        }
      });
      if (bar === bars - 1) { // fill
        for (let s = spb - 4; s < spb; s++) addNote(pat, ti, s, 1, pick(rng, [45, 47, 48, 38]), 96);
      }
    }
  }
  function melodySection(pat, ti, root, scale, bars, spb, vel, rng, restProb, ambitus) {
    const total = bars * spb;
    let step = 0, idx = 0;
    while (step < total) {
      const len = Math.min(pick(rng, [1, 2, 2, 3, 4]), total - step);
      if (rng() > restProb) addNote(pat, ti, step, len, degreePitch(root, scale, idx), vel + Math.floor(rng() * 16) - 8);
      step += len;
      idx = clamp(idx + pick(rng, [-3, -2, -1, -1, 1, 1, 2, 3]), ambitus[0], ambitus[1]);
      if (step > total * 0.85) idx = idx > 0 ? Math.max(0, idx - 1) : Math.min(0, idx + 1);
    }
  }

  const D = (s) => s.split('').map(c => c !== '.' && c !== ' ');   // 'x..x' -> [1,0,0,1]

  const STYLES = {
    'industrial-cyber': {
      label: 'Industrial Cyber', tempo: 128, root: 38, scale: 'phrygian', bars: 4,
      tracks: [['Pad', 90, 0], ['Bass', 39, 1], ['Lead', 81, 2], ['Drums', 0, DRUM_CHANNEL]],
      degrees: [0, 0, 5, 3], holdBars: 1, bassPat: [[0, 2, 0], [4, 2, 0], [8, 2, 0], [11, 1, 4], [12, 2, 0]],
      drums: [{ note: 36, steps: D('x...x...x...x...'), vel: 112 }, { note: 38, steps: D('....x.......x...'), vel: 100 },
        { note: 42, steps: D('x.x.x.x.x.x.x.x.'), vel: 74 }, { note: 51, steps: D('..............x.'), vel: 70, chance: 0.5 }],
      lead: { restProb: 0.45, ambitus: [-1, 8], vel: 96 }, order: [0, 0, 1, 0]
    },
    'dark-ambient': {
      label: 'Dark Ambient', tempo: 74, root: 33, scale: 'minor', bars: 4,
      tracks: [['Drone', 89, 0], ['Sub', 43, 1], ['Bells', 98, 2], ['Air', 95, 3], ['Perc', 0, DRUM_CHANNEL]],
      degrees: [0, 0, 6, 4], holdBars: 2, bassPat: [[0, 14, 0]],
      drums: [{ note: 41, steps: D('x.......'), vel: 70, chance: 0.7 }, { note: 54, steps: D('........x.......'), vel: 46, chance: 0.4 }],
      lead: { restProb: 0.7, ambitus: [0, 6], vel: 66 }, order: [0, 1, 0, 1]
    },
    'doom-metal': {
      label: 'Doom Metal', tempo: 150, root: 40, scale: 'minor', bars: 4,
      tracks: [['Rhythm Gtr', 29, 0], ['Bass', 33, 1], ['Lead Gtr', 30, 2], ['Drums', 0, DRUM_CHANNEL]],
      degrees: [0, 0, 3, 5], holdBars: 1, bassPat: [[0, 1, 0], [1, 1, 0], [2, 1, 0], [3, 1, 0], [4, 1, 0], [6, 1, 4], [8, 1, 0], [10, 1, 0], [12, 1, 0], [14, 1, 6]],
      drums: [{ note: 36, steps: D('x.x.x.x.x.x.x.x.'), vel: 118 }, { note: 38, steps: D('....x.......x...'), vel: 112 },
        { note: 42, steps: D('xxxxxxxxxxxxxxxx'), vel: 64 }, { note: 49, steps: D('x...............'), vel: 100 }],
      lead: { restProb: 0.25, ambitus: [0, 11], vel: 104 }, order: [0, 0, 1, 1]
    },
    'synthwave': {
      label: 'Synthwave', tempo: 112, root: 41, scale: 'dorian', bars: 4,
      tracks: [['Pad', 88, 0], ['Bass', 38, 1], ['Arp', 87, 2], ['Lead', 80, 3], ['Drums', 0, DRUM_CHANNEL]],
      degrees: [0, 5, 3, 4], holdBars: 1, bassPat: [[0, 2, 0], [2, 2, 0], [4, 2, 0], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 0], [14, 2, 0]],
      arp: { every: 1 },
      drums: [{ note: 36, steps: D('x...x...x...x...'), vel: 110 }, { note: 39, steps: D('....x.......x...'), vel: 96 },
        { note: 46, steps: D('..x...x...x...x.'), vel: 62 }],
      lead: { restProb: 0.4, ambitus: [0, 9], vel: 92 }, order: [0, 0, 1, 0]
    },
    'gothic-organ': {
      label: 'Gothic Organ', tempo: 88, root: 36, scale: 'harmonic', bars: 4,
      tracks: [['Organ', 19, 0], ['Pedal', 19, 1], ['Choir', 52, 2], ['Bells', 14, 3], ['Timpani', 0, DRUM_CHANNEL]],
      degrees: [0, 4, 5, 0], holdBars: 1, bassPat: [[0, 8, 0], [8, 8, 4]],
      drums: [{ note: 41, steps: D('x.......x.......'), vel: 96 }, { note: 52, steps: D('x...............'), vel: 72, chance: 0.5 }],
      lead: { restProb: 0.5, ambitus: [0, 7], vel: 80 }, order: [0, 1, 0, 1]
    }
  };

  function generate(styleKey, seed) {
    const S = STYLES[styleKey];
    if (!S) return;
    const rng = mulberry32(seed >>> 0);
    state.name = S.label + ' Cue';
    state.tempo = S.tempo;
    state.ts = [4, 4];
    state.patternBars = S.bars;
    state.key = { root: S.root % 12, scale: S.scale };
    state.tracks = S.tracks.map(t => newTrack(t[0], t[1], t[2]));
    const scale = SCALES[S.scale];
    const spb = stepsPerBar();
    const bars = S.bars;
    const drumTi = state.tracks.findIndex(isDrum);

    state.patterns = [];
    for (let pi = 0; pi < 2; pi++) {
      const pat = newPattern(pi === 0 ? 'A / MAIN' : 'B / TURN');
      const degrees = pi === 0 ? S.degrees : S.degrees.slice().reverse();
      chordSection(pat, 0, S.root + 12, scale, bars, spb, degrees, pi === 0 ? 78 : 70, S.holdBars);
      bassSection(pat, 1, S.root, scale, bars, spb, degrees, S.bassPat, 104, -1);
      const arpTi = S.arp ? 2 : -1;
      if (arpTi >= 0) arpSection(pat, arpTi, S.root + 12, scale, bars, spb, degrees, 76, S.arp.every);
      const leadTi = state.tracks.length - (drumTi === state.tracks.length - 1 ? 2 : 1);
      if (leadTi > 1 && leadTi !== arpTi) {
        melodySection(pat, leadTi, S.root + 24, scale, bars, spb,
          S.lead.vel - (pi === 0 ? 0 : 6), rng, pi === 0 ? S.lead.restProb : S.lead.restProb + 0.15, S.lead.ambitus);
      }
      if (drumTi >= 0) percSection(pat, drumTi, bars, spb, S.drums, rng);
      state.patterns.push(pat);
    }
    state.order = S.order.slice();
    state.selPattern = 0;
    state.selTrack = 0;
  }

  /* ---------------------------------------------------- imported .mid -> model */
  function songToState(song) {
    const spbeat = STEPS_PER_BEAT;
    state.name = song.name || 'Imported Cue';
    state.tempo = song.tempo || 120;
    state.ts = song.timeSignature || [4, 4];
    const stepTicks = (song.ppq || PPQ) / spbeat;
    const bars = Math.max(1, Math.ceil(song.endTick / (stepsPerBar() * stepTicks)));
    state.patternBars = bars;
    state.tracks = song.tracks.slice(0, 8).map((t, i) => {
      const tr = newTrack(t.name || ('Track ' + (i + 1)), t.program || 0, t.channel === undefined ? i : t.channel);
      tr.volume = t.volume === undefined ? 100 : t.volume;
      tr.pan = t.pan === undefined ? 64 : t.pan;
      return tr;
    });
    const pat = newPattern('IMPORT');
    song.tracks.slice(0, 8).forEach((t, ti) => {
      t.notes.forEach(n => addNote(pat, ti, Math.round(n.tick / stepTicks), Math.max(1, Math.round(n.dur / stepTicks)), n.pitch, n.vel));
    });
    state.patterns = [pat];
    state.order = [0];
    state.selPattern = 0;
    state.selTrack = 0;
  }

  /* ================================================================== the UI */
  function buildUI(host, ed) {
    host.innerHTML = '';
    host.style.cssText = 'font:11px/1.4 "Courier New",monospace;color:#00ffcc;background:#080c10;' +
      'display:flex;flex-direction:column;gap:6px;padding:6px;box-sizing:border-box;height:100%;min-height:300px;overflow:hidden';

    const BTN = 'background:#101820;border:1px solid #00ffcc;color:#00ffcc;font:11px "Courier New",monospace;' +
      'padding:3px 8px;cursor:pointer;border-radius:2px';
    const FLD = 'background:#0c1218;border:1px solid #1d3b42;color:#9ef;font:11px "Courier New",monospace;padding:2px 4px';

    const bar = el('div', 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:0 0 auto');
    host.appendChild(bar);

    const field = (label, node, w) => {
      const wrap = el('label', 'display:flex;gap:4px;align-items:center;color:#4b7a86');
      wrap.appendChild(el('span', '', label));
      if (w) node.style.width = w;
      wrap.appendChild(node);
      bar.appendChild(wrap);
      return node;
    };
    const button = (label, fn, title) => {
      const b = el('button', BTN, label);
      if (title) b.title = title;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };

    const nameIn = field('CUE', Object.assign(el('input', FLD), { value: state.name }), '120px');
    const tempoIn = field('BPM', Object.assign(el('input', FLD), { type: 'number', min: '40', max: '240', value: state.tempo }), '52px');
    const tsNum = field('TS', Object.assign(el('input', FLD), { type: 'number', min: '1', max: '16', value: state.ts[0] }), '40px');
    const tsDen = el('select', FLD);
    [2, 4, 8, 16].forEach(d => tsDen.appendChild(Object.assign(el('option', '', String(d)), { value: String(d) })));
    tsDen.value = String(state.ts[1]);
    field('/', tsDen, '52px');
    const barsIn = field('BARS', Object.assign(el('input', FLD), { type: 'number', min: '1', max: '32', value: state.patternBars }), '46px');

    const rootSel = el('select', FLD);
    NOTE_NAMES.forEach((n, i) => rootSel.appendChild(Object.assign(el('option', '', n), { value: String(i) })));
    rootSel.value = String(state.key.root);
    field('KEY', rootSel, '54px');
    const scaleSel = el('select', FLD);
    Object.keys(SCALES).forEach(k => scaleSel.appendChild(Object.assign(el('option', '', k.toUpperCase()), { value: k })));
    scaleSel.value = state.key.scale;
    field('', scaleSel, '96px');

    const styleSel = el('select', FLD);
    Object.keys(STYLES).forEach(k => styleSel.appendChild(Object.assign(el('option', '', STYLES[k].label), { value: k })));
    field('STYLE', styleSel, '130px');
    const seedIn = field('SEED', Object.assign(el('input', FLD), { type: 'number', value: '1337' }), '62px');

    const playBtn = button('PLAY', () => togglePlay(), 'Preview through the game synth');
    button('STOP', () => stopPlay());
    const loopBox = Object.assign(el('input', ''), { type: 'checkbox', checked: state.loop });
    field('LOOP', loopBox);
    const volIn = field('VOL', Object.assign(el('input', ''), { type: 'range', min: '0', max: '100', value: String(state.volume * 100) }), '70px');

    bar.appendChild(el('span', 'flex:1 1 auto'));
    button('GENERATE', () => { generate(styleSel.value, parseInt(seedIn.value, 10) || 1); syncFromState(); redrawAll(); toast('Generated ' + STYLES[styleSel.value].label); });
    button('EXPORT .MID', () => exportMid());
    const upBtn = button('UPLOAD .MID', () => fileIn.click());
    const cueSel = el('select', FLD);
    field('CUE PACK', cueSel, '190px');
    button('ASSIGN CUE', () => assignBuiltin(cueSel.value));
    const assignBtn = button('ASSIGN TO LEVEL', () => assignComposed());
    assignBtn.style.cssText = BTN + ';border-color:#ff0055;color:#ff0055';

    const fileIn = Object.assign(el('input', 'display:none'), { type: 'file', accept: '.mid,.midi,audio/midi' });
    host.appendChild(fileIn);
    fileIn.addEventListener('change', () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      f.arrayBuffer().then(buf => {
        try {
          songToState(W().read(new Uint8Array(buf)));
          state.name = f.name.replace(/\.midi?$/i, '');
          syncFromState(); redrawAll();
          toast('Loaded ' + f.name + ' (' + state.tracks.length + ' tracks)');
        } catch (e) { toast('Not a readable MIDI file: ' + e.message); }
        fileIn.value = '';
      });
    });

    /* ------------------------------------------------------------ body: 3 cols */
    const body = el('div', 'display:flex;gap:6px;flex:1 1 auto;min-height:0');
    host.appendChild(body);

    const left = el('div', 'width:196px;flex:0 0 auto;display:flex;flex-direction:column;gap:4px;overflow:auto;' +
      'border:1px solid #123;padding:4px;box-sizing:border-box');
    const mid = el('div', 'flex:1 1 auto;min-width:0;overflow:auto;border:1px solid #123;position:relative');
    const right = el('div', 'width:180px;flex:0 0 auto;display:flex;flex-direction:column;gap:4px;overflow:auto;' +
      'border:1px solid #123;padding:4px;box-sizing:border-box');
    body.appendChild(left); body.appendChild(mid); body.appendChild(right);

    const canvas = el('canvas', 'display:block;image-rendering:pixelated;cursor:crosshair');
    mid.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const statusRow = el('div', 'flex:0 0 auto;color:#4b7a86;display:flex;gap:12px;flex-wrap:wrap');
    host.appendChild(statusRow);

    /* --------------------------------------------------------------- tracks */
    function redrawTracks() {
      left.innerHTML = '';
      const head = el('div', 'display:flex;justify-content:space-between;align-items:center;color:#ff0055');
      head.appendChild(el('span', '', 'TRACKS ' + state.tracks.length + '/8'));
      const add = el('button', BTN + ';padding:1px 6px', '+');
      add.addEventListener('click', () => {
        if (state.tracks.length >= 8) return toast('8 tracks is the ceiling');
        const used = state.tracks.map(t => t.channel);
        let ch = 0; while (ch < 15 && (used.indexOf(ch) !== -1 || ch === DRUM_CHANNEL)) ch++;
        state.tracks.push(newTrack('Track ' + (state.tracks.length + 1), 81, ch));
        redrawTracks(); redrawRoll();
      });
      head.appendChild(add);
      left.appendChild(head);

      state.tracks.forEach((t, i) => {
        const row = el('div', 'border:1px solid ' + (i === state.selTrack ? '#00ffcc' : '#1d3b42') +
          ';padding:3px;display:flex;flex-direction:column;gap:2px;background:' + (i === state.selTrack ? '#0d1c20' : 'transparent'));
        row.addEventListener('mousedown', () => { state.selTrack = i; autoOctave(); redrawTracks(); redrawRoll(); });
        const top = el('div', 'display:flex;gap:3px;align-items:center');
        const nm = Object.assign(el('input', FLD + ';flex:1 1 auto;width:60px'), { value: t.name });
        nm.addEventListener('input', () => { t.name = nm.value; });
        top.appendChild(nm);
        const mute = el('button', BTN + ';padding:1px 4px;' + (t.muted ? 'border-color:#ff0055;color:#ff0055' : ''), t.muted ? 'M' : 'm');
        mute.title = 'Mute track';
        mute.addEventListener('click', (e) => { e.stopPropagation(); t.muted = !t.muted; redrawTracks(); });
        top.appendChild(mute);
        const del = el('button', BTN + ';padding:1px 4px;border-color:#553', 'x');
        del.title = 'Remove track';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (state.tracks.length <= 1) return;
          state.tracks.splice(i, 1);
          state.patterns.forEach(p => {
            p.notes = p.notes.filter(n => n.t !== i).map(n => (n.t > i ? Object.assign(n, { t: n.t - 1 }) : n));
          });
          state.selTrack = Math.min(state.selTrack, state.tracks.length - 1);
          redrawTracks(); redrawRoll();
        });
        top.appendChild(del);
        row.appendChild(top);

        const prog = el('select', FLD + ';width:100%');
        GM_NAMES.forEach((n, pi) => prog.appendChild(Object.assign(el('option', '', pi + ' ' + n), { value: String(pi) })));
        prog.value = String(t.program);
        prog.disabled = isDrum(t);
        prog.addEventListener('change', () => { t.program = parseInt(prog.value, 10); });
        row.appendChild(prog);

        const chRow = el('div', 'display:flex;gap:3px;align-items:center;color:#4b7a86');
        const chSel = el('select', FLD + ';width:64px');
        for (let c = 0; c < 16; c++) chSel.appendChild(Object.assign(el('option', '', 'ch' + (c + 1) + (c === DRUM_CHANNEL ? ' drums' : '')), { value: String(c) }));
        chSel.value = String(t.channel);
        chSel.addEventListener('change', () => { t.channel = parseInt(chSel.value, 10); redrawTracks(); redrawRoll(); });
        chRow.appendChild(chSel);
        const pan = Object.assign(el('input', 'width:60px'), { type: 'range', min: '0', max: '127', value: String(t.pan) });
        pan.title = 'Pan';
        pan.addEventListener('input', () => { t.pan = parseInt(pan.value, 10); });
        chRow.appendChild(pan);
        const vol = Object.assign(el('input', 'width:60px'), { type: 'range', min: '0', max: '127', value: String(t.volume) });
        vol.title = 'Track volume (CC7)';
        vol.addEventListener('input', () => { t.volume = parseInt(vol.value, 10); });
        chRow.appendChild(vol);
        row.appendChild(chRow);
        left.appendChild(row);
      });
    }

    /* ------------------------------------------------------- patterns + order */
    function redrawPatterns() {
      right.innerHTML = '';
      const head = el('div', 'display:flex;justify-content:space-between;color:#ff0055');
      head.appendChild(el('span', '', 'PATTERNS'));
      const add = el('button', BTN + ';padding:1px 6px', '+');
      add.addEventListener('click', () => { state.patterns.push(newPattern()); state.selPattern = state.patterns.length - 1; redrawPatterns(); redrawRoll(); });
      head.appendChild(add);
      right.appendChild(head);

      state.patterns.forEach((p, i) => {
        const row = el('div', 'display:flex;gap:3px;align-items:center');
        const b = el('button', BTN + ';flex:1 1 auto;text-align:left' +
          (i === state.selPattern ? ';background:#0d2a2a' : ''), p.name + ' (' + p.notes.length + ')');
        b.addEventListener('click', () => { state.selPattern = i; autoOctave(); redrawPatterns(); redrawRoll(); });
        row.appendChild(b);
        const push = el('button', BTN + ';padding:1px 5px', '>');
        push.title = 'Append to song order';
        push.addEventListener('click', () => { state.order.push(i); redrawPatterns(); });
        row.appendChild(push);
        right.appendChild(row);
      });

      right.appendChild(el('div', 'color:#ff0055;margin-top:6px', 'SONG ORDER'));
      const strip = el('div', 'display:flex;flex-wrap:wrap;gap:3px');
      state.order.forEach((pi, slot) => {
        const s = el('button', BTN + ';padding:1px 5px', String.fromCharCode(65 + pi));
        s.title = 'Slot ' + (slot + 1) + ' - click to cycle pattern, right-click to remove';
        s.addEventListener('click', () => { state.order[slot] = (pi + 1) % state.patterns.length; redrawPatterns(); });
        s.addEventListener('contextmenu', (e) => { e.preventDefault(); state.order.splice(slot, 1); redrawPatterns(); });
        strip.appendChild(s);
      });
      right.appendChild(strip);
      const bars = state.order.length * state.patternBars;
      right.appendChild(el('div', 'color:#4b7a86', bars + ' bars | ' +
        (bars * 4 * 60 / Math.max(1, state.tempo)).toFixed(1) + 's'));
    }

    /* ------------------------------------------------------------ piano roll */
    const ROWS = 36;
    const CELL_W = 15, CELL_H = 9, GUTTER = 46;
    let playheadStep = -1;

    const rowPitch = (row) => (state.baseOctave + 1) * 12 + (ROWS - 1 - row);
    const pitchRow = (p) => (ROWS - 1) - (p - (state.baseOctave + 1) * 12);

    /* Scroll the 3-octave window to wherever the selected track actually sits -
       a drum track lives at 36-51 and would otherwise be off-screen entirely. */
    function autoOctave() {
      const t = state.tracks[state.selTrack];
      if (!t) return;
      if (isDrum(t)) { state.baseOctave = 2; return; }
      const pat = state.patterns[state.selPattern];
      const ps = pat ? pat.notes.filter(n => n.t === state.selTrack).map(n => n.p).sort((a, b) => a - b) : [];
      if (!ps.length) return;
      const median = ps[ps.length >> 1];
      state.baseOctave = clamp(Math.round((median - 18) / 12) - 1, 0, 7);
    }

    function redrawRoll() {
      const steps = patternSteps();
      const spb = stepsPerBar();
      canvas.width = GUTTER + steps * CELL_W;
      canvas.height = ROWS * CELL_H + 14;
      const scale = SCALES[state.key.scale];
      const inScale = (p) => scale.indexOf((((p - state.key.root) % 12) + 12) % 12) !== -1;
      const track = state.tracks[state.selTrack];
      const drums = track && isDrum(track);

      ctx.fillStyle = '#05080b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let r = 0; r < ROWS; r++) {
        const p = rowPitch(r);
        const y = r * CELL_H;
        ctx.fillStyle = drums ? (PERC[p] ? '#0c1418' : '#070b0e') : (inScale(p) ? '#0b1418' : '#070a0d');
        ctx.fillRect(GUTTER, y, canvas.width - GUTTER, CELL_H);
        if (!drums && p % 12 === state.key.root) { ctx.fillStyle = '#10222a'; ctx.fillRect(GUTTER, y, canvas.width - GUTTER, CELL_H); }
        ctx.fillStyle = '#2c4a52';
        ctx.font = '8px "Courier New",monospace';
        ctx.fillText(drums ? (PERC[p] || '').slice(0, 8) : noteLabel(p), 2, y + CELL_H - 1);
      }
      for (let s = 0; s <= steps; s++) {
        const x = GUTTER + s * CELL_W;
        ctx.strokeStyle = (s % spb === 0) ? '#28565e' : (s % 4 === 0 ? '#16333a' : '#0e2026');
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ROWS * CELL_H); ctx.stroke();
        if (s % spb === 0 && s < steps) {
          ctx.fillStyle = '#3d6d76';
          ctx.fillText('bar ' + (s / spb + 1), x + 3, ROWS * CELL_H + 10);
        }
      }
      for (let r = 0; r <= ROWS; r++) {
        ctx.strokeStyle = '#0e2026';
        ctx.beginPath(); ctx.moveTo(GUTTER, r * CELL_H + 0.5); ctx.lineTo(canvas.width, r * CELL_H + 0.5); ctx.stroke();
      }

      const pat = state.patterns[state.selPattern];
      if (pat) {
        // Other tracks stay visible but dim, so the roll reads as one song.
        pat.notes.forEach(n => {
          const row = pitchRow(n.p);
          if (row < 0 || row >= ROWS) return;
          const x = GUTTER + n.s * CELL_W, y = row * CELL_H;
          const w = Math.max(3, n.l * CELL_W - 1), h = CELL_H - 1;
          if (n.t === state.selTrack) {
            const a = 0.35 + 0.65 * (n.v / 127);
            ctx.fillStyle = 'rgba(0,255,204,' + a.toFixed(2) + ')';
            ctx.fillRect(x + 1, y + 1, w, h - 1);
            ctx.strokeStyle = '#003b33';
            ctx.strokeRect(x + 0.5, y + 0.5, w + 1, h);
          } else {
            ctx.fillStyle = 'rgba(255,0,85,0.22)';
            ctx.fillRect(x + 1, y + 1, w, h - 1);
          }
        });
      }
      if (playheadStep >= 0) {
        const x = GUTTER + playheadStep * CELL_W;
        ctx.strokeStyle = '#ffee00';
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ROWS * CELL_H); ctx.stroke();
      }
      redrawPatterns();
      statusRow.textContent = '';
      statusRow.appendChild(el('span', '', 'PATTERN ' + (state.selPattern + 1) + '/' + state.patterns.length +
        ' | TRACK ' + (state.tracks[state.selTrack] ? state.tracks[state.selTrack].name : '-') +
        ' | ' + patternSteps() + ' steps'));
      statusRow.appendChild(el('span', '', 'click add/remove | drag right edge = length | shift-drag = velocity'));
      statusRow.appendChild(el('span', '', state.assigned ? ('ASSIGNED: ' + state.assigned) : 'NOT ASSIGNED'));
      const oct = el('span', '');
      const o1 = el('button', BTN + ';padding:0 5px', 'OCT-');
      o1.addEventListener('click', () => { state.baseOctave = Math.max(0, state.baseOctave - 1); redrawRoll(); });
      const o2 = el('button', BTN + ';padding:0 5px', 'OCT+');
      o2.addEventListener('click', () => { state.baseOctave = Math.min(7, state.baseOctave + 1); redrawRoll(); });
      oct.appendChild(o1); oct.appendChild(o2);
      statusRow.appendChild(oct);
    }

    /* ------------------------------------------------------- roll interaction */
    let drag = null;
    const hitNote = (pat, step, row) => {
      const p = rowPitch(row);
      for (let i = pat.notes.length - 1; i >= 0; i--) {
        const n = pat.notes[i];
        if (n.t === state.selTrack && n.p === p && step >= n.s && step < n.s + n.l) return n;
      }
      return null;
    };
    canvas.addEventListener('mousedown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < GUTTER || y > ROWS * CELL_H) return;
      const step = Math.floor((x - GUTTER) / CELL_W);
      const row = Math.floor(y / CELL_H);
      const pat = state.patterns[state.selPattern];
      if (!pat || step < 0 || step >= patternSteps() || row < 0 || row >= ROWS) return;
      const n = hitNote(pat, step, row);

      if (n && e.shiftKey) { drag = { mode: 'vel', note: n, y0: y, v0: n.v }; return; }
      if (n) {
        const endX = GUTTER + (n.s + n.l) * CELL_W;
        if (endX - x <= 6) { drag = { mode: 'len', note: n }; return; }
        pat.notes.splice(pat.notes.indexOf(n), 1);
        redrawRoll();
        return;
      }
      const note = { t: state.selTrack, s: step, l: state.lastLen, p: rowPitch(row), v: 100 };
      pat.notes.push(note);
      drag = { mode: 'len', note: note };
      redrawRoll();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag.mode === 'len') {
        const step = Math.floor((x - GUTTER) / CELL_W);
        drag.note.l = clamp(step - drag.note.s + 1, 1, patternSteps() - drag.note.s);
        state.lastLen = drag.note.l;
      } else {
        drag.note.v = clamp(Math.round(drag.v0 + (drag.y0 - y) * 2), 1, 127);
      }
      redrawRoll();
    });
    window.addEventListener('mouseup', () => { drag = null; });

    /* -------------------------------------------------------------- transport */
    let rafId = 0;
    function togglePlay() {
      const midi = globalThis.CyberMidi;
      if (!midi) return toast('MIDI player not loaded');
      const st = midi.status ? midi.status() : null;
      if (st && st.playing) { stopPlay(); return; }
      const bytes = W().write(flatten());
      midi.setVolume(state.volume);
      midi.playBytes(bytes, { loop: state.loop });
      playBtn.textContent = 'PAUSE';
      const barTicks = stepsPerBar() * STEP_TICKS;
      const patTicks = state.patternBars * barTicks;
      const tick = () => {
        const s = midi.status();
        if (!s.playing) { playheadStep = -1; playBtn.textContent = 'PLAY'; redrawRoll(); return; }
        const slot = Math.floor(s.curTick / patTicks);
        const within = s.curTick - slot * patTicks;
        const orderPat = state.order.length ? state.order[slot % state.order.length] : state.selPattern;
        playheadStep = (orderPat === state.selPattern) ? Math.floor(within / STEP_TICKS) : -1;
        redrawRoll();
        rafId = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
    function stopPlay() {
      cancelAnimationFrame(rafId);
      if (globalThis.CyberMidi) globalThis.CyberMidi.stop();
      playheadStep = -1;
      playBtn.textContent = 'PLAY';
      redrawRoll();
    }

    /* --------------------------------------------------------------- outputs */
    const fileSlug = () => (state.name || 'cue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cue';

    function exportMid() {
      const bytes = W().write(flatten());
      const blob = new Blob([bytes], { type: 'audio/midi' });
      const a = el('a', 'display:none');
      a.href = URL.createObjectURL(blob);
      a.download = fileSlug() + '.mid';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Exported ' + a.download + ' (' + bytes.length + ' bytes)');
    }

    function assignBuiltin(fileOrId) {
      const cues = (globalThis.CyberMidi && globalThis.CyberMidi.listCues()) || [];
      const cue = cues.find(c => c.file === fileOrId || c.id === fileOrId);
      if (!cue) return toast('No such cue');
      writeMusic({ file: cue.file, name: cue.name }, cue.name);
    }

    function assignComposed() {
      const bytes = W().write(flatten());
      const name = state.name;
      const st = ed.storage;
      const packId = (ed.pack && (ed.pack.id || ed.pack.packId)) || 'custom';
      const done = (music) => writeMusic(music, name);
      if (st && typeof st.saveMidi === 'function') {
        Promise.resolve(st.saveMidi(packId, fileSlug() + '.mid', bytes)).then(ref => {
          let music = { name: name };
          if (typeof ref === 'string') music.file = ref;
          else if (ref && typeof ref === 'object') music = Object.assign(music, ref);
          if (!music.file && !music.url && !music.data) music.data = W().bytesToBase64(bytes);
          done(music);
        }, () => done({ name: name, data: W().bytesToBase64(bytes) }));
      } else {
        done({ name: name, data: W().bytesToBase64(bytes) });
      }
    }

    function writeMusic(music, label) {
      if (!ed || typeof ed.apply !== 'function') return toast('No level open');
      ed.apply((level) => { level.music = music; }, 'Assign music: ' + label);
      state.assigned = label;
      redrawRoll();
      toast('Level music set to ' + label);
    }

    const toast = (m) => { if (ed && ed.toast) ed.toast(m); else console.log('[midi-composer]', m); };

    /* ----------------------------------------------------------------- wiring */
    nameIn.addEventListener('input', () => { state.name = nameIn.value; });
    tempoIn.addEventListener('change', () => { state.tempo = clamp(parseInt(tempoIn.value, 10) || 120, 40, 240); });
    const reGrid = () => {
      state.ts = [clamp(parseInt(tsNum.value, 10) || 4, 1, 16), parseInt(tsDen.value, 10) || 4];
      state.patternBars = clamp(parseInt(barsIn.value, 10) || 4, 1, 32);
      redrawRoll();
    };
    tsNum.addEventListener('change', reGrid);
    tsDen.addEventListener('change', reGrid);
    barsIn.addEventListener('change', reGrid);
    rootSel.addEventListener('change', () => { state.key.root = parseInt(rootSel.value, 10); redrawRoll(); });
    scaleSel.addEventListener('change', () => { state.key.scale = scaleSel.value; redrawRoll(); });
    loopBox.addEventListener('change', () => { state.loop = loopBox.checked; });
    volIn.addEventListener('input', () => {
      state.volume = parseInt(volIn.value, 10) / 100;
      if (globalThis.CyberMidi) globalThis.CyberMidi.setVolume(state.volume);
    });

    function syncFromState() {
      nameIn.value = state.name;
      tempoIn.value = String(state.tempo);
      tsNum.value = String(state.ts[0]);
      tsDen.value = String(state.ts[1]);
      barsIn.value = String(state.patternBars);
      rootSel.value = String(state.key.root);
      scaleSel.value = state.key.scale;
    }

    function fillCues() {
      cueSel.innerHTML = '';
      const cues = (globalThis.CyberMidi && globalThis.CyberMidi.listCues()) || [];
      cues.forEach(c => {
        cueSel.appendChild(Object.assign(el('option', '', '[' + c.id + '] ' + c.name + (c.levelEligible ? '' : ' *sting')),
          { value: c.file }));
      });
    }

    function readLevel() {
      const lv = ed && ed.level;
      state.assigned = (lv && lv.music) ? (lv.music.name || lv.music.file || 'inline cue') : null;
    }

    function redrawAll() { autoOctave(); redrawTracks(); redrawRoll(); }

    if (ed && typeof ed.on === 'function') {
      ed.on('level-loaded', () => { readLevel(); redrawRoll(); });
      ed.on('level-changed', () => { readLevel(); redrawRoll(); });
    }

    // Open on something playable rather than an empty grid.
    generate('industrial-cyber', 1337);
    syncFromState();
    fillCues();
    readLevel();
    redrawAll();

    // Test/automation hook: the harness drives these instead of the mouse.
    host.__composer = {
      geom: { gutter: GUTTER, cellW: CELL_W, cellH: CELL_H, rows: ROWS, rowPitch: rowPitch, pitchRow: pitchRow },
      state: state, flatten: flatten, generate: (k, s) => { generate(k, s); syncFromState(); redrawAll(); },
      exportBytes: () => W().write(flatten()), redraw: redrawAll, play: togglePlay, stop: stopPlay,
      importBytes: (b) => { songToState(W().read(b)); syncFromState(); redrawAll(); },
      assign: assignComposed, assignCue: assignBuiltin
    };
    globalThis.CyberMidiComposer = host.__composer;
  }

  /* ------------------------------------------------------------ registration */
  function boot(ed) {
    if (!ed || boot.done) return;
    boot.done = true;
    let built = false;
    const build = (node) => { if (built || !node) return; built = true; buildUI(node, ed); };
    const ret = ed.registerPanel({
      id: 'midi-composer',
      title: 'MIDI COMPOSER',
      side: 'bottom',
      mount: build
    });
    if (ret && ret.nodeType === 1) setTimeout(() => build(ret), 0);
  }

  if (globalThis.CyberEditor) boot(globalThis.CyberEditor);
  else {
    window.addEventListener('cybereditor-ready', () => boot(globalThis.CyberEditor), { once: true });
    // The shell may have come up before this script did; poll briefly as well.
    let tries = 0;
    const t = setInterval(() => {
      if (globalThis.CyberEditor) { clearInterval(t); boot(globalThis.CyberEditor); }
      else if (++tries > 100) clearInterval(t);
    }, 100);
  }
})();
