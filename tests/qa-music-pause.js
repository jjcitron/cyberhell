#!/usr/bin/env node
/**
 * CYBERHELL MUSIC / PAUSE REGRESSION CHECK
 *
 * Covers the round-1 QA failures and re-runs the round-1 passes that the fix
 * for them could plausibly break.
 *
 *   CH-QA-06  A track picked while the mission is PAUSED must select, not play.
 *             The sequencer stays stopped, the synth AudioContext stays
 *             suspended (which is what clears the Chrome tab speaker), and the
 *             overlay must not report PLAYING.
 *   CH-QA-07  RESUME after that pick must start the NEWLY selected cue exactly
 *             once, with no second sequencer start and no second AudioContext.
 *   CH-QA-01  ENTER THE ABYSS stays fully visible and hit-testable.
 *   no-widget There is still no music selector on the title screen.
 *
 * Usage:
 *   node tests/qa-music-pause.js                 # serves the repo itself
 *   QA_BASE=http://host/index.html node tests/qa-music-pause.js
 *
 * Needs puppeteer-core and a Chrome binary (CHROME_PATH, default
 * /usr/bin/google-chrome). Headless Chrome cannot prove the absence of a
 * renderer crash or that anything is audible - see the notes at the bottom.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n        ${detail}`);
}

/* -------------------------------------------------------------------------
   A static server, so the check has no external dependency.
   ------------------------------------------------------------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.mid': 'audio/midi', '.png': 'image/png', '.css': 'text/css' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* -------------------------------------------------------------------------
   Page setup. AudioContext construction is counted from before the first
   script runs, which is how CH-QA-07's "no duplicate AudioContext" is checked.
   ------------------------------------------------------------------------- */
async function openPage(browser, base, w, h) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|404/i.test(t)) errors.push('console: ' + t);
  });
  await page.evaluateOnNewDocument(() => {
    window.__ctxCount = 0;
    const Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) return;
    class Counted extends Native {
      constructor(...a) { super(...a); window.__ctxCount++; }
    }
    window.AudioContext = Counted;
    window.webkitAudioContext = Counted;
  });
  await page.evaluateOnNewDocument(CTA_PROBE_SRC);
  await page.setViewport({ width: w, height: h });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cyberMidi && window.cyberMidi.synth && document.getElementById('start-btn'));
  await sleep(2500);   // pack manifest + level json settle
  return { page, errors };
}

// Counts every call into the synth transport, and watches the sequencer for
// the two shapes a racing/backdated start would take: playTime running
// backwards, and a single tick dumping a burst of scheduled events.
const INSTRUMENT = () => {
  const s = window.cyberMidi.synth;
  window.__p = { playMIDI: 0, stopMIDI: 0, loadMIDI: 0, send: 0, maxBurst: 0, regress: 0, maxNotetab: 0, tickBack: 0 };
  ['playMIDI', 'stopMIDI', 'loadMIDI'].forEach((n) => {
    const f = s[n];
    s[n] = function () { window.__p[n]++; return f.apply(s, arguments); };
  });
  const send = s.send;
  s.send = function () { window.__p.send++; return send.apply(s, arguments); };
  let lastSend = 0, lastPT = null, lastTick = null;
  setInterval(() => {
    const d = window.__p.send - lastSend; lastSend = window.__p.send;
    if (d > window.__p.maxBurst) window.__p.maxBurst = d;
    if (s.playing) {
      if (lastPT !== null && s.playTime < lastPT - 1e-3) window.__p.regress++;
      if (lastTick !== null && s.playTick < lastTick - 1 && s.playTick > 1) window.__p.tickBack++;
      lastPT = s.playTime; lastTick = s.playTick;
    } else { lastPT = null; lastTick = null; }
    if (s.notetab.length > window.__p.maxNotetab) window.__p.maxNotetab = s.notetab.length;
  }, 50);
};

