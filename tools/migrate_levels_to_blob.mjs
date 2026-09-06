// Seed the editor store from the repo's levelPacks/. The logic lives in api/_lib/migrate.js so the
// same code also runs server-side (POST /api/admin/migrate) where the Blob token exists.
//
//   node tools/migrate_levels_to_blob.mjs --dry-run          # report, write nothing
//   node tools/migrate_levels_to_blob.mjs --store=fs         # rehearse against .editor-data/
//   node tools/migrate_levels_to_blob.mjs                    # uses DATABASE_URL if set
//   node tools/migrate_levels_to_blob.mjs --pack=pack1       # one pack only
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

const dryRun = !!flag('dry-run');
const onlyPack = value('pack');
if (value('store')) process.env.EDITOR_STORE = value('store');
if (!process.env.SESSION_SECRET) process.env.CH_DEV = '1';

const { getStore } = await import('../api/_lib/store.js');
const { migrateCorpus } = await import('../api/_lib/migrate.js');
const store = getStore();
console.log(`migrate: store=${store.kind}${dryRun ? ' (dry run)' : ''}`);

const result = await migrateCorpus({
  store,
  dryRun,
  onlyPack,
  readText: (rel) => fs.readFile(path.join(ROOT, rel), 'utf8'),
  log: (line) => console.log(line),
});
console.log(`\n${result.levels} levels scanned -> ${result.created} created, ${result.updated} updated, ${result.skipped} unchanged.`);
if (dryRun) console.log('Dry run: nothing was written.');
