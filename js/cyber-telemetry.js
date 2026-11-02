// Anonymous play telemetry for Cyberhell.
// Sends session_start, level_start, and death to same-origin /api/event.
// Never carries account ids, email, IP, or the user-agent string.
// track() never throws and never awaits: a 404 from a static host is silent.
// Classic script in the page (window.cyberTelemetry). Node tests require() it.
(function (root) {
  'use strict';

  var growth = (root.CyberGrowth && root.CyberGrowth.detectInternal)
    ? root.CyberGrowth
    : require('./growthTag.js');

  var EVENT_NAMES = Object.freeze([
    'session_start',
    'level_start',
    'death',
  ]);

  var ALLOWED_PROPS = Object.freeze([
    'level',
    'index',
    'difficulty',
    'cause',
  ]);

  var CLIENT_KEY = 'cyberhell.cid';
  var ENDPOINT = '/api/event';

  function uuid(randomId) {
    if (randomId) return randomId();
    try {
      if (root.crypto && root.crypto.randomUUID) return 'ch_' + root.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'ch_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  }

  function createTelemetry(env) {
    env = env || {};
    var storage = env.storage !== undefined ? env.storage : root.localStorage;
    var transport = env.transport || defaultTransport;
    var now = env.now || function () { return Date.now(); };
    var enabled = env.enabled !== false;
    // Hard mutes drop the event. Tagging never turns a mute into a send.
    // ?test=1 is a tag, not a mute.
    var qaMute = env.qaMute !== undefined ? !!env.qaMute : detectQaMute(env);
    // Computed once per page load, including when muted, so ?internal=1 still sticks.
    var detected = growth.detectInternal(env);

    var clientId = null;
    try { clientId = storage && storage.getItem && storage.getItem(CLIENT_KEY); } catch (e) { clientId = null; }
    if (!clientId) {
      clientId = uuid(env.randomId);
      try { if (storage && storage.setItem) storage.setItem(CLIENT_KEY, clientId); } catch (e) { /* ignore */ }
    }
    var sessionId = uuid(env.randomId);
    var sent = Object.create(null);

    function track(name, props) {
      try {
        if (!enabled || qaMute) return false;
        var eventName = String(name || '');
        if (EVENT_NAMES.indexOf(eventName) < 0) return false;

        var clean = {};
        var incoming = props && typeof props === 'object' ? props : {};
        for (var i = 0; i < ALLOWED_PROPS.length; i++) {
          var key = ALLOWED_PROPS[i];
          if (incoming[key] !== undefined) clean[key] = incoming[key];
        }

        try {
          transport({
            name: eventName,
            type: eventName,
            ts: now(),
            client_id: clientId,
            session_id: sessionId,
            props: clean,
            internal: detected.internal,
            internal_reasons: detected.reasons.slice(),
            schema_v: growth.SCHEMA_V,
          });
        } catch (e) { /* telemetry must not break play */ }
        return true;
      } catch (e) {
        return false;
      }
    }

    // At most one send of this name for the page session.
    function once(name, props) {
      try {
        var eventName = String(name || '');
        if (sent[eventName]) return false;
        var ok = track(eventName, props);
        if (ok) sent[eventName] = true;
        return ok;
      } catch (e) {
        return false;
      }
    }

    return {
      track: track,
      once: once,
      setEnabled: function (on) { enabled = !!on; },
      isEnabled: function () { return enabled && !qaMute; },
      isQaMuted: function () { return qaMute; },
      getInternal: function () { return { internal: detected.internal, reasons: detected.reasons.slice() }; },
      getClientId: function () { return clientId; },
      getSessionId: function () { return sessionId; },
    };
  }

  function defaultTransport(payload) {
    var body;
    try { body = JSON.stringify(payload); } catch (e) { return; }
    var nav = root.navigator;
    // text/plain is what sendBeacon will queue. application/json often returns
    // false and sends nothing. A false return falls through to fetch.
    var queued = false;
    if (nav && typeof nav.sendBeacon === 'function') {
      try {
        var blob = new root.Blob([body], { type: 'text/plain;charset=UTF-8' });
        queued = nav.sendBeacon(ENDPOINT, blob) === true;
      } catch (e) {
        queued = false;
      }
    }
    if (queued) return;
    var fetchFn = root.fetch;
    if (typeof fetchFn === 'function') {
      try {
        var pending = fetchFn(ENDPOINT, {
          method: 'POST',
          body: body,
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          keepalive: true,
        });
        if (pending && typeof pending.catch === 'function') pending.catch(function () {});
      } catch (e) { /* a static host 404 must not throw */ }
    }
  }

  // Dev mode, an explicit opt-out, the qa-runner path, and an iframe send nothing.
  // ?test=1 does not mute: those hits are tagged internal instead of dropped.
  // A thrown check mutes, so a cross-origin frame (top is unreadable) stays quiet.
  function detectQaMute(env) {
    env = env || {};
    try {
      var location = env.location !== undefined ? env.location : root.location;
      var query = new URLSearchParams((location && location.search) || '');
      if (query.get('dev') === '1' || query.get('telemetry') === '0') return true;
      if (String((location && location.pathname) || '').indexOf('qa-runner') !== -1) return true;
      var selfRef = env.self !== undefined ? env.self : root.self;
      var topRef = env.top !== undefined ? env.top : root.top;
      if (selfRef && topRef && selfRef !== topRef) return true;
    } catch (e) {
      return true;
    }
    return false;
  }

  var api = {
    createTelemetry: createTelemetry,
    detectQaMute: detectQaMute,
    detectInternal: growth.detectInternal,
    EVENT_NAMES: EVENT_NAMES,
    ALLOWED_PROPS: ALLOWED_PROPS,
  };

  // Page session only. Node tests build their own instance.
  if (typeof window !== 'undefined') {
    try { api.instance = createTelemetry(); } catch (e) { api.instance = null; }
    window.cyberTelemetry = api;
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
