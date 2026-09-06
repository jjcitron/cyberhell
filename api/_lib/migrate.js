// Seed the editor store from the level corpus: one canonical pack per packs.json entry, one level
// per manifest entry, one content-addressed version per level, plus a copy of the raw JSON at
// canonical/<pack>/<file>. Idempotent -- a level whose payload already matches its current version
// is skipped. The corpus is read through `readText(relPath)` so the same code runs from the repo
// (tools/migrate_levels_to_blob.mjs) and from a Vercel function that fetches its own static files
// (api/admin/migrate.js), which is where the Blob token actually lives.
import { sha256 } from './store.js';

const baseName = (p) => p.split('/').pop();

export async function migrateCorpus({ store, readText, dryRun = false, onlyPack = null, log = () => {} }) {
  if (!dryRun) await store.init();
  const packs = JSON.parse(await readText('levelPacks/packs.json'));
  let created = 0, updated = 0, skipped = 0, levels = 0;
  const perPack = [];

  for (const [packIndex, entry] of packs.entries()) {
    if (onlyPack && entry.id !== onlyPack) continue;
    const manifest = JSON.parse(await readText(entry.manifest));
    log(`${entry.id}  ${entry.name}  (${manifest.length} levels)`);
    const before = { created, updated, skipped };

    const pack = {
      id: entry.id, slug: entry.id, name: entry.name, ownerId: null, isCanonical: true,
      published: true, sort: packIndex, createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (!dryRun) await store.putPack(pack);

    for (const [levelIndex, item] of manifest.entries()) {
      const json = JSON.parse(await readText(item.file));
      const canonical = JSON.stringify(json);
      const sha = sha256(canonical);
      const levelId = `${entry.id}__${item.id}`;
      levels++;

      if (dryRun) { log(`  + ${levelId}  ${sha.slice(0, 12)}  ${Buffer.byteLength(canonical)}B`); created++; continue; }

      const existing = await store.getLevel(levelId);
      const current = existing?.currentVersionId
        ? (await store.listVersions(levelId)).find((v) => v.id === existing.currentVersionId)
        : null;
      if (current?.sha256 === sha) { skipped++; continue; }

      const blob = await store.putPayload(sha, canonical);
      await store.putCanonical(`canonical/${entry.id}/${baseName(item.file)}`, canonical);
      const level = {
        id: levelId, packId: entry.id, slug: item.id, name: item.name, sort: levelIndex,
        currentVersionId: null, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(),
      };
      await store.putLevel(level);
      const version = {
        id: `${levelId}__${sha.slice(0, 12)}`, levelId, blobUrl: blob?.url || null, sha256: sha,
        bytes: Buffer.byteLength(canonical),
        sectors: item.sectors ?? (json.sectors?.length || 0),
        walls: item.walls ?? (json.walls?.length || 0),
        entities: item.entities ?? (json.entities?.length || 0),
        authorId: null, note: 'migrated from levelPacks/', createdAt: Date.now(),
      };
      await store.putVersion(version);
      await store.putLevel({ ...level, currentVersionId: version.id });
      if (existing) updated++; else created++;
    }
    perPack.push({ id: entry.id, created: created - before.created, updated: updated - before.updated, skipped: skipped - before.skipped });
    log(`  done: ${created} new, ${updated} updated, ${skipped} unchanged`);
  }
  return { levels, created, updated, skipped, perPack, dryRun };
}
