/* Anonymous Cyberhell telemetry: one `session` beacon per page load and one
   `play` beacon the first time a mission actually starts. Posts to /api/event.
   Carries no PII, no user agent, no IP, and nothing per-frame or per-combat.

   SOFT-FAIL IS THE CONTRACT: track() never throws and never awaits. A blocked
   beacon or a 404 from a static host must not touch the game.

   Muted by ?dev=1, ?telemetry=0, embedded frames and qa-runner pages. */
(function (root) {
  'use strict';

  var EVENT_TYPES = ['session', 'play'];
  var ALLOWED_PROPS = ['mode', 'pack', 'level', 'action', 'reason', 'touch', 'duration'];
  var CLIENT_KEY = 'cyberhell.cid';
  var ENDPOINT = '/api/event';

  function uuid() {
    try {
      if (root.crypto && root.crypto.randomUUID) return 'ch_' + root.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'ch_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  }

  function detectMute() {
    try {
      var loc = root.location;
      var q = new URLSearchParams((loc && loc.search) || '');
      if (q.get('dev') === '1' || q.get('telemetry') === '0') return true;
      if (loc && loc.pathname && loc.pathname.indexOf('qa-runner') !== -1) return true;
      if (root.self && root.top && root.self !== root.top) return true;
      if (root.__CYBERHELL_QA_MUTE__) return true;
    } catch (e) {
      return true;
    }
    return false;
  }

  function defaultTransport(payload) {
    var body = JSON.stringify(payload);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch (e) { /* fall through to fetch */ }
    if (typeof fetch === 'function') {
      fetch(ENDPOINT, {
        method: 'POST', body: body, headers: { 'content-type': 'application/json' }, keepalive: true
      }).catch(function () {});
    }
  }

  function create(env) {
    env = env || {};
    var storage = env.storage;
    if (storage === undefined) { try { storage = root.localStorage; } catch (e) { storage = null; } }
    var transport = env.transport || defaultTransport;
    var now = env.now || Date.now;
    var muted = env.muted !== undefined ? !!env.muted : detectMute();

    // Anonymous install id so unique players can be counted; identifies no one.
    var clientId = null;
    try { clientId = storage && storage.getItem(CLIENT_KEY); } catch (e) { /* no storage */ }
    if (!clientId) {
      clientId = uuid();
      try { if (storage) storage.setItem(CLIENT_KEY, clientId); } catch (e) { /* no storage */ }
    }
    var sessionId = uuid();
    var sent = {};

    function track(type, props) {
      try {
        if (muted) return false;
        type = String(type || '').toLowerCase();
        if (EVENT_TYPES.indexOf(type) === -1) return false;
        var clean = {};
        var incoming = props && typeof props === 'object' ? props : {};
        for (var i = 0; i < ALLOWED_PROPS.length; i++) {
          var k = ALLOWED_PROPS[i];
          if (incoming[k] !== undefined) clean[k] = incoming[k];
        }
        transport({ type: type, name: type, ts: now(), client_id: clientId, session_id: sessionId, props: clean });
        return true;
      } catch (e) {
        return false; // analytics never touch the game
      }
    }

    // Fires at most once per page load, however often the caller repeats it.
    function once(type, props) {
      if (sent[type]) return false;
      sent[type] = true;
      return track(type, props);
    }

    return { track: track, once: once, isMuted: function () { return muted; },
      getClientId: function () { return clientId; }, getSessionId: function () { return sessionId; } };
  }

  var api = { create: create, detectMute: detectMute, EVENT_TYPES: EVENT_TYPES, ALLOWED_PROPS: ALLOWED_PROPS };
  try { api.instance = create(); } catch (e) { api.instance = null; }
  root.cyberTelemetry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
