/* Account panel for the Cyberhell editor: email -> magic link -> username -> signed in.
 * Registered through CyberEditor.registerPanel like every other lane's panel. No fixed
 * elements, no overlay, nothing that can sit on top of the editor.
 *
 * The API is only contacted where one can exist -- the https deployment or the local dev API
 * server on :5305 -- the same rule index.html uses for its pack-list probe. On a plain static
 * host the panel says so and never issues a request.
 */
(function () {
  'use strict';

  var apiPossible = location.protocol === 'https:' || location.port === '5305';
  var state = { user: null, checked: false, inflight: null, screen: 'auto', message: '', email: '' };
  var host = null;

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var e = new Error((body && body.error) || 'HTTP ' + res.status);
          e.status = res.status;
          throw e;
        }
        return body;
      });
    });
  }

  function refresh() {
    if (!apiPossible) { state.checked = true; return Promise.resolve(null); }
    if (state.inflight) return state.inflight;
    state.inflight = api('/api/auth/me')
      .catch(function () { return null; })
      .then(function (u) {
        state.user = u;
        state.checked = true;
        state.inflight = null;
        window.dispatchEvent(new CustomEvent('cyberauth-change', { detail: u }));
        render();
        return u;
      });
    return state.inflight;
  }

  /* ---- panel screens ----------------------------------------------------- */

  function say(msg) { state.message = msg || ''; render(); }

  function screenLocal() {
    host.appendChild(el('div', { class: 'ed-hint' },
      'Local mode. Your work is saved in this browser. Sign-in and cloud packs are available on ' +
      'the deployed site, or locally via node tools/dev_api_server.mjs (port 5305).'));
  }

  function screenSignIn() {
    host.appendChild(el('div', { class: 'ed-hint' }, 'We email you a one-time link. No password.'));
    var row = el('div', { class: 'ed-row' });
    row.appendChild(el('label', null, 'Email'));
    var input = el('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    input.value = state.email;
    row.appendChild(input);
    host.appendChild(row);

    var btns = el('div', { class: 'ed-btns' });
    var go = el('button', null, 'Send link');
    function send() {
      state.email = input.value;
      say('sending…');
      api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: input.value }) })
        .then(function (out) {
          state.screen = 'sent';
          say(out && out.emailed === false
            ? 'No mail service configured — the link was printed to the dev server console.'
            : '');
        })
        .catch(function (err) { say(err.message); });
    }
    go.addEventListener('click', send);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
    btns.appendChild(go);
    host.appendChild(btns);
  }

  function screenSent() {
    host.appendChild(el('div', { class: 'ed-hint' },
      'A sign-in link is on its way to ' + state.email + '. It expires in 15 minutes. Open it in ' +
      'this browser, then come back here.'));
    var btns = el('div', { class: 'ed-btns' });
    var again = el('button', null, 'I signed in');
    again.addEventListener('click', function () {
      state.inflight = null;
      refresh().then(function (u) { if (u) state.screen = 'auto'; else say('Still signed out.'); });
    });
    var back = el('button', null, 'Use another email');
    back.addEventListener('click', function () { state.screen = 'auto'; say(''); });
    btns.appendChild(again);
    btns.appendChild(back);
    host.appendChild(btns);
  }

  function screenUsername() {
    host.appendChild(el('div', { class: 'ed-hint' }, '3-20 characters: letters, numbers, underscore.'));
    var row = el('div', { class: 'ed-row' });
    row.appendChild(el('label', null, 'Name'));
    var input = el('input', { placeholder: 'ripcord' });
    input.value = (state.user && state.user.username) || '';
    row.appendChild(input);
    host.appendChild(row);

    var btns = el('div', { class: 'ed-btns' });
    var save = el('button', null, 'Claim');
    function claim() {
      say('saving…');
      api('/api/auth/username', { method: 'POST', body: JSON.stringify({ username: input.value }) })
        .then(function () { state.screen = 'auto'; state.inflight = null; return refresh(); })
        .catch(function (err) { say(err.message); });
    }
    save.addEventListener('click', claim);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') claim(); });
    btns.appendChild(save);
    if (state.user && state.user.username) {
      var cancel = el('button', null, 'Cancel');
      cancel.addEventListener('click', function () { state.screen = 'auto'; say(''); });
      btns.appendChild(cancel);
    }
    host.appendChild(btns);
  }

  function screenSignedIn() {
    var u = state.user;
    host.appendChild(el('div', { class: 'ed-row' }, u.username || u.email));
    host.appendChild(el('div', { class: 'ed-hint' }, u.isAdmin
      ? 'Admin — you can edit the canonical packs.'
      : 'Creator mode — your own packs.'));

    var btns = el('div', { class: 'ed-btns' });
    var rename = el('button', null, 'Change name');
    rename.addEventListener('click', function () { state.screen = 'username'; say(''); });
    var out = el('button', null, 'Sign out');
    out.addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' })
        .catch(function () {})
        .then(function () {
          state.user = null;
          state.screen = 'auto';
          window.dispatchEvent(new CustomEvent('cyberauth-change', { detail: null }));
          say('Signed out.');
        });
    });
    btns.appendChild(rename);
    btns.appendChild(out);
    host.appendChild(btns);
  }

  function render() {
    if (!host) return;
    host.innerHTML = '';
    var u = state.user;
    var title = 'Account';
    if (!apiPossible) title = 'Account — local mode';
    else if (u) title = 'Account — ' + (u.username || u.email);
    host.appendChild(el('div', { class: 'ed-head' }, title));

    if (!apiPossible) screenLocal();
    else if (state.screen === 'sent') screenSent();
    else if (state.screen === 'username' || (u && !u.username)) screenUsername();
    else if (u) screenSignedIn();
    else screenSignIn();

    if (state.message) host.appendChild(el('div', { class: 'ed-hint' }, state.message));
  }

  /* ---- public surface ---------------------------------------------------- */

  var CyberAuth = {
    // "Open" means show the Account tab. Nothing ever covers the editor.
    open: function () { if (window.CyberEditor) window.CyberEditor.showPanel('auth'); },
    refresh: refresh,
    possible: function () { return apiPossible; },
    current: function () { return state.user; },
    get: function () { return state.checked ? Promise.resolve(state.user) : refresh(); },
    // Resolves to the user once signed in with a username, else null after showing the panel.
    ensureSignedIn: function () {
      return CyberAuth.get().then(function (u) {
        if (u && u.username) return u;
        CyberAuth.open();
        if (window.CyberEditor) {
          window.CyberEditor.toast(apiPossible ? 'Sign in on the Account tab' : 'Cloud saving needs the deployed site', 'bad');
        }
        return null;
      });
    },
  };
  window.CyberAuth = CyberAuth;

  function mount() {
    var ed = window.CyberEditor;
    if (!ed || typeof ed.registerPanel !== 'function' || host) return !!host;
    host = ed.registerPanel({ id: 'auth', title: 'Account', side: 'right' });

    // ?auth=setup|welcome|invalid|expired comes back from /api/auth/verify. Surface it on the
    // tab, but never steal focus from whatever the editor was doing.
    var q = new URLSearchParams(location.search).get('auth');
    if (q) history.replaceState(null, '', location.pathname);
    if (q === 'invalid') state.message = 'That link was not valid.';
    if (q === 'expired') state.message = 'That link expired. Send another.';

    render();
    refresh().then(function () { if (q === 'setup' || q === 'invalid' || q === 'expired') CyberAuth.open(); });
    return true;
  }

  if (!mount()) {
    window.addEventListener('cybereditor-ready', mount);
    var tries = 0;
    var poll = setInterval(function () { if (mount() || ++tries > 100) clearInterval(poll); }, 100);
  }
})();
