# Editor round — MIDI composer lane

Date: 2026-09-06
Branch: `editor/midi-composer` (worktree `C:\Dev\Personal\_wt\ch-midi-composer`)
Scope: `js/editor/midi_writer.js`, `js/editor/midi_composer.js`, `js/cyber-midi-player.js`
Deliverable from the plan: *"Music becomes assignable"* —
`.claude-documentation/plans/2026-09-06-level-world-pack-editor.md`.

## Outcome

All three deliverables are in and verified. The SMF writer round-trips byte-identically, the player
honours `level.music` ahead of the pack/map heuristic with every existing level's cue resolution
unchanged (198 assignments diffed, zero differences), and the composer panel generates, edits,
previews, exports, imports and assigns from a standalone harness driven in isolated Chromium.

## What was built

**`js/editor/midi_writer.js`** — dependency-free Standard MIDI File type-1 writer and reader, the
same hand-rolled approach as Clash of Steel's `tools/compose_midi.py` (header chunk, MTrk chunks,
variable-length deltas, meta and channel events), plus base64 helpers. Loads both as a browser
`<script>` (`globalThis.CyberMidiWriter`) and as a CommonJS module for node tests. The writer emits
tempo, time signature, track names, program change, CC7 volume, CC10 pan and note on/off with
velocity across as many tracks as the model carries; the reader parses arbitrary SMFs (running
status, note-on velocity 0 as note-off, sysex, meta) back into the same model, so an uploaded `.mid`
becomes editable.

Round-trip identity is a property of the design, not a coincidence: the writer never uses running
status and orders events purely from the note set (tick, then note-off before note-on, then pitch),
so the byte stream is a pure function of the model. One case genuinely cannot round-trip — two
overlapping same-pitch notes on one channel, because the first note-off ends both — so the writer
normalises them instead of emitting bytes that mean something other than the model: same-tick
duplicates merge (longest duration, loudest velocity) and a held note is clipped where the next
strike of that pitch begins.

**`js/cyber-midi-player.js`** — three additions, no behaviour change for levels without music:

- `attachLevel` now accepts `(file, name)` as before, plus `(file, name, level)` and `(level)`. When
  the level carries `music: { file | url, data (base64 SMF), name }`, that cue leads the level's
  track list and the pack/map heuristic cues stay behind it in the pause menu. The custom cue lives
  in a single appended slot on the shared track list (id `level-custom`) so the pause menu, the id
  index and `selectTrack()` all treat it as an ordinary cue; the slot is popped again the moment a
  level without music is attached. `fetchTrack()` decodes inline base64 with no network at all.
- `window.CyberMidi` facade for the editor: `playBytes(uint8, {loop})`, `stop()`, `setVolume(v)`,
  `status()` (playhead tick straight off the synth) and `listCues()` returning the 26 shipped cues as
  `{id, file, name, mood, bpm, levelEligible}` for the assignment dropdown. A preview supersedes the
  level transport through the existing generation counter and holds it until stopped, so it can
  never race the game's own reconciliation.
- `CYBER_NO_TITLE_THEME`: an editor page hosting the synth for previews no longer arms the attract
  theme on first click.

**`js/editor/midi_composer.js`** — the panel. Tracker-shaped model: song-level instrument tracks
(up to 8, GM program picker, channel picker with channel 10 as drums, per-track volume, pan, mute),
notes living in patterns, and a song-order strip that says which pattern plays when; `flatten()`
turns that into the writer's linear model. Tempo, time signature, bars per pattern, key and scale are
editable, and the piano roll shades in-scale rows (GM percussion names replace note names on a drum
track, and the three-octave window auto-scrolls to wherever the selected track actually sits).
Editing is click to add or remove, drag the right edge for length, shift-drag for velocity.
Transport is Play/Stop with loop and a playhead read from the synth's own tick. Five style presets
(industrial cyber, dark ambient, doom metal, synthwave, gothic organ) generate a full starting song
from a seeded RNG through one shared set of section builders — chord pad, bass pattern, arp, drum
pattern with fills, scale-degree random-walk melody — exactly the toolkit-plus-parameter-table shape
`compose_midi.py` uses. Outputs: Export `.mid` (download), Upload `.mid` (parsed into the model),
Assign to level (writes `level.music` through `CyberEditor.apply`, using `storage.saveMidi` when the
shell offers it and inline base64 otherwise) and a dropdown of the 26 built-in cues that assigns by
file reference. The panel registers as `{id:'midi-composer', side:'bottom'}` and waits for the shell
via `cybereditor-ready` or a short poll.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| SMF round trip + all 26 shipped cues parse | `node tests/midi-writer.test.mjs` | PASS — 2301 bytes identical on write→read→write, 26 cues, 43408 notes |
| `level.music` precedence, slot reversibility, preview scheduling, cue list | `node tests/midi-level-music.test.mjs` | PASS |
| Cue resolution unchanged for every shipped level | baseline dump of `assignmentFor()` before/after | PASS — 198 entries (197 levels + boot), zero diff |
| Composer panel end to end | `node tests/qa-midi-composer.js` (harness on :5304) | PASS |
| Game still boots with the modified player | `QA_PORT=8177 node tests/qa-mobile-start.js` | ALL PASS |
| In-game transport smoke (title cue, pause menu options, track step) | ad-hoc Chromium run against `index.html` | 26 tracks, MAP01 assignment `ch-01,ch-02,ch-07`, 20 pause-menu options, no page errors |

Composer QA numbers, one line per preset (tracks / patterns / order slots / notes / exported SMF /
notes recovered by the reader):

```
industrial-cyber   tracks=4 patterns=2 order=4 notes=218 smf=3920B reparsed=440 bpm=128
dark-ambient       tracks=5 patterns=2 order=4 notes=48  smf=1076B reparsed=96  bpm=74
doom-metal         tracks=4 patterns=2 order=4 notes=355 smf=5964B reparsed=710 bpm=150
synthwave          tracks=5 patterns=2 order=4 notes=338 smf=5833B reparsed=674 bpm=112
gothic-organ       tracks=5 patterns=2 order=4 notes=96  smf=1905B reparsed=192 bpm=88
roll edits: add/remove ok, length 2 -> 7 steps, velocity 100 -> 127
preview: 3726 bytes loaded + playMIDI, playhead armed
import ch-12: 5 tracks, 2081 notes, 160 bpm, 48 bars
assign: "Doom Metal Cue" -> level.music (base64), player cue order level-custom,ch-12
cue dropdown assign: midi/ch-17-void-cathedral.mid
```

Headless audio is silent, so playback is asserted on the calls reaching the synth: the exact byte
count handed to `loadMIDI` matches the exported song, `playMIDI` follows, and the player reports a
preview in progress. Screenshots were taken and inspected at 1280x720:
`prototype_artifacts/_midi_composer_{default,preset,edit,playing,import,assigned,drums}.png`.

## Known gaps

- `tests/qa-music-pause.js` could not run: it requires `puppeteer-core`, which is not installed in
  this environment. Pre-existing, unrelated to this lane. The ad-hoc Chromium smoke above covers the
  same surface at a shallower depth.
- The composer holds one song in memory. There is no per-pack library browser yet; `storage.listMidi`
  is read by nothing. Add it when the shell's storage lands for real.
- Pattern length is one value for the whole song (bars per pattern), not per pattern.
- The panel assumes the shell either calls `mount(el)` or returns an element from `registerPanel`; it
  handles both, but nothing else.
