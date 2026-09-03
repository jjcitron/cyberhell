/**
 * CYBERHELL MIDI PLAYER MODULE
 * Web Audio + SoundFont/Synthesizer playback for all 26 original Cyberhell MIDI cues.
 * Completely isolated from core engine and collision code.
 *
 * Music is a property of the LEVEL, not a menu feature. There is no music
 * selector on the title screen: every level carries an assignment drawn from the
 * existing 26-cue pack and it starts on its own when the mission starts. The
 * only place a player changes track is the PAUSE menu.
 */

(function() {
  const CYBER_TRACKS = [
    { id: 'ch-01', file: 'midi/ch-01-ground-zero.mid', title: 'Ground Zero', mood: 'dark synth', bpm: 112, signal: 'MAP01 ENTRYWAY / GROUND ZERO', map01: true },
    { id: 'ch-02', file: 'midi/ch-02-cyber-radar.mid', title: 'Cyber-Radar', mood: 'techno', bpm: 128, signal: 'CYBER-RADAR overlay', map01: true },
    { id: 'ch-03', file: 'midi/ch-03-terraformer.mid', title: 'Terraformer Spine', mood: 'industrial', bpm: 100, signal: 'UAC terraforming complex' },
    { id: 'ch-04', file: 'midi/ch-04-bio-cyber.mid', title: 'Bio-Cyber Hunt', mood: 'metal', bpm: 140, signal: 'bio-cybernetic abominations' },
    { id: 'ch-05', file: 'midi/ch-05-southern-extract.mid', title: 'Southern Extraction', mood: 'goth', bpm: 90, signal: 'southern extraction portal' },
    { id: 'ch-06', file: 'midi/ch-06-secret-alcove.mid', title: 'Secret Alcove', mood: 'ambient industrial', bpm: 80, signal: 'secret alcoves' },
    { id: 'ch-07', file: 'midi/ch-07-map01-engine.mid', title: 'MAP01 Engine', mood: 'industrial', bpm: 120, signal: 'CYBER-ENTRY // MAP01 ENGINE', map01: true },
    { id: 'ch-08', file: 'midi/ch-08-sector-lockdown.mid', title: 'Sector Lockdown', mood: 'techno', bpm: 132, signal: 'MAP02-scale corridors' },
    { id: 'ch-09', file: 'midi/ch-09-iron-corridor.mid', title: 'Iron Corridor', mood: 'metal', bpm: 150, signal: 'MAP03 sprawl' },
    { id: 'ch-10', file: 'midi/ch-10-waste-grinder.mid', title: 'Waste Grinder', mood: 'grunge', bpm: 118, signal: 'MAP04 slaughter' },
    { id: 'ch-11', file: 'midi/ch-11-blood-server.mid', title: 'Blood Server', mood: 'goth', bpm: 95, signal: 'MAP05' },
    { id: 'ch-12', file: 'midi/ch-12-the-crucible.mid', title: 'The Crucible', mood: 'industrial metal', bpm: 160, signal: 'MAP07 small arena' },
    { id: 'ch-13', file: 'midi/ch-13-downtown-static.mid', title: 'Grid Static', mood: 'dark synth', bpm: 108, signal: 'MAP12 megastructure' },
    { id: 'ch-14', file: 'midi/ch-14-industrial-park.mid', title: 'Industrial Park', mood: 'industrial', bpm: 124, signal: 'mid-pack factory' },
    { id: 'ch-15', file: 'midi/ch-15-suburbs-of-rust.mid', title: 'Suburbs of Rust', mood: 'grunge', bpm: 102, signal: 'MAP13' },
    { id: 'ch-16', file: 'midi/ch-16-core-breach.mid', title: 'Core Breach', mood: 'metal', bpm: 144, signal: 'MAP20-scale' },
    { id: 'ch-17', file: 'midi/ch-17-void-cathedral.mid', title: 'Void Cathedral', mood: 'goth ritual', bpm: 88, signal: 'MAP21 hellish' },
    { id: 'ch-18', file: 'midi/ch-18-icon-furnace.mid', title: 'Icon Furnace', mood: 'industrial ritual', bpm: 70, signal: 'MAP30 tiny boss' },
    { id: 'ch-19', file: 'midi/ch-19-cyber-entry-title.mid', title: 'Cyber-Entry', mood: 'dark synth title', bpm: 96, signal: 'live title theme', map01: true },
    { id: 'ch-20', file: 'midi/ch-20-tnt-system-pulse.mid', title: 'System Pulse', mood: 'techno industrial', bpm: 136, signal: 'pack3 techbase' },
    { id: 'ch-21', file: 'midi/ch-21-uac-hangar-ghost.mid', title: 'Hangar Ghost', mood: 'dark synth', bpm: 110, signal: 'pack2 techbase' },
    { id: 'ch-22', file: 'midi/ch-22-deus-vult-siege.mid', title: 'Deus Vult Siege', mood: 'industrial metal', bpm: 128, signal: 'DV megamap' },
    { id: 'ch-23', file: 'midi/ch-23-intermission-static.mid', title: 'Intermission Static', mood: 'ambient industrial', bpm: 85, signal: 'between levels' },
    { id: 'ch-24', file: 'midi/ch-24-combat-stinger.mid', title: 'Combat Stinger', mood: 'metal stinger', bpm: 155, signal: 'combat spike' },
    { id: 'ch-25', file: 'midi/ch-25-extraction-failed.mid', title: 'Extraction Failed', mood: 'funeral industrial', bpm: 60, signal: 'death / retry' },
    { id: 'ch-26', file: 'midi/ch-26-armor-zero.mid', title: 'Armor Zero', mood: 'tense techno', bpm: 134, signal: 'ARMOR 0% pressure' }
  ];

  /* ==========================================================================
     LEVEL -> TRACK ASSIGNMENT
     Assignment only. No cue is composed, re-rendered or edited here.

     CONTEXTUAL_CUES are event stings, not level themes: they must never be
     handed to a level and they are not offered as a level's music in the pause
     menu. TITLE_CUE is the attract-screen theme and is likewise not a level
     theme. Everything else in the pack is fair game, and reuse across a pack is
     expected - 197 levels ship against 20 level-eligible cues.
     ========================================================================== */
  const CONTEXTUAL_CUES = ['ch-06', 'ch-23', 'ch-24', 'ch-25', 'ch-26'];
  const TITLE_CUE = 'ch-19';

  // Doom-II style map slots. Slots whose number the TRACKLIST names outright
  // (MAP01/02/03/04/05/07/12/13/20/21/30) take that cue; the rest are filled by
  // mood so a pack reads as a continuous descent.
  const MAP_SLOT_THEMES = {
    MAP01: ['ch-01', 'ch-02', 'ch-07'],  // TRACKLIST: MAP01 ENTRYWAY / GROUND ZERO
    MAP02: ['ch-08'],                    // TRACKLIST: MAP02-scale corridors
    MAP03: ['ch-09'],                    // TRACKLIST: MAP03 sprawl
    MAP04: ['ch-10'],                    // TRACKLIST: MAP04 slaughter
    MAP05: ['ch-11'],                    // TRACKLIST: MAP05
    MAP06: ['ch-03'],
    MAP07: ['ch-12'],                    // TRACKLIST: MAP07 small arena
    MAP08: ['ch-14'],
    MAP09: ['ch-04'],
    MAP10: ['ch-20'],
    MAP11: ['ch-05'],
    MAP12: ['ch-13'],                    // TRACKLIST: MAP12 megastructure
    MAP13: ['ch-15'],                    // TRACKLIST: MAP13
    MAP14: ['ch-14'],
    MAP15: ['ch-05'],
    MAP16: ['ch-10'],
    MAP17: ['ch-09'],
    MAP18: ['ch-03'],
    MAP19: ['ch-13'],
    MAP20: ['ch-16'],                    // TRACKLIST: MAP20-scale
    MAP21: ['ch-17'],                    // TRACKLIST: MAP21 hellish
    MAP22: ['ch-11'],
    MAP23: ['ch-10'],
    MAP24: ['ch-17'],
    MAP25: ['ch-11'],
    MAP26: ['ch-16'],
    MAP27: ['ch-04'],
    MAP28: ['ch-17'],
    MAP29: ['ch-12'],
    MAP30: ['ch-18'],                    // TRACKLIST: MAP30 tiny boss
    MAP31: ['ch-20'],
    MAP32: ['ch-16'],
    MAP33: ['ch-18']
  };

  // Episode/mission slots (packs whose levels are numbered EnMn).
  const EPISODE_SLOT_THEMES = {
    E1M1: ['ch-01', 'ch-07'],
    E1M2: ['ch-03'],
    E1M3: ['ch-14'],
    E1M4: ['ch-08'],
    E1M5: ['ch-09'],
    E1M6: ['ch-13'],
    E1M7: ['ch-20'],
    E1M8: ['ch-12'],
    E1M9: ['ch-02'],
    E2M1: ['ch-04'],
    E2M2: ['ch-10'],
    E2M3: ['ch-14'],
    E2M4: ['ch-11'],
    E2M5: ['ch-08'],
    E2M6: ['ch-17'],
    E2M7: ['ch-04'],
    E2M8: ['ch-16'],
    E2M9: ['ch-05'],
    E3M1: ['ch-17'],
    E3M2: ['ch-15'],
    E3M3: ['ch-11'],
    E3M4: ['ch-17'],
    E3M5: ['ch-11'],
    E3M6: ['ch-16'],
    E3M7: ['ch-18'],
    E3M8: ['ch-18'],
    E3M9: ['ch-05'],
    E4M1: ['ch-12'],
    E4M2: ['ch-10'],
    E4M3: ['ch-09'],
    E4M4: ['ch-04'],
    E4M5: ['ch-17'],
    E4M6: ['ch-16'],
    E4M7: ['ch-18'],
    E4M8: ['ch-12'],
    E4M9: ['ch-13']
  };

  /* Per-pack rules.
     style  - which slot table the pack's level numbering reads from
     lead   - cue put in FRONT of the slot theme for every level in the pack
     extra  - cue appended to every level in the pack
     except - slots the pack-wide cue is withheld from */
  const PACK_RULES = {
    builtin: { style: 'map' },
    pack1:   { style: 'map' },
    // TRACKLIST ch-21 "pack2 techbase (not E1M1)".
    pack2:   { style: 'episode', extra: 'ch-21', except: ['E1M1'] },
    // TRACKLIST ch-20 "pack3 techbase".
    pack3:   { style: 'map', extra: 'ch-20' },
    pack4:   { style: 'episode' },
    pack5:   { style: 'map' },
    pack6:   { style: 'map' },
    // TRACKLIST ch-22 "DV megamap" - the megamap's own theme leads every level.
    dv:      { style: 'map', lead: 'ch-22' }
  };

  // Any level whose pack or slot cannot be read still gets music.
  const FALLBACK_THEME = ['ch-01', 'ch-14'];

  const indexById = {};
  CYBER_TRACKS.forEach((t, i) => { indexById[t.id] = i; });

  const isContextual = (id) => CONTEXTUAL_CUES.indexOf(id) !== -1;
  const isLevelEligible = (id) => !isContextual(id) && id !== TITLE_CUE;

  // 'levelPacks/pack3/json7.json' -> 'pack3'; the boot level -> 'builtin'.
  function packIdFromFile(file) {
    if (!file) return 'builtin';
    const m = /levelPacks\/([A-Za-z0-9_-]+)\//.exec(file);
    return m ? m[1] : 'builtin';
  }

  // 'Pack 3 (Final Doom TNT) - Level 7 (MAP08)' -> 'MAP08'. The trailing
  // parenthesised token is the original map slot and is present in both the
  // pack manifests and the level JSON itself.
  function slotFromName(name) {
    if (!name) return null;
    const all = String(name).toUpperCase().match(/\b(?:MAP\d{1,2}|E\d M?\d|E\dM\d)\b/g);
    if (!all || !all.length) return null;
    return all[all.length - 1].replace(/\s+/g, '');
  }

  /* Resolve one level to its assigned cue ids. Deterministic: same level always
     gets the same list, in the same order, so the auto-play track is stable. */
  function assignmentFor(file, name) {
    const packId = packIdFromFile(file);
    const rules = PACK_RULES[packId] || PACK_RULES.builtin;
    // The boot level is Entryway / MAP01 and carries no slot token in its name.
    const slot = slotFromName(name) || (packId === 'builtin' ? 'MAP01' : null);
    const table = rules.style === 'episode' ? EPISODE_SLOT_THEMES : MAP_SLOT_THEMES;
    const base = (slot && table[slot]) || FALLBACK_THEME;

    const ids = [];
    const push = (id) => {
      if (id && isLevelEligible(id) && ids.indexOf(id) === -1) ids.push(id);
    };
    const withheld = slot && rules.except && rules.except.indexOf(slot) !== -1;
    if (rules.lead && !withheld) push(rules.lead);
    base.forEach(push);
    if (rules.extra && !withheld) push(rules.extra);
    if (!ids.length) FALLBACK_THEME.forEach(push);

    return { key: packId + ':' + (slot || 'UNKNOWN'), packId: packId, slot: slot, ids: ids };
  }

  class CyberMidiPlayer {
    constructor() {
      this.synth = null;
      this.tracks = CYBER_TRACKS;
      this.currentIndex = indexById[TITLE_CUE];
      this.isPlaying = false;
      this.isMuted = false;
      this.isLooping = true;
      this.volume = 0.6;
      this.unlocked = false;

      // 'title' while the attract screen owns the transport, 'level' once a
      // mission has been entered.
      this.mode = 'title';
      // desiredIndex is what SHOULD be sounding. Playback is reconciled to it
      // by render(); nothing else starts or stops the sequencer.
      this.desiredIndex = null;
      this.playingIndex = null;

      // Current level's assignment.
      this.levelKey = null;
      this.levelAssignment = null;
      this.levelTrackIndices = [];
      // Pause-menu picks are remembered per level so RESUME does not undo them.
      this.levelChoice = {};

      // While the pause overlay holds the transport, remember whether playback
      // should come back on resume.
      this.heldByPause = false;
      this.listeners = [];

      this.initSynth();
      this.setupUnlockListener();
    }

    initSynth() {
      if (typeof WebAudioTinySynth !== 'undefined') {
        this.synth = new WebAudioTinySynth({ quality: 1, useReverb: 1 });
        this.synth.setMasterVol(this.volume);
        this.synth.setLoop(this.isLooping ? 1 : 0);
      } else {
        console.warn('WebAudioTinySynth not found.');
      }
    }

    /* ----------------------------------------------------------------------
       AUTOPLAY UNLOCK
       Chrome will not let the synth's AudioContext leave 'suspended' until a
       user gesture. There is no menu music control to double as that gesture
       any more, so the unlock rides on whatever the player touches first -
       normally the ENTER THE ABYSS click, which is also what starts the level.
       Once unlocked, render() flushes whatever the game asked for while muted.
       ---------------------------------------------------------------------- */
    setupUnlockListener() {
      const onGesture = () => {
        if (this.unlocked) return;
        this.ensureUnlocked().then(() => this.render());
      };
      ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, onGesture, { once: false });
      });
    }

    // Must be called from inside a user gesture to actually take effect.
    ensureUnlocked() {
      const actx = this.synth && this.synth.actx;
      if (!actx) {
        this.unlocked = true;
        return Promise.resolve();
      }
      if (actx.state === 'suspended' && typeof actx.resume === 'function') {
        const p = actx.resume();
        if (p && typeof p.then === 'function') {
          return p.then(() => { this.unlocked = true; }, () => { this.unlocked = true; });
        }
      }
      this.unlocked = true;
      return Promise.resolve();
    }

    /* ----------------------------------------------------------------------
       DESIRED-STATE RECONCILIATION
       ---------------------------------------------------------------------- */
    setDesired(index) {
      this.desiredIndex = (typeof index === 'number' && index >= 0 && index < this.tracks.length)
        ? index : null;
      if (this.desiredIndex !== null) this.currentIndex = this.desiredIndex;
      this.render();
      this.notify();
    }

    render() {
      if (this.desiredIndex === null) return;
      // The pause gate outranks everything: while it is held the tab must be
      // silent, and resumeForGame() calls render() again on the way back.
      if (this.heldByPause) return;
      if (!this.unlocked) return;
      if (this.isPlaying && this.playingIndex === this.desiredIndex) return;
      this.loadAndPlay(this.desiredIndex);
    }

    loadAndPlay(index) {
      const track = this.tracks[index];
      if (!track || !this.synth) return;
      this.currentIndex = index;
      this.playingIndex = index;
      this.isPlaying = true;

      this.synth.stopMIDI();
      const xhr = new XMLHttpRequest();
      xhr.open('GET', track.file, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.status !== 200) return;
        // A later request may have superseded this one mid-flight.
        if (this.playingIndex !== index) return;
        this.synth.loadMIDI(xhr.response);
        this.synth.setLoop(this.isLooping ? 1 : 0);
        this.synth.setMasterVol(this.isMuted ? 0 : this.volume);
        if (this.isPlaying && !this.heldByPause) this.synth.playMIDI();
        this.notify();
      };
      xhr.send();
      this.notify();
    }

    /* ----------------------------------------------------------------------
       LEVEL BINDING
       ---------------------------------------------------------------------- */
    assignmentFor(file, name) {
      return assignmentFor(file, name);
    }

    // Called by the engine every time a level's geometry is loaded.
    attachLevel(file, name) {
      const a = assignmentFor(file, name);
      this.levelKey = a.key;
      this.levelAssignment = a;
      this.levelTrackIndices = a.ids.map(id => indexById[id]).filter(i => i !== undefined);
      if (this.mode === 'level') {
        this.setDesired(this.trackForLevel());
      } else {
        this.notify();
      }
    }

    // The track this level should open with: the player's pause-menu pick for
    // this level if they made one, otherwise the head of the assignment.
    trackForLevel() {
      const remembered = this.levelChoice[this.levelKey];
      if (typeof remembered === 'number') return remembered;
      if (this.levelTrackIndices.length) return this.levelTrackIndices[0];
      return indexById[FALLBACK_THEME[0]];
    }

    // Title / attract screen. Only actually sounds once a gesture unlocks audio.
    armTitleTheme() {
      this.mode = 'title';
      this.setDesired(indexById[TITLE_CUE]);
    }

    // ENTER THE ABYSS / mission start. Runs inside the click, so this is both
    // the autoplay unlock point and the auto-start of the level's own music.
    enterLevel() {
      this.mode = 'level';
      this.heldByPause = false;
      const idx = this.trackForLevel();
      this.desiredIndex = idx;
      this.currentIndex = idx;
      this.ensureUnlocked().then(() => this.render());
      this.notify();
    }

    /* ----------------------------------------------------------------------
       PAUSE MENU TRACK SWITCH - the only place a player changes music.
       ---------------------------------------------------------------------- */
    selectTrack(index) {
      if (!(index >= 0 && index < this.tracks.length)) return;
      if (!isLevelEligible(this.tracks[index].id)) return;
      if (this.levelKey) this.levelChoice[this.levelKey] = index;
      // A deliberate pick releases the pause hold so the change is audible
      // immediately instead of waiting for RESUME.
      this.heldByPause = false;
      this.ensureUnlocked().then(() => {
        this.desiredIndex = index;
        this.currentIndex = index;
        this.render();
        this.notify();
      });
    }

    stepTrack(delta) {
      const list = this.levelTrackIndices.length ? this.levelTrackIndices : this.levelEligibleIndices();
      if (!list.length) return;
      let at = list.indexOf(this.currentIndex);
      if (at === -1) at = 0;
      const next = list[(at + delta + list.length) % list.length];
      this.selectTrack(next);
    }

    levelEligibleIndices() {
      const out = [];
      this.tracks.forEach((t, i) => { if (isLevelEligible(t.id)) out.push(i); });
      return out;
    }

    setVolume(vol) {
      this.volume = Math.max(0, Math.min(1, vol));
      if (!this.isMuted && this.synth) this.synth.setMasterVol(this.volume);
      this.notify();
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      if (this.synth) this.synth.setMasterVol(this.isMuted ? 0 : this.volume);
      this.notify();
    }

    /* ----------------------------------------------------------------------
       PAUSE GATE
       Escape / lost pointer lock / alt-tab / hidden tab stops the sequencer AND
       suspends the audio context, which is what actually clears the Chrome tab
       speaker indicator. Resume restores from the same tick, because stopMIDI()
       keeps playTick.
       ---------------------------------------------------------------------- */
    pauseForGame() {
      if (this.heldByPause) return;
      this.heldByPause = true;
      this.isPlaying = false;
      if (this.synth) {
        this.synth.stopMIDI();
        const actx = this.synth.actx;
        if (actx && actx.state === 'running' && typeof actx.suspend === 'function') {
          actx.suspend();
        }
      }
      this.notify();
    }

    resumeForGame() {
      if (!this.heldByPause) return;
      this.heldByPause = false;

      const restart = () => {
        if (this.desiredIndex === null) { this.notify(); return; }
        if (this.playingIndex === this.desiredIndex && this.synth && this.synth.song) {
          this.isPlaying = true;
          this.synth.playMIDI();
          this.notify();
        } else {
          this.render();
        }
      };

      const actx = this.synth && this.synth.actx;
      if (actx && actx.state === 'suspended') {
        // playMIDI() schedules against actx.currentTime, which stays frozen
        // until the context is actually running again. Restarting before the
        // resume settles backdates playTime and makes the sequencer fire a
        // burst of catch-up notes, so wait for the promise where we get one.
        const p = actx.resume();
        if (p && typeof p.then === 'function') {
          p.then(restart, restart);
          this.notify();
          return;
        }
      }
      restart();
    }

    /* ----------------------------------------------------------------------
       UI HOOK. The player owns no DOM: the pause menu subscribes and renders.
       ---------------------------------------------------------------------- */
    onChange(fn) {
      if (typeof fn === 'function') {
        this.listeners.push(fn);
        fn(this.status());
      }
    }

    notify() {
      const s = this.status();
      this.listeners.forEach(fn => { try { fn(s); } catch (e) { /* UI only */ } });
    }

    status() {
      const track = this.tracks[this.currentIndex] || null;
      return {
        mode: this.mode,
        track: track,
        currentIndex: this.currentIndex,
        isPlaying: this.isPlaying && !this.heldByPause,
        isMuted: this.isMuted,
        volume: this.volume,
        heldByPause: this.heldByPause,
        unlocked: this.unlocked,
        levelKey: this.levelKey,
        levelTrackIndices: this.levelTrackIndices.slice(),
        assignment: this.levelAssignment
      };
    }
  }

  window.CyberMidiPlayer = CyberMidiPlayer;
  // Exposed for assignment audits and for the pause menu's option list.
  window.CYBER_MUSIC = {
    tracks: CYBER_TRACKS,
    contextualCues: CONTEXTUAL_CUES,
    titleCue: TITLE_CUE,
    isLevelEligible: isLevelEligible,
    assignmentFor: assignmentFor,
    indexById: indexById
  };

  window.addEventListener('DOMContentLoaded', () => {
    window.cyberMidi = new CyberMidiPlayer();
    // Title / attract theme. Silent until the first user gesture unlocks audio.
    window.cyberMidi.armTitleTheme();
  });
})();
