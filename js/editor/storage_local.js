/* ===========================================================================
   storage_local.js — the local StorageAdapter (IndexedDB + fetch + files).

   Canonical packs are read-only: they come from fetch('levelPacks/packs.json')
   and each pack's manifest.json. Local packs live in IndexedDB. Editing a
   canonical level and saving forces a "Save as" into a local pack, or a
   "Save into repo" via the File System Access API.

   DB 'cyberhell-editor':
     drafts   key 'current'          -- the Test-in-game handoff (bridge.js)
     packs    key packId             -- {id,name,source:'local',levels:[{id,name,file}]}
     levels   key packId + '/' + id  -- {key, packId, levelId, json, updatedAt}
     enemies  key packId + '/' + id
     midi     key packId + '/' + name
   =========================================================================== */
(function () {
  'use strict';

  var DB_NAME = 'cyberhell-editor';
  var DB_VERSION = 1;
  var STORES = ['drafts', 'packs', 'levels', 'enemies', 'midi'];

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (s) { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var req = fn(t.objectStore(store));
        t.oncomplete = function () { db.close(); resolve(req && req.result); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  var idbGet = function (s, k) { return tx(s, 'readonly', function (o) { return o.get(k); }); };
  var idbPut = function (s, k, v) { return tx(s, 'readwrite', function (o) { return o.put(v, k); }); };
  var idbDel = function (s, k) { return tx(s, 'readwrite', function (o) { return o.delete(k); }); };
  var idbAll = function (s) { return tx(s, 'readonly', function (o) { return o.getAll(); }); };

  function slug(name) {
    return String(name || 'pack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pack';
  }

  function StorageAdapter() {
    this.backend = 'local';
    this._canonical = null;   // packs.json cache
    this._manifests = {};     // packId -> manifest array
  }

  /* ---- canonical (read-only, from the repo) ----------------------------- */

  StorageAdapter.prototype._canonicalPacks = function () {
    var self = this;
    if (this._canonical) return Promise.resolve(this._canonical);
    return fetch('levelPacks/packs.json').then(function (r) { return r.json(); })
      .then(function (packs) { self._canonical = packs; return packs; })
      .catch(function () { self._canonical = []; return []; });
  };

  StorageAdapter.prototype._manifest = function (packId) {
    var self = this;
    if (this._manifests[packId]) return Promise.resolve(this._manifests[packId]);
    return this._canonicalPacks().then(function (packs) {
      var p = packs.filter(function (x) { return x.id === packId; })[0];
      if (!p) return [];
      return fetch(p.manifest).then(function (r) { return r.json(); }).then(function (m) {
        self._manifests[packId] = m;
        return m;
      });
    });
  };

  /* ---- pack list -------------------------------------------------------- */

  StorageAdapter.prototype.listPacks = function () {
    return Promise.all([this._canonicalPacks(), idbAll('packs')]).then(function (res) {
      var canon = (res[0] || []).map(function (p) {
        return { id: p.id, name: p.name, levelCount: p.levelCount, source: 'canonical' };
      });
      var local = (res[1] || []).map(function (p) {
        return { id: p.id, name: p.name, levelCount: (p.levels || []).length, source: 'local' };
      });
      return canon.concat(local);
    });
  };

  StorageAdapter.prototype.getPack = function (id) {
    var self = this;
    return idbGet('packs', id).then(function (local) {
      if (local) return local;
      return self._canonicalPacks().then(function (packs) {
        var p = packs.filter(function (x) { return x.id === id; })[0];
        if (!p) return null;
        return self._manifest(id).then(function (m) {
          return {
            id: id, name: p.name, source: 'canonical',
            levels: m.map(function (l) { return { id: l.id, name: l.name, file: l.file }; })
          };
        });
      });
    });
  };

  StorageAdapter.prototype.loadLevel = function (packId, levelId) {
    var self = this;
    return idbGet('levels', packId + '/' + levelId).then(function (rec) {
      if (rec) return rec.json;
      return self.getPack(packId).then(function (pack) {
        if (!pack) throw new Error('unknown pack ' + packId);
        var entry = (pack.levels || []).filter(function (l) { return l.id === levelId; })[0];
        if (!entry) throw new Error('unknown level ' + levelId);
        return fetch(entry.file).then(function (r) { return r.json(); });
      });
    });
  };

  /* ---- writes (local packs only) ---------------------------------------- */

  StorageAdapter.prototype._assertLocal = function (packId) {
    return idbGet('packs', packId).then(function (p) {
      if (!p) throw new Error('pack "' + packId + '" is canonical (read-only). Use Save as, or Save into repo.');
      return p;
    });
  };

  StorageAdapter.prototype.saveLevel = function (packId, levelId, json, opts) {
    var self = this;
    return this._assertLocal(packId).then(function (pack) {
      var known = (pack.levels || []).some(function (l) { return l.id === levelId; });
      if (!known) {
        pack.levels = pack.levels || [];
        pack.levels.push({ id: levelId, name: json.name || levelId, file: 'local:' + packId + '/' + levelId });
      } else {
        pack.levels.forEach(function (l) { if (l.id === levelId) l.name = json.name || l.name; });
      }
      var versionId = String(Date.now());
      return idbPut('levels', packId + '/' + levelId, {
        packId: packId, levelId: levelId, json: json, versionId: versionId,
        note: (opts && opts.note) || '', updatedAt: Date.now()
      }).then(function () { return idbPut('packs', packId, pack); })
        .then(function () { return { levelId: levelId, versionId: versionId }; });
    });
  };

  StorageAdapter.prototype.saveLevelAs = function (packId, name, json) {
    var self = this;
    return this._assertLocal(packId).then(function (pack) {
      var base = slug(name) || 'level';
      var id = base, n = 2;
      var taken = {};
      (pack.levels || []).forEach(function (l) { taken[l.id] = true; });
      while (taken[id]) id = base + '-' + (n++);
      var copy = JSON.parse(JSON.stringify(json));
      copy.name = name;
      return self.saveLevel(packId, id, copy, { note: 'save as' });
    });
  };

  StorageAdapter.prototype.createPack = function (name) {
    var base = 'local-' + slug(name);
    return idbAll('packs').then(function (packs) {
      var taken = {};
      (packs || []).forEach(function (p) { taken[p.id] = true; });
      var id = base, n = 2;
      while (taken[id]) id = base + '-' + (n++);
      return idbPut('packs', id, { id: id, name: name, source: 'local', levels: [] })
        .then(function () { return { id: id }; });
    });
  };

  StorageAdapter.prototype.renamePack = function (id, name) {
    return this._assertLocal(id).then(function (p) { p.name = name; return idbPut('packs', id, p); });
  };

  StorageAdapter.prototype.deletePack = function (id) {
    return this._assertLocal(id).then(function (p) {
      return Promise.all((p.levels || []).map(function (l) { return idbDel('levels', id + '/' + l.id); }))
        .then(function () { return idbDel('packs', id); });
    });
  };

  StorageAdapter.prototype.reorderLevels = function (packId, ids) {
    return this._assertLocal(packId).then(function (p) {
      var byId = {};
      (p.levels || []).forEach(function (l) { byId[l.id] = l; });
      var out = [];
      ids.forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
      Object.keys(byId).forEach(function (k) { out.push(byId[k]); });
      p.levels = out;
      return idbPut('packs', packId, p);
    });
  };

  StorageAdapter.prototype.deleteLevel = function (packId, levelId) {
    return this._assertLocal(packId).then(function (p) {
      p.levels = (p.levels || []).filter(function (l) { return l.id !== levelId; });
      return idbDel('levels', packId + '/' + levelId).then(function () { return idbPut('packs', packId, p); });
    });
  };

  /* ---- enemies / midi (other lanes consume these) ------------------------ */

  function scopedList(store, packId) {
    return tx(store, 'readonly', function (o) { return o.getAll(); }).then(function (rows) {
      return (rows || []).filter(function (r) { return !packId || r.packId === packId; });
    });
  }

  StorageAdapter.prototype.listEnemies = function (packId) { return scopedList('enemies', packId); };
  StorageAdapter.prototype.saveEnemy = function (packId, def) {
    var id = def.id || ('enemy-' + Date.now());
    def.id = id;
    return idbPut('enemies', packId + '/' + id, { packId: packId, id: id, def: def }).then(function () { return def; });
  };
  StorageAdapter.prototype.deleteEnemy = function (packId, id) { return idbDel('enemies', packId + '/' + id); };

  StorageAdapter.prototype.listMidi = function (packId) { return scopedList('midi', packId); };
  StorageAdapter.prototype.saveMidi = function (packId, name, uint8) {
    return idbPut('midi', packId + '/' + name, { packId: packId, name: name, bytes: uint8, updatedAt: Date.now() })
      .then(function () { return { packId: packId, name: name }; });
  };
  StorageAdapter.prototype.deleteMidi = function (packId, name) { return idbDel('midi', packId + '/' + name); };

  /* ---- files ------------------------------------------------------------ */

  StorageAdapter.prototype.exportLevel = function (json) {
    var text = JSON.stringify(json, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slug(json.name) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    return Promise.resolve(a.download);
  };

  StorageAdapter.prototype.importLevelFile = function (file) {
    return file.text().then(function (t) { return JSON.parse(t); });
  };

  /* Writes a whole local pack into a folder the user picks — that folder is
     meant to be levelPacks/<pack>. Chromium only (File System Access API). */
  function writeJson(dir, name, value) {
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(JSON.stringify(value, null, 2)).then(function () { return w.close(); }); });
  }

  function readJson(dir, name) {
    return dir.getFileHandle(name)
      .then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .then(function (t) { return JSON.parse(t); })
      .catch(function () { return null; });
  }

  /* Writes a local pack into the repo. The user picks the levelPacks FOLDER (not
     the pack folder) so this can create a new pack directory and keep
     packs.json in step -- the game reads packs.json first, so a pack that is
     missing from it is invisible however good its files are. */
  StorageAdapter.prototype.saveIntoRepo = function (packId) {
    var self = this;
    if (!window.showDirectoryPicker) return Promise.reject(new Error('File System Access API not available in this browser'));
    return this.getPack(packId).then(function (pack) {
      if (!pack) throw new Error('unknown pack');
      return window.showDirectoryPicker({ mode: 'readwrite', id: 'cyberhell-levelpacks' }).then(function (root) {
        return root.getDirectoryHandle(packId, { create: true }).then(function (dir) {
          var manifest = [];
          var chain = Promise.resolve();
          (pack.levels || []).forEach(function (entry) {
            chain = chain.then(function () {
              return self.loadLevel(packId, entry.id).then(function (json) {
                var fileName = entry.id + '.json';
                manifest.push({
                  id: entry.id, name: json.name || entry.name,
                  file: 'levelPacks/' + packId + '/' + fileName,
                  sectors: (json.sectors || []).length,
                  walls: (json.walls || []).length,
                  entities: (json.entities || []).length
                });
                return writeJson(dir, fileName, json);
              });
            });
          });
          return chain
            .then(function () { return writeJson(dir, 'manifest.json', manifest); })
            .then(function () { return readJson(root, 'packs.json'); })
            .then(function (packs) {
              packs = Array.isArray(packs) ? packs : [];
              var row = {
                id: packId, name: pack.name,
                manifest: 'levelPacks/' + packId + '/manifest.json',
                levelCount: manifest.length
              };
              var at = packs.findIndex ? packs.findIndex(function (x) { return x.id === packId; }) : -1;
              if (at >= 0) packs[at] = Object.assign({}, packs[at], row);
              else packs.push(row);
              return writeJson(root, 'packs.json', packs).then(function () { return packs.length; });
            })
            .then(function (packCount) {
              return { files: manifest.length + 2, packs: packCount, pack: packId };
            });
        });
      });
    });
  };

  /* Draft handoff used by bridge.js and index.html's ?draft=1 boot. */
  StorageAdapter.prototype.putDraft = function (json) { return idbPut('drafts', 'current', json); };
  StorageAdapter.prototype.getDraft = function () { return idbGet('drafts', 'current'); };

  window.EdStorageLocal = StorageAdapter;
})();
