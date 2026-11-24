// Gamepad support: core mapping (js/acid-gamepad.js) + Cyberhell glue
// (js/cyber-gamepad.js), driven by a mocked navigator.getGamepads.
// Run: node --test tests/gamepad.test.mjs (conventions: Acidlemon Crossfire, beatemup src/gamepad.js)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const load = (f) => vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), { filename: f });
load('acid-gamepad.js');
load('cyber-gamepad.js');
const G = globalThis.AcidGamepad;
import test from 'node:test';
import assert from 'node:assert/strict';

// Mocked navigator.getGamepads / window events: no browser needed.
// Conventions under test are Acidlemon Crossfire's (beatemup src/gamepad.js @ fdb1ab6).
function btn(v) { return { pressed: v > 0.5, value: v }; }
function makePad(over = {}) {
  const buttons = Array.from({ length: 17 }, () => btn(0));
  return { index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons, ...over };
}
function makeEnv() {
  const listeners = {};
  const pads = [];
  return {
    pads,
    nav: { getGamepads: () => pads.slice() },
    win: {
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
      emit: (t, e) => (listeners[t] || []).forEach((f) => f(e)),
      count: (t) => (listeners[t] || []).length
    }
  };
}
/** A pad that is already awake (its waking press released). */
function awake(env, pad, opts = {}) {
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win, timer: false, ...opts });
  pad.buttons[3] = btn(1); gp.poll();
  pad.buttons[3] = btn(0); gp.poll();
  return gp;
}

test('radial deadzone zeroes drift and rescales to full tilt', () => {
  assert.deepEqual(G.applyDeadzone(0.1, 0.1, 0.2), { x: 0, y: 0, mag: 0 });
  const full = G.applyDeadzone(1, 0, 0.2);
  assert.equal(full.x, 1); assert.equal(full.mag, 1);
  const half = G.applyDeadzone(0.6, 0, 0.2);
  assert.ok(Math.abs(half.x - 0.5) < 1e-9);
});

test('wake: the first press only wakes the pad, it never also confirms', () => {
  const env = makeEnv();
  const pad = makePad();
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win, timer: false });
  gp.poll();
  assert.equal(gp.connected, true);
  assert.equal(gp.awake, false, 'idle pad is not live yet');
  pad.buttons[0] = btn(1); gp.poll();
  assert.equal(gp.awake, true);
  assert.equal(gp.pressed('a'), false, 'waking A is swallowed');
  assert.equal(gp.held('a'), false, 'and stays blocked while held');
  gp.poll();
  assert.equal(gp.held('a'), false);
  pad.buttons[0] = btn(0); gp.poll();
  pad.buttons[0] = btn(1); gp.poll();
  assert.equal(gp.pressed('a'), true, 'the next press is real');
  gp.dispose();
});

