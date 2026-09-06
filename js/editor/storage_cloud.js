/* Cloud StorageAdapter for the Cyberhell editor: the same method set as the local IndexedDB
 * backend, backed by /api/*. Classic script, no imports, no dependencies.
 *
 *   window.CyberCloudStorage.create()  -> adapter
 *   adapter.available()                -> Promise<boolean>  (does the API answer?)
 *
 * Registered on window.CyberEditor.storage.backends.cloud when the editor is present; the editor
 * core decides when to switch to it (auth_ui.js flips it once /api/auth/me answers).
 */
(function () {
  'use strict';

  const json = async (path, opts = {}) => {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  };

  const post = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const patch = (path, body) => json(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
  const put = (path, body) => json(path, { method: 'PUT', body: JSON.stringify(body || {}) });
  const del = (path) => json(path, { method: 'DELETE' });

  function createAdapter() {
    return {
      id: 'cloud',
      name: 'Cloud',

      async available() {
        try { await json('/api/packs'); return true; } catch { return false; }
      },

      // --- packs -------------------------------------------------------------
      // Returns packs.json shape: { id, name, manifest, levelCount }.
      listPacks() { return json('/api/packs'); },

      // Returns manifest shape: [{ id, name, file, sectors, walls, entities }].
      getPack(packId) { return json(`/api/packs/${encodeURIComponent(packId)}`); },

      createPack(name) { return post('/api/packs', { name }); },
      renamePack(packId, name) { return patch(`/api/packs/${encodeURIComponent(packId)}`, { name }); },
      deletePack(packId) { return del(`/api/packs/${encodeURIComponent(packId)}`); },
      reorderLevels(packId, levelIds) { return patch(`/api/packs/${encodeURIComponent(packId)}`, { levelOrder: levelIds }); },
      publishPack(packId, published) { return post(`/api/publish/${encodeURIComponent(packId)}`, { published: published !== false }); },

      // --- levels ------------------------------------------------------------
      loadLevel(levelId, versionId) {
        const q = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
        return json(`/api/levels/${encodeURIComponent(levelId)}/json${q}`);
      },
      levelMeta(levelId) { return json(`/api/levels/${encodeURIComponent(levelId)}`); },
      listVersions(levelId) { return json(`/api/levels/${encodeURIComponent(levelId)}/versions`); },

      // Save a new version of an existing level, or create it when there is no id yet.
      saveLevel(levelId, levelJson, note) {
        if (!levelId) throw new Error('saveLevel needs a level id; use saveLevelAs for new levels.');
        return put(`/api/levels/${encodeURIComponent(levelId)}`, { json: levelJson, note });
      },

      // Save-as: a copy in the same pack when `levelId` is given, otherwise a brand new level
      // in `packId`.
      saveLevelAs(levelId, name, levelJson, packId) {
        if (levelId) return put(`/api/levels/${encodeURIComponent(levelId)}?as=new`, { json: levelJson, name });
        return post('/api/levels', { packId, name, json: levelJson });
      },

      createLevel(packId, name, levelJson) { return post('/api/levels', { packId, name, json: levelJson }); },
      deleteLevel(levelId) { return del(`/api/levels/${encodeURIComponent(levelId)}`); },

      // --- enemies -----------------------------------------------------------
      listEnemies(packId) { return json(`/api/enemies${packId ? `?packId=${encodeURIComponent(packId)}` : ''}`); },
      saveEnemy(enemy) {
        if (enemy && enemy.id) return put(`/api/enemies/${encodeURIComponent(enemy.id)}`, enemy);
        return post('/api/enemies', enemy);
      },
      deleteEnemy(enemyId) { return del(`/api/enemies/${encodeURIComponent(enemyId)}`); },

      // --- midi --------------------------------------------------------------
      listMidi(packId) { return json(`/api/midi${packId ? `?packId=${encodeURIComponent(packId)}` : ''}`); },

      // `data` is an ArrayBuffer/Uint8Array of the .mid file, or an already-base64 string.
      saveMidi(name, data, opts = {}) {
        return post('/api/midi', { name, dataBase64: toBase64(data), packId: opts.packId || null, bpm: opts.bpm });
      },
      deleteMidi(midiId) { return del(`/api/midi/${encodeURIComponent(midiId)}`); },
      midiUrl(midiId) { return `/api/midi/${encodeURIComponent(midiId)}`; },
    };
  }

  function toBase64(data) {
    if (typeof data === 'string') return data.replace(/^data:[^,]*,/, '');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = '';
    // Chunked so a large file does not blow the argument limit of String.fromCharCode.
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  window.CyberCloudStorage = { create: createAdapter, toBase64 };

  // Register with the editor as soon as it exists, whichever order the scripts load in.
  function register() {
    const ed = window.CyberEditor;
    if (!ed || !ed.storage) return false;
    ed.storage.backends = ed.storage.backends || {};
    ed.storage.backends.cloud = ed.storage.backends.cloud || createAdapter();
    return true;
  }
  if (!register()) {
    window.addEventListener('cybereditor-ready', register);
    let tries = 0;
    const poll = setInterval(() => { if (register() || ++tries > 100) clearInterval(poll); }, 100);
  }
})();
