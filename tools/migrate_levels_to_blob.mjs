// Seed the editor store from the repo's levelPacks/: one canonical pack per packs.json entry,
// one level per manifest entry, one content-addressed version per level, plus a copy of the raw
// JSON at canonical/<pack>/<file>. Idempotent -- a level whose payload already matches its
// current version is skipped, so re-running after adding a pack only writes the new work.
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

const { getStore, sha256 } = await import('../api/_lib/store.js');
const store = getStore();

console.log(`migrate: store=${store.kind}${dryRun ? ' (dry run)' : ''}`);
if (!dryRun) await store.init();

const packs = JSON.parse(await fs.readFile(path.join(ROOT, 'levelPacks', 'packs.json'), 'utf8'));
let created = 0, updated = 0, skipped = 0, levels = 0;

for (const [packIndex, entry] of packs.entries()) {
  if (onlyPack && entry.id !== onlyPack) continue;
  const manifestPath = path.join(ROOT, entry.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  console.log(`\n${entry.id}  ${entry.name}  (${manifest.length} levels)`);

  const pack = {
    id: entry.id,
    slug: entry.id,
    name: entry.name,
    ownerId: null,
    isCanonical: true,
    published: true,
    sort: packIndex,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!dryRun) await store.putPack(pack);

  for (const [levelIndex, item] of manifest.entries()) {
    const text = await fs.readFile(path.join(ROOT, item.file), 'utf8');
    const json = JSON.parse(text);
    const canonical = JSON.stringify(json);
    const sha = sha256(canonical);
    // Deterministic id so re-running updates the same row instead of duplicating it.
    const levelId = `${entry.id}__${item.id}`;
    levels++;

    if (dryRun) { console.log(`  + ${levelId}  ${sha.slice(0, 12)}  ${Buffer.byteLength(canonical)}B`); created++; continue; }

    const existing = await store.getLevel(levelId);
    const current = existing?.currentVersionId
      ? (await store.listVersions(levelId)).find((v) => v.id === existing.currentVersionId)
      : null;
    if (current?.sha256 === sha) { skipped++; continue; }

    const blob = await store.putPayload(sha, canonical);
    await store.putCanonical(`canonical/${entry.id}/${path.basename(item.file)}`, canonical);
    const level = {
      id: levelId,
      packId: entry.id,
      slug: item.id,
      name: item.name,
      sort: levelIndex,
      currentVersionId: null,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await store.putLevel(level);
    const version = {
      id: `${levelId}__${sha.slice(0, 12)}`,
      levelId,
      blobUrl: blob?.url || null,
      sha256: sha,
      bytes: Buffer.byteLength(canonical),
      sectors: item.sectors ?? (json.sectors?.length || 0),
      walls: item.walls ?? (json.walls?.length || 0),
      entities: item.entities ?? (json.entities?.length || 0),
      authorId: null,
      note: 'migrated from levelPacks/',
      createdAt: Date.now(),
    };
    await store.putVersion(version);
    await store.putLevel({ ...level, currentVersionId: version.id });
    if (existing) updated++; else created++;
  }
  console.log(`  done: ${created} new, ${updated} updated, ${skipped} unchanged`);
}

console.log(`\n${levels} levels scanned -> ${created} created, ${updated} updated, ${skipped} unchanged.`);
if (dryRun) console.log('Dry run: nothing was written.');
