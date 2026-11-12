/**
 * touch-gyro.test.mjs — pitch is noticeably less sensitive than yaw,
 * and a small deadzone kills jitter.
 *   node --test tests/touch-gyro.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import gyro from '../js/cyber-touch-gyro.js';
const {
  YAW_ASSIST, PITCH_DEAD_DEG, DEFAULT_PITCH_SCALE,
  deadzone, wrapAlphaDelta, clampPitch, lookDeltas
} = gyro;

test('defaults: pitch scale is 0.45–0.5 of yaw, assist and deadzone are set', () => {
  assert.equal(YAW_ASSIST, 0.6);
  assert.ok(DEFAULT_PITCH_SCALE >= 0.45 && DEFAULT_PITCH_SCALE <= 0.5, `scale=${DEFAULT_PITCH_SCALE}`);
  assert.ok(PITCH_DEAD_DEG >= 0.15 && PITCH_DEAD_DEG <= 0.5, `dead=${PITCH_DEAD_DEG}`);
});

test('equal degree ticks: pitch delta is ~0.48 of yaw after the deadzone', () => {
  const d = lookDeltas(10, 10);
  assert.ok(d.yawDelta > 0);
  assert.ok(d.pitchDelta > 0);
  const ratio = d.pitchDelta / d.yawDelta;
  // (10 - 0.3) / 10 * 0.48 = 0.4656
  assert.ok(ratio >= 0.40 && ratio <= 0.50, `ratio=${ratio}`);
  assert.ok(Math.abs(ratio - ((10 - PITCH_DEAD_DEG) / 10) * DEFAULT_PITCH_SCALE) < 1e-12);
});

test('pitch deadzone zeroes jitter smaller than the threshold, yaw is unfiltered', () => {
  const jitter = PITCH_DEAD_DEG * 0.5;
  const d = lookDeltas(2, jitter);
  assert.ok(d.yawDelta > 0, 'yaw still applies');
  assert.equal(d.pitchDelta, 0, 'sub-deadzone pitch is zero');
  const justOver = lookDeltas(0, PITCH_DEAD_DEG + 0.05);
  assert.ok(justOver.pitchDelta > 0);
  const exact = lookDeltas(0, PITCH_DEAD_DEG);
  assert.equal(exact.pitchDelta, 0); // '<' not '<='
});

test('deadzone subtracts the threshold so motion is continuous past it', () => {
  assert.equal(deadzone(0, 0.3), 0);
  assert.equal(deadzone(0.29, 0.3), 0);
  assert.equal(deadzone(-0.29, 0.3), 0);
  assert.ok(Math.abs(deadzone(1.0, 0.3) - 0.7) < 1e-12);
  assert.ok(Math.abs(deadzone(-1.0, 0.3) - (-0.7)) < 1e-12);
});

test('wrapAlphaDelta unwraps the 360° seam', () => {
  assert.equal(wrapAlphaDelta(10), 10);
  assert.equal(wrapAlphaDelta(-10), -10);
  assert.equal(wrapAlphaDelta(350), 350 - 360);
  assert.equal(wrapAlphaDelta(-350), -350 + 360);
});

test('clampPitch stays inside the look limits', () => {
  assert.equal(clampPitch(0), 0);
  assert.equal(clampPitch(10), Math.PI / 2.3);
  assert.equal(clampPitch(-10), -Math.PI / 2.3);
});

test('gyroPitch setting of 30% scales pitch to 0.30 of (deadzoned) yaw assist', () => {
  const d = lookDeltas(8, 8, 0.30);
  const expected = (8 - PITCH_DEAD_DEG) * (Math.PI / 180) * YAW_ASSIST * 0.30;
  assert.ok(Math.abs(d.pitchDelta - expected) < 1e-12);
  assert.ok(Math.abs(d.pitchDelta / lookDeltas(8, 8, 1).pitchDelta - 0.30) < 1e-12);
});

test('missing or NaN pitch scale falls back to the default 0.48', () => {
  const a = lookDeltas(5, 5);
  const b = lookDeltas(5, 5, undefined);
  const c = lookDeltas(5, 5, NaN);
  assert.equal(a.pitchDelta, b.pitchDelta);
  assert.equal(a.pitchDelta, c.pitchDelta);
});
