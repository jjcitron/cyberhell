#!/usr/bin/env node
/**
 * CYBERHELL EDITOR-ENTRY QA (browser, headless)
 *
 * Proves the two UI halves of the main-screen-editor + shared-magic-link job, in a real page
 * rather than by reading the diff:
 *
 * QA-EE-1  index.html title screen shows a LEVEL EDITOR entry, it points at editor.html,
 *          and it is hidden once the overlay switches to pause/end mode (same overlay element).
 * QA-EE-2  Clicking it actually lands on the editor shell (window.CyberEditor exists).
 * QA-EE-3  A signed-out guest can open the editor and save; the save completes AND opens the
 *          Account tab with the magic-link form naming Cyberhell@games.acidlemon.com.
 * QA-EE-4  Neither page logs an uncaught error on the way through.
 *
 * Needs the dev API server on :5305 (auth_ui.js only talks to an API on https or :5305) and
 * playwright-core from the shared tools checkout. Run: node tests/qa-editor-entry.js
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const PW = process.env.PW_CORE ||
  'C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core';
const { chromium } = require(PW);

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.QA_PORT || 5305);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev_api_server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), EDITOR_DATA_DIR: path.join(ROOT, '.qa-editor-entry-data'), SESSION_SECRET: 'qa-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/packs`); if (r.ok) return child; } catch {}
    await wait(100);
  }
  child.kill();
  throw new Error('dev server did not start');
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  ctx.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(`${p.url()} :: ${e.message}`));
  });

  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#overlay-screen.mode-title', { timeout: 15000 });

    const btn = page.locator('#editor-btn');
    const visible = await btn.isVisible();
    const href = await btn.getAttribute('href');
    const label = (await btn.textContent() || '').trim();
    check('QA-EE-1a', visible && /editor\.html$/.test(href || ''),
      `visible=${visible} href=${href} label="${label}"`);

    // The overlay is reused for pause and the end card; the entry must not survive into them.
    const hiddenInPause = await page.evaluate(() => {
      const o = document.getElementById('overlay-screen');
      o.classList.remove('mode-title'); o.classList.add('mode-pause');
      const hidden = getComputedStyle(document.getElementById('editor-btn')).display === 'none';
      o.classList.remove('mode-pause'); o.classList.add('mode-title');
      return hidden;
    });
    check('QA-EE-1b', hiddenInPause, `hidden in pause mode = ${hiddenInPause}`);

    await Promise.all([page.waitForURL(/editor\.html/, { timeout: 20000 }), btn.click()]);
    await page.waitForFunction(() => !!window.CyberEditor, null, { timeout: 20000 });
    check('QA-EE-2', true, `landed on ${page.url()} with window.CyberEditor`);

    // Guest, signed out. Open a canonical level, then save-as into a local pack.
    await page.waitForFunction(() => !!(window.CyberAuth && window.CyberEditor.storage), null, { timeout: 20000 });
    const signedOut = await page.evaluate(() => window.CyberAuth.get().then((u) => u === null));
    check('QA-EE-3a', signedOut, `guest session: signed out = ${signedOut}`);

    const saved = await page.evaluate(async () => {
      const ed = window.CyberEditor;
      const packs = await ed.storage.listPacks();
      const canon = packs.find((p) => p.source === 'canonical');
      const full = await ed.storage.getPack(canon.id);
      await ed.openLevel(canon.id, full.levels[0].id);
      const pack = await ed.storage.createPack('Guest Pack');
      const r = await ed.saveLevelAs(pack.id, 'Guest Level (MAP01)');
      return { ok: !!r, canon: canon.name };
    });
    check('QA-EE-3b', saved.ok, `guest save completed (work not lost): ${JSON.stringify(saved)}`);

    // The prompt: Account tab selected, sign-in form up, sender named.
    await page.waitForTimeout(500);
    const panel = await page.evaluate(() => {
      const host = document.querySelector('#ed-panels .ed-panel:not([hidden]), #ed-panels .ed-panel.on');
      const text = document.getElementById('ed-panels').innerText || '';
      const toast = document.getElementById('ed-toasts').innerText || '';
      const emailInput = !!document.querySelector('#ed-panels input[type="email"]');
      return { text, toast, emailInput, hasHost: !!host };
    });
    const namesSender = panel.text.includes('Cyberhell@games.acidlemon.com');
    check('QA-EE-3c', panel.emailInput && namesSender,
      `magic-link form shown=${panel.emailInput}, sender named=${namesSender}`);
    check('QA-EE-3d', /[Ss]ign in/.test(panel.toast),
      `save toast: ${JSON.stringify(panel.toast.trim().slice(0, 120))}`);

    check('QA-EE-4', errors.length === 0, errors.length ? errors.join(' | ') : 'no uncaught page errors');
  } finally {
    await browser.close();
    server.kill();
    await require('fs/promises').rm(path.join(ROOT, '.qa-editor-entry-data'), { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
