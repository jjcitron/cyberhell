/**
 * Gyro assist math for Cyberhell touch look.
 * Yaw (left/right) keeps the original 0.6 assist. Pitch (up/down) is
 * scaled by a default 0.48 of that, and a small deadzone kills jitter.
 * Pure functions, also loaded as a Node module for unit tests.
 */
(function (root) {
  const YAW_ASSIST = 0.6;
  const PITCH_DEAD_DEG = 0.3;
  const DEFAULT_PITCH_SCALE = 0.48;
  const PITCH_MIN = -Math.PI / 2.3;
  const PITCH_MAX = Math.PI / 2.3;

  function deadzone(delta, dead) {
    if (!(dead > 0)) return delta;
    if (delta == null || Math.abs(delta) < dead) return 0;
    return delta - Math.sign(delta) * dead;
  }

  function wrapAlphaDelta(da) {
    if (da > 180) return da - 360;
    if (da < -180) return da + 360;
    return da;
  }

  function clampPitch(pitch) {
    return Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
  }

  /**
   * @param {number} da yaw degrees (alpha delta, already wrap-normalized)
   * @param {number} db pitch degrees (beta delta)
   * @param {number} [pitchScale] fraction of yaw assist, default 0.48
   * @returns {{ yawDelta: number, pitchDelta: number }} radians
   */
  function lookDeltas(da, db, pitchScale) {
    const scale = (pitchScale == null || Number.isNaN(Number(pitchScale)))
      ? DEFAULT_PITCH_SCALE
      : Math.max(0, Number(pitchScale));
    const RAD = Math.PI / 180;
    const pdb = deadzone(db, PITCH_DEAD_DEG);
    return {
      yawDelta: da * RAD * YAW_ASSIST,
      pitchDelta: pdb * RAD * YAW_ASSIST * scale
    };
  }

  const api = {
    YAW_ASSIST, PITCH_DEAD_DEG, DEFAULT_PITCH_SCALE, PITCH_MIN, PITCH_MAX,
    deadzone, wrapAlphaDelta, clampPitch, lookDeltas
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CyberTouchGyro = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
