/* Editor "Validate" panel: quick-mode auto-run on every level-changed (debounced),
   a Full button for the reachability pass, a findings list grouped by severity
   that jumps the editor's selection to the offending object on click, and a
   stats footer. Classic script, no bundler -- mirrors the rest of js/editor/*.

   Waits for window.CyberEditor (built by a parallel lane) via the
   'cybereditor-ready' event, falling back to a short poll in case this script
   loads after that event already fired or the event is never dispatched. */
(function () {
  'use strict';

  var DEBOUNCE_MS = 300;
  var POLL_MS = 100;
  var POLL_GIVEUP = 200; // ~20s

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function whenReady(cb) {
    if (window.CyberEditor) { cb(window.CyberEditor); return; }
    var done = false;
    function fire() {
      if (done) return;
      done = true;
      window.removeEventListener('cybereditor-ready', fire);
      clearInterval(iv);
      cb(window.CyberEditor);
    }
    window.addEventListener('cybereditor-ready', fire);
    var tries = 0;
    var iv = setInterval(function () {
      if (window.CyberEditor) { fire(); return; }
      if (++tries > POLL_GIVEUP) clearInterval(iv);
    }, POLL_MS);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildUI(root) {
    root.innerHTML = '';
    var bar = el('div', 'lv-bar');
    var fullBtn = el('button', 'lv-full-btn', 'Full validate');
    var status = el('span', 'lv-status', '');
    bar.appendChild(fullBtn);
    bar.appendChild(status);

    var list = el('div', 'lv-findings');
    var stats = el('div', 'lv-stats');

    root.appendChild(bar);
    root.appendChild(list);
    root.appendChild(stats);

    return { fullBtn: fullBtn, status: status, list: list, stats: stats };
  }

  function findingRow(f, severity, Editor) {
    var row = el('div', 'lv-finding lv-' + severity);
    row.appendChild(el('span', 'lv-code', f.code));
    row.appendChild(el('span', 'lv-msg', f.msg));
    if (f.ref && f.ref.kind && f.ref.index >= 0 && typeof Editor.select === 'function') {
      row.title = 'Click to select ' + f.ref.kind + ' ' + f.ref.index;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () { Editor.select(f.ref.kind, f.ref.index); });
    }
    return row;
  }

  function render(ui, result, ranFull, Editor) {
    ui.list.innerHTML = '';
    if (!result) {
      ui.list.appendChild(el('div', 'lv-empty', 'No level loaded.'));
      return;
    }
    var errN = result.errors.length, warnN = result.warnings.length;
    if (!errN && !warnN) {
      ui.list.appendChild(el('div', 'lv-empty lv-clean', ranFull ? 'Full validate: clean.' : 'Quick validate: clean.'));
    } else {
      result.errors.forEach(function (f) { ui.list.appendChild(findingRow(f, 'error', Editor)); });
      result.warnings.forEach(function (f) { ui.list.appendChild(findingRow(f, 'warning', Editor)); });
    }

    var s = result.stats;
    ui.stats.textContent = 'sectors ' + s.sectors + '  walls ' + s.walls + '  entities ' + s.entities +
      '  triggers ' + s.triggers + (s.reachableFloorPct != null ? '  reachable floor ' + s.reachableFloorPct + '%' : '') +
      (ranFull ? '  (full)' : '  (quick)');

    if (typeof Editor.setStatus === 'function') {
      Editor.setStatus('validate', errN ? (errN + ' error' + (errN === 1 ? '' : 's')) : (warnN ? warnN + ' warning' + (warnN === 1 ? '' : 's') : 'OK'),
        errN ? 'error' : (warnN ? 'warning' : 'ok'));
    }
  }

  whenReady(function (Editor) {
    var LV = window.LevelValidate;
    if (!LV) { console.error('[validate_panel] window.LevelValidate not loaded -- include js/shared/level_validate.js first'); return; }

    var ui;
    Editor.registerPanel({
      id: 'validate',
      title: 'Validate',
      side: 'right',
      mount: function (mountEl) {
        ui = buildUI(mountEl);
        ui.fullBtn.addEventListener('click', runFull);
        return mountEl;
      }
    });

    function run(quick) {
      if (!ui || !Editor.level) return;
      var t0 = (window.performance || Date).now();
      var result = LV.validateLevel(Editor.level, { quick: quick });
      var ms = (window.performance || Date).now() - t0;
      ui.status.textContent = quick ? 'quick · ' + ms.toFixed(0) + 'ms' : 'full · ' + ms.toFixed(0) + 'ms';
      render(ui, result, !quick, Editor);
      if (typeof Editor.toast === 'function' && !quick) {
        Editor.toast(result.errors.length ? result.errors.length + ' validation error(s)' : 'Full validate passed');
      }
    }
    function runQuick() { run(true); }
    function runFull() { run(false); }

    var debouncedQuick = debounce(runQuick, DEBOUNCE_MS);
    Editor.on('level-loaded', runQuick);
    Editor.on('level-changed', debouncedQuick);
    if (Editor.level) runQuick();
  });
})();
