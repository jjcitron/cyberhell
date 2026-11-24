// Cyberhell gamepad glue: feeds js/acid-gamepad.js into the engine's existing
// input layer (keys / moveAxis / applyLook / isFiring), the same seams the
// touch layer already uses. Polled once per frame from CyberDoomEngine.animate.
//
// Aligned with Acidlemon Crossfire (beatemup src/gamepad.js): A jump, X light,
// Y heavy, B special/back, RB bomb, LB item, LT/RT weapon cycle, Start pause.
//
//   Left stick / D-pad  move (analog)        Right stick  look
//   X / Square          fire (hold)          A / Cross    jump (menus: confirm)
//   RB                  fire (hold) - no grenade in the engine, so "bomb" fires
//   Y / LB              use / open (heavy / item: the engine's only other action)
//   RT / LT             next / prev weapon   B / Circle   back (close map / resume)
//   View / Share        automap              Start        pause / resume
// Rumble: the engine calls gamepad.feel('hit' | 'kill' | 'boss').
// Physical gamepad input fades touch controls; touching the screen restores them.

(function (root) {
  'use strict';
  var LOOK_SPEED_X = 3.0;   // rad/s at full tilt
  var LOOK_SPEED_Y = 2.0;
  var MOVE_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
  var VIRTUAL_PAD_ID = 'Cyberhell Touch Virtual Pad';
  var FADE_CLASS = 'cyber-pad-touch-faded';
  var FADE_STYLE_ID = 'cyber-pad-touch-fade-style';
  var nativeGetGamepads = null;

  // Capture the native API before index.html merges in the virtual touch pad.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      nativeGetGamepads = navigator.getGamepads.bind(navigator);
    }
  } catch (e) {}

  function lookCurve(v) { return v * Math.abs(v); }   // fine aim near centre

  // opts: { pad (an existing createGamepadInput to share; the caller polls it),
  //         onPause, onBack (in-run Start / B overrides), onExtra(pad, engine),
  //         AcidGamepad, nav, win, doc, toast, isVisible (tests) }
  function attach(engine, opts) {
    opts = opts || {};
    var G = opts.AcidGamepad || root.AcidGamepad;
    if (!G) return null;
    var ownsPad = !opts.pad;
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    var win = opts.win || (typeof window !== 'undefined' ? window : null);
    var byId = function (id) { return doc ? doc.getElementById(id) : null; };
    var toast = opts.toast || function (t) { G.showPadToast(t); };

    var st = { padKeys: {}, padMoving: false, padFiring: false };
    var pad = opts.pad || G.createGamepadInput({
      nav: opts.nav, win: opts.win, timer: opts.timer,
      onConnect: function (i) { toast(i.text); },
      onDisconnect: function (i) {
        toast(i.text);
        release(engine, st);
        // Losing the pad mid-mission parks the run behind PAUSED, like losing focus.
        if (engine.isRunning && typeof engine.pauseRun === 'function') engine.pauseRun('PAUSED', 'CONTROLLER DISCONNECTED - RECONNECT AND PRESS START');
      }
    });

    var overlayOpen = function () {
      var o = byId('overlay-screen');
      return !!(o && o.style.display !== 'none' && !engine.isRunning) && o;
    };
    var clickStart = function () {
      var b = byId('start-btn');
      if (!b) return;
      engine.padGesture = true;           // startRun skips pointer lock for a pad
      try { b.click(); } finally { engine.padGesture = false; }
    };
    var menu = G.createMenuNavigator({
      doc: doc,
      getRoot: function () { return overlayOpen() || null; },
      isVisible: opts.isVisible,
      getDefault: function () { return byId('start-btn'); },
      onStart: clickStart,
      onBack: function () {
        var o = overlayOpen();
        if (o && o.classList && o.classList.contains('mode-pause')) clickStart();
      }
    });
    if (doc) G.injectPadFocusStyle(doc);
    if (doc) opts.touchFade = attachTouchFade(doc, win, opts.nav, G);
    engine.gamepad = pad;
    return {
      pad: pad, menu: menu, state: st,
      release: function () { release(engine, st); },
      update: function (dt) { update(engine, pad, menu, st, dt, ownsPad, opts); }
    };
  }

  function attachTouchFade(doc, win, suppliedNav, G) {
    injectTouchFadeStyle(doc);
    if (doc.__cyberPadTouchFade) return doc.__cyberPadTouchFade;

    var nav = suppliedNav;
    if (!nav && nativeGetGamepads) nav = { getGamepads: nativeGetGamepads };
    var previous = {};
    var hadPhysicalPad = false;
    var deadzone = G && G.DEFAULT_DEADZONE != null ? G.DEFAULT_DEADZONE : 0.25;

    function padKey(pad) {
      return String(pad.index) + ':' + String(pad.id || '');
    }

    function snapshot(pad) {
      var active = [];
      var buttons = pad.buttons || [];
      var axes = pad.axes || [];
      var i, button, value;
      for (i = 0; i < buttons.length; i++) {
        button = buttons[i];
        value = button && typeof button.value === 'number' ? button.value : 0;
        active.push(!!(button && (button.pressed || value > 0.5)));
      }
      for (i = 0; i < axes.length; i++) {
        value = typeof axes[i] === 'number' ? axes[i] : 0;
        active.push(Math.abs(value) > deadzone);
      }
      return active;
    }

    function setFaded(faded) {
      var controls = doc.getElementById('mobile-controls');
      if (controls && controls.classList) controls.classList[faded ? 'add' : 'remove'](FADE_CLASS);
      state.faded = !!faded;
    }

    function clear() {
      setFaded(false);
    }

    function physicalPads() {
      if (!nav || typeof nav.getGamepads !== 'function') return [];
      var list;
      try { list = nav.getGamepads() || []; } catch (e) { return []; }
      var pads = [];
      for (var i = 0; i < list.length; i++) {
        var pad = list[i];
        if (pad && pad.connected !== false && pad.id !== VIRTUAL_PAD_ID) pads.push(pad);
      }
      return pads;
    }

    function poll() {
      var pads = physicalPads();
      var next = {};
      var activeEdge = false;
      for (var i = 0; i < pads.length; i++) {
        var pad = pads[i];
        var key = padKey(pad);
        var current = snapshot(pad);
        var prior = previous[key] || [];
        for (var j = 0; j < current.length; j++) {
          if (current[j] && !prior[j]) {
            activeEdge = true;
            break;
          }
        }
        next[key] = current;
      }
      if (!pads.length && hadPhysicalPad) clear();
      previous = next;
      hadPhysicalPad = pads.length > 0;
      if (activeEdge) setFaded(true);
      return activeEdge;
    }

    function onPointerDown(event) {
      if (event && event.pointerType === 'touch') clear();
    }

    function onGamepadDisconnected(event) {
      var pad = event && event.gamepad;
      if (pad && pad.id !== VIRTUAL_PAD_ID) {
        delete previous[padKey(pad)];
        clear();
      } else if (!physicalPads().length) {
        clear();
      }
    }

    function listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      try { target.addEventListener(type, handler, { capture: true, passive: true }); }
      catch (e) { target.addEventListener(type, handler, true); }
    }

    var state = { faded: false, poll: poll, clear: clear };
    listen(doc, 'touchstart', clear);
    listen(doc, 'pointerdown', onPointerDown);
    if (win && win !== doc) {
      listen(win, 'touchstart', clear);
      listen(win, 'pointerdown', onPointerDown);
      listen(win, 'gamepaddisconnected', onGamepadDisconnected);
    } else {
      listen(doc, 'gamepaddisconnected', onGamepadDisconnected);
    }
    doc.__cyberPadTouchFade = state;
    return state;
  }

  function injectTouchFadeStyle(doc) {
    if (!doc || !doc.head || doc.getElementById(FADE_STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = FADE_STYLE_ID;
    style.textContent = '#mobile-controls{transition:opacity .16s ease;}' +
      '#mobile-controls.' + FADE_CLASS + '{opacity:0 !important;}' +
      '#mobile-controls.' + FADE_CLASS + ',#mobile-controls.' + FADE_CLASS + ' *{pointer-events:none !important;}';
    doc.head.appendChild(style);
  }

  function release(engine, st) {
    for (var k in st.padKeys) if (st.padKeys[k]) engine.keys[k] = false;
    st.padKeys = {};
    if (st.padMoving) engine.moveAxis = null;
    st.padMoving = false;
    if (st.padFiring) engine.isFiring = false;
    st.padFiring = false;
  }

  function setKey(engine, st, code, on) {
    if (on) { engine.keys[code] = true; st.padKeys[code] = true; }
    else if (st.padKeys[code]) { engine.keys[code] = false; delete st.padKeys[code]; }
  }

  function update(engine, pad, menu, st, dt, ownsPad, opts) {
    if (opts.touchFade) opts.touchFade.poll();
    if (ownsPad) pad.poll();
    if (!pad.connected) { if (st.padMoving || st.padFiring) release(engine, st); return; }

    if (!engine.isRunning) {
      release(engine, st);
      if (engine.isAutomapOpen && engine.isAutomapOpen() && (pad.pressed('b') || pad.pressed('select'))) { engine.toggleAutomap(); return; }
      // Game over / cleared screens: A or Start presses the primary button.
      menu.update(pad);
      return;
    }

    var s = pad.state;
    if (pad.pressed('start')) { release(engine, st); if (opts.onPause) opts.onPause(); else engine.pauseRun(); return; }
    var mapOpen = engine.isAutomapOpen && engine.isAutomapOpen();
    if (pad.pressed('b') && !mapOpen && opts.onBack) { release(engine, st); opts.onBack(); return; }

    // Movement: analog, mirrored into the key map exactly like the touch stick.
    var m = s.move;
    if (m.mag > 0) {
      engine.moveAxis = { x: m.x, z: m.y };
      st.padMoving = true;
      setKey(engine, st, 'KeyW', m.y < -0.2);
      setKey(engine, st, 'KeyS', m.y > 0.2);
      setKey(engine, st, 'KeyA', m.x < -0.2);
      setKey(engine, st, 'KeyD', m.x > 0.2);
    } else if (st.padMoving) {
      engine.moveAxis = null;
      st.padMoving = false;
      MOVE_KEYS.forEach(function (k) { setKey(engine, st, k, false); });
    }

    var r = s.rightStick;
    if (r.mag > 0) engine.applyLook(lookCurve(r.x) * LOOK_SPEED_X, lookCurve(r.y) * LOOK_SPEED_Y, dt);

    setKey(engine, st, 'Space', pad.held('a'));

    var fireHeld = pad.held('x') || pad.held('rb');
    if (fireHeld) {
      if (!st.padFiring) { st.padFiring = true; engine.isFiring = true; engine.fireWeapon(); }
    } else if (st.padFiring) { st.padFiring = false; engine.isFiring = false; }

    if (pad.pressed('y') || pad.pressed('lb')) engine.interact();
    if (pad.pressed('rt')) cycle(engine, 1);
    if (pad.pressed('lt')) cycle(engine, -1);
    if (pad.pressed('select') || (pad.pressed('b') && mapOpen)) engine.toggleAutomap();
    if (opts.onExtra) opts.onExtra(pad, engine);
  }

  function cycle(engine, step) {
    var list = engine.ownedWeapons();
    if (!list || list.length < 2) return;
    var i = list.indexOf(engine.player.currentWeapon);
    engine.switchWeapon(list[(i + step + list.length) % list.length]);
  }

  root.CyberGamepad = { attach: attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CyberGamepad;
})(typeof window !== 'undefined' ? window : globalThis);
