// Ad-hoc QA driver for the preview3d harness. Not part of the repo's node
// test suite (no npm deps of its own) -- run manually against the http
// server on 5302, screenshots go to prototype_artifacts/.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core');

const OUT = path.resolve('prototype_artifacts');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });
page.on('requestfailed', req => errors.push('requestfailed: ' + req.url() + ' ' + (req.failure()?.errorText || '')));

await page.goto('http://localhost:5302/tests/preview3d-harness.html', { waitUntil: 'load' });

// Polls window.__previewEvents (populated by a listener registered at page
// load, before any action) instead of attaching a fresh listener per call --
// attaching after the action races the 60ms debounce and misses fast events.
async function waitForNextRebuild(sinceCount, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await page.evaluate(() => window.__previewEvents);
    if (events.length > sinceCount) return events[events.length - 1];
    await page.waitForTimeout(20);
  }
  return null;
}
function eventCount() { return page.evaluate(() => window.__previewEvents.length); }

// --- 1. small level auto-loaded on boot ---
const small = await waitForNextRebuild(0);
console.log('pack1/json1 rebuild:', small);
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, '_preview3d_pack1_json1.png') });

// --- click to select something, verify highlight + selection callback ---
await page.mouse.click(700, 400);
await page.waitForTimeout(600);
const statusAfterClick = await page.textContent('#status');
console.log('status after click:', statusAfterClick);
await page.screenshot({ path: path.join(OUT, '_preview3d_pack1_json1_selected.png') });

// --- top-down toggle ---
await page.click('text=Top-down');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '_preview3d_pack1_json1_topdown.png') });
await page.click('text=Top-down');

// --- jump to spawn ---
await page.click('text=Jump to spawn');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '_preview3d_pack1_json1_spawn.png') });

// --- mutate -> debounced incremental rebuild ---
const beforeMutate = await eventCount();
const mutateStart = Date.now();
await page.click('text=Mutate level (fire level-changed)');
const mutateResult = await waitForNextRebuild(beforeMutate);
console.log('incremental rebuild after mutate:', mutateResult, 'wall-clock ms:', Date.now() - mutateStart);

// --- 2. biggest level: dv/json2 (2229 sectors, 20461 walls, 4681 entities) ---
const beforeBig = await eventCount();
const bigStart = Date.now();
await page.click('text=Load dv / json2 (biggest)');
const big = await waitForNextRebuild(beforeBig, 30000);
console.log('dv/json2 rebuild:', big, 'wall-clock ms:', Date.now() - bigStart);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '_preview3d_dv_json2.png') });

await page.click('text=Top-down');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, '_preview3d_dv_json2_topdown.png') });

console.log('---');
console.log('page errors:', errors.length ? errors : 'none');

await browser.close();
process.exit(errors.length ? 1 : 0);