test('a press on another pad hands control over, also blocked', () => {
  const env = makeEnv();
  const p1 = makePad();
  const gp = awake(env, p1);
  const p2 = makePad({ index: 1, id: 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)' });
  env.pads.push(p2);
  p2.buttons[2] = btn(1); gp.poll();
  assert.equal(gp.state.index, 1);
  assert.equal(gp.pressed('x'), false);
  p2.buttons[2] = btn(0); gp.poll();
  p2.buttons[2] = btn(1); gp.poll();
  assert.equal(gp.pressed('x'), true);
});

test('standard mapping: edges, Start, sticks, triggers, d-pad', () => {
  const env = makeEnv();
  const pad = makePad();
  const gp = awake(env, pad);
  pad.buttons[0] = btn(1); pad.buttons[9] = btn(1); pad.buttons[7] = btn(0.9);
  pad.axes = [0.9, 0, 0, -1];
  gp.poll();
  assert.equal(gp.pressed('a'), true);
  assert.equal(gp.pressed('start'), true);
  assert.equal(gp.held('rt'), true);
  assert.ok(gp.state.leftStick.x > 0.8);
  assert.ok(gp.state.rightStick.y < -0.99);
  gp.poll();
  assert.equal(gp.pressed('a'), false, 'a held button is one press');
  assert.equal(gp.held('a'), true);
  pad.buttons[0] = btn(0);
  gp.poll();
  assert.equal(gp.released('a'), true);
  pad.buttons[12] = btn(1);
  gp.poll();
  assert.equal(gp.state.move.y, -1, 'd-pad up overrides stick for move');
  assert.equal(gp.state.move.x, 0);
  assert.deepEqual(gp.state.digital, { x: 0, y: -1 });
});

test('generic mapping fallback matches Crossfire: Back 6, Start 7, triggers on axes 2/5, hat on 6/7', () => {
  const env = makeEnv();
  const pad = { index: 1, id: 'Generic USB Joystick (Vendor: 0079)', mapping: '', connected: true,
    axes: [0, 0, -1, 0.95, 0, -1, -1, 0], buttons: Array.from({ length: 12 }, () => btn(0)) };
  const gp = awake(env, pad);
  assert.equal(gp.state.standard, false);
  assert.equal(gp.state.buttons.left, true, 'hat axis 6 = -1 reads as d-pad left');
  assert.ok(gp.state.rightStick.x > 0.9);
  assert.equal(gp.held('lt'), false, 'trigger at rest (-1) is released');
  pad.buttons[7] = btn(1); pad.buttons[6] = btn(1); pad.axes[5] = 0.6; pad.axes[2] = 0.2;
  gp.poll();
  assert.equal(gp.pressed('start'), true, 'button 7 is Start on a generic pad');
  assert.equal(gp.pressed('select'), true, 'button 6 is Back / View');
  assert.equal(gp.held('rt'), true, 'RT axis past 0.3');
  assert.equal(gp.held('lt'), false, 'LT axis below 0.3');
  assert.equal(G.readPad({ mapping: '', buttons: [], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, -1] }).buttons.up, true, 'single-axis hat on axis 9: -1 = up');
  assert.equal(G.readPad({ mapping: '', buttons: [], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3.28] }).buttons.up, false, 'hat centred');
  const b16 = Array.from({ length: 16 }, () => btn(0)); b16[15] = btn(1);
  assert.equal(G.readPad({ mapping: '', buttons: b16, axes: [0, 0] }).buttons.right, true, 'buttons 12-15 when the pad has them');
});

test('digital stick uses the 0.35 axial deadzone; menus read it', () => {
  assert.deepEqual(G.readPad(makePad({ axes: [0.3, 0, 0, 0] })).digital, { x: 0, y: 0 });
  assert.equal(G.readPad(makePad({ axes: [0.4, 0, 0, 0] })).digital.x, 0.4);
  assert.equal(G.padDirection({ digital: { x: 0.5, y: 0.5 } }), 'down', 'vertical first, like Crossfire');
});

test('60 Hz timer samples latch taps that start and end between frames', () => {
  const env = makeEnv();
  const pad = makePad();
  const gp = awake(env, pad);
  pad.buttons[0] = btn(1); gp.sample();       // timer tick mid-frame
  pad.buttons[0] = btn(0); gp.sample();       // released before the next frame
  gp.poll();
  assert.equal(gp.pressed('a'), true, 'the tap is still seen');
  assert.equal(gp.held('a'), true, 'and counts as held for that frame');
  assert.equal(gp.released('a'), true);
  gp.poll();
  assert.equal(gp.pressed('a'), false);
  let ticks = 0;
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { ticks = ms; return { unref() {} }; };
  try { G.createGamepadInput({ nav: env.nav, win: env.win }); } finally { globalThis.setInterval = realSet; }
  assert.equal(ticks, 16, 'timer runs at 60 Hz');
});

test('hot-plug: connect + disconnect mid-session, Crossfire toast text, held input released', () => {
  const env = makeEnv();
  const events = [];
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win, timer: false,
    onConnect: (i) => events.push(['on', i.family, i.text]), onDisconnect: (i) => events.push(['off', i.index, i.text]) });
  gp.poll();
  assert.equal(gp.connected, false);
  const pad = makePad({ id: 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)' });
  env.pads.push(pad);
  env.win.emit('gamepadconnected', { gamepad: pad });
  pad.axes = [0, -1, 0, 0];
  gp.poll();
  assert.deepEqual(events[0], ['on', 'playstation', '🎮 Controller connected — DualSense']);
  assert.ok(gp.state.move.y < -0.9, 'the stick wakes the pad and moves at once');
  env.pads.length = 0;                       // unplugged without an event
  gp.poll();
  assert.equal(gp.connected, false);
  assert.equal(gp.awake, false);
  assert.equal(gp.state.move.mag, 0);
  assert.deepEqual(events[1], ['off', 0, '🎮 Controller disconnected']);
  env.pads.push({ ...makePad({ id: 'Generic USB Joystick' }), mapping: '' });
  gp.poll();
  assert.equal(events[2][2], '🎮 Controller connected — Generic USB Joystick (generic mapping)');
  env.win.emit('gamepaddisconnected', { gamepad: env.pads[0] });
  assert.equal(events.filter((e) => e[0] === 'off').length, 2);
  gp.dispose();
  assert.equal(env.win.count('gamepadconnected'), 0);
});

