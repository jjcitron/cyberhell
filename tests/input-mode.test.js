/**
 * input-mode.test.js — unit test for js/cyber-input-mode.js detectTouch().
 *   node --test tests/input-mode.test.js
 * The UAs and media-query answers are what the real devices report.
 */
const test = require('node:test');
const assert = require('node:assert');
const { detectTouch, readForce } = require('../js/cyber-input-mode.js');

const UA = {
  tclTablet: 'Mozilla/5.0 (Linux; Android 13; 9137W) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  tabletDesktopSite: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  pixelPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

test('Android tablet with finger-only screen (pointer: coarse) is touch', () => {
  assert.strictEqual(detectTouch({ coarse: true, anyCoarse: true, maxTouchPoints: 10, ua: UA.tclTablet }), true);
});

test('Android tablet with stylus digitizer (pointer: fine, no "Mobile" in UA) is touch', () => {
  assert.strictEqual(detectTouch({ coarse: false, anyCoarse: true, maxTouchPoints: 10, ua: UA.tclTablet }), true);
});

test('Android tablet whose OEM exposes a virtual mouse (any-pointer coarse missing) still touch via maxTouchPoints', () => {
  assert.strictEqual(detectTouch({ coarse: false, anyCoarse: false, maxTouchPoints: 10, ua: UA.tclTablet }), true);
});

test('Android tablet in Chrome "desktop site" mode (X11 Linux UA) with stylus is touch', () => {
  assert.strictEqual(detectTouch({ coarse: false, anyCoarse: true, maxTouchPoints: 10, ua: UA.tabletDesktopSite }), true);
});

test('Android phone is touch', () => {
  assert.strictEqual(detectTouch({ coarse: true, anyCoarse: true, maxTouchPoints: 5, ua: UA.pixelPhone }), true);
});

test('desktops without touch stay desktop', () => {
  for (const ua of [UA.windows, UA.mac, UA.tabletDesktopSite, UA.chromebook]) {
    assert.strictEqual(detectTouch({ coarse: false, anyCoarse: false, maxTouchPoints: 0, ua }), false, ua);
  }
});

test('Windows / ChromeOS touchscreen laptops keep pointer-lock mouse look', () => {
  assert.strictEqual(detectTouch({ coarse: false, anyCoarse: true, maxTouchPoints: 10, ua: UA.windows }), false);
  assert.strictEqual(detectTouch({ coarse: false, anyCoarse: true, maxTouchPoints: 10, ua: UA.chromebook }), false);
});

test('force overrides everything', () => {
  assert.strictEqual(detectTouch({ force: true, coarse: false, ua: UA.windows }), true);
  assert.strictEqual(detectTouch({ force: false, coarse: true, ua: UA.tclTablet }), false);
});

test('readForce parses ?touch= and remembers it', () => {
  const store = new Map();
  const s = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  assert.strictEqual(readForce('', s), null);
  assert.strictEqual(readForce('?touch=1', s), true);
  assert.strictEqual(readForce('', s), true);       // remembered
  assert.strictEqual(readForce('?a=b&touch=0', s), false);
  assert.strictEqual(readForce('?touch=auto', s), null);
  assert.strictEqual(readForce('?touchy=1', s), null);
});
