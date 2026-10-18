// Gamepad support: core mapping (js/acid-gamepad.js) + Cyberhell glue
// (js/cyber-gamepad.js), driven by a mocked navigator.getGamepads.
// Run: node --test tests/gamepad.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const load = (f) => vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), { filename: f });
load('acid-gamepad.js');
load('cyber-gamepad.js');
const G = globalThis.AcidGamepad;
import test from 'node:test';
import assert from 'node:assert/strict';

// Mocked navigator.getGamepads / window events: no browser needed.
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

test('radial deadzone zeroes drift and rescales to full tilt', () => {
  assert.deepEqual(G.applyDeadzone(0.1, 0.1, 0.2), { x: 0, y: 0, mag: 0 });
  const full = G.applyDeadzone(1, 0, 0.2);
  assert.equal(full.x, 1); assert.equal(full.mag, 1);
  const half = G.applyDeadzone(0.6, 0, 0.2);
  assert.ok(Math.abs(half.x - 0.5) < 1e-9);
});

test('standard mapping: A confirm edge, Start, sticks, triggers, d-pad', () => {
  const env = makeEnv();
  const pad = makePad();
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win });
  gp.poll();
  assert.equal(gp.connected, true);
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
});

test('non-standard pad falls back to a sensible layout (hat d-pad, RS on 3/4)', () => {
  const env = makeEnv();
  const pad = { index: 1, id: 'Generic USB Joystick (Vendor: 0079)', mapping: '', connected: true,
    axes: [0, 0, -1, 0.95, 0, -1, -1, 0], buttons: Array.from({ length: 12 }, () => btn(0)) };
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win });
  gp.poll();
  assert.equal(gp.state.standard, false);
  assert.equal(gp.state.buttons.left, true, 'hat axis 6 = -1 reads as d-pad left');
  assert.ok(gp.state.rightStick.x > 0.9);
  assert.equal(gp.held('lt'), false, 'trigger at rest (-1) is released');
});

test('hot-plug: connect + disconnect mid-session, held input released', () => {
  const env = makeEnv();
  const events = [];
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win,
    onConnect: (i) => events.push(['on', i.family, i.label]), onDisconnect: (i) => events.push(['off', i.index]) });
  gp.poll();
  assert.equal(gp.connected, false);
  const pad = makePad({ id: 'DualSense Wireless Controller (Vendor: 054c Product: 0ce6)' });
  env.pads.push(pad);
  env.win.emit('gamepadconnected', { gamepad: pad });
  pad.axes = [0, -1, 0, 0];
  pad.buttons[7] = btn(1);
  gp.poll();
  assert.deepEqual(events[0], ['on', 'playstation', 'PlayStation controller']);
  assert.ok(gp.state.move.y < -0.9);
  env.pads.length = 0;                       // unplugged without an event
  gp.poll();
  assert.equal(gp.connected, false);
  assert.equal(gp.state.move.mag, 0);
  assert.equal(gp.held('rt'), false);
  assert.deepEqual(events[1], ['off', 0]);
  env.pads.push(pad);                       // replugged, then event-only removal
  gp.poll();
  env.win.emit('gamepaddisconnected', { gamepad: pad });
  assert.equal(events.filter((e) => e[0] === 'off').length, 2);
  gp.dispose();
  assert.equal(env.win.count('gamepadconnected'), 0);
});

test('rumble is feature-detected: vibrationActuator, hapticActuators, none', () => {
  const env = makeEnv();
  const calls = [];
  const pad = makePad({ vibrationActuator: { type: 'dual-rumble', playEffect: (t, p) => { calls.push([t, p.strongMagnitude, p.duration]); return Promise.resolve('complete'); } } });
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win });
  gp.poll();
  assert.equal(gp.rumble(0.8, 0.4, 200), true);
  assert.deepEqual(calls[0], ['dual-rumble', 0.8, 200]);
  delete pad.vibrationActuator;
  pad.hapticActuators = [{ pulse: (v, d) => { calls.push(['pulse', v, d]); return Promise.resolve(true); } }];
  assert.equal(gp.rumble(0.5, 0.2, 90), true);
  assert.deepEqual(calls[1], ['pulse', 0.5, 90]);
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
  const gp = G.createGamepadInput({ nav: {}, win: null });
  gp.poll();
  assert.equal(gp.connected, false);
  assert.equal(gp.pressed('a'), false);
  assert.equal(gp.rumble(1, 1, 50), false);
});