test('rumble: feature-detected, and Crossfire events hit / kill / boss', () => {
  const env = makeEnv();
  const calls = [];
  const pad = makePad({ vibrationActuator: { type: 'dual-rumble', playEffect: (t, p) => { calls.push([t, p.strongMagnitude, p.weakMagnitude, p.duration]); return Promise.resolve('complete'); } } });
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win, timer: false });
  gp.poll();
  assert.equal(gp.rumble(0.8, 0.4, 200), false, 'a sleeping pad never rumbles');
  pad.buttons[16] = btn(1); gp.poll();
  assert.equal(gp.rumble(0.8, 0.4, 200), true);
  assert.deepEqual(calls[0], ['dual-rumble', 0.8, 0.4, 200]);
  assert.equal(gp.feel('hit'), true);
  assert.equal(gp.feel('kill'), true);
  assert.equal(gp.feel('boss'), true);
  assert.equal(gp.feel('nope'), false);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(calls[1][1], 0.6) && calls[1][2] === 0.75 && calls[1][3] === 170, 'hit 0.75 / 170 ms');
  assert.ok(near(calls[2][1], 0.36) && calls[2][2] === 0.45 && calls[2][3] === 110, 'kill 0.45 / 110 ms');
  assert.ok(near(calls[3][1], 0.8) && calls[3][2] === 1 && calls[3][3] === 600, 'boss 1.0 / 600 ms');
  delete pad.vibrationActuator;
  pad.hapticActuators = [{ pulse: (v, d) => { calls.push(['pulse', v, d]); return Promise.resolve(true); } }];
  assert.equal(gp.rumble(0.5, 0.2, 90), true);
  assert.deepEqual(calls[4], ['pulse', 0.5, 90]);
  delete pad.hapticActuators;
  assert.equal(gp.rumble(1, 1, 100), false, 'no actuator: silently skipped');
  gp.rumbleEnabled = false;
  assert.equal(gp.rumble(1, 1, 100), false);
  const throws = makePad({ vibrationActuator: { playEffect: () => { throw new Error('nope'); } } });
  env.pads[0] = throws;
  gp.rumbleEnabled = true;
  assert.equal(gp.rumble(1, 1, 100), false, 'actuator errors never reach the game');
});

test('no Gamepad API at all is a no-op', () => {
  const gp = G.createGamepadInput({ nav: {}, win: null, timer: false });
  gp.poll();
  assert.equal(gp.connected, false);
  assert.equal(gp.pressed('a'), false);
  assert.equal(gp.rumble(1, 1, 50), false);
  assert.equal(gp.feel('hit'), false);
});

test('menu navigator: .padfocus highlight on open, d-pad / stick move, A clicks, B backs out', () => {
  const env = makeEnv();
  const pad = makePad();
  const gp = awake(env, pad);
  const clicks = [];
  const mk = (name, top, left = 0) => { const cls = new Set(); return { name, tagName: 'BUTTON', cls, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    getBoundingClientRect: () => ({ top, left, width: 100, height: 30 }), focus() { doc.activeElement = this; }, click() { clicks.push(name); } }; };
  const doc = { activeElement: null };
  const items = [mk('start', 0), mk('options', 50), mk('quit', 100)];
  const root = { querySelectorAll: () => items };
  let backs = 0;
  const nav = G.createMenuNavigator({ doc, getRoot: () => root, isVisible: () => true, onBack: () => backs++ });
  let t = 0;
  const frame = () => { gp.poll(); nav.update(gp, (t += 16)); };
  frame();
  assert.equal(doc.activeElement.name, 'start', 'highlight shows as soon as the menu is up');
  assert.ok(items[0].cls.has('padfocus'));
  pad.buttons[13] = btn(1); frame();
  assert.equal(doc.activeElement.name, 'options');
  assert.ok(!items[0].cls.has('padfocus') && items[1].cls.has('padfocus'));
  pad.buttons[13] = btn(0); frame();
  pad.axes = [0, 0.4, 0, 0]; frame();             // left stick past 0.35
  assert.equal(doc.activeElement.name, 'quit');
  pad.axes = [0, 0, 0, 0]; frame();
  pad.buttons[13] = btn(1); frame();             // wraps
  assert.equal(doc.activeElement.name, 'start');
  for (let i = 0; i < 25; i++) frame();          // held: 380 ms, then repeat
  assert.equal(doc.activeElement.name, 'options');
  for (let i = 0; i < 8; i++) frame();           // +128 ms: one 120 ms repeat
  assert.equal(doc.activeElement.name, 'quit');
  pad.buttons[13] = btn(0); frame();
  pad.buttons[0] = btn(1); frame();
  assert.deepEqual(clicks, ['quit']);
  pad.buttons[0] = btn(0); pad.buttons[1] = btn(1); frame();
  assert.equal(backs, 1);
});

