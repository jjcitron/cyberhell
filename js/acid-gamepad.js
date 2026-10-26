// Acidlemon shared gamepad input (Gamepad API). Keep in sync across titles.
// Aligned with Acidlemon Crossfire (beatemup src/gamepad.js @ fdb1ab6): A confirm/jump,
// B back, Start pause, stick + D-pad navigate, .padfocus highlight, generic-mapping
// fallback, wake on first press, 60 Hz timer, rumble events hit / kill / boss.
(function (root) {
  'use strict';

  // Standard Gamepad API mapping (https://w3c.github.io/gamepad/#remapping).
  // Acidlemon convention (shared across titles): A/Cross = confirm/jump,
  // B/Circle = back, Start/Options = pause, left stick + D-pad = move/navigate.
  var STD_BUTTONS = {
    a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
    select: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16
  };
  // Non-standard fallback, same as Acidlemon Crossfire (beatemup src/gamepad.js):
  // the common XInput / HID order (Firefox Linux xpad, many generic pads).
  var RAW_BUTTONS = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, select: 6, start: 7, home: 8, ls: 9, rs: 10 };
  var BUTTON_NAMES = Object.keys(STD_BUTTONS);
  var DEFAULT_DEADZONE = 0.2;   // analog sticks (look / steer / fly): radial, rescaled
  var DIGITAL_DEAD = 0.35;      // menus + digital moves: Crossfire's axial deadzone
  var PRESS = 0.5;              // Crossfire: a button / standard trigger counts past half travel
  var RAW_TRIGGER = 0.3;        // Crossfire: xpad trigger axis (rest -1) counts past 0.3
  // Crossfire rumble events: [strength, ms]; weak motor = strength, strong = 0.8 x strength.
  var RUMBLE_EVENTS = { hit: [0.75, 170], kill: [0.45, 110], boss: [1, 600] };
  // Crossfire: buttons held through the waking press stay blocked until released.
  var WAKE_BLOCK = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt'];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /** Radial deadzone with rescale: |v| < dz -> 0, edge of the zone -> 0, full tilt -> 1. */
  function applyDeadzone(x, y, dz) {
    x = num(x); y = num(y);
    if (dz == null) dz = DEFAULT_DEADZONE;
    var mag = Math.sqrt(x * x + y * y);
    if (mag <= dz || mag === 0) return { x: 0, y: 0, mag: 0 };
    var scaled = Math.min(1, (mag - dz) / (1 - dz));
    return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled };
  }

  function btnValue(b) {
    if (b == null) return 0;
    if (typeof b === 'number') return b;
    if (typeof b.value === 'number' && b.value > 0) return b.value;
    return b.pressed ? 1 : 0;
  }
  /** Crossfire: pressed flag, or more than half travel. */
  function btnPressed(b) {
    if (b == null) return false;
    if (typeof b === 'number') return b > PRESS;
    return !!b.pressed || (typeof b.value === 'number' && b.value > PRESS);
  }

  /** Controller family from the id string, for the toast and button glyph hints. */
  function padFamily(id) {
    var s = String(id || '').toLowerCase();
    // Xbox first: "Xbox Wireless Controller" must not hit the PS4 "Wireless Controller" id.
    if (/(045e|xbox|xinput|x-box)/.test(s)) return 'xbox';
    if (/(054c|playstation|dualshock|dualsense|wireless controller|ps[345])/.test(s)) return 'playstation';
    if (/(057e|nintendo|switch|pro controller|joy-con)/.test(s)) return 'nintendo';
    return 'generic';
  }
  var FAMILY_LABEL = { xbox: 'Xbox controller', playstation: 'PlayStation controller', nintendo: 'Switch Pro controller', generic: 'gamepad' };

  /** Crossfire's prettyName: what the connect toast calls the pad. */
  function padLabel(id) {
    var s = String(id || '').toLowerCase();
    if (/xbox|xinput|045e/.test(s)) return 'Xbox controller';
    if (/dualsense|0ce6/.test(s)) return 'DualSense';
    if (/dualshock|playstation|054c|wireless controller/.test(s)) return 'PlayStation controller';
    if (/switch|057e|pro controller/.test(s)) return 'Switch Pro controller';
    return String(id || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'gamepad';
  }
  /** Crossfire toast wording, shared so every title says the same thing. */
  function connectText(info) {
    return '\uD83C\uDFAE Controller connected \u2014 ' + padLabel(info && info.id) + (info && info.standard === false ? ' (generic mapping)' : '');
  }
  var DISCONNECT_TEXT = '\uD83C\uDFAE Controller disconnected';

  /**
   * Normalise one Gamepad into a plain snapshot. Standard-mapped pads are read
   * by the spec layout; anything else uses Crossfire's generic fallback:
   * XInput/HID button order (A B X Y LB RB Back Start Guide LS RS), triggers on
   * axes 2 / 5 (rest -1), D-pad on buttons 12-15 when the pad has them, else a
   * hat on axes 6 / 7, else a single-axis hat on axis 9. RS (not used by
   * Crossfire) reads axes 3 / 4 on six-axis pads, 2 / 3 otherwise.
   */
  function readPad(pad, deadzone) {
    var buttons = pad.buttons || [];
    var axes = pad.axes || [];
    var standard = pad.mapping === 'standard';
    var M = standard ? STD_BUTTONS : RAW_BUTTONS;
    var raw = {}, pressed = {};
    var i, n;
    for (i = 0; i < BUTTON_NAMES.length; i++) {
      n = BUTTON_NAMES[i];
      raw[n] = M[n] == null ? 0 : btnValue(buttons[M[n]]);
      pressed[n] = M[n] == null ? false : btnPressed(buttons[M[n]]);
    }
    var lx = num(axes[0]), ly = num(axes[1]), rx = 0, ry = 0;
    if (standard) {
      rx = num(axes[2]); ry = num(axes[3]);
    } else {
      if (axes.length > 5) {
        var t2 = num(axes[2]), t5 = num(axes[5]);   // 0 = never touched yet on some drivers
        raw.lt = t2 !== 0 ? clamp((t2 + 1) / 2, 0, 1) : 0;
        raw.rt = t5 !== 0 ? clamp((t5 + 1) / 2, 0, 1) : 0;
        pressed.lt = t2 > RAW_TRIGGER;
        pressed.rt = t5 > RAW_TRIGGER;
        rx = num(axes[3]); ry = num(axes[4]);
      } else if (axes.length >= 4) {
        rx = num(axes[2]); ry = num(axes[3]);
      }
    }
    // D-pad
    var dx = 0, dy = 0;
    if (standard || buttons.length > 15) {
      var bv = function (k) { return btnPressed(buttons[k]) ? 1 : 0; };
      dx = bv(15) - bv(14); dy = bv(13) - bv(12);
    }
    if (!standard && !dx && !dy) {
      if (axes.length >= 8 && (Math.abs(num(axes[6])) > 0.5 || Math.abs(num(axes[7])) > 0.5)) {
        dx = Math.round(num(axes[6])); dy = Math.round(num(axes[7]));
      } else if (axes.length >= 10 && Math.abs(num(axes[9])) <= 1.01) {
        var h = Math.round((num(axes[9]) + 1) * 3.5);   // -1 = up, steps of 2/7 clockwise, > 1 = centred
        if (h >= 0 && h <= 7) { var a = h * Math.PI / 4; dx = Math.round(Math.sin(a)); dy = -Math.round(Math.cos(a)); }
      }
    }
    pressed.left = dx < 0; pressed.right = dx > 0; pressed.up = dy < 0; pressed.down = dy > 0;
    raw.left = pressed.left ? 1 : 0; raw.right = pressed.right ? 1 : 0; raw.up = pressed.up ? 1 : 0; raw.down = pressed.down ? 1 : 0;

    var ls = applyDeadzone(lx, ly, deadzone);
    var rs = applyDeadzone(rx, ry, deadzone);
    // D-pad wins over the stick for moves; the stick stays analog.
    var move = ls;
    if (dx || dy) move = (dx && dy) ? { x: dx * Math.SQRT1_2, y: dy * Math.SQRT1_2, mag: 1 } : { x: dx, y: dy, mag: 1 };
    // Crossfire digital stick: axial 0.35 deadzone, D-pad overrides. Menus read this.
    var digital = (dx || dy) ? { x: dx, y: dy }
      : { x: Math.abs(lx) > DIGITAL_DEAD ? lx : 0, y: Math.abs(ly) > DIGITAL_DEAD ? ly : 0 };
    return {
      index: pad.index, id: pad.id, family: padFamily(pad.id), standard: standard,
      buttons: pressed, values: raw,
      leftStick: ls, rightStick: rs, move: move, digital: digital,
      lt: clamp(raw.lt, 0, 1), rt: clamp(raw.rt, 0, 1)
    };
  }

  /** True while the Acidlemon startup splash (acid-splash.js) owns input. */
  function splashBlocking() {
    var g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
    var sp = g && g.AcidSplash;
    try { return !!(sp && typeof sp.blocking === 'function' && sp.blocking()); } catch (e) { return false; }
  }

  function anyActivity(snap) {
    if (!snap) return false;
    if (snap.leftStick.mag > 0 || snap.rightStick.mag > 0) return true;
    for (var n in snap.buttons) if (snap.buttons[n]) return true;
    return false;
  }

  function emptySnapshot() {
    var b = {}, v = {};
    for (var i = 0; i < BUTTON_NAMES.length; i++) { b[BUTTON_NAMES[i]] = false; v[BUTTON_NAMES[i]] = 0; }
    var z = { x: 0, y: 0, mag: 0 };
    return { index: -1, id: '', family: 'generic', standard: true, buttons: b, values: v, leftStick: z, rightStick: z, move: z, digital: { x: 0, y: 0 }, lt: 0, rt: 0 };
  }

  /** Rumble one specific Gamepad: vibrationActuator first, hapticActuators fallback. */
  function rumblePad(pad, strong, weak, durationMs) {
    if (!pad) return false;
    strong = clamp(num(strong), 0, 1);
    weak = clamp(weak == null ? strong : num(weak), 0, 1);
    durationMs = Math.max(0, Math.round(num(durationMs) || 120));
    try {
      var act = pad.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        var p = act.playEffect(act.type || 'dual-rumble', { startDelay: 0, duration: durationMs, strongMagnitude: strong, weakMagnitude: weak });
        if (p && p.catch) p.catch(function () {});
        return true;
      }
      var h = pad.hapticActuators && pad.hapticActuators[0];
      if (h && typeof h.pulse === 'function') {
        var q = h.pulse(Math.max(strong, weak), durationMs);
        if (q && q.catch) q.catch(function () {});
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * Gamepad input source. Call poll() once per frame from the game loop, then
   * read state / pressed(name) / released(name) / held(name). Hot-plug safe: a
   * pad that is unplugged mid-session releases every held input on the next poll.
   *
   * Crossfire conventions:
   *  - Wake: a pad is not live until its first press (browsers hide pads until
   *    then anyway). The waking press only wakes / hands control over: buttons
   *    held at that moment stay blocked until released, so it never also
   *    confirms a menu item or fires. A press on another pad hands control to it.
   *  - 60 Hz timer: when frames are slow (> 28 ms apart) a 16 ms timer samples
   *    the pad too, and presses / releases seen between frames are latched for
   *    the next poll(), so short taps are never missed.
   *  - body.pad-active while a pad is live; a touch hands control back.
   *
   * opts: { deadzone, onConnect(info), onDisconnect(info), rumble: true,
   *         timer: true, nav: navigator-like, win: window-like (for events),
   *         doc: document-like (pad-active class) }
   * info: { index, id, family, label, standard, text }  (text = Crossfire toast)
   */
  function createGamepadInput(opts) {
    opts = opts || {};
    var nav = opts.nav || (typeof navigator !== 'undefined' ? navigator : null);
    var win = opts.win || (typeof window !== 'undefined' ? window : null);
    var doc = opts.doc || (opts.win ? null : (typeof document !== 'undefined' ? document : null));
    var deadzone = opts.deadzone == null ? DEFAULT_DEADZONE : opts.deadzone;
    var now = opts.now || function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
    var known = {};          // index -> id of pads we have announced
    var activeIndex = null;  // the awake pad
    var last = emptySnapshot();   // latest sample (masked)
    var cur = emptySnapshot();    // what this frame sees
    var block = {};          // buttons held at wake / hand-over
    var pendDown = {}, pendUp = {}, frameDown = {}, frameUp = {};
    var lastSample = -1e9, timerId = null;
    var self = {
      state: cur,
      connected: false,
      awake: false,
      rumbleEnabled: opts.rumble !== false,
      samples: 0,
      poll: poll,
      sample: sample,
      pressed: function (n) { return !!frameDown[n]; },
      released: function (n) { return !!frameUp[n]; },
      held: function (n) { return !!cur.buttons[n] || !!frameDown[n]; },
      rumble: rumble,
      feel: feel,
      activePad: activePad,
      dispose: dispose,
      setDeadzone: function (d) { deadzone = d; }
    };

    function info(index, id, standard) {
      var o = { index: index, id: id, family: padFamily(id), label: padLabel(id), standard: standard !== false };
      o.text = connectText(o);
      return o;
    }
    function bodyClass(on) {
      try { if (doc && doc.body && doc.body.classList) doc.body.classList[on ? 'add' : 'remove']('pad-active'); } catch (e) {}
    }

    function listPads() {
      if (!nav || typeof nav.getGamepads !== 'function') return [];
      var list;
      try { list = nav.getGamepads() || []; } catch (e) { return []; }
      var out = [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].connected !== false) out.push(list[i]);
      return out;
    }

    function announce(pad) {
      if (known[pad.index] === pad.id) return;
      known[pad.index] = pad.id;
      if (opts.onConnect) try { opts.onConnect(info(pad.index, pad.id, pad.mapping === 'standard')); } catch (e) {}
    }
    function forget(index, id) {
      if (!(index in known)) return;
      var pid = id || known[index];
      delete known[index];
      if (activeIndex === index) { activeIndex = null; self.awake = false; bodyClass(false); }
      if (opts.onDisconnect) {
        var o = info(index, pid);
        o.text = DISCONNECT_TEXT;
        try { opts.onDisconnect(o); } catch (e) {}
      }
    }

    function onConn(e) { if (e && e.gamepad) announce(e.gamepad); }
    function onDisc(e) { if (e && e.gamepad) forget(e.gamepad.index, e.gamepad.id); }
    function onTouch() { if (self.awake) bodyClass(false); }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('gamepadconnected', onConn);
      win.addEventListener('gamepaddisconnected', onDisc);
      try { win.addEventListener('touchstart', onTouch, { passive: true }); } catch (e) {}
    }

    function activePad() {
      var pads = listPads();
      for (var i = 0; i < pads.length; i++) if (pads[i].index === activeIndex) return pads[i];
      return null;
    }

    /** Read the pads once: hot-plug, wake / hand-over, edges latched for the next poll(). */
    function sample() {
      lastSample = now();
      self.samples++;
      var pads = listPads();
      var seen = {};
      var i, n;
      // Chrome only exposes a pad after a button press and sometimes skips the
      // event, so polling also announces / retires pads.
      for (i = 0; i < pads.length; i++) { seen[pads[i].index] = true; announce(pads[i]); }
      for (var k in known) if (!seen[k]) forget(Number(k));
      self.connected = pads.length > 0;
      var chosen = null, other = null;
      for (i = 0; i < pads.length; i++) {
        var s = readPad(pads[i], deadzone);
        if (pads[i].index === activeIndex) chosen = s;
        else if (!other && anyActivity(s)) other = s;
      }
      var s2 = chosen, woke = false;
      if (other && (!chosen || !anyActivity(chosen))) {
        // Wake (first input) or hand-over. Like Crossfire, the waking input
        // fires no edges, and held face / shoulder / trigger buttons stay
        // blocked until released (moves and Start / Back just read as held).
        s2 = other;
        activeIndex = other.index;
        self.awake = true;
        woke = true;
        bodyClass(true);
        block = {};
        for (i = 0; i < WAKE_BLOCK.length; i++) if (s2.buttons[WAKE_BLOCK[i]]) block[WAKE_BLOCK[i]] = true;
      }
      if (!s2) { activeIndex = null; self.awake = false; s2 = emptySnapshot(); }
      else if (self.awake) bodyClass(true);
      // Acidlemon splash up (or its skip press still held): that press is the
      // splash's, so every held button stays blocked until released.
      if (splashBlocking()) for (n in s2.buttons) if (s2.buttons[n]) block[n] = true;
      for (n in block) {
        if (s2.buttons[n]) { s2.buttons[n] = false; if (n === 'lt' || n === 'rt') s2[n] = 0; }
        else delete block[n];
      }
      for (i = 0; i < BUTTON_NAMES.length && !woke; i++) {
        n = BUTTON_NAMES[i];
        if (s2.buttons[n] && !last.buttons[n]) pendDown[n] = true;
        if (!s2.buttons[n] && last.buttons[n]) pendUp[n] = true;
      }
      last = s2;
      return s2;
    }

    /** Once per frame from the game loop. */
    function poll() {
      sample();
      frameDown = pendDown; frameUp = pendUp;
      pendDown = {}; pendUp = {};
      cur = last;
      self.state = cur;
      return cur;
    }

    if (opts.timer !== false && typeof setInterval === 'function') {
      timerId = setInterval(function () { if (now() - lastSample > 28) { try { sample(); } catch (e) {} } }, 16);
      if (timerId && typeof timerId.unref === 'function') timerId.unref();
    }

    /** Feature-detected rumble on the active pad; silently skipped where unsupported. */
    function rumble(strong, weak, durationMs) {
      if (!self.rumbleEnabled || !self.awake) return false;
      return rumblePad(activePad(), strong, weak, durationMs);
    }
    /** Crossfire rumble events: 'hit' | 'kill' | 'boss'. */
    function feel(kind) {
      var r = RUMBLE_EVENTS[kind];
      if (!r) return false;
      return rumble(r[0] * 0.8, r[0], r[1]);
    }

    function dispose() {
      if (timerId != null && typeof clearInterval === 'function') clearInterval(timerId);
      timerId = null;
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('gamepadconnected', onConn);
        win.removeEventListener('gamepaddisconnected', onDisc);
        try { win.removeEventListener('touchstart', onTouch); } catch (e) {}
      }
    }
    return self;
  }

  /* ---------------------------------------------------------------------------
     Menu navigation: D-pad / left stick moves focus between the visible
     focusable controls of whatever menu is open, A/Cross clicks, B/Circle
     calls onBack. Left/right on a <select> or range steps its value.
     ------------------------------------------------------------------------- */
  var FOCUSABLE = 'button:not([disabled]), [href], select:not([disabled]), input:not([disabled]):not([type=hidden]), [tabindex]:not([tabindex="-1"])';

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof getComputedStyle === 'function') {
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    }
    return true;
  }

  /** Pure spatial pick: nearest candidate rect in direction dir from rect from. */
  function pickInDirection(from, rects, dir) {
    var fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    var best = -1, bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = cx - fx, dy = cy - fy;
      var main, cross;
      if (dir === 'up') { main = -dy; cross = Math.abs(dx); }
      else if (dir === 'down') { main = dy; cross = Math.abs(dx); }
      else if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
      else { main = dx; cross = Math.abs(dy); }
      if (main <= 1) continue;
      // Inside the 45-degree cone beats anything off to the side.
      var score = main + cross * 2 + (cross > main ? 1e6 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** Crossfire menu direction: digital stick / D-pad, vertical first. */
  function padDirection(s) {
    var d = s && (s.digital || s.move);
    if (!d) return null;
    var x = Math.abs(d.x) > DIGITAL_DEAD - 1e-9 ? d.x : 0, y = Math.abs(d.y) > DIGITAL_DEAD - 1e-9 ? d.y : 0;
    return y < 0 ? 'up' : y > 0 ? 'down' : x < 0 ? 'left' : x > 0 ? 'right' : null;
  }

  function createMenuNavigator(opts) {
    opts = opts || {};
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    var getRoot = opts.getRoot || function () { return null; };
    var selector = opts.selector || FOCUSABLE;
    var repeatDelay = opts.repeatDelay || 380, repeatRate = opts.repeatRate || 120;   // Crossfire: 0.38 s, then 0.12 s
    var held = null, nextAt = 0;
    var focusClass = opts.focusClass || 'padfocus';   // Crossfire's highlight class
    var current = null;

    function candidates(root) {
      var list = root.querySelectorAll ? root.querySelectorAll(selector) : [];
      var out = [];
      for (var i = 0; i < list.length; i++) if ((opts.isVisible || isVisible)(list[i])) out.push(list[i]);
      return out;
    }
    function mark(el) {
      if (current && current !== el && current.classList) current.classList.remove(focusClass);
      current = el;
      if (el) {
        if (el.classList) el.classList.add(focusClass);
        try { el.focus({ preventScroll: false }); } catch (e) { try { el.focus(); } catch (e2) {} }
      }
    }
    function focused(list) {
      var a = doc && doc.activeElement;
      if (a && list.indexOf(a) >= 0) return a;
      if (current && list.indexOf(current) >= 0) return current;
      return null;
    }
    function preferred(list) {
      var d = opts.getDefault && opts.getDefault();
      return d && list.indexOf(d) >= 0 ? d : list[0];
    }
    function stepValue(el, d) {
      if (el.tagName === 'SELECT') {
        var n = el.options ? el.options.length : 0;
        if (!n) return false;
        var idx = clamp(el.selectedIndex + d, 0, n - 1);
        if (idx === el.selectedIndex) return true;
        el.selectedIndex = idx;
      } else if (el.tagName === 'INPUT' && el.type === 'range') {
        var step = Number(el.step) || 1;
        var v = clamp(Number(el.value) + d * step, Number(el.min || 0), Number(el.max || 100));
        el.value = String(v);
        fire(el, 'input');
      } else return false;
      fire(el, 'change');
      return true;
    }
    function fire(el, type) {
      try {
        var ev = typeof Event === 'function' ? new Event(type, { bubbles: true }) : null;
        if (ev) el.dispatchEvent(ev);
      } catch (e) {}
    }
    function move(dir) {
      var root = getRoot();
      if (!root) return null;
      var list = candidates(root);
      if (!list.length) return null;
      var at = focused(list);
      // Nothing focused yet (menu just opened): take the default first.
      if (!at || !current) { var d0 = (opts.getDefault && preferred(list)) || at || list[0]; mark(d0); return d0; }
      if ((dir === 'left' || dir === 'right') && stepValue(at, dir === 'left' ? -1 : 1)) return at;
      var rects = [], els = [];
      for (var i = 0; i < list.length; i++) if (list[i] !== at) { rects.push(list[i].getBoundingClientRect()); els.push(list[i]); }
      var k = pickInDirection(at.getBoundingClientRect(), rects, dir);
      if (k < 0) {
        // Wrap vertically in a single column menu.
        var j = list.indexOf(at);
        if (dir === 'down') k = els.indexOf(list[(j + 1) % list.length]);
        else if (dir === 'up') k = els.indexOf(list[(j - 1 + list.length) % list.length]);
      }
      if (k >= 0) mark(els[k]);
      return k >= 0 ? els[k] : at;
    }
    function confirm() {
      var root = getRoot();
      if (!root) return false;
      var list = candidates(root);
      var at = (current && focused(list)) || preferred(list);
      if (!at) return false;
      mark(at);
      if (at.tagName === 'INPUT' && at.type === 'checkbox') { at.checked = !at.checked; fire(at, 'change'); return true; }
      if (typeof at.click === 'function') at.click();
      return true;
    }
    function ensureFocus() {
      var root = getRoot();
      if (!root) return;
      var list = candidates(root);
      if (!list.length) return;
      if (current && list.indexOf(current) >= 0) { if (!current.classList || current.classList.contains(focusClass)) return; }
      mark((current && list.indexOf(current) >= 0 && current) || preferred(list));
    }
    /** Feed one gamepad frame. Returns true when the menu consumed input. */
    function update(pad, now) {
      if (!getRoot()) { held = null; if (current && current.classList) current.classList.remove(focusClass); current = null; return false; }
      now = now == null ? Date.now() : now;
      // Crossfire: while a pad is live the menu always shows its highlight.
      if (pad.awake !== false) ensureFocus();
      var dir = padDirection(pad.state);
      var used = false;
      if (dir) {
        if (dir !== held) { held = dir; nextAt = now + repeatDelay; move(dir); used = true; }
        else if (now >= nextAt) { nextAt = now + repeatRate; move(dir); used = true; }
      } else held = null;
      if (pad.pressed('a')) { confirm(); used = true; }
      if (pad.pressed('b') && opts.onBack) { opts.onBack(); used = true; }
      if (pad.pressed('start') && opts.onStart) { opts.onStart(); used = true; }
      return used;
    }
    return { update: update, move: move, confirm: confirm, focus: mark, get current() { return current; } };
  }

  /* Small on-screen "controller connected" toast. */
  function showPadToast(text, opts) {
    try { return toastImpl(text, opts || {}); } catch (e) { return null; }   // cosmetic: never break input
  }
  function toastImpl(text, opts) {
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body) return null;
    var el = doc.getElementById('acid-pad-toast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'acid-pad-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;' +
        'padding:8px 16px;border-radius:6px;background:rgba(0,0,0,.82);color:#fff;border:1px solid rgba(255,255,255,.25);' +
        'font:600 13px/1.3 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none;transition:opacity .25s;opacity:0';
      doc.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    if (el._t) clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; }, opts.ms || 3200);
    return el;
  }

  /* Focus ring for pad navigation, injected once. */
  function injectPadFocusStyle(doc, css) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.head || doc.getElementById('acid-pad-style')) return;
    var st = doc.createElement('style');
    st.id = 'acid-pad-style';
    st.textContent = css || '.padfocus{outline:3px solid #ffcf3a !important;outline-offset:2px;box-shadow:0 0 0 6px rgba(255,207,58,.25) !important;}';   // Crossfire style.css
    doc.head.appendChild(st);
  }

  var AcidGamepad = {
    STD_BUTTONS: STD_BUTTONS, RAW_BUTTONS: RAW_BUTTONS, FAMILY_LABEL: FAMILY_LABEL, DEFAULT_DEADZONE: DEFAULT_DEADZONE,
    RUMBLE_EVENTS: RUMBLE_EVENTS, DISCONNECT_TEXT: DISCONNECT_TEXT,
    applyDeadzone: applyDeadzone, readPad: readPad, padFamily: padFamily, padLabel: padLabel, connectText: connectText,
    padDirection: padDirection,
    createGamepadInput: createGamepadInput, rumblePad: rumblePad, createMenuNavigator: createMenuNavigator,
    pickInDirection: pickInDirection, showPadToast: showPadToast, injectPadFocusStyle: injectPadFocusStyle
  };
  root.AcidGamepad = AcidGamepad;
  if (typeof module !== 'undefined' && module.exports) module.exports = AcidGamepad;
})(typeof window !== 'undefined' ? window : globalThis);