const SNAP = () => {
  const m = window.cyberMidi, s = m.synth, st = m.status();
  const meta = document.getElementById('pause-music-meta');
  const now = document.getElementById('pause-music-now');
  return {
    heldByPause: st.heldByPause, statusIsPlaying: st.isPlaying,
    currentIndex: st.currentIndex, desiredIndex: st.desiredIndex,
    playingIndex: st.playingIndex, loadedIndex: st.loadedIndex,
    trackId: st.track && st.track.id,
    synthPlaying: s.playing, actx: s.actx.state, playTick: s.playTick,
    ctxCount: window.__ctxCount,
    metaText: meta ? meta.textContent : '', nowText: now ? now.textContent : '',
    p: JSON.parse(JSON.stringify(window.__p))
  };
};

// The engine instance is not exported; find it by shape.
const FIND_ENGINE = () => {
  for (const k of Object.keys(window)) {
    try { const v = window[k]; if (v && v.pauseAllAudio && v.canvas) { window.__eng = v; return true; } } catch (e) {}
  }
  return false;
};

/* -------------------------------------------------------------------------
   CH-QA-06 / CH-QA-07
   ------------------------------------------------------------------------- */
async function musicPauseCycle(browser, base) {
  const { page, errors } = await openPage(browser, base, 1280, 800);
  await page.evaluate(INSTRUMENT);
  const hasEngine = await page.evaluate(FIND_ENGINE);
  if (!hasEngine) { check('CH-QA-06/07 setup', false, 'engine instance not reachable from the page'); return { page, errors }; }

  const ID = (id) => page.evaluate(i => window.CYBER_MUSIC.indexById[i], id);
  const CH01 = await ID('ch-01'), CH02 = await ID('ch-02');

  // ---- enter MAP01 -------------------------------------------------------
  await page.click('#start-btn');
  await sleep(2000);
  const entered = await page.evaluate(SNAP);
  check('CH-QA-06.1 enter MAP01 auto-plays its cue',
    entered.trackId === 'ch-01' && entered.synthPlaying === 1 && entered.actx === 'running' && entered.statusIsPlaying === true,
    `track=${entered.trackId} synth.playing=${entered.synthPlaying} actx=${entered.actx} status.isPlaying=${entered.statusIsPlaying}`);

  // ---- pause -------------------------------------------------------------
  // Escape drives this through pointerlockchange, which is not available
  // headlessly; showPauseOverlay/pauseAllAudio is reached through the
  // identical lost-focus leg instead.
  await page.evaluate(() => { window.__eng.isRunning = true; window.dispatchEvent(new Event('blur')); });
  await sleep(1200);
  const paused = await page.evaluate(SNAP);
  check('CH-QA-06.2 pause is silent',
    paused.heldByPause === true && paused.synthPlaying === 0 && paused.actx === 'suspended' &&
    paused.statusIsPlaying === false && /PAUSED/.test(paused.metaText) && !/PLAYING/.test(paused.metaText),
    `held=${paused.heldByPause} synth.playing=${paused.synthPlaying} actx=${paused.actx} meta="${paused.metaText}"`);

  const playsBeforeSwitch = paused.p.playMIDI;

  // ---- switch ch-01 -> ch-02 WHILE STILL PAUSED -------------------------
  await page.evaluate((idx) => {
    const sel = document.getElementById('pause-music-select');
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, CH02);
  await sleep(2500);   // long enough for the cue fetch to land
  const picked = await page.evaluate(SNAP);

  check('CH-QA-06.3 paused pick selects ch-02',
    picked.currentIndex === CH02 && picked.desiredIndex === CH02 && /ch-02/.test(picked.nowText),
    `currentIndex=${picked.currentIndex} desiredIndex=${picked.desiredIndex} now="${picked.nowText}" (ch-02=${CH02})`);

  check('CH-QA-06.4 paused pick stays silent',
    picked.heldByPause === true && picked.synthPlaying === 0 && picked.actx === 'suspended' &&
    picked.p.playMIDI === playsBeforeSwitch,
    `held=${picked.heldByPause} synth.playing=${picked.synthPlaying} actx=${picked.actx} ` +
    `playMIDI ${playsBeforeSwitch}->${picked.p.playMIDI} (must not change)`);

  check('CH-QA-06.5 paused pick does not report PLAYING',
    picked.statusIsPlaying === false && /PAUSED/.test(picked.metaText) && !/PLAYING/.test(picked.metaText),
    `status.isPlaying=${picked.statusIsPlaying} meta="${picked.metaText}"`);

  const cached = await page.evaluate(i => !!(window.cyberMidi.buffers && window.cyberMidi.buffers[i]), CH02);
  check('CH-QA-06.6 the cue is loaded, not merely deferred',
    cached, `ch-02 bytes cached while the mission is paused: ${cached}`);

  // ---- resume ------------------------------------------------------------
  await page.click('#start-btn');
  await page.evaluate(() => { window.__eng.isRunning = true; });
  await sleep(2500);
  const resumed = await page.evaluate(SNAP);
  const tickA = resumed.playTick;
  await sleep(2500);
  const settled = await page.evaluate(SNAP);

  check('CH-QA-07.1 resume starts exactly one playback',
    resumed.p.playMIDI === playsBeforeSwitch + 1 && settled.p.playMIDI === playsBeforeSwitch + 1,
    `playMIDI ${playsBeforeSwitch} -> ${resumed.p.playMIDI} -> ${settled.p.playMIDI} (want +1, then steady)`);

  check('CH-QA-07.2 resume plays the newly selected cue',
    settled.trackId === 'ch-02' && settled.playingIndex === CH02 && settled.loadedIndex === CH02 &&
    settled.synthPlaying === 1 && settled.actx === 'running' && settled.heldByPause === false,
    `track=${settled.trackId} playing/loaded=${settled.playingIndex}/${settled.loadedIndex} ` +
    `synth.playing=${settled.synthPlaying} actx=${settled.actx}`);

  check('CH-QA-07.3 the sequencer advances forward, no catch-up burst',
    settled.playTick > tickA && settled.p.regress === 0 && settled.p.tickBack === 0 && settled.p.maxBurst < 400,
    `playTick ${tickA}->${settled.playTick} playTimeRegressions=${settled.p.regress} ` +
    `tickRewinds=${settled.p.tickBack} largestTickBurst=${settled.p.maxBurst} events`);

  check('CH-QA-07.4 no second AudioContext',
    settled.ctxCount === entered.ctxCount,
    `AudioContexts constructed: ${entered.ctxCount} at mission start -> ${settled.ctxCount} after the cycle`);

  // ---- repeat the cycle: one start per resume, every time ----------------
  const cues = ['ch-07', 'ch-01', 'ch-08', 'ch-02'];
  let ok = true, log = [];
  for (let i = 0; i < cues.length; i++) {
    const before = (await page.evaluate(SNAP)).p.playMIDI;
    await page.evaluate(() => { window.__eng.isRunning = true; window.dispatchEvent(new Event('blur')); });
    await sleep(500);
    // Chrome blurs the window when the native <select> popup opens and
    // refocuses it on the pick; both legs fire here.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(150);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const idx = await ID(cues[i]);
    await page.evaluate((n) => {
      const sel = document.getElementById('pause-music-select');
      sel.value = String(n);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, idx);
    // Alternate resuming before and after the cue fetch can have landed.
    await sleep(i % 2 ? 120 : 1400);
    const mid = await page.evaluate(SNAP);
    if (mid.synthPlaying !== 0 || mid.actx !== 'suspended') {
      ok = false; log.push(`${cues[i]}: sounded while paused (playing=${mid.synthPlaying} actx=${mid.actx})`);
    }
    await page.click('#start-btn');
    await page.evaluate(() => { window.__eng.isRunning = true; });
    await sleep(2200);
    const after = await page.evaluate(SNAP);
    if (after.p.playMIDI !== before + 1) { ok = false; log.push(`${cues[i]}: playMIDI +${after.p.playMIDI - before}`); }
    if (after.trackId !== cues[i]) { ok = false; log.push(`${cues[i]}: resumed on ${after.trackId}`); }
  }
  const end = await page.evaluate(SNAP);
  check('CH-QA-07.5 repeated pause/pick/resume stays single-pathed',
    ok && end.p.regress === 0 && end.p.tickBack === 0 && end.ctxCount === entered.ctxCount,
    log.length ? log.join('; ') :
      `${cues.length} cycles: one playMIDI per resume, silent while paused, ` +
      `AudioContexts=${end.ctxCount}, playTimeRegressions=${end.p.regress}, maxNotetab=${end.p.maxNotetab}`);

  check('CH-QA-07.6 no uncaught exception across the whole cycle',
    errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'no pageerror, no console error');

  return { page, errors };
}

/* -------------------------------------------------------------------------
   CH-QA-01 geometry + the title screen carries no music widget
   ------------------------------------------------------------------------- */
const CTA_PROBE_SRC = `function CTA_PROBE_INLINE(){
  const btn = document.getElementById('start-btn');
  const r = btn.getBoundingClientRect();
  const hits = [];
  for (const fx of [0.08, 0.5, 0.92]) for (const fy of [0.15, 0.5, 0.85]) {
    const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    hits.push(!!el && (el === btn || btn.contains(el)));
  }
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
           fullyIn: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
           hits: hits.filter(Boolean).length, text: btn.innerText.trim() };
}`;

const CTA_PROBE = () => {
  const btn = document.getElementById('start-btn');
  const r = btn.getBoundingClientRect();
  const hits = [];
  for (const fx of [0.08, 0.5, 0.92]) for (const fy of [0.15, 0.5, 0.85]) {
    const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    hits.push(!!el && (el === btn || btn.contains(el)));
  }
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, vw: window.innerWidth,
    fullyIn: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
    hits: hits.filter(Boolean).length,
    text: btn.innerText.trim()
  };
};

const WIDGET_PROBE = () => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const musicish = [...document.querySelectorAll('select, button, input')].filter((e) => {
    const s = ((e.id || '') + ' ' + (e.className || '') + ' ' + (e.getAttribute('aria-label') || '') +
               ' ' + (e.title || '') + ' ' + (e.textContent || '')).toLowerCase();
    return /midi|music|track|cue|loop|mute|\bvol\b/.test(s);
  });
  const pm = document.getElementById('pause-music');
  return {
    legacyWidget: !!document.getElementById('cyber-midi-ui'),
    map01Buttons: document.querySelectorAll('.cyber-map01-btn').length,
    visibleMusicControls: musicish.filter(visible).map(e => e.id || e.className || e.tagName),
    pauseRowInDom: !!pm,
    pauseRowVisible: !!pm && visible(pm)
  };
};

