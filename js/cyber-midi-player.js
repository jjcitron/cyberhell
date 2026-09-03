/**
 * CYBERHELL MIDI PLAYER MODULE
 * Web Audio + SoundFont/Synthesizer playback for all 26 original Cyberhell MIDI cues.
 * Completely isolated from core engine and collision code.
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

  class CyberMidiPlayer {
    constructor() {
      this.synth = null;
      this.currentIndex = 0;
      this.isPlaying = false;
      this.isMuted = false;
      this.isLooping = true;
      this.volume = 0.6;
      this.unlocked = false;
      this.uiContainer = null;
      this.tracks = CYBER_TRACKS;
      // CH-QA-02: collapse state lives on the instance and is mirrored onto the
      // widget as data-collapsed, so the toggle can always self-heal from the DOM.
      this.isMinimized = false;
      // CH-QA-03: while the game pause overlay holds the transport we remember
      // whether playback should come back on resume.
      this.heldByPause = false;
      this.resumeAfterPause = false;
      
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

    setupUnlockListener() {
      const unlockAudio = () => {
        if (this.unlocked) return;
        if (this.synth && this.synth.actx) {
          if (this.synth.actx.state === 'suspended') {
            this.synth.actx.resume().then(() => {
              this.unlocked = true;
              if (this.isPlaying) {
                this.playTrack(this.currentIndex);
              }
            });
          } else {
            this.unlocked = true;
          }
        }
      };

      ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, unlockAudio, { once: false });
      });
    }

    loadTrack(index) {
      if (index < 0 || index >= this.tracks.length) return;
      this.currentIndex = index;
      const track = this.tracks[index];

      if (this.synth) {
        this.synth.stopMIDI();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', track.file, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = (e) => {
          if (xhr.status === 200) {
            this.synth.loadMIDI(xhr.response);
            this.synth.setLoop(this.isLooping ? 1 : 0);
            this.synth.setMasterVol(this.isMuted ? 0 : this.volume);
            if (this.isPlaying) {
              this.synth.playMIDI();
            }
            this.updateUI();
          }
        };
        xhr.send();
      }
      this.updateUI();
    }

    playTrack(index) {
      this.releasePauseHold();
      this.currentIndex = index;
      this.isPlaying = true;
      if (this.synth && this.synth.actx && this.synth.actx.state === 'suspended') {
        this.synth.actx.resume();
      }
      this.loadTrack(index);
    }

    play() {
      this.releasePauseHold();
      this.isPlaying = true;
      if (this.synth && this.synth.actx && this.synth.actx.state === 'suspended') {
        this.synth.actx.resume();
      }
      if (this.synth && this.synth.song) {
        this.synth.playMIDI();
      } else {
        this.loadTrack(this.currentIndex);
      }
      this.updateUI();
    }

    pause() {
      this.isPlaying = false;
      if (this.synth) {
        this.synth.stopMIDI();
      }
      this.updateUI();
    }

    togglePlay() {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    }

    next() {
      let nextIdx = (this.currentIndex + 1) % this.tracks.length;
      this.playTrack(nextIdx);
    }

    prev() {
      let prevIdx = (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
      this.playTrack(prevIdx);
    }

    setVolume(vol) {
      this.volume = Math.max(0, Math.min(1, vol));
      if (!this.isMuted && this.synth) {
        this.synth.setMasterVol(this.volume);
      }
      this.updateUI();
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      if (this.synth) {
        this.synth.setMasterVol(this.isMuted ? 0 : this.volume);
      }
      this.updateUI();
    }

    toggleLoop() {
      this.isLooping = !this.isLooping;
      if (this.synth) {
        this.synth.setLoop(this.isLooping ? 1 : 0);
      }
      this.updateUI();
    }

    /* ----------------------------------------------------------------------
       CH-QA-03: pause hold. The pause overlay (Escape / lost pointer lock /
       hidden tab) stops the sequencer AND suspends the audio context, which is
       what actually clears the Chrome tab speaker indicator. Resume restores
       playback from the same tick, because stopMIDI() keeps playTick.
       ---------------------------------------------------------------------- */
    pauseForGame() {
      if (this.heldByPause) return;
      this.heldByPause = true;
      this.resumeAfterPause = this.isPlaying;
      this.isPlaying = false;
      if (this.synth) {
        this.synth.stopMIDI();
        const actx = this.synth.actx;
        if (actx && actx.state === 'running' && typeof actx.suspend === 'function') {
          actx.suspend();
        }
      }
      this.updateUI();
    }

    resumeForGame() {
      if (!this.heldByPause) return;
      const shouldPlay = this.resumeAfterPause;
      this.heldByPause = false;
      this.resumeAfterPause = false;

      const restart = () => {
        if (!shouldPlay) return;
        this.isPlaying = true;
        if (this.synth && this.synth.song) {
          this.synth.playMIDI();
        } else {
          this.loadTrack(this.currentIndex);
        }
        this.updateUI();
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
          this.updateUI();
          return;
        }
      }
      restart();
      this.updateUI();
    }

    // A deliberate click on the widget transport overrides the pause hold.
    releasePauseHold() {
      this.heldByPause = false;
      this.resumeAfterPause = false;
    }

    /* ----------------------------------------------------------------------
       CH-QA-02: minimize / restore driven off DOM state, not a closure flag.
       ---------------------------------------------------------------------- */
    setMinimized(collapsed) {
      this.isMinimized = !!collapsed;
      this.applyMinimizedState();
    }

    toggleMinimized() {
      // Read the DOM, not just the cached flag, so a desynced widget still
      // toggles the way the user expects instead of needing a reload.
      const domCollapsed = this.uiContainer
        ? this.uiContainer.getAttribute('data-collapsed') === '1'
        : this.isMinimized;
      this.setMinimized(!domCollapsed);
    }

    applyMinimizedState() {
      const uiDiv = this.uiContainer || document.getElementById('cyber-midi-ui');
      if (!uiDiv) return;
      const content = document.getElementById('cyber-midi-content');
      const minBtn = document.getElementById('cyber-midi-minimize');
      const header = document.getElementById('cyber-midi-header');
      const collapsed = this.isMinimized;

      uiDiv.setAttribute('data-collapsed', collapsed ? '1' : '0');
      uiDiv.style.width = collapsed ? '210px' : '330px';
      if (content) content.style.display = collapsed ? 'none' : 'block';
      if (minBtn) {
        minBtn.textContent = collapsed ? '+' : '\u2013';
        minBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        minBtn.title = collapsed ? 'Restore MIDI controls' : 'Minimize MIDI panel';
      }
      if (header) {
        // Collapsed, the whole title bar restores the panel. The bare toggle is a
        // small target that travels down the screen as the panel shrinks, so a
        // second click at the previous cursor position would hit nothing.
        header.style.cursor = 'pointer';
        header.style.borderBottom = collapsed ? '1px solid transparent' : '1px solid #00ffcc44';
        header.style.paddingBottom = collapsed ? '0' : '6px';
        header.style.marginBottom = collapsed ? '0' : '8px';
        header.title = collapsed ? 'Restore MIDI controls' : 'Minimize MIDI panel';
      }
      this.updateOverlayReserve();
    }

    /* ----------------------------------------------------------------------
       CH-QA-01: publish the widget footprint as --midi-reserve so the start /
       pause overlay can keep ENTER THE ABYSS clear of it at any viewport size.
       ---------------------------------------------------------------------- */
    updateOverlayReserve() {
      const uiDiv = this.uiContainer || document.getElementById('cyber-midi-ui');
      if (!uiDiv) return;
      const visible = getComputedStyle(uiDiv).display !== 'none';
      const rect = uiDiv.getBoundingClientRect();
      // 16px is the widget's own bottom/right offset; 24px is clearance, which
      // also absorbs the 5% hover scale on .start-btn.
      const GAP = 16 + 24;
      // Expanded, the panel is tall enough to sit beside the vertically centred
      // overlay content, so it has to claim a right-hand gutter. Collapsed to
      // its title bar it only occupies a bottom strip, and claiming the gutter
      // there would push the title screen off-centre for no reason.
      const reserveX = visible && !this.isMinimized ? Math.ceil(rect.width) + GAP : 0;
      const reserveY = visible && this.isMinimized ? Math.ceil(rect.height) + GAP : 0;
      const root = document.documentElement.style;
      root.setProperty('--midi-reserve-x', reserveX + 'px');
      root.setProperty('--midi-reserve', reserveY + 'px');
    }

    renderUI() {
      if (document.getElementById('cyber-midi-ui')) return;

      const uiDiv = document.createElement('div');
      uiDiv.id = 'cyber-midi-ui';
      uiDiv.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 99999;
        background: rgba(5, 8, 15, 0.92);
        border: 1px solid #00ffcc;
        box-shadow: 0 0 15px rgba(0, 255, 204, 0.3);
        border-radius: 6px;
        padding: 12px;
        width: 330px;
        font-family: 'Courier New', monospace;
        color: #00ffcc;
        font-size: 12px;
        /* No backdrop-filter: over a 0.92-opaque panel it is visually inert, and
           the extra compositing layer is a known source of stale hit-test
           regions at non-100% browser zoom - which is where CH-QA-02 was seen. */
        user-select: none;
      `;

      uiDiv.innerHTML = `
        <div id="cyber-midi-header" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 1px solid #00ffcc44; padding-bottom: 6px; margin-bottom: 8px;">
          <span style="flex: 1 1 auto; min-width: 0; font-weight: bold; letter-spacing: 1px; text-shadow: 0 0 5px #00ffcc;">🎵 CYBERHELL MIDI SYNTH</span>
          <button id="cyber-midi-minimize" type="button" aria-expanded="true" title="Minimize MIDI panel" style="flex: 0 0 auto; background: none; border: 1px solid #00ffcc; color: #00ffcc; cursor: pointer; min-width: 26px; height: 24px; line-height: 1; padding: 0 6px; font-size: 15px; font-weight: bold; border-radius: 3px;">–</button>
        </div>

        <div id="cyber-midi-content">
          <!-- MAP01 Quick Selection -->
          <div style="margin-bottom: 8px;">
            <div style="font-size: 10px; color: #88ccff; margin-bottom: 4px; font-weight: bold;">MAP01 FIRST CUES:</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
              <button class="cyber-map01-btn" data-idx="0" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; padding: 4px; font-size: 10px; cursor: pointer; border-radius: 3px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">ch-01 Ground Zero</button>
              <button class="cyber-map01-btn" data-idx="1" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; padding: 4px; font-size: 10px; cursor: pointer; border-radius: 3px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">ch-02 Cyber-Radar</button>
              <button class="cyber-map01-btn" data-idx="6" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; padding: 4px; font-size: 10px; cursor: pointer; border-radius: 3px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">ch-07 MAP01 Engine</button>
              <button class="cyber-map01-btn" data-idx="18" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; padding: 4px; font-size: 10px; cursor: pointer; border-radius: 3px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">ch-19 Cyber-Entry</button>
            </div>
          </div>

          <!-- All 26 Tracks Dropdown -->
          <div style="margin-bottom: 8px;">
            <select id="cyber-midi-select" style="width: 100%; background: #081018; border: 1px solid #00ffcc; color: #00ffcc; padding: 4px; font-family: monospace; font-size: 11px; border-radius: 3px; cursor: pointer;">
              ${CYBER_TRACKS.map((t, idx) => `<option value="${idx}">[${t.id}] ${t.title} (${t.mood})</option>`).join('')}
            </select>
          </div>

          <!-- Track Info -->
          <div style="background: rgba(0,255,204,0.05); border: 1px dashed #00ffcc55; padding: 6px; margin-bottom: 8px; border-radius: 3px;">
            <div id="cyber-midi-title" style="font-weight: bold; color: #ffffff; margin-bottom: 2px;">Ground Zero</div>
            <div id="cyber-midi-meta" style="font-size: 10px; color: #a0e6ff;">Dark Synth | 112 BPM</div>
            <div id="cyber-midi-signal" style="font-size: 9px; color: #00ffaa; font-style: italic; margin-top: 2px;">MAP01 ENTRYWAY / GROUND ZERO</div>
          </div>

          <!-- Transport Controls -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="display: flex; gap: 4px;">
              <button id="cyber-midi-prev" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; cursor: pointer; padding: 4px 8px; font-size: 11px; border-radius: 3px;">⏮</button>
              <button id="cyber-midi-play" style="background: #00ffcc; border: 1px solid #00ffcc; color: #000; font-weight: bold; cursor: pointer; padding: 4px 12px; font-size: 11px; border-radius: 3px;">▶ PLAY</button>
              <button id="cyber-midi-next" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; cursor: pointer; padding: 4px 8px; font-size: 11px; border-radius: 3px;">⏭</button>
            </div>
            <div style="display: flex; gap: 4px; align-items: center;">
              <button id="cyber-midi-mute" style="background: #0a1b24; border: 1px solid #00ffcc; color: #00ffcc; cursor: pointer; padding: 4px 8px; font-size: 11px; border-radius: 3px;">🔊</button>
              <button id="cyber-midi-loop" style="background: #00ffcc; border: 1px solid #00ffcc; color: #000; font-weight: bold; cursor: pointer; padding: 4px 8px; font-size: 10px; border-radius: 3px;">🔁 LOOP</button>
            </div>
          </div>

          <!-- Volume Slider -->
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 10px; color: #88ccff;">VOL:</span>
            <input id="cyber-midi-vol" type="range" min="0" max="100" value="60" style="flex-grow: 1; accent-color: #00ffcc; cursor: pointer;">
            <span id="cyber-midi-vol-val" style="font-size: 10px; width: 28px; text-align: right;">60%</span>
          </div>
        </div>
      `;

      document.body.appendChild(uiDiv);
      this.uiContainer = uiDiv;

      // Event listeners for UI controls
      document.getElementById('cyber-midi-select').addEventListener('change', (e) => {
        this.playTrack(parseInt(e.target.value, 10));
      });

      document.querySelectorAll('.cyber-map01-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          this.playTrack(idx);
        });
      });

      document.getElementById('cyber-midi-play').addEventListener('click', () => {
        this.togglePlay();
      });

      document.getElementById('cyber-midi-prev').addEventListener('click', () => {
        this.prev();
      });

      document.getElementById('cyber-midi-next').addEventListener('click', () => {
        this.next();
      });

      document.getElementById('cyber-midi-mute').addEventListener('click', () => {
        this.toggleMute();
      });

      document.getElementById('cyber-midi-loop').addEventListener('click', () => {
        this.toggleLoop();
      });

      document.getElementById('cyber-midi-vol').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10) / 100;
        this.setVolume(val);
      });

      // CH-QA-02: delegated on the widget root, so the toggle keeps working
      // even if the header is ever re-rendered, and so the collapsed title bar
      // is itself a restore target.
      uiDiv.addEventListener('click', (e) => {
        const onToggle = e.target.closest && e.target.closest('#cyber-midi-minimize');
        const onHeader = e.target.closest && e.target.closest('#cyber-midi-header');
        if (onToggle || (this.isMinimized && onHeader)) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleMinimized();
        }
      });

      // CH-QA-01: keep --midi-reserve in step with the widget's real footprint.
      if (typeof ResizeObserver !== 'undefined') {
        this._reserveObserver = new ResizeObserver(() => this.updateOverlayReserve());
        this._reserveObserver.observe(uiDiv);
      }
      window.addEventListener('resize', () => this.updateOverlayReserve());

      this.applyMinimizedState();
      this.updateUI();
    }

    updateUI() {
      if (!this.uiContainer) return;
      const track = this.tracks[this.currentIndex];

      // CH-QA-02: re-assert the collapse state on every refresh; updateUI() runs
      // from XHR callbacks and transport changes, and must never leave the panel
      // half-collapsed with no way back.
      const uiDiv = this.uiContainer;
      const contentEl = document.getElementById('cyber-midi-content');
      if (contentEl) {
        const want = this.isMinimized ? 'none' : 'block';
        if (contentEl.style.display !== want) contentEl.style.display = want;
      }
      if (uiDiv.getAttribute('data-collapsed') !== (this.isMinimized ? '1' : '0')) {
        this.applyMinimizedState();
      }

      const select = document.getElementById('cyber-midi-select');
      if (select) select.value = this.currentIndex;

      const titleEl = document.getElementById('cyber-midi-title');
      if (titleEl) titleEl.textContent = `[${track.id}] ${track.title}`;

      const metaEl = document.getElementById('cyber-midi-meta');
      if (metaEl) metaEl.textContent = `${track.mood.toUpperCase()} | ${track.bpm} BPM`;

      const sigEl = document.getElementById('cyber-midi-signal');
      if (sigEl) sigEl.textContent = track.signal;

      const playBtn = document.getElementById('cyber-midi-play');
      if (playBtn) {
        if (this.isPlaying) {
          playBtn.textContent = '⏸ PAUSE';
          playBtn.style.background = '#ff0055';
          playBtn.style.color = '#fff';
          playBtn.style.borderColor = '#ff0055';
        } else {
          playBtn.textContent = '▶ PLAY';
          playBtn.style.background = '#00ffcc';
          playBtn.style.color = '#000';
          playBtn.style.borderColor = '#00ffcc';
        }
      }

      const muteBtn = document.getElementById('cyber-midi-mute');
      if (muteBtn) {
        muteBtn.textContent = this.isMuted ? '🔇' : '🔊';
        muteBtn.style.borderColor = this.isMuted ? '#ff0055' : '#00ffcc';
      }

      const loopBtn = document.getElementById('cyber-midi-loop');
      if (loopBtn) {
        if (this.isLooping) {
          loopBtn.style.background = '#00ffcc';
          loopBtn.style.color = '#000';
        } else {
          loopBtn.style.background = '#0a1b24';
          loopBtn.style.color = '#888';
        }
      }

      const volSlider = document.getElementById('cyber-midi-vol');
      if (volSlider) volSlider.value = Math.round(this.volume * 100);

      const volVal = document.getElementById('cyber-midi-vol-val');
      if (volVal) volVal.textContent = `${Math.round(this.volume * 100)}%`;

      document.querySelectorAll('.cyber-map01-btn').forEach(btn => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (idx === this.currentIndex) {
          btn.style.background = '#00ffcc';
          btn.style.color = '#000';
          btn.style.fontWeight = 'bold';
        } else {
          btn.style.background = '#0a1b24';
          btn.style.color = '#00ffcc';
          btn.style.fontWeight = 'normal';
        }
      });
    }
  }

  window.CyberMidiPlayer = CyberMidiPlayer;

  window.addEventListener('DOMContentLoaded', () => {
    window.cyberMidi = new CyberMidiPlayer();
    window.cyberMidi.renderUI();
    // Default load first track (Ground Zero, MAP01)
    window.cyberMidi.loadTrack(0);
  });
})();
