/* Sign-in panel for the Cyberhell editor: email -> magic link -> username -> signed in.
 * A plain DOM overlay (reliable text input and mobile keyboards), classic script, no deps.
 *
 * Registers as a panel on window.CyberEditor when it appears, and switches
 * CyberEditor.storage.backend to 'cloud' once /api/auth/me answers.
 */
(function () {
  'use strict';

  const state = { user: null, checked: false, inflight: null };

  async function api(path, opts) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error((body && body.error) || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return body;
  }

  function refresh() {
    if (state.inflight) return state.inflight;
    state.inflight = api('/api/auth/me')
      .then((u) => u)
      .catch(() => null)
      .then((u) => { state.user = u; state.checked = true; state.inflight = null; onUser(u); return u; });
    return state.inflight;
  }

  function onUser(user) {
    const ed = window.CyberEditor;
    if (user && ed && ed.storage && ed.storage.backends && ed.storage.backends.cloud) {
      ed.storage.backend = 'cloud';
      if (typeof ed.storage.setBackend === 'function') ed.storage.setBackend('cloud');
    }
    window.dispatchEvent(new CustomEvent('cyberauth-change', { detail: user }));
    render();
  }

  // ---------------------------------------------------------------- overlay UI

  let root, body;
  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'cyber-auth';
    root.hidden = true;
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(4,4,6,.82);font:14px Consolas,monospace;color:#d7d7d7';
    body = document.createElement('div');
    body.style.cssText = 'background:#111114;border:1px solid #ff3b30;padding:22px;min-width:320px;max-width:420px';
    root.appendChild(body);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.body.appendChild(root);
    return root;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const open = () => { ensureRoot(); root.hidden = false; render(); };
  const close = () => { if (root) root.hidden = true; };

  function screenSignIn(message) {
    body.innerHTML = `
      <h3 style="margin:0 0 12px;color:#ff3b30">EDITOR SIGN-IN</h3>
      <p style="margin:0 0 12px;color:#9a9a9a">We email you a one-time link. No password.</p>
      <input id="cyber-auth-email" type="email" placeholder="you@example.com" autocomplete="email"
        style="width:100%;box-sizing:border-box;padding:9px;background:#000;color:#d7d7d7;border:1px solid #444">
      <p id="cyber-auth-msg" style="min-height:18px;margin:8px 0;color:#ffb020">${esc(message || '')}</p>
      <button id="cyber-auth-go" style="padding:9px 18px;background:#ff3b30;color:#0b0b0d;border:0;font-weight:bold;cursor:pointer">SEND LINK</button>
      <button id="cyber-auth-close" style="padding:9px 14px;margin-left:8px;background:#222;color:#aaa;border:0;cursor:pointer">CANCEL</button>`;
    const input = body.querySelector('#cyber-auth-email');
    const msg = body.querySelector('#cyber-auth-msg');
    const send = async () => {
      msg.textContent = 'Sending...';
      try {
        const out = await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: input.value }) });
        screenSent(input.value, out && out.emailed === false);
      } catch (err) { msg.textContent = err.message; }
    };
    body.querySelector('#cyber-auth-go').onclick = send;
    body.querySelector('#cyber-auth-close').onclick = close;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
    input.focus();
  }

  function screenSent(email, printedOnly) {
    body.innerHTML = `
      <h3 style="margin:0 0 12px;color:#ff3b30">CHECK YOUR INBOX</h3>
      <p style="margin:0 0 8px">A sign-in link is on its way to <b>${esc(email)}</b>. It expires in 15 minutes.</p>
      ${printedOnly ? '<p style="color:#ffb020;margin:0 0 8px">No mail service configured -- the link was printed to the dev server console.</p>' : ''}
      <p style="color:#9a9a9a;margin:0 0 12px">Open it in this browser, then come back here.</p>
      <button id="cyber-auth-recheck" style="padding:9px 18px;background:#ff3b30;color:#0b0b0d;border:0;font-weight:bold;cursor:pointer">I SIGNED IN</button>
      <button id="cyber-auth-close" style="padding:9px 14px;margin-left:8px;background:#222;color:#aaa;border:0;cursor:pointer">CLOSE</button>`;
    body.querySelector('#cyber-auth-recheck').onclick = () => refresh().then(() => { if (state.user) close(); });
    body.querySelector('#cyber-auth-close').onclick = close;
  }

  function screenUsername(message) {
    body.innerHTML = `
      <h3 style="margin:0 0 12px;color:#ff3b30">PICK A NAME</h3>
      <p style="margin:0 0 12px;color:#9a9a9a">3-20 characters: letters, numbers, underscore.</p>
      <input id="cyber-auth-name" placeholder="ripcord" style="width:100%;box-sizing:border-box;padding:9px;background:#000;color:#d7d7d7;border:1px solid #444">
      <p id="cyber-auth-msg" style="min-height:18px;margin:8px 0;color:#ffb020">${esc(message || '')}</p>
      <button id="cyber-auth-save" style="padding:9px 18px;background:#ff3b30;color:#0b0b0d;border:0;font-weight:bold;cursor:pointer">CLAIM</button>`;
    const input = body.querySelector('#cyber-auth-name');
    const msg = body.querySelector('#cyber-auth-msg');
    const save = async () => {
      try {
        await api('/api/auth/username', { method: 'POST', body: JSON.stringify({ username: input.value }) });
        await refresh();
        close();
      } catch (err) { msg.textContent = err.message; }
    };
    body.querySelector('#cyber-auth-save').onclick = save;
    input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
    input.focus();
  }

  function screenSignedIn() {
    const u = state.user;
    body.innerHTML = `
      <h3 style="margin:0 0 12px;color:#ff3b30">SIGNED IN</h3>
      <p style="margin:0 0 6px">${esc(u.username || u.email)}${u.isAdmin ? ' <span style="color:#ffb020">[admin]</span>' : ''}</p>
      <p style="margin:0 0 14px;color:#9a9a9a">${u.isAdmin ? 'You can edit the canonical packs.' : 'Creator mode: your own packs.'}</p>
      <button id="cyber-auth-rename" style="padding:9px 14px;background:#222;color:#ddd;border:0;cursor:pointer">CHANGE NAME</button>
      <button id="cyber-auth-out" style="padding:9px 14px;margin-left:8px;background:#222;color:#aaa;border:0;cursor:pointer">SIGN OUT</button>
      <button id="cyber-auth-close" style="padding:9px 14px;margin-left:8px;background:#222;color:#aaa;border:0;cursor:pointer">CLOSE</button>`;
    body.querySelector('#cyber-auth-rename').onclick = () => screenUsername();
    body.querySelector('#cyber-auth-close').onclick = close;
    body.querySelector('#cyber-auth-out').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      onUser(null);
      screenSignIn('Signed out.');
    };
  }

  function render() {
    updateChip();
    if (!root || root.hidden) return;
    if (!state.user) return screenSignIn();
    if (!state.user.username) return screenUsername();
    return screenSignedIn();
  }

  // A chip the editor core can place anywhere; falls back to a fixed corner button.
  let chip;
  function updateChip() {
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'cyber-auth-chip';
      chip.style.cssText = 'position:fixed;right:10px;top:10px;z-index:9998;padding:6px 12px;' +
        'background:#141418;color:#d7d7d7;border:1px solid #444;font:12px Consolas,monospace;cursor:pointer';
      chip.onclick = open;
      const host = document.getElementById('editor-auth-slot');
      (host || document.body).appendChild(chip);
      if (host) chip.style.position = 'static';
    }
    chip.textContent = state.user ? `◈ ${state.user.username || state.user.email}` : '◈ Sign in';
  }

  const CyberAuth = {
    open, close, refresh,
    current: () => state.user,
    get: () => (state.checked ? Promise.resolve(state.user) : refresh()),
    // Resolves to the user once they are signed in with a username, else null.
    async ensureSignedIn() {
      await CyberAuth.get();
      if (state.user && state.user.username) return state.user;
      open();
      return null;
    },
  };
  window.CyberAuth = CyberAuth;

  function attach() {
    const ed = window.CyberEditor;
    if (ed && typeof ed.registerPanel === 'function' && !attach.done) {
      attach.done = true;
      ed.registerPanel({ id: 'auth', title: 'Account', open, element: () => ensureRoot() });
    }
    return !!attach.done;
  }

  function boot() {
    ensureRoot();
    updateChip();
    // ?auth=setup|welcome|invalid|expired comes back from /api/auth/verify.
    const q = new URLSearchParams(location.search).get('auth');
    refresh().then(() => {
      if (q === 'setup' || (q === 'welcome' && state.user && !state.user.username)) open();
      else if (q === 'invalid' || q === 'expired') { open(); screenSignIn(q === 'expired' ? 'That link expired. Send another.' : 'That link was not valid.'); }
      if (q) history.replaceState(null, '', location.pathname);
    });
    if (!attach()) {
      window.addEventListener('cybereditor-ready', attach);
      let tries = 0;
      const poll = setInterval(() => { if (attach() || ++tries > 100) clearInterval(poll); }, 100);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
