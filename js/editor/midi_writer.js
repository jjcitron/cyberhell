/**
 * CYBERHELL EDITOR - STANDARD MIDI FILE WRITER / READER
 *
 * Dependency-free SMF type-1 writer and reader. Same hand-rolled approach as
 * Clash of Steel's tools/compose_midi.py (header chunk, MTrk chunks,
 * variable-length deltas, meta + channel events), ported to JS so the editor
 * can author cues in the browser and hand the bytes straight to tinysynth.
 *
 * Song model (the reader produces it, the writer consumes it):
 *   {
 *     ppq: 480,
 *     tempo: 120,                 // BPM
 *     timeSignature: [4, 4],
 *     endTick: 7680,              // explicit song end (optional; derived if absent)
 *     name: 'Cue name',
 *     tracks: [{
 *       name: 'Bass', channel: 0, program: 38,
 *       volume: 100, pan: 64,     // CC7 / CC10, 0-127
 *       notes: [{ tick, dur, pitch, vel }]
 *     }]
 *   }
 *
 * Round-trip guarantee: write -> read -> write is byte-identical. That holds
 * because the writer never uses running status and orders events purely from
 * the note set (tick, then note-off before note-on, then pitch), so the reader
 * only has to recover the same notes, not the same emission order.
 *
 * Loaded both as a browser <script> (globalThis.CyberMidiWriter) and as a
 * CommonJS module in node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CyberMidiWriter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PPQ = 480;

  function varlen(n) {
    n = Math.max(0, n | 0);
    const out = [n & 0x7f];
    n >>>= 7;
    while (n) { out.unshift((n & 0x7f) | 0x80); n >>>= 7; }
    return out;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

  function pushBytes(arr, bytes) { for (let i = 0; i < bytes.length; i++) arr.push(bytes[i] & 0xff); }

  function str2bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128) out.push(c); // ASCII only, same as the python writer
    }
    return out;
  }

  function chunk(id, data) {
    const out = str2bytes(id);
    const len = data.length;
    out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    return out.concat(data);
  }

  /* ------------------------------------------------------------------ write */

  // Builds one MTrk body from a list of { tick, order, bytes }.
  function trackBody(events, endTick) {
    const evs = events.slice().sort((a, b) => (a.tick - b.tick) || (a.order - b.order));
    const out = [];
    let prev = 0;
    for (const e of evs) {
      pushBytes(out, varlen(e.tick - prev));
      pushBytes(out, e.bytes);
      prev = e.tick;
    }
    pushBytes(out, varlen(Math.max(0, endTick - prev)));
    pushBytes(out, [0xff, 0x2f, 0x00]);
    return out;
  }

  function metaEvent(type, data) {
    return [0xff, type].concat(varlen(data.length)).concat(data);
  }

  function songEndTick(song) {
    const ppq = song.ppq || DEFAULT_PPQ;
    const ts = song.timeSignature || [4, 4];
    let end = song.endTick || 0;
    if (!end) {
      const perBar = Math.round(ppq * 4 * ts[0] / ts[1]);
      end = Math.max(perBar, Math.round((song.bars || 4) * perBar));
    }
    (song.tracks || []).forEach(t => (t.notes || []).forEach(n => {
      end = Math.max(end, Math.round(n.tick + Math.max(1, n.dur)));
    }));
    return end;
  }

  /* One channel cannot sound the same pitch twice at once: two overlapping
     same-pitch notes are indistinguishable once written, because the first
     note-off ends both. So collapse them here rather than emitting bytes that
     mean something different from the model - duplicates at one tick merge,
     and a held note is clipped where the next strike of that pitch begins. */
  function normalizeNotes(list) {
    const notes = (list || [])
      .map(n => ({
        tick: Math.max(0, Math.round(n.tick)),
        dur: Math.max(1, Math.round(n.dur)),
        pitch: clamp(n.pitch, 0, 127),
        vel: clamp(n.vel === undefined ? 96 : n.vel, 1, 127)
      }))
      .sort((a, b) => (a.tick - b.tick) || (a.pitch - b.pitch));

    const byPitch = {};
    const out = [];
    notes.forEach(n => {
      const prev = byPitch[n.pitch];
      if (prev && prev.tick === n.tick) {
        prev.dur = Math.max(prev.dur, n.dur);
        prev.vel = Math.max(prev.vel, n.vel);
        return;
      }
      if (prev && prev.tick + prev.dur > n.tick) prev.dur = n.tick - prev.tick;
      byPitch[n.pitch] = n;
      out.push(n);
    });
    return out.filter(n => n.dur >= 1);
  }

  /** Song model -> SMF type-1 bytes. */
  function write(song) {
    const ppq = song.ppq || DEFAULT_PPQ;
    const ts = song.timeSignature || [4, 4];
    const bpm = song.tempo || 120;
    const end = songEndTick(song);

    // Track 0: conductor. Tempo + time signature only, exactly as read back.
    const cond = [];
    let order = 0;
    cond.push({ tick: 0, order: order++, bytes: metaEvent(0x03, str2bytes(song.name || 'Cyberhell Cue')) });
    const usPerQ = Math.round(60000000 / bpm);
    cond.push({ tick: 0, order: order++, bytes: metaEvent(0x51, [(usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff]) });
    let denPow = 2;
    for (let p = 0; p < 8; p++) if ((1 << p) === ts[1]) denPow = p;
    cond.push({ tick: 0, order: order++, bytes: metaEvent(0x58, [clamp(ts[0], 1, 32), denPow, 24, 8]) });

    const chunks = [trackBody(cond, end)];

    (song.tracks || []).forEach((t, ti) => {
      const ch = clamp(t.channel === undefined ? ti : t.channel, 0, 15);
      const evs = [];
      let o = 0;
      evs.push({ tick: 0, order: o++, bytes: metaEvent(0x03, str2bytes(t.name || ('Track ' + (ti + 1)))) });
      evs.push({ tick: 0, order: o++, bytes: [0xc0 | ch, clamp(t.program || 0, 0, 127)] });
      evs.push({ tick: 0, order: o++, bytes: [0xb0 | ch, 7, clamp(t.volume === undefined ? 100 : t.volume, 0, 127)] });
      evs.push({ tick: 0, order: o++, bytes: [0xb0 | ch, 10, clamp(t.pan === undefined ? 64 : t.pan, 0, 127)] });

      // Note events are ordered by (tick, off-before-on, pitch) so the order is
      // a pure function of the note set - the basis of the round-trip test.
      const notes = normalizeNotes(t.notes);
      const noteEvs = [];
      notes.forEach(n => {
        const tick = Math.max(0, Math.round(n.tick));
        const dur = Math.max(1, Math.round(n.dur));
        const pitch = clamp(n.pitch, 0, 127);
        const vel = clamp(n.vel === undefined ? 96 : n.vel, 1, 127);
        noteEvs.push({ tick: tick, kind: 1, pitch: pitch, bytes: [0x90 | ch, pitch, vel] });
        noteEvs.push({ tick: tick + dur, kind: 0, pitch: pitch, bytes: [0x80 | ch, pitch, 0] });
      });
      noteEvs.sort((a, b) => (a.tick - b.tick) || (a.kind - b.kind) || (a.pitch - b.pitch));
      noteEvs.forEach(e => evs.push({ tick: e.tick, order: 1000 + (o++), bytes: e.bytes }));

      chunks.push(trackBody(evs, end));
    });

    const header = chunk('MThd', [0, 1, (chunks.length >> 8) & 0xff, chunks.length & 0xff,
      (ppq >> 8) & 0xff, ppq & 0xff]);
    let bytes = header;
    chunks.forEach(c => { bytes = bytes.concat(chunk('MTrk', c)); });
    return Uint8Array.from(bytes);
  }

  /* ------------------------------------------------------------------- read */

  /** SMF bytes (Uint8Array / ArrayBuffer / array) -> song model. */
  function read(input) {
    const s = input instanceof Uint8Array ? input : new Uint8Array(input);
    const get4 = (i) => ((s[i] << 24) >>> 0) + (s[i + 1] << 16) + (s[i + 2] << 8) + s[i + 3];
    const get2 = (i) => (s[i] << 8) + s[i + 1];
    const tag = (i) => String.fromCharCode(s[i], s[i + 1], s[i + 2], s[i + 3]);

    if (s.length < 14 || tag(0) !== 'MThd') throw new Error('not a Standard MIDI File');
    const division = get2(12);
    if (division & 0x8000) throw new Error('SMPTE timecode MIDI files are not supported');

    const song = {
      ppq: division || DEFAULT_PPQ,
      tempo: 120,
      timeSignature: [4, 4],
      name: '',
      endTick: 0,
      tracks: []
    };

    let p = 8 + get4(4);
    let firstTrack = true;
    while (p + 8 <= s.length) {
      if (tag(p) !== 'MTrk') break;
      const len = get4(p + 4);
      const start = p + 8;
      const end = Math.min(s.length, start + len);
      p = start + len;

      // channel -> track record; a chunk holding several channels splits.
      const byChannel = {};
      const open = {}; // channel:pitch -> { note }
      let maxTick = 0;
      let chunkName = '';
      let i = start;
      let tick = 0;
      let runst = 0;

      const readVar = () => {
        let v = 0, c;
        do { c = s[i++]; v = (v << 7) + (c & 0x7f); } while (c & 0x80 && i < end);
        return v;
      };
      const trackFor = (ch) => {
        if (!byChannel[ch]) {
          byChannel[ch] = {
            name: chunkName || ('Channel ' + (ch + 1)), channel: ch, program: 0,
            volume: 100, pan: 64, notes: []
          };
        }
        return byChannel[ch];
      };

      while (i < end) {
        tick += readVar();
        if (i >= end) break;
        let st = s[i];
        if (st & 0x80) { i++; runst = st; } else { st = runst; }
        const hi = st & 0xf0;
        const ch = st & 0x0f;

        if (st === 0xff) {
          const type = s[i++];
          const dlen = readVar();
          const data = s.subarray(i, i + dlen);
          i += dlen;
          if (type === 0x51 && dlen === 3) {
            const us = (data[0] << 16) + (data[1] << 8) + data[2];
            if (us > 0) song.tempo = Math.round(60000000 / us);
          } else if (type === 0x58 && dlen >= 2) {
            song.timeSignature = [data[0], 1 << data[1]];
          } else if (type === 0x03) {
            let nm = '';
            for (let k = 0; k < data.length; k++) nm += String.fromCharCode(data[k]);
            if (firstTrack && !song.name) song.name = nm;
            if (!chunkName) {
              chunkName = nm;
              Object.keys(byChannel).forEach(k => { byChannel[k].name = nm; });
            }
          }
          if (type === 0x2f) { maxTick = Math.max(maxTick, tick); break; }
          maxTick = Math.max(maxTick, tick);
          continue;
        }

        if (st === 0xf0 || st === 0xf7) { const dlen = readVar(); i += dlen; continue; }

        switch (hi) {
          case 0x80: case 0x90: {
            const pitch = s[i++]; const vel = s[i++];
            if (hi === 0x90 && vel > 0) {
              // Re-strike of a still-held pitch: the held note ends here.
              const held = open[ch + ':' + pitch];
              if (held) held.dur = Math.max(1, tick - held.tick);
              open[ch + ':' + pitch] = { tick: tick, dur: 0, pitch: pitch, vel: vel };
              trackFor(ch).notes.push(open[ch + ':' + pitch]);
            } else {
              const n = open[ch + ':' + pitch];
              if (n) { n.dur = Math.max(1, tick - n.tick); delete open[ch + ':' + pitch]; }
            }
            break;
          }
          case 0xb0: {
            const cc = s[i++]; const val = s[i++];
            if (cc === 7) trackFor(ch).volume = val;
            else if (cc === 10) trackFor(ch).pan = val;
            break;
          }
          case 0xc0: trackFor(ch).program = s[i++]; break;
          case 0xd0: i += 1; break;
          case 0xa0: case 0xe0: i += 2; break;
          default: i = end; break;
        }
        maxTick = Math.max(maxTick, tick);
      }

      // Any note still held at end of track gets closed at the track end.
      Object.keys(open).forEach(k => { if (!open[k].dur) open[k].dur = Math.max(1, maxTick - open[k].tick); });

      Object.keys(byChannel)
        .sort((a, b) => a - b)
        .forEach(k => {
          const t = byChannel[k];
          t.notes.sort((a, b) => (a.tick - b.tick) || (a.pitch - b.pitch));
          song.tracks.push(t);
        });
      song.endTick = Math.max(song.endTick, maxTick);
      firstTrack = false;
    }

    const perBar = Math.round(song.ppq * 4 * song.timeSignature[0] / song.timeSignature[1]);
    song.bars = Math.max(1, Math.round(song.endTick / perBar));
    return song;
  }

  /* ---------------------------------------------------------------- base64 */

  function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof btoa === 'function') {
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }
    return Buffer.from(u8).toString('base64'); // node
  }

  function base64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(String(b64).replace(/^data:[^,]*,/, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(String(b64), 'base64'));
  }

  return {
    PPQ: DEFAULT_PPQ,
    write: write,
    read: read,
    songEndTick: songEndTick,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes
  };
});
