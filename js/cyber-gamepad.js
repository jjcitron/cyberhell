// Cyberhell gamepad glue: feeds js/acid-gamepad.js into the engine's existing
// input layer (keys / moveAxis / applyLook / isFiring), the same seams the
// touch layer already uses. Polled once per frame from CyberDoomEngine.animate.
//
//   Left stick / D-pad  move (analog)        Right stick  look
//   RT / RB             fire (hold)          A / Cross    jump (menus: confirm)
//   X / Square, LT      use / open           B / Circle   back (close map / resume)
//   Y / LB              next / prev weapon   View/Share   automap
//   Start / Options     pause / resume
(function (root) {
  'use strict';
  var LOOK_SPEED_X = 3.0;   // rad/s at full tilt
  var LOOK_SPEED_Y = 2.0;
  var MOVE_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];

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
    var byId = function (id) { return doc ? doc.getElementById(id) : null; };
    var toast = opts.toast || function (t) { G.showPadToast(t); };

    var st = { padKeys: {}, padMoving: false, padFiring: false };
    var pad = opts.pad || G.createGamepadInput({
      nav: opts.nav, win: opts.win,
      onConnect: function (i) { toast(i.label + ' connected'); },
      onDisconnect: function (i) {
        toast(i.label + ' disconnected');
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
    engine.gamepad = pad;
    return {
      pad: pad, menu: menu, state: st,
      release: function () { release(engine, st); },
      update: function (dt) { update(engine, pad, menu, st, dt, ownsPad, opts); }
    };
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

    var fireHeld = pad.held('rt') || pad.held('rb');
    if (fireHeld) {
      if (!st.padFiring) { st.padFiring = true; engine.isFiring = true; engine.fireWeapon(); }
    } else if (st.padFiring) { st.padFiring = false; engine.isFiring = false; }

    if (pad.pressed('x') || pad.pressed('lt')) engine.interact();
    if (pad.pressed('y')) cycle(engine, 1);
    if (pad.pressed('lb')) cycle(engine, -1);
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
