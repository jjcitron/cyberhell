// One-off smoke test of preview3d.js inside the REAL editor.html shell
// (post-merge), not just the standalone harness. Ad hoc, not part of the
// repo's node test suite.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Dev/Tools/browserclaw-cli/node_modules/playwright-core');

const OUT = path.resolve('prototype_artifacts');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

await page.goto('http://localhost:5302/editor.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  hasEditor: !!window.CyberEditor,
  hasLevel: !!(window.CyberEditor && window.CyberEditor.level),
  hasPreview: !!window.__cyberPreview3DBooted,
  lastRebuildMs: window.__cyberPreview3DLastRebuildMs
}));
console.log('boot state', state);

await page.screenshot({ path: path.join(OUT, '_preview3d_realshell_boot.png') });

// try clicking a sector/wall in the 2D map to drive selection into the 3D panel
const mapCanvas = await page.$('canvas');
if (mapCanvas) {
  const box = await mapCanvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.waitForTimeout(500);
  }
}
await page.screenshot({ path: path.join(OUT, '_preview3d_realshell_selected.png') });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
