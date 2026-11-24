/* ==========================================================================
   cyber-input-mode.js : decides once, before any CSS or engine code runs,
   whether this is the touch build (virtual pad, tap to start, no pointer
   lock) or the desktop build (mouse look under pointer lock).

   Why not just `(pointer: coarse)`: that media query reports the PRIMARY
   pointer, and Chrome on Android picks the finest input it can see. A tablet
   with a stylus digitizer (TCL NXTPAPER + T-Pen, Galaxy Tab + S Pen) or an
   OEM "virtual mouse" input device therefore reports `pointer: fine` /
   `hover: hover`, even though the user is holding a touchscreen. The game then
   hid the touch pad, showed the keyboard HUD, and asked for pointer lock on the
   START tap, which Android refuses for touch: not playable.

   Chrome on 10"+ Android tablets also defaults to "desktop site", which sends
   an X11 Linux UA with no "Android" in it, so the UA cannot be the only test.

   Rule (pure, unit-tested in tests/input-mode.test.js):
     1. ?touch=1 / ?touch=0 forces the mode (remembered); ?touch=auto clears it
     2. primary pointer coarse                                  -> touch
     3. Android or non-ChromeOS Linux UA with a touchscreen      -> touch
        (any-pointer: coarse, or maxTouchPoints > 0)
     4. otherwise desktop. A Windows/Mac touchscreen laptop stays desktop so
        it keeps pointer-lock mouse look, as before.
   On top of that the engine upgrades to touch at runtime the first time a
   finger or pen (not a mouse) presses anything before the mission starts.
   ========================================================================== */
(function (root) {
  'use strict';

  var FORCE_KEY = 'cyberhell.forceTouch';

  function detectTouch(env) {
    env = env || {};
    if (env.force === true || env.force === false) return env.force;
    if (env.coarse) return true;
    var ua = env.ua || '';
    var android = /Android/i.test(ua);
    var desktopLinux = /\bLinux\b/.test(ua) && !/CrOS/.test(ua) && !/Windows NT|Macintosh/.test(ua);
    var hasTouchscreen = !!env.anyCoarse || (env.maxTouchPoints || 0) > 0;
    if ((android || desktopLinux) && hasTouchscreen) return true;
    return false;
  }

  // Read the ?touch= override, persist it, and return true/false/null.
  function readForce(search, storage) {
    var m = /[?&]touch=(1|0|on|off|auto)\b/.exec(search || '');
    try {
      if (m) {
        if (m[1] === 'auto') storage.removeItem(FORCE_KEY);
        else storage.setItem(FORCE_KEY, (m[1] === '1' || m[1] === 'on') ? '1' : '0');
      }
      var v = storage.getItem(FORCE_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (err) { /* storage blocked: fall through to the URL alone */
      if (m && m[1] !== 'auto') return m[1] === '1' || m[1] === 'on';
    }
    return null;
  }

  function browserEnv() {
    var mm = function (q) { try { return root.matchMedia(q).matches; } catch (e) { return false; } };
    var storage = null;
    try { storage = root.localStorage; } catch (e) {}
    return {
      force: readForce(root.location && root.location.search, storage || { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} }),
      coarse: mm('(pointer: coarse)'),
      anyCoarse: mm('(any-pointer: coarse)'),
      maxTouchPoints: (root.navigator && root.navigator.maxTouchPoints) || 0,
      ua: (root.navigator && root.navigator.userAgent) || ''
    };
  }

  // Single writer for the mode: the <html> class drives every touch-only CSS
  // rule, window.CYBER_TOUCH is what the scripts read.
  function setTouchMode(on) {
    root.CYBER_TOUCH = !!on;
    var el = root.document && root.document.documentElement;
    if (el) { el.classList.toggle('touch', !!on); el.classList.toggle('desktop', !on); }
    return root.CYBER_TOUCH;
  }

  var api = { detectTouch: detectTouch, readForce: readForce, setTouchMode: setTouchMode, FORCE_KEY: FORCE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) {
    root.CyberInputMode = api;
    setTouchMode(detectTouch(browserEnv()));
  }
})(typeof window !== 'undefined' ? window : this);
