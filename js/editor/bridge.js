/* ===========================================================================
   bridge.js — Test in game.

   Writes the live level to IndexedDB (db 'cyberhell-editor', store 'drafts',
   key 'current') and opens index.html?draft=1, where the game's editor-bridge
   region reads it instead of a pack manifest.
   =========================================================================== */
(function () {
  'use strict';

  function install(ed) {
    ed.testInGame = function () {
      if (!ed.level) { ed.toast('no level open', 'bad'); return Promise.resolve(false); }
      // levelForGame folds the pack's enemy library in — the engine only ever
      // reads customEnemies off the level it is handed.
      var draft = ed.levelForGame();
      return ed.storage.putDraft(draft).then(function () {
        window.open('index.html?draft=1', '_blank');
        ed.toast('draft sent to the game', 'ok');
        return true;
      }).catch(function (err) {
        ed.toast('draft failed: ' + err.message, 'bad');
        return false;
      });
    };
  }

  window.EdBridge = { install: install };
})();
