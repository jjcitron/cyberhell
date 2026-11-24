/* Acidlemon Games startup splash. Copied from Sumi: Crossfire (beatemup
   src/main.js splash() + src/style.css #splash): the official lockup
   (brand/acidlemon-lockup.svg), "ACIDLEMON GAMES / presents", 1.4 s logo
   ease-in, auto-out at 2.6 s, 0.6 s fade.

   Load it as the FIRST script in <head> (classic, not a module) so its
   capture-phase listeners run before any game listener:
     <script src="acid-splash.js" data-logo="brand/acidlemon-lockup.svg"></script>

   - Once per session (sessionStorage 'acidlemon-splash'); ?nosplash skips it.
   - Skip: tap, click, any key, any gamepad button. The skip press is swallowed
     (capture phase, stopImmediatePropagation) through its release and the click
     that follows, so it never reaches the game (it cannot start a run).
   - The skip press still gives the page its user activation, so audio can
     start on the next game action; games may also register
     AcidSplash.onSkip(fn) to unlock audio inside the skip gesture itself.
   - AcidSplash.blocking() is true while the splash is up or its skip press is
     held; the Acidlemon gamepad module masks pad buttons while it is. */
(function (root) {
  'use strict';
  var KEY = 'acidlemon-splash';
  var AUTO_MS = 2600, FADE_MS = 600;
  var doc = root.document;
  var script = doc && doc.currentScript;
  var logo = (script && script.getAttribute('data-logo')) || 'brand/acidlemon-lockup.svg';
  var api = { shown: false, active: false, holding: false, skippedBy: null, blocking: function () { return api.active || api.holding; }, onSkip: function (fn) { hooks.push(fn); } };
  var hooks = [];
  root.AcidSplash = api;

  function seen() { try { return root.sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function markSeen() { try { root.sessionStorage.setItem(KEY, '1'); } catch (e) {} }
  if (!doc || /[?&]nosplash\b/.test(root.location.search) || seen()) return;
  markSeen();
  api.shown = true;
  api.active = true;

  var CSS = '#acid-splash{position:fixed;inset:0;z-index:2147483600;background:#0A0B0D;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;transition:opacity .6s;color:#C8E84B;font-family:system-ui,sans-serif;cursor:pointer;-webkit-user-select:none;user-select:none;touch-action:none}' +
    '#acid-splash img{width:min(70vw,440px);animation:acid-spl 1.4s ease-out}' +
    '#acid-splash p{margin:0;letter-spacing:.5em;font-weight:800;font-size:clamp(12px,2.4vw,18px)}' +
    '#acid-splash small{opacity:.6;letter-spacing:.3em}' +
    '#acid-splash.out{opacity:0;pointer-events:none}' +
    '@keyframes acid-spl{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}';
  var el = doc.createElement('div');
  el.id = 'acid-splash';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Acidlemon Games presents');
  el.innerHTML = '<img src="' + logo + '" alt="acidlemon"><p>ACIDLEMON GAMES</p><small>presents</small>';
  function mount() {
    if (!api.active || el.isConnected) return;
    var st = doc.createElement('style');
    st.id = 'acid-splash-style';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
    doc.body.appendChild(el);
    // Timed from when the logo is actually on screen, not from script start: a heavy page
    // can take longer than the whole splash to reach DOMContentLoaded.
    setTimeout(out, AUTO_MS);
  }
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount);

  // ---- input swallowing (capture phase on window: runs before every game listener)
  var DOWN = ['keydown', 'pointerdown', 'mousedown', 'touchstart'];
  var UP = ['keyup', 'pointerup', 'mouseup', 'touchend', 'touchcancel', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'keypress', 'auxclick'];
  var releaseTimer = null;
  function swallow(e) {
    if (!api.blocking()) return;
    e.stopImmediatePropagation();
    if (e.cancelable && e.type !== 'keyup') e.preventDefault();
    if (api.active && DOWN.indexOf(e.type) >= 0) skip(e.type === 'keydown' ? 'key' : 'pointer');
    else if (api.holding && (e.type === 'keyup' || e.type === 'pointerup' || e.type === 'mouseup' || e.type === 'touchend' || e.type === 'touchcancel' || e.type === 'pointercancel')) {
      // The click that follows a release is part of the same press: keep swallowing briefly.
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(function () { if (!padHeld()) api.holding = false; }, 60);
    }
  }
  var types = DOWN.concat(UP);
  for (var i = 0; i < types.length; i++) root.addEventListener(types[i], swallow, { capture: true, passive: false });

  // ---- gamepad: any button skips; held until every button is let go
  function padHeld() {
    var pads;
    try { pads = root.navigator.getGamepads ? root.navigator.getGamepads() : []; } catch (e) { return false; }
    for (var p = 0; p < (pads ? pads.length : 0); p++) {
      var g = pads[p];
      if (!g || g.connected === false || !g.buttons) continue;
      for (var b = 0; b < g.buttons.length; b++) { var q = g.buttons[b]; if (q && (q.pressed || q.value > 0.5)) return true; }
    }
    return false;
  }
  var padTimer = setInterval(function () {
    if (api.active) { if (padHeld()) skip('gamepad'); return; }
    if (api.holding && api.skippedBy === 'gamepad' && !padHeld()) api.holding = false;
    if (!api.active && !api.holding) clearInterval(padTimer);
  }, 16);

  function skip(by) {
    if (!api.active) return;
    api.skippedBy = by;
    api.holding = true;
    for (var h = 0; h < hooks.length; h++) { try { hooks[h](by); } catch (e) {} }
    out();
  }
  function out() {
    if (!api.active) return;
    api.active = false;
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, FADE_MS);
  }
})(typeof window !== 'undefined' ? window : globalThis);