test('pickInDirection prefers aligned neighbours', () => {
  const from = { top: 0, left: 0, width: 10, height: 10 };
  const rects = [{ top: 0, left: 100, width: 10, height: 10 }, { top: 40, left: 5, width: 10, height: 10 }, { top: -50, left: 0, width: 10, height: 10 }];
  assert.equal(G.pickInDirection(from, rects, 'right'), 0);
  assert.equal(G.pickInDirection(from, rects, 'down'), 1);
  assert.equal(G.pickInDirection(from, rects, 'up'), 2);
  assert.equal(G.pickInDirection(from, rects, 'left'), -1);
});

test('controller names match Crossfire', () => {
  assert.equal(G.padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(G.padLabel('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox controller');
  assert.equal(G.padLabel('054c-09cc-Wireless Controller'), 'PlayStation controller');
  assert.equal(G.padLabel('DualSense Wireless Controller (Vendor: 054c Product: 0ce6)'), 'DualSense');
  assert.equal(G.padLabel('Pro Controller (Vendor: 057e)'), 'Switch Pro controller');
  assert.equal(G.padLabel('Logitech Dual Action (Vendor: 046d)'), 'Logitech Dual Action');
});

test('splash: pad buttons pressed while the Acidlemon splash owns input never reach the game', () => {
  const env = makeEnv();
  const pad = makePad();
  const gp = awake(env, pad);
  let blocking = true;
  globalThis.AcidSplash = { blocking: () => blocking };
  try {
    pad.buttons[0] = btn(1); gp.poll();
    assert.equal(gp.pressed('a'), false);
    blocking = false;                         // splash gone, A still held from the skip
    gp.poll();
    assert.equal(gp.held('a'), false, 'the skip press stays blocked until released');
    pad.buttons[0] = btn(0); gp.poll();
    pad.buttons[0] = btn(1); gp.poll();
    assert.equal(gp.pressed('a'), true);
  } finally { delete globalThis.AcidSplash; }
});

/* ---- Cyberhell glue against a fake engine (Crossfire layout) ---- */
function fakeEngine() {
  const log = [];
  return {
    log, keys: {}, moveAxis: null, isFiring: false, isRunning: true, yaw: 0, pitch: 0,
    player: { currentWeapon: 'pistol' },
    applyLook(dx, dy, sens) { this.yaw -= dx * sens; this.pitch -= dy * sens; },
    fireWeapon() { log.push('fire'); }, interact() { log.push('use'); },
    toggleAutomap() { log.push('map'); }, isAutomapOpen() { return false; },
    ownedWeapons() { return ['pistol', 'shotgun', 'rifle']; },
    switchWeapon(w) { this.player.currentWeapon = w; log.push('weapon:' + w); },
    pauseRun(t, sub) { this.isRunning = false; log.push('pause:' + (sub || '')); }
  };
}
function glueEnv(extra = {}) {
  const env = makeEnv();
  const pad = makePad();
  const toasts = [];
  const eng = fakeEngine();
  const ctl = CyberGamepad.attach(eng, { AcidGamepad: G, nav: env.nav, win: env.win, doc: null, timer: false, toast: (t) => toasts.push(t), ...extra });
  env.pads.push(pad);
  pad.buttons[16] = btn(1); ctl.update(0.016);     // wake (Home) and let go
  pad.buttons[16] = btn(0); ctl.update(0.016);
  return { env, pad, toasts, eng, ctl };
}

test('cyber glue: stick moves (analog + key mirror), right stick looks, X holds fire', () => {
  const { pad, eng, ctl, toasts } = glueEnv();
  assert.equal(toasts[0], '🎮 Controller connected — Xbox controller');
  pad.axes = [0, -1, 1, 0];
  pad.buttons[2] = btn(1);
  ctl.update(0.016);
  assert.ok(eng.moveAxis.z < -0.9);
  assert.equal(eng.keys.KeyW, true);
  assert.ok(eng.yaw < 0, 'right stick right turns right');
  assert.equal(eng.isFiring, true);
  assert.deepEqual(eng.log, ['fire']);
  pad.axes = [0, 0, 0, 0]; pad.buttons[2] = btn(0);
  ctl.update(0.016);
  assert.equal(eng.moveAxis, null);
  assert.equal(eng.keys.KeyW, false);
  assert.equal(eng.isFiring, false);
  pad.buttons[5] = btn(1); ctl.update(0.016);
  assert.equal(eng.isFiring, true, 'RB ("bomb") fires too: the engine has no grenade');
});

test('cyber glue: A jumps, Y/LB use, RT/LT cycle weapons, View map, Start pauses', () => {
  const { pad, eng, ctl } = glueEnv();
  pad.buttons[0] = btn(1); ctl.update(0.016);
  assert.equal(eng.keys.Space, true);
  pad.buttons[0] = btn(0); pad.buttons[3] = btn(1); pad.buttons[7] = btn(1); pad.buttons[8] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.keys.Space, false);
  assert.deepEqual(eng.log, ['use', 'weapon:shotgun', 'map']);
  assert.equal(eng.isFiring, false, 'RT no longer fires');
  pad.buttons[3] = btn(0); pad.buttons[7] = btn(0); pad.buttons[8] = btn(0); pad.buttons[6] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.player.currentWeapon, 'pistol', 'LT = previous weapon');
  pad.buttons[6] = btn(0); pad.buttons[4] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.log.at(-1), 'use', 'LB (item) = use');
  pad.buttons[4] = btn(0); pad.buttons[9] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.isRunning, false);
  assert.equal(eng.log.at(-1), 'pause:');
});

