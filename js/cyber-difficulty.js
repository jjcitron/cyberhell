/* Difficulty slider (ported from the beat 'em up, /workspace/beatemup src/main.js @ 52f8d2a, Oct 15).
   Five steps. Each picks a CyberAI aggression preset (attackers allowed at once, hitscan accuracy,
   wake reaction, burst size) and two multipliers the engine applies live:
     taken  x damage the player takes   (CyberDoomEngine.damagePlayer)
     dealt  x damage the player deals   (damageEnemy + barrel blasts), i.e. enemy health is
            effectively hp / dealt, and it follows the slider mid-level.
   NORMAL is the default and is exactly the pre-slider game: CyberAI 'normal' == its stock TUNING,
   taken 1, dealt 1. The AI preset's own damageScale is pinned to 1 so damage is scaled once, here.
   Stored in localStorage 'cyberhell-difficulty'. The slider sits in #overlay-screen, which is both
   the title screen and the pause menu. */
(function () {
  var DIFFS = [
    { id: 'story',     name: 'STORY',     ai: 'easy',      taken: 0.4,  dealt: 1.7,  note: 'just the tale' },
    { id: 'easy',      name: 'EASY',      ai: 'easy',      taken: 0.7,  dealt: 1.35, note: 'gentler' },
    { id: 'normal',    name: 'NORMAL',    ai: 'normal',    taken: 1.0,  dealt: 1.0,  note: 'default' },
    { id: 'hard',      name: 'HARD',      ai: 'hard',      taken: 1.25, dealt: 0.9,  note: 'Cyberhell hard' },
    { id: 'nightmare', name: 'NIGHTMARE', ai: 'nightmare', taken: 1.6,  dealt: 0.8,  note: 'Cyberhell nightmare' }
  ];
  var KEY = 'cyberhell-difficulty', DEFAULT = 2;
  var idx = DEFAULT, custom = null, listeners = [];
  try { var v = localStorage.getItem(KEY), i = DIFFS.findIndex(function (d) { return d.id === v; }); if (i >= 0) idx = i; } catch (e) {}
  // Migrate the branch's damage controls into the same state as the master slider.
  try {
    if (!v || v === 'custom') {
      var saved = JSON.parse(localStorage.getItem('cyberhell.difficulty'));
      if (saved && valid(saved.dealt, 0.25, 3) && valid(saved.taken, 0.1, 2)) custom = manual(saved.dealt, saved.taken);
    }
  } catch (e) {}

  function valid(n, min, max) { return typeof n === 'number' && isFinite(n) && n >= min && n <= max; }
  function manual(dealt, taken) { return { id: 'custom', name: 'CUSTOM', ai: 'normal', dealt: dealt, taken: taken, note: 'damage controls' }; }
  function cur() { return custom || DIFFS[idx]; }
  function applyAI() {
    var A = window.CyberAI;
    if (!A || !A.setDifficulty) return;
    A.setDifficulty(cur().ai);
    if (A.TUNING) A.TUNING.damageScale = 1;
  }
  function sync(el) {
    var D = cur();
    el.querySelector('input').value = idx;
    el.querySelector('.dn').textContent = D.name;
    el.querySelector('.dd').textContent = 'damage taken \u00d7' + D.taken + ' \u00b7 dealt \u00d7' + D.dealt + ' \u00b7 ' + D.note;
  }
  function set(i) {
    if (typeof i === 'string') i = DIFFS.findIndex(function (d) { return d.id === i; });
    idx = Math.max(0, Math.min(DIFFS.length - 1, i | 0));
    custom = null;
    return changed();
  }
  function changed() {
    try { localStorage.setItem(KEY, cur().id); } catch (e) {}
    try { localStorage.setItem('cyberhell.difficulty', JSON.stringify({ dealt: cur().dealt, taken: cur().taken })); } catch (e) {}
    applyAI();
    document.querySelectorAll('.diffSlider').forEach(sync);
    listeners.forEach(function (fn) { fn(); });
    return cur();
  }
  function setCustom(dealt, taken) {
    if (!valid(dealt, 0.25, 3) || !valid(taken, 0.1, 2)) return cur();
    custom = manual(dealt, taken);
    return changed();
  }
  function mount(el) {
    el.classList.add('diffSlider');
    el.innerHTML = '<label>DIFFICULTY <b class="dn"></b> <small class="dd"></small></label>' +
      '<input type="range" min="0" max="' + (DIFFS.length - 1) + '" step="1" aria-label="Difficulty">' +
      '<div class="dl">' + DIFFS.map(function (d) { return '<span>' + d.name + '</span>'; }).join('') + '</div>';
    var inp = el.querySelector('input');
    inp.addEventListener('input', function () { set(+inp.value); });
    inp.addEventListener('change', function () { set(+inp.value); });
    // Keep the overlay's own tap/click/key handlers (start, resume, touch look) off the slider.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'keydown'].forEach(function (t) {
      el.addEventListener(t, function (ev) { ev.stopPropagation(); }, { passive: true });
    });
    sync(el);
  }

  window.CyberDifficulty = {
    LEVELS: DIFFS, get: cur, set: set, setCustom: setCustom, mount: mount, applyAI: applyAI,
    subscribe: function (fn) { listeners.push(fn); },
    taken: function () { return cur().taken; },
    dealt: function () { return cur().dealt; }
  };
  function boot() { applyAI(); document.querySelectorAll('[data-diff-slider]').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