/* -------------------------------------------------------------------------
   The PAUSED overlay carries the briefing card as well as the music row, so
   it is the taller of the two overlay states and is the one that decides
   whether the CTA still fits.
   ------------------------------------------------------------------------- */
async function pauseGeometry(browser, base, w, h) {
  const { page } = await openPage(browser, base, w, h);
  await page.evaluate(FIND_ENGINE);
  await page.click('#start-btn');
  await sleep(1500);
  await page.evaluate(() => { window.__eng.isRunning = true; window.dispatchEvent(new Event('blur')); });
  await sleep(1000);
  const o = await page.evaluate(() => {
    const ov = document.getElementById('overlay-screen');
    ov.scrollTop = 0;
    const card = document.querySelector('.instructions-card');
    const pm = document.getElementById('pause-music');
    const vis = (e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
                         return cs.display !== 'none' && r.height > 0; };
    const cta = CTA_PROBE_INLINE();
    return {
      mode: ov.className, overflowPx: ov.scrollHeight - ov.clientHeight,
      cardVisible: vis(card), cardH: Math.round(card.getBoundingClientRect().height),
      musicVisible: vis(pm), cta
    };
  });
  check(`pause overlay fits with the briefing card @${w}x${h}`,
    /mode-pause/.test(o.mode) && o.cardVisible && o.musicVisible && o.overflowPx === 0 &&
    o.cta.fullyIn && o.cta.hits === 9 && /RESUME/i.test(o.cta.text),
    `mode="${o.mode}" briefingCard=${o.cardVisible}(${o.cardH}px) musicRow=${o.musicVisible} ` +
    `overlayOverflow=${o.overflowPx}px "${o.cta.text}" bottom=${o.cta.bottom}/${o.cta.vh} ` +
    `fullyInViewport=${o.cta.fullyIn} hitTestablePoints=${o.cta.hits}/9`);
  await page.close();
}