test('menu navigator: d-pad moves focus spatially, A clicks, B backs out', () => {
  const env = makeEnv();
  const pad = makePad();
  env.pads.push(pad);
  const gp = G.createGamepadInput({ nav: env.nav, win: env.win });
  const clicks = [];
  const mk = (name, top, left = 0) => ({ name, tagName: 'BUTTON', classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top, left, width: 100, height: 30 }), focus() { doc.activeElement = this; }, click() { clicks.push(name); } });
  const doc = { activeElement: null };
  const items = [mk('start', 0), mk('options', 50), mk('quit', 100)];
  const root = { querySelectorAll: () => items };
  let backs = 0;
  const nav = G.createMenuNavigator({ doc, getRoot: () => root, isVisible: () => true, onBack: () => backs++ });
  let t = 0;
  const frame = () => { gp.poll(); nav.update(gp, (t += 16)); };
  pad.buttons[13] = btn(1); frame();              // first press focuses the first item
  assert.equal(doc.activeElement.name, 'start');
  pad.buttons[13] = btn(0); frame();
  pad.buttons[13] = btn(1); frame();
  assert.equal(doc.activeElement.name, 'options');
  pad.buttons[13] = btn(0); frame();
  pad.axes = [0, 0.9, 0, 0]; frame();             // left stick works too
  assert.equal(doc.activeElement.name, 'quit');
  pad.axes = [0, 0, 0, 0]; frame();
  pad.buttons[13] = btn(1); frame();             // wraps
  assert.equal(doc.activeElement.name, 'start');
  pad.buttons[13] = btn(0); frame();
  pad.buttons[0] = btn(1); frame();
  assert.deepEqual(clicks, ['start']);
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

test('controller family detection for toast labels', () => {
  assert.equal(G.padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
  assert.equal(G.padFamily('054c-09cc-Wireless Controller'), 'playstation');
  assert.equal(G.padFamily('Logitech Dual Action'), 'generic');
  assert.equal(G.padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
});

/* ---- Cyberhell glue against a fake engine ---- */
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
function glueEnv() {
  const env = makeEnv();
  const pad = makePad();
  const toasts = [];
  const eng = fakeEngine();
  const ctl = CyberGamepad.attach(eng, { AcidGamepad: G, nav: env.nav, win: env.win, doc: null, toast: (t) => toasts.push(t) });
  return { env, pad, toasts, eng, ctl };
}

test('cyberhell: stick moves (analog + key mirror), right stick looks, RT holds fire', () => {
  const { env, pad, eng, ctl, toasts } = glueEnv();
  env.pads.push(pad);
  pad.axes = [0, -1, 1, 0];
  pad.buttons[7] = btn(1);
  ctl.update(0.016);
  assert.equal(toasts[0], 'Xbox controller connected');
  assert.ok(eng.moveAxis.z < -0.9);
  assert.equal(eng.keys.KeyW, true);
  assert.ok(eng.yaw < 0, 'right stick right turns right');
  assert.equal(eng.isFiring, true);
  assert.deepEqual(eng.log, ['fire']);
  pad.axes = [0, 0, 0, 0]; pad.buttons[7] = btn(0);
  ctl.update(0.016);
  assert.equal(eng.moveAxis, null);
  assert.equal(eng.keys.KeyW, false);
  assert.equal(eng.isFiring, false);
});

test('cyberhell: A jumps, X uses, Y/LB cycle weapons, View opens map, Start pauses', () => {
  const { env, pad, eng, ctl } = glueEnv();
  env.pads.push(pad);
  ctl.update(0.016);
  pad.buttons[0] = btn(1); ctl.update(0.016);
  assert.equal(eng.keys.Space, true);
  pad.buttons[0] = btn(0); pad.buttons[2] = btn(1); pad.buttons[3] = btn(1); pad.buttons[8] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.keys.Space, false);
  assert.deepEqual(eng.log, ['use', 'weapon:shotgun', 'map']);
  pad.buttons[2] = btn(0); pad.buttons[3] = btn(0); pad.buttons[8] = btn(0); pad.buttons[4] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.player.currentWeapon, 'pistol');
  pad.buttons[4] = btn(0); pad.buttons[9] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.isRunning, false);
  assert.equal(eng.log.at(-1), 'pause:');
});

test('cyberhell: unplugging mid-run releases held input and pauses', () => {
  const { env, pad, eng, ctl, toasts } = glueEnv();
  env.pads.push(pad);
  pad.axes = [1, 0, 0, 0]; pad.buttons[7] = btn(1);
  ctl.update(0.016);
  assert.equal(eng.keys.KeyD, true);
  env.pads.length = 0;
  ctl.update(0.016);
  assert.equal(eng.keys.KeyD, false);
  assert.equal(eng.moveAxis, null);
  assert.equal(eng.isFiring, false);
  assert.equal(eng.isRunning, false);
  assert.match(eng.log.at(-1), /CONTROLLER DISCONNECTED/);
  assert.equal(toasts.at(-1), 'Xbox controller disconnected');
});

test('cyberhell: keyboard keys the pad never pressed are left alone', () => {
  const { env, pad, eng, ctl } = glueEnv();
  env.pads.push(pad);
  eng.keys.KeyW = true;           // player holding W on the keyboard
  ctl.update(0.016);
  pad.axes = [0, 0, 0, 0];
  ctl.update(0.016);
  assert.equal(eng.keys.KeyW, true);
});
