// Acidlemon shared gamepad input (Gamepad API). Keep in sync across titles.
// Mapping: A/Cross = confirm/jump, B/Circle = back, Start = pause,
// left stick + D-pad = move/navigate. Rumble is feature-detected.
(function (root) {
  'use strict';

  // Standard Gamepad API mapping (https://w3c.github.io/gamepad/#remapping).
  // Acidlemon convention (shared across titles): A/Cross = confirm/jump,
  // B/Circle = back, Start/Options = pause, left stick + D-pad = move/navigate.
  var STD_BUTTONS = {
    a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
    select: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16
  };
  var BUTTON_NAMES = Object.keys(STD_BUTTONS);
  var DEFAULT_DEADZONE = 0.2;
  var TRIGGER_THRESHOLD = 0.35;

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

  /** Controller family from the id string, for the toast and button glyph hints. */
  function padFamily(id) {
    var s = String(id || '').toLowerCase();
    // Xbox first: "Xbox Wireless Controller" must not hit the PS4 "Wireless Controller" id.
    if (/(045e|xbox|xinput|x-box)/.test(s)) return 'xbox';
    if (/(054c|playstation|dualshock|dualsense|wireless controller|ps[345])/.test(s)) return 'playstation';
    if (/(057e|nintendo|switch|pro controller|joy-con)/.test(s)) return 'nintendo';
    return 'generic';
  }
  var FAMILY_LABEL = { xbox: 'Xbox controller', playstation: 'PlayStation controller', nintendo: 'Nintendo controller', generic: 'Controller' };

  /**
   * Normalise one Gamepad into a plain snapshot. Standard-mapped pads are read
   * by the spec layout; anything else gets a best-effort fallback that matches
   * the common DirectInput / Linux joydev layouts (face 0-3, shoulders 4-7,
   * select/start 8/9, LS on axes 0/1, RS on 2/3 or 3/4, hat on the last axes).
   */
  function readPad(pad, deadzone) {
    var buttons = pad.buttons || [];
    var axes = pad.axes || [];
    var standard = pad.mapping === 'standard';
    var raw = {};
    var i;
    for (i = 0; i < BUTTON_NAMES.length; i++) raw[BUTTON_NAMES[i]] = btnValue(buttons[STD_BUTTONS[BUTTON_NAMES[i]]]);
    var lx = num(axes[0]), ly = num(axes[1]), rx = 0, ry = 0;
    if (standard) {
      rx = num(axes[2]); ry = num(axes[3]);
    } else {
      if (axes.length >= 6) {
        // xpad-style: 2 = LT, 3/4 = RS, 5 = RT (triggers rest at -1).
        rx = num(axes[3]); ry = num(axes[4]);
        var t2 = num(axes[2]), t5 = num(axes[5]); // 0 = never touched yet
        raw.lt = Math.max(raw.lt, t2 !== 0 ? (t2 + 1) / 2 : 0);
        raw.rt = Math.max(raw.rt, t5 !== 0 ? (t5 + 1) / 2 : 0);
      } else if (axes.length >= 4) {
        rx = num(axes[2]); ry = num(axes[3]);
      }
      // D-pad: buttons 12-15 when present, else a hat on the last axis pair.
      if (buttons.length < 16 && axes.length >= 6) {
        var hx = num(axes[axes.length - 2]), hy = num(axes[axes.length - 1]);
        if (axes.length >= 8) { hx = num(axes[6]); hy = num(axes[7]); }
        raw.left = Math.max(raw.left, hx < -0.5 ? 1 : 0);
        raw.right = Math.max(raw.right, hx > 0.5 ? 1 : 0);
        raw.up = Math.max(raw.up, hy < -0.5 ? 1 : 0);
        raw.down = Math.max(raw.down, hy > 0.5 ? 1 : 0);
      }
    }
    var ls = applyDeadzone(lx, ly, deadzone);
    var rs = applyDeadzone(rx, ry, deadzone);
    var pressed = {};
    for (i = 0; i < BUTTON_NAMES.length; i++) {
      var n = BUTTON_NAMES[i];
      pressed[n] = (n === 'lt' || n === 'rt') ? raw[n] > TRIGGER_THRESHOLD : raw[n] > 0.5;
    }
    // D-pad wins over the stick for digital moves; the stick stays analog.
    var dx = (pressed.right ? 1 : 0) - (pressed.left ? 1 : 0);
    var dy = (pressed.down ? 1 : 0) - (pressed.up ? 1 : 0);
    var move = (dx || dy) ? applyDeadzone(dx, dy, 0) : ls;
    if (dx && dy) { move = { x: dx * Math.SQRT1_2, y: dy * Math.SQRT1_2, mag: 1 }; }
    return {
      index: pad.index, id: pad.id, family: padFamily(pad.id), standard: standard,
      buttons: pressed, values: raw,
      leftStick: ls, rightStick: rs, move: move,
      lt: clamp(raw.lt, 0, 1), rt: clamp(raw.rt, 0, 1)
    };
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
    return { index: -1, id: '', family: 'generic', standard: true, buttons: b, values: v, leftStick: z, rightStick: z, move: z, lt: 0, rt: 0 };
  }

  /**
   * Gamepad input source. Call poll() once per frame from the game loop, then
   * read state / pressed(name) / released(name). Hot-plug safe: a pad that is
   * unplugged mid-session releases every held input on the next poll.
   *
   * opts: { deadzone, onConnect(info), onDisconnect(info), rumble: true,
   *         nav: navigator-like, win: window-like (for events) }
   */
  function createGamepadInput(opts) {
    opts = opts || {};
    var nav = opts.nav || (typeof navigator !== 'undefined' ? navigator : null);
    var win = opts.win || (typeof window !== 'undefined' ? window : null);
    var deadzone = opts.deadzone == null ? DEFAULT_DEADZONE : opts.deadzone;
    var known = {};          // index -> id of pads we have announced
    var activeIndex = null;
    var prev = emptySnapshot();
    var cur = emptySnapshot();
    var self = {
      state: cur,
      connected: false,
      rumbleEnabled: opts.rumble !== false,
      poll: poll,
      pressed: function (n) { return !!cur.buttons[n] && !prev.buttons[n]; },
      released: function (n) { return !cur.buttons[n] && !!prev.buttons[n]; },
      held: function (n) { return !!cur.buttons[n]; },
      rumble: rumble,
      activePad: activePad,
      dispose: dispose,
      setDeadzone: function (d) { deadzone = d; }
    };

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
      if (opts.onConnect) try { opts.onConnect({ index: pad.index, id: pad.id, family: padFamily(pad.id), label: FAMILY_LABEL[padFamily(pad.id)], standard: pad.mapping === 'standard' }); } catch (e) {}
    }
    function forget(index, id) {
      if (!(index in known)) return;
      var pid = id || known[index];
      delete known[index];
      if (activeIndex === index) activeIndex = null;
      if (opts.onDisconnect) try { opts.onDisconnect({ index: index, id: pid, family: padFamily(pid), label: FAMILY_LABEL[padFamily(pid)] }); } catch (e) {}
    }

    function onConn(e) { if (e && e.gamepad) announce(e.gamepad); }
    function onDisc(e) { if (e && e.gamepad) forget(e.gamepad.index, e.gamepad.id); }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('gamepadconnected', onConn);
      win.addEventListener('gamepaddisconnected', onDisc);
    }

    function activePad() {
      var pads = listPads();
      for (var i = 0; i < pads.length; i++) if (pads[i].index === activeIndex) return pads[i];
      return null;
    }

    function poll() {
      var pads = listPads();
      var seen = {};
      var i;
      // Chrome only exposes a pad after a button press and sometimes skips the
      // event, so polling also announces / retires pads.
      for (i = 0; i < pads.length; i++) { seen[pads[i].index] = true; announce(pads[i]); }
      for (var k in known) if (!seen[k]) forget(Number(k));
      // The pad that last produced input owns the player; first pad otherwise.
      var chosen = null, firstActive = null;
      for (i = 0; i < pads.length; i++) {
        var s = readPad(pads[i], deadzone);
        if (pads[i].index === activeIndex) chosen = s;
        if (!firstActive && anyActivity(s)) firstActive = s;
      }
      if (firstActive && (!chosen || !anyActivity(chosen))) chosen = firstActive;
      if (!chosen && pads.length) chosen = readPad(pads[0], deadzone);
      prev = cur;
      cur = chosen || emptySnapshot();
      activeIndex = chosen ? chosen.index : null;
      self.state = cur;
      self.connected = pads.length > 0;
      return cur;
    }

    /** Feature-detected rumble; resolves silently where unsupported. */
    function rumble(strong, weak, durationMs) {
      if (!self.rumbleEnabled) return false;
      var pad = activePad();
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

    function dispose() {
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('gamepadconnected', onConn);
        win.removeEventListener('gamepaddisconnected', onDisc);
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

  function createMenuNavigator(opts) {
    opts = opts || {};
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    var getRoot = opts.getRoot || function () { return null; };
    var selector = opts.selector || FOCUSABLE;
    var repeatDelay = opts.repeatDelay || 380, repeatRate = opts.repeatRate || 130;
    var held = null, nextAt = 0;
    var focusClass = opts.focusClass || 'pad-focus';
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
      if (!at) { var d0 = preferred(list); mark(d0); return d0; }
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
      var at = focused(list) || preferred(list);
      if (!at) return false;
      mark(at);
      if (at.tagName === 'INPUT' && at.type === 'checkbox') { at.checked = !at.checked; fire(at, 'change'); return true; }
      if (typeof at.click === 'function') at.click();
      return true;
    }
    /** Feed one gamepad frame. Returns true when the menu consumed input. */
    function update(pad, now) {
      if (!getRoot()) { held = null; if (current && current.classList) current.classList.remove(focusClass); current = null; return false; }
      now = now == null ? Date.now() : now;
      var s = pad.state, m = s.move;
      var dir = null;
      if (Math.abs(m.x) > 0.5 || Math.abs(m.y) > 0.5) dir = Math.abs(m.x) > Math.abs(m.y) ? (m.x > 0 ? 'right' : 'left') : (m.y > 0 ? 'down' : 'up');
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
    opts = opts || {};
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
    el._t = setTimeout(function () { el.style.opacity = '0'; }, opts.ms || 2500);
    return el;
  }

  /* Focus ring for pad navigation, injected once. */
  function injectPadFocusStyle(doc, css) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.head || doc.getElementById('acid-pad-style')) return;
    var st = doc.createElement('style');
    st.id = 'acid-pad-style';
    st.textContent = css || '.pad-focus{outline:3px solid #ffe14d !important;outline-offset:2px !important;box-shadow:0 0 12px rgba(255,225,77,.6) !important;}';
    doc.head.appendChild(st);
  }

  var AcidGamepad = {
    STD_BUTTONS: STD_BUTTONS, FAMILY_LABEL: FAMILY_LABEL, DEFAULT_DEADZONE: DEFAULT_DEADZONE,
    applyDeadzone: applyDeadzone, readPad: readPad, padFamily: padFamily,
    createGamepadInput: createGamepadInput, createMenuNavigator: createMenuNavigator,
    pickInDirection: pickInDirection, showPadToast: showPadToast, injectPadFocusStyle: injectPadFocusStyle
  };
  root.AcidGamepad = AcidGamepad;
  if (typeof module !== 'undefined' && module.exports) module.exports = AcidGamepad;
})(typeof window !== 'undefined' ? window : globalThis);