async function geometry(browser, base, w, h) {
  const { page } = await openPage(browser, base, w, h);
  const cta = await page.evaluate(CTA_PROBE);
  check(`CH-QA-01 CTA fully visible @${w}x${h}`,
    cta.fullyIn && cta.hits === 9 && /ENTER THE ABYSS/i.test(cta.text),
    `"${cta.text}" top=${cta.top} bottom=${cta.bottom} viewport=${cta.vw}x${cta.vh} ` +
    `fullyInViewport=${cta.fullyIn} hitTestablePoints=${cta.hits}/9`);

  const wdg = await page.evaluate(WIDGET_PROBE);
  check(`no menu music widget @${w}x${h}`,
    !wdg.legacyWidget && wdg.map01Buttons === 0 && wdg.visibleMusicControls.length === 0 &&
    wdg.pauseRowInDom && !wdg.pauseRowVisible,
    `#cyber-midi-ui=${wdg.legacyWidget} .cyber-map01-btn=${wdg.map01Buttons} ` +
    `visibleMusicControlsOnTitle=[${wdg.visibleMusicControls.join(',')}] ` +
    `#pause-music inDom=${wdg.pauseRowInDom} visibleOnTitle=${wdg.pauseRowVisible}`);
  await page.close();
}

/* ----------------------------------------------------------------------- */
async function runAll(base) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--autoplay-policy=user-gesture-required', '--mute-audio',
           '--force-device-scale-factor=1', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    await musicPauseCycle(browser, base);
    // 1280x800 is the QA window; 1046x640 is the page area that window
    // actually leaves once Chrome's own chrome is subtracted.
    await geometry(browser, base, 1280, 800);
    await geometry(browser, base, 1046, 640);
    await pauseGeometry(browser, base, 1280, 800);
    await pauseGeometry(browser, base, 1046, 640);
  } finally {
    await browser.close();
  }
}