test('cyber glue: the waking press neither jumps nor fires', () => {
  const env = makeEnv();
  const pad = makePad();
  const eng = fakeEngine();
  const ctl = CyberGamepad.attach(eng, { AcidGamepad: G, nav: env.nav, win: env.win, doc: null, timer: false, toast() {} });
  env.pads.push(pad);
  pad.buttons[0] = btn(1); pad.buttons[2] = btn(1);
  ctl.update(0.016); ctl.update(0.016);
  assert.equal(eng.keys.Space, undefined);
  assert.equal(eng.isFiring, false);
  pad.buttons[0] = btn(0); pad.buttons[2] = btn(0); ctl.update(0.016);
  pad.buttons[0] = btn(1); ctl.update(0.016);
  assert.equal(eng.keys.Space, true);
});

test('cyber glue: B goes back (onBack) when the map is shut', () => {
  let backs = 0;
  const { pad, ctl } = glueEnv({ onBack: () => backs++ });
  pad.buttons[1] = btn(1); ctl.update(0.016);
  assert.equal(backs, 1);
});

test('cyber glue: unplugging mid-run releases held input and pauses', () => {
  const { env, pad, eng, ctl, toasts } = glueEnv();
  pad.axes = [1, 0, 0, 0]; pad.buttons[2] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.keys.KeyD, true);
  env.pads.length = 0;
  ctl.update(0.016);
  assert.equal(eng.keys.KeyD, false);
  assert.equal(eng.moveAxis, null);
  assert.equal(eng.isFiring, false);
  assert.equal(eng.isRunning, false);
  assert.match(eng.log.at(-1), /CONTROLLER DISCONNECTED/);
  assert.equal(toasts.at(-1), '🎮 Controller disconnected');
});

test('cyber glue: keyboard keys the pad never pressed are left alone', () => {
  const { pad, eng, ctl } = glueEnv();
  eng.keys.KeyW = true;           // player holding W on the keyboard
  ctl.update(0.016);
  pad.axes = [0, 0, 0, 0];
  ctl.update(0.016);
  assert.equal(eng.keys.KeyW, true);
});
