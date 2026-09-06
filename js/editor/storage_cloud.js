/* ===========================================================================
   storage_cloud.js — the cloud StorageAdapter.

   It IS the local adapter (prototype chain), with the pack-scoped methods
   overridden to route to /api/* for packs that live in the cloud. Everything
   local stays local: canonical packs still come from levelPacks/, local packs
   still live in IndexedDB, and exportLevel / importLevelFile / saveIntoRepo /
   putDraft / getDraft are inherited untouched.

   listPacks() returns canonical + local (from the local adapter) plus the
   caller's cloud packs tagged source:'cloud'. Every write routes on the pack's
   source, so nothing else in the editor has to know which backend it is on.

   Signed out, or on a host with no API, the cloud list is empty and this
   behaves exactly like storage_local.js.
   =========================================================================== */
(function () {
  'use strict';

  // Same rule as index.html and auth_ui.js: only ask where an API can exist.
  var apiPossible = location.protocol === 'https:' || location.port === '5305';

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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

  var Local = window.EdStorageLocal;

  function CloudStorage() {
    Local.call(this);
    this.backend = 'cloud';
    this._cloudList = null;   // /api/packs rows that are not canonical
    this._cloudById = {};
  }
  CloudStorage.prototype = Object.create(Local.prototype);
  CloudStorage.prototype.constructor = CloudStorage;

  /* ---- which packs are in the cloud -------------------------------------- */

  // /api/packs answers with canonical packs too (the same ids as the repo copies,
  // or the repo list verbatim before the migration runs), so those are dropped
  // here and left to the local adapter's canonical path.
  CloudStorage.prototype._cloudPacks = function () {
    var self = this;
    if (this._cloudList) return Promise.resolve(this._cloudList);
    if (!apiPossible) { this._cloudList = []; return Promise.resolve([]); }
    // ?mine=1 so a pack this account made but has not published still shows in the editor.
    return Promise.all([api('/api/packs?mine=1').catch(function () { return []; }), this._canonicalPacks()])
      .then(function (res) {
        var canonIds = {};
        (res[1] || []).forEach(function (p) { canonIds[p.id] = true; });
        var rows = (res[0] || []).filter(function (p) { return !canonIds[p.id]; });
        self._cloudList = rows;
        self._cloudById = {};
        rows.forEach(function (p) { self._cloudById[p.id] = p; });
        return rows;
      });
  };

  CloudStorage.prototype.invalidate = function () {
    this._cloudList = null;
    this._cloudById = {};
    return this;
  };

  // Resolves to the cloud pack row, or null when the pack is canonical/local.
  CloudStorage.prototype._cloud = function (packId) {
    var self = this;
    return this._cloudPacks().then(function () { return self._cloudById[packId] || null; });
  };

  /* ---- reads -------------------------------------------------------------- */

  CloudStorage.prototype.listPacks = function () {
    var self = this;
    return Promise.all([Local.prototype.listPacks.call(this), this._cloudPacks()]).then(function (res) {
      return (res[0] || []).concat((res[1] || []).map(function (p) {
        return { id: p.id, name: p.name, levelCount: p.levelCount, source: 'cloud' };
      }));
    });
  };

  CloudStorage.prototype.getPack = function (id) {
    var self = this;
    return this._cloud(id).then(function (row) {
      if (!row) return Local.prototype.getPack.call(self, id);
      return api('/api/packs/' + encodeURIComponent(id)).then(function (manifest) {
        return {
          id: id, name: row.name, source: 'cloud',
          // `file` is /api/levels/<id>/json, so the inherited loadLevel and
          // saveIntoRepo fetch it without knowing it came from the API.
          levels: (manifest || []).map(function (l) { return { id: l.id, name: l.name, file: l.file }; }),
        };
      });
    });
  };

  /* ---- writes ------------------------------------------------------------- */

  CloudStorage.prototype.saveLevel = function (packId, levelId, json, opts) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.saveLevel.call(self, packId, levelId, json, opts);
      return api('/api/levels/' + encodeURIComponent(levelId), {
        method: 'PUT', body: { json: json, note: (opts && opts.note) || 'editor save' },
      }).then(function (r) {
        self.invalidate();
        return { levelId: levelId, versionId: r.version.id };
      });
    });
  };

  CloudStorage.prototype.saveLevelAs = function (packId, name, json) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.saveLevelAs.call(self, packId, name, json);
      var copy = JSON.parse(JSON.stringify(json));
      copy.name = name;
      return api('/api/levels', { method: 'POST', body: { packId: packId, name: name, json: copy } })
        .then(function (r) {
          self.invalidate();
          return { levelId: r.level.id, versionId: r.version.id };
        });
    });
  };

  // New packs stay local, the same as before signing in. Cloud packs are made by
  // copyPackToCloud, which is what the Account panel's "Copy to cloud" calls.
  CloudStorage.prototype.createCloudPack = function (name) {
    var self = this;
    return api('/api/packs', { method: 'POST', body: { name: name } }).then(function (p) {
      self.invalidate();
      return { id: p.id };
    });
  };

  CloudStorage.prototype.copyPackToCloud = function (packId) {
    var self = this;
    return this.getPack(packId).then(function (pack) {
      if (!pack) throw new Error('unknown pack ' + packId);
      if (pack.source === 'cloud') throw new Error('that pack is already in the cloud');
      return self.createCloudPack(pack.name).then(function (made) {
        var chain = Promise.resolve();
        var n = 0;
        (pack.levels || []).forEach(function (entry) {
          chain = chain.then(function () {
            return self.loadLevel(packId, entry.id).then(function (json) {
              return self.saveLevelAs(made.id, json.name || entry.name || entry.id, json)
                .then(function () { n++; });
            });
          });
        });
        return chain.then(function () {
          self.invalidate();
          return { id: made.id, name: pack.name, levels: n };
        });
      });
    });
  };

  CloudStorage.prototype.renamePack = function (id, name) {
    var self = this;
    return this._cloud(id).then(function (row) {
      if (!row) return Local.prototype.renamePack.call(self, id, name);
      return api('/api/packs/' + encodeURIComponent(id), { method: 'PATCH', body: { name: name } })
        .then(function () { self.invalidate(); });
    });
  };

  CloudStorage.prototype.deletePack = function (id) {
    var self = this;
    return this._cloud(id).then(function (row) {
      if (!row) return Local.prototype.deletePack.call(self, id);
      return api('/api/packs/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () { self.invalidate(); });
    });
  };

  CloudStorage.prototype.reorderLevels = function (packId, ids) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.reorderLevels.call(self, packId, ids);
      return api('/api/packs/' + encodeURIComponent(packId), { method: 'PATCH', body: { levelOrder: ids } });
    });
  };

  CloudStorage.prototype.deleteLevel = function (packId, levelId) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.deleteLevel.call(self, packId, levelId);
      return api('/api/levels/' + encodeURIComponent(levelId), { method: 'DELETE' })
        .then(function () { self.invalidate(); });
    });
  };

  CloudStorage.prototype.publishPack = function (packId, published) {
    return api('/api/publish/' + encodeURIComponent(packId), {
      method: 'POST', body: { published: published !== false },
    });
  };

  /* ---- enemies ------------------------------------------------------------ */

  CloudStorage.prototype.listEnemies = function (packId) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.listEnemies.call(self, packId);
      return api('/api/enemies?packId=' + encodeURIComponent(packId)).then(function (rows) {
        // Same row shape the local adapter returns: { packId, id, def }.
        return (rows || []).map(function (e) { return { packId: packId, id: e.id, def: e.def }; });
      });
    });
  };

  CloudStorage.prototype.saveEnemy = function (packId, def) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.saveEnemy.call(self, packId, def);
      var body = { name: def.name || def.id || 'enemy', baseType: def.base || def.baseType || null, def: def, packId: packId };
      var call = def.id && String(def.id).indexOf('enemy_') === 0
        ? api('/api/enemies/' + encodeURIComponent(def.id), { method: 'PUT', body: body })
        : api('/api/enemies', { method: 'POST', body: body });
      return call.then(function (e) { def.id = e.id; return def; });
    });
  };

  CloudStorage.prototype.deleteEnemy = function (packId, id) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.deleteEnemy.call(self, packId, id);
      return api('/api/enemies/' + encodeURIComponent(id), { method: 'DELETE' });
    });
  };

  /* ---- midi --------------------------------------------------------------- */

  function toBase64(data) {
    if (typeof data === 'string') return data.replace(/^data:[^,]*,/, '');
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var s = '';
    // Chunked so a large file does not blow String.fromCharCode's argument limit.
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  CloudStorage.prototype.listMidi = function (packId) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.listMidi.call(self, packId);
      return api('/api/midi?packId=' + encodeURIComponent(packId)).then(function (rows) {
        return (rows || []).map(function (m) {
          return { packId: packId, name: m.name, id: m.id, url: '/api/midi/' + m.id, bytes: m.bytes, updatedAt: m.updatedAt };
        });
      });
    });
  };

  CloudStorage.prototype.saveMidi = function (packId, name, uint8) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.saveMidi.call(self, packId, name, uint8);
      return api('/api/midi', { method: 'POST', body: { name: name, dataBase64: toBase64(uint8), packId: packId } })
        .then(function (m) { return { packId: packId, name: name, id: m.id, url: '/api/midi/' + m.id }; });
    });
  };

  // The local store keys MIDI by name, the API by id, so look the id up first.
  CloudStorage.prototype.deleteMidi = function (packId, name) {
    var self = this;
    return this._cloud(packId).then(function (row) {
      if (!row) return Local.prototype.deleteMidi.call(self, packId, name);
      return self.listMidi(packId).then(function (rows) {
        var hit = rows.filter(function (m) { return m.name === name; })[0];
        if (!hit) return null;
        return api('/api/midi/' + encodeURIComponent(hit.id), { method: 'DELETE' });
      });
    });
  };

  window.EdStorageCloud = CloudStorage;

  // Install over the local adapter the editor made at boot. Safe unconditionally:
  // signed out, or with no API on this host, the cloud list is empty and every
  // method falls through to the local implementation it inherits.
  function install() {
    var ed = window.CyberEditor;
    if (!ed || !ed.storage || ed.storage instanceof CloudStorage) return !!ed;
    var next = new CloudStorage();
    next._canonical = ed.storage._canonical;
    next._manifests = ed.storage._manifests || {};
    ed.storage = next;
    return true;
  }
  if (apiPossible && !install()) {
    window.addEventListener('cybereditor-ready', install);
    var tries = 0;
    var poll = setInterval(function () { if (install() || ++tries > 100) clearInterval(poll); }, 100);
  }
})();
