import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../js/cyber-difficulty.js', import.meta.url), 'utf8');
function boot(saved = {}) {
  const store = new Map(Object.entries(saved));
  const window = { CyberAI: { TUNING: {}, setDifficulty(id) { this.id = id; this.TUNING.damageScale = 1.35; } } };
  vm.runInNewContext(source, { window, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) },
    document: { readyState: 'complete', querySelectorAll: () => [] } });
  return { D: window.CyberDifficulty, ai: window.CyberAI, store };
}
test('master preset and custom damage controls share state across reloads', () => {
  let {D, ai, store} = boot();
  let notifications = 0; D.subscribe(() => notifications++);
  D.set('hard');
  assert.equal(ai.id, 'hard'); assert.equal(ai.TUNING.damageScale, 1);
  assert.equal(D.taken(), 1.25); assert.equal(D.dealt(), .9);
  D.setCustom(2.5, .1);
  assert.equal(ai.id, 'normal'); assert.equal(ai.TUNING.damageScale, 1);
  assert.equal(D.get().id, 'custom'); assert.equal(notifications, 2);
  const reloaded = boot(Object.fromEntries(store));
  assert.equal(reloaded.D.dealt(), 2.5); assert.equal(reloaded.D.taken(), .1);
  reloaded.D.set('normal'); assert.equal(reloaded.D.dealt(), 1); assert.equal(reloaded.D.taken(), 1);
  assert.equal(boot(Object.fromEntries(reloaded.store)).D.get().id, 'normal');
});
test('legacy saves migrate; invalid custom damage cannot corrupt active state', () => {
  const {D} = boot({'cyberhell.difficulty': JSON.stringify({dealt:1.6,taken:.4})});
  assert.equal(D.dealt(), 1.6); assert.equal(D.taken(), .4);
  for (const [dealt,taken] of [[NaN,1],[Infinity,1],[.24,1],[3.01,1],[1,.09],[1,2.01],['2',1]]) D.setCustom(dealt,taken);
  assert.equal(D.dealt(), 1.6); assert.equal(D.taken(), .4);
  assert.equal(boot({'cyberhell.difficulty':'{"dealt":null,"taken":-1}'}).D.get().id, 'normal');
});
