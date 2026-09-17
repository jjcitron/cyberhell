/* ==========================================================================
   CyberQuality — Low / Medium / High presets (job 20260908-1150).

   One place that answers "how much is this machine allowed to be asked for".
   Everything else (renderer setup, gore density, env dressing, AI budgets,
   enemy LOD distances) reads its number from here instead of hard-coding a
   desktop assumption.

   Two rules the producer set, both load-bearing:

     1. Low is the DEFAULT on weak device signals — coarse pointer, <= 4
        cores, low deviceMemory — not an opt-in buried in a menu.
     2. The tier NEVER changes itself mid-run from a frame-rate probe. A
        quality flip during a fight is worse than the frames it buys, and a
        probe that samples a shader-compile stall will flip on a machine that
        did not need it. Resolution happens once, at boot, from device
        signals and the player's own override. That is the whole policy.

   Resolution order: ?quality= in the URL (QA and support) > the player's
   saved Options choice > auto from device signals.

   Classic script, no module system, loads before three.js like the rest of
   js/ — so it must not touch THREE at load time.
   ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'cyberhell.quality';

  /* Every knob a tier owns. Numbers chosen so High is exactly what the game
     shipped as before this job, Medium trims the costs that scale with body
     count and fill rate, and Low is an honest integrated-GPU preset rather
     than High with the resolution turned down. */
  var TIERS = {
    high: {
      label: 'HIGH',
      pixelRatioCap: 2,
      antialias: true,
      shadows: true,
      shadowMapSize: 2048,
      anisotropy: 4,
      dynLights: 5,             // neon accents kept alive per level
      projLights: 8,            // pooled projectile lights, always in the
      flashLights: 2,           // light set at intensity 0 (see _ensureDynLightPools)
      envPropBudget: 300,       // instanced dressing props
      envDustScale: 1,          // atmosphere particle count multiplier
      goreSprayScale: 1,        // droplets per hit
      goreDecalCap: 400,        // per fluid
      goreChunks: 8,            // debris meshes per death
      goreMist: true,
      enemyLodNear: 22,         // full rig inside this
      enemyLodFar: 95,          // culled beyond this
      aiAnimRadius: 22,
      aiAnimSlowRate: 3,
      aiMaxNear: 90,
      aiScanStripe: 4,
      aiFieldBudget: 5000,
      aiFieldNewBudget: 160,
      loadSliceMs: 10           // build work allowed per frame while loading
    },
    medium: {
      label: 'MEDIUM',
      pixelRatioCap: 1.25,
      antialias: true,
      shadows: true,
      shadowMapSize: 1024,
      anisotropy: 2,
      dynLights: 4,             // neon accents kept alive per level
      projLights: 6,            // pooled projectile lights, always in the
      flashLights: 2,           // light set at intensity 0 (see _ensureDynLightPools)
      envPropBudget: 160,
      envDustScale: 0.5,
      goreSprayScale: 0.65,
      goreDecalCap: 250,
      goreChunks: 4,
      goreMist: true,
      enemyLodNear: 18,
      enemyLodFar: 72,
      aiAnimRadius: 16,
      aiAnimSlowRate: 4,
      aiMaxNear: 60,
      aiScanStripe: 5,
      aiFieldBudget: 4000,
      aiFieldNewBudget: 130,
      loadSliceMs: 8
    },
    low: {
      label: 'LOW',
      pixelRatioCap: 1,
      antialias: false,
      shadows: false,           // the whole shadow pass, not a smaller map
      shadowMapSize: 512,
      anisotropy: 1,
      dynLights: 2,             // neon accents kept alive per level
      projLights: 3,            // pooled projectile lights, always in the
      flashLights: 1,           // light set at intensity 0 (see _ensureDynLightPools)
      envPropBudget: 60,
      envDustScale: 0,          // no atmosphere particles at all
      goreSprayScale: 0.35,
      goreDecalCap: 120,
      goreChunks: 2,
      goreMist: false,
      enemyLodNear: 14,
      enemyLodFar: 52,
      aiAnimRadius: 12,
      aiAnimSlowRate: 5,
      aiMaxNear: 35,
      aiScanStripe: 6,
      aiFieldBudget: 2500,
      aiFieldNewBudget: 90,
      loadSliceMs: 6
    }
  };

  var ORDER = ['low', 'medium', 'high'];

  /* ---- device signals ---------------------------------------------------
     Deliberately coarse and deliberately static. Every signal here is known
     before the first frame renders, which is what lets rule 2 hold. */
  function signals() {
    var coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) {}
    var cores = navigator.hardwareConcurrency;
    var mem = navigator.deviceMemory;      // Chromium only; undefined elsewhere
    return {
      coarsePointer: coarse,
      cores: typeof cores === 'number' ? cores : null,
      deviceMemoryGB: typeof mem === 'number' ? mem : null
    };
  }

  function detect(sig) {
    sig = sig || signals();
    // A phone or tablet is a Low device no matter what it reports for cores:
    // the thermal envelope, not the core count, is what runs out.
    if (sig.coarsePointer) return 'low';
    if (sig.cores !== null && sig.cores <= 4) return 'low';
    if (sig.deviceMemoryGB !== null && sig.deviceMemoryGB <= 4) return 'low';
    // Nothing above this line uses deviceMemory again on purpose: the spec
    // caps navigator.deviceMemory at 8, so "<= 8 GB" is true on a 64 GB
    // workstation and would quietly demote every desktop in the world.
    if (sig.cores !== null && sig.cores <= 6) return 'medium';
    return 'high';
  }

  function fromUrl() {
    try {
      var m = /[?&]quality=([a-z]+)/i.exec(location.search);
      var v = m && m[1].toLowerCase();
      return TIERS[v] ? v : null;
    } catch (e) { return null; }
  }

  function fromStore() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      return v && TIERS[v] ? v : null;
    } catch (e) { return null; }
  }

  var API = {
    TIERS: TIERS,
    ORDER: ORDER,
    tier: 'high',
    autoTier: 'high',
    source: 'auto',            // 'url' | 'saved' | 'auto'
    settings: TIERS.high,
    signals: null,
    _listeners: [],

    /** Resolve the tier. Safe to call more than once; later calls re-resolve
        from the same three inputs and do not consult any runtime measurement. */
    init: function () {
      this.signals = signals();
      this.autoTier = detect(this.signals);
      var url = fromUrl();
      var saved = fromStore();
      if (url) { this.tier = url; this.source = 'url'; }
      else if (saved) { this.tier = saved; this.source = 'saved'; }
      else { this.tier = this.autoTier; this.source = 'auto'; }
      this.settings = TIERS[this.tier];
      return this.tier;
    },

    /** Player picked a tier in Options. persist=false for a QA/one-shot set. */
    set: function (tier, persist) {
      if (!TIERS[tier]) return false;
      this.tier = tier;
      this.settings = TIERS[tier];
      this.source = persist === false ? this.source : 'saved';
      if (persist !== false) {
        try { localStorage.setItem(STORE_KEY, tier); } catch (e) {}
      }
      for (var i = 0; i < this._listeners.length; i++) {
        try { this._listeners[i](tier, this.settings); } catch (e) {}
      }
      return true;
    },

    /** Forget the override and go back to what the device signals say. */
    clearOverride: function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      return this.set(this.autoTier, false);
    },

    onChange: function (fn) { if (typeof fn === 'function') this._listeners.push(fn); },

    get: function (key, fallback) {
      var v = this.settings[key];
      return v === undefined ? fallback : v;
    },

    /** What QA and the candidate packet read. */
    summary: function () {
      return {
        tier: this.tier,
        label: this.settings.label,
        source: this.source,
        autoTier: this.autoTier,
        signals: this.signals,
        settings: this.settings
      };
    }
  };

  API.init();
  window.CyberQuality = API;
}());
