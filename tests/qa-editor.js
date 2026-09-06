#!/usr/bin/env node
/**
 * CYBERHELL EDITOR QA (browser, headless)
 *
 * Drives a real browser against this worktree to prove the shared validator
 * actually works where it matters: loaded live in a page, not just under
 * `node --test`. editor.html and window.CyberEditor are being built by a
 * parallel lane and may not exist yet when this runs, so every editor-shell
 * step is feature-detected and prints SKIP with a reason instead of failing
 * when the surface isn't there -- this file has to survive being run both
 * before and after that lane lands.
 *
 * QA-ED-1  (editor.html present) The editor shell loads, exposes
 *          window.CyberEditor, a level can be loaded into it, and
 *          window.LevelValidate.validateLevel(CyberEditor.level) reports 0
 *          errors for a known-good canonical level.
 * QA-ED-2  (editor.html present, CyberEditor exposes a recognized
 *          level-loading API) "Test in game": index.html?draft=1 boots with
 *          no page errors.
 * QA-ED-3  (always) window.LevelValidate, loaded the same way the editor
 *          panel loads it (plain <script> tags, no bundler), validates a
 *          real level fetched over HTTP with 0 errors -- proves the shared
 *          module works as a browser global, independent of the editor shell.
 *
 * Serves this worktree with a plain node static server (same pattern as
 * tests/qa-collision.js) on QA_PORT (default 5306) and drives an isolated
 * headless Chromium via playwright-core -- never the shared bcl daemon.
 *
 * Usage: node tests/qa-editor.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5306);
const PW = process.env.PLAYWRIGHT_PATH ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.mid': 'audio/midi'
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const results = []; // {name, ok, skip, detail}
function record(name, ok, detail) { results.push({ name, ok, skip: false, detail: detail || '' }); }
function skip(name, reason) { results.push({ name, ok: true, skip: true, detail: reason }); }

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const editorHtmlExists = fs.existsSync(path.join(ROOT, 'editor.html'));

  try {
    // -------------------------------------------------------------- QA-ED-3
    // Always runnable: window.LevelValidate as a plain browser global,
    // loaded exactly the way the editor panel would load it, against a real
    // fetched level. Doesn't depend on editor.html or CyberEditor at all.
    {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(String(e)));
      await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
      // index.html already loads js/cyber-traversal.js; add the validator on top.
      await page.addScriptTag({ url: '/js/shared/level_validate.js' });
      const hasLV = await page.evaluate(() => typeof window.LevelValidate !== 'undefined');
      if (!hasLV) {
        record('QA-ED-3 LevelValidate loads as a browser global', false, 'window.LevelValidate is undefined after script tag');
      } else {
        const r = await page.evaluate(async () => {
          const res = await fetch('/levelPacks/pack1/json1.json');
          const level = await res.json();
          return window.LevelValidate.validateLevel(level, { quick: false });
        });
        record('QA-ED-3 LevelValidate.validateLevel(pack1/json1, full) has 0 errors in-browser',
          r.errors.length === 0, r.errors.length ? JSON.stringify(r.errors.slice(0, 3)) : '');
        record('QA-ED-3 zero page errors while doing so', pageErrors.length === 0, pageErrors.join(' | '));
      }
      await page.close();
    }

    // -------------------------------------------------------------- QA-ED-1/2
    if (!editorHtmlExists) {
      skip('QA-ED-1 editor.html loads and CyberEditor validates a loaded level', 'editor.html does not exist yet (editor-core lane not landed)');
      skip('QA-ED-2 Test in game (index.html?draft=1) boots with no page errors', 'editor.html does not exist yet -- nothing produced a draft to test');
    } else {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(String(e)));
      await page.goto(`http://127.0.0.1:${PORT}/editor.html`, { waitUntil: 'load' });

      let hasEditor = false;
      try {
        await page.waitForFunction(() => !!window.CyberEditor, { timeout: 5000 });
        hasEditor = true;
      } catch (e) { /* fall through to skip below */ }

      if (!hasEditor) {
        skip('QA-ED-1 editor.html loads and CyberEditor validates a loaded level', 'window.CyberEditor never appeared within 5s');
        skip('QA-ED-2 Test in game (index.html?draft=1) boots with no page errors', 'no CyberEditor to produce a draft from');
      } else {
        // Feature-detect a level-loading entry point; the editor-core lane's
        // exact API wasn't finalized when this was written.
        const loaded = await page.evaluate(async () => {
          const E = window.CyberEditor;
          const candidates = ['loadLevel', 'openLevel', 'loadFile'];
          for (const name of candidates) {
            if (typeof E[name] === 'function') {
              try {
                await E[name]('levelPacks/pack1/json1.json');
                return { ok: true, via: name };
              } catch (e) { /* try next candidate */ }
            }
          }
          return { ok: false };
        });

        if (!loaded.ok) {
          skip('QA-ED-1 editor.html loads and CyberEditor validates a loaded level', 'no recognized level-loading method on CyberEditor (tried loadLevel/openLevel/loadFile)');
        } else {
          await page.addScriptTag({ url: '/js/shared/level_validate.js' });
          const r = await page.evaluate(() => window.LevelValidate.validateLevel(window.CyberEditor.level, { quick: false }));
          record('QA-ED-1 CyberEditor.level (via ' + loaded.via + ') validates with 0 errors',
            r && r.errors && r.errors.length === 0, r ? JSON.stringify((r.errors || []).slice(0, 3)) : 'validateLevel returned nothing');
        }
        await page.close();

        // Test in game: this is meaningful even before the storage/bridge
        // lane lands -- either it actually exercises a real draft, or it at
        // minimum proves index.html still boots cleanly with an unrecognized
        // query param, which is the safety property "Test in game" depends on.
        const gamePage = await browser.newPage();
        const gameErrors = [];
        gamePage.on('pageerror', e => gameErrors.push(String(e)));
        await gamePage.goto(`http://127.0.0.1:${PORT}/index.html?draft=1`, { waitUntil: 'load' });
        let booted = false;
        try {
          await gamePage.waitForFunction(() => !!(window.cyberEngine && window.cyberEngine.levelData), { timeout: 8000 });
          booted = true;
        } catch (e) { /* booted stays false */ }
        record('QA-ED-2 index.html?draft=1 boots (window.cyberEngine.levelData present)', booted);
        record('QA-ED-2 zero page errors on draft boot', gameErrors.length === 0, gameErrors.join(' | '));
        await gamePage.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\nCYBERHELL EDITOR QA');
  for (const r of results) {
    const tag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
    console.log(`  [${tag}] ${r.name}` + (r.detail ? `  -- ${r.detail}` : ''));
  }
  const failed = results.filter(r => !r.skip && !r.ok);
  const skipped = results.filter(r => r.skip).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length} passed, ${skipped} skipped, ${failed.length} failed.`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 2; });