(async () => {
  let srv = null, base = process.env.QA_BASE;
  if (!base) { const s = await serve(); srv = s.srv; base = `http://127.0.0.1:${s.port}/index.html`; }
  console.log(`base: ${base}\n`);

  // This build renders WebGL through the software rasteriser in headless. On a
  // loaded host that can wedge the renderer's main thread, which arrives as a
  // CDP protocol timeout rather than as a result - a harness failure, not a
  // product failure, so it is retried rather than reported as one.
  const ATTEMPTS = Number(process.env.QA_ATTEMPTS || 3);
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    results.length = 0;
    try { await runAll(base); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!/timed out|Protocol error|Target closed/i.test(e.message) || attempt === ATTEMPTS) break;
      console.log(`\n[retry ${attempt}/${ATTEMPTS - 1}] renderer stalled (${e.message.split('\n')[0]})\n`);
    }
  }
  if (srv) srv.close();
  if (lastErr) { console.error('HARNESS ERROR', lastErr); process.exit(2); }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    '\nNOT PROVABLE HERE: headless Chrome cannot demonstrate the absence of a\n' +
    'renderer crash (Aw Snap), cannot show the tab speaker indicator, runs with\n' +
    '--mute-audio so nothing is listened to, and cannot drive Escape through real\n' +
    'pointer lock. These assert the state that produced those symptoms.');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
