// Pack/level business rules shared by the endpoints: the static levelPacks fallback, the
// packs.json / manifest.json response shapes the game already understands, ownership checks,
// and content-addressed version writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './json.js';
import { getStore, newId, sha256 } from './store.js';
import { levelShape, slugify, validateLevelJson, MAX_LEVEL_BYTES } from './validate.js';

const repoFile = (...p) => path.join(process.cwd(), ...p);

export async function staticPacks() {
  try { return JSON.parse(await fs.readFile(repoFile('levelPacks', 'packs.json'), 'utf8')); }
  catch { return []; }
}

export async function staticManifest(packId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(packId || ''))) return null;
  try { return JSON.parse(await fs.readFile(repoFile('levelPacks', packId, 'manifest.json'), 'utf8')); }
  catch { return null; }
}

// GET /api/packs body. Same shape as levelPacks/packs.json, so index.html's loader is unchanged:
// { id, name, manifest, levelCount }. Canonical packs come from the store once the migration has
// run and from the repo copies until then; published community packs are appended.
export async function packsIndex() {
  const store = getStore();
  const all = await store.listPacks();
  const canonical = all.filter((p) => p.isCanonical).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const published = all.filter((p) => !p.isCanonical && p.published).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const out = [];
  if (canonical.length) {
    for (const p of canonical) {
      out.push({ id: p.id, name: p.name, manifest: `/api/packs/${p.id}`, levelCount: (await store.listLevels(p.id)).length });
    }
  } else {
    out.push(...await staticPacks());
  }
  for (const p of published) {
    out.push({ id: p.id, name: p.name, manifest: `/api/packs/${p.id}`, levelCount: (await store.listLevels(p.id)).length });
  }
  return out;
}

// GET /api/packs/:id body. Same shape as a pack manifest.json, with `file` pointing at
// /api/levels/:id/json so the game's existing level loader works unchanged.
export async function manifestFor(packId) {
  const store = getStore();
  const pack = await store.getPack(packId);
  if (!pack) {
    const stat = await staticManifest(packId);
    if (stat) return stat;
    throw new HttpError(404, 'Pack not found');
  }
  const levels = await store.listLevels(packId);
  const versions = new Map();
  for (const l of levels) {
    if (!l.currentVersionId) continue;
    const v = (await store.listVersions(l.id)).find((x) => x.id === l.currentVersionId);
    if (v) versions.set(l.id, v);
  }
  return levels.map((l) => {
    const v = versions.get(l.id);
    return {
      id: l.id,
      name: l.name,
      file: `/api/levels/${l.id}/json`,
      sectors: v?.sectors ?? 0,
      walls: v?.walls ?? 0,
      entities: v?.entities ?? 0,
    };
  });
}

// Admin edits anything; a creator edits only packs they own; canonical packs are admin-only.
export function assertCanEdit(pack, user) {
  if (!pack) throw new HttpError(404, 'Pack not found');
  if (user.isAdmin) return;
  if (pack.isCanonical) throw new HttpError(403, 'Canonical packs are admin-only.');
  if (pack.ownerId !== user.id) throw new HttpError(403, 'That pack belongs to someone else.');
}

// Shape check, size cap and shared-validator run, before anything is written. Callers that
// create a level must run this first so a rejected payload cannot leave an orphan level row.
export async function prepareLevel(json) {
  const counts = levelShape(json);
  const text = JSON.stringify(json);
  if (Buffer.byteLength(text) > MAX_LEVEL_BYTES) throw new HttpError(413, 'Level JSON is too large.');
  const report = await validateLevelJson(json);
  if (!report.ok) throw new HttpError(422, `Level failed validation: ${report.errors.join('; ')}`);
  return { counts, text, sha: sha256(text), warnings: report.warnings || [] };
}

// Content-address, store the payload, record a version and point the level at it.
export async function writeVersion(level, json, user, note, prepared) {
  const store = getStore();
  const { counts, text, sha, warnings } = prepared || await prepareLevel(json);
  const blob = await store.putPayload(sha, text);
  const version = {
    id: newId('v'),
    levelId: level.id,
    blobUrl: blob?.url || null,
    sha256: sha,
    bytes: Buffer.byteLength(text),
    ...counts,
    authorId: user?.id || null,
    note: note ? String(note).slice(0, 240) : null,
    createdAt: Date.now(),
  };
  await store.putVersion(version);
  await store.putLevel({ ...level, currentVersionId: version.id, updatedAt: Date.now() });
  return { version, warnings };
}

export async function createLevel({ packId, name, json, user, sort, note }) {
  const store = getStore();
  const prepared = await prepareLevel(json);
  const level = {
    id: newId('lvl'),
    packId,
    slug: slugify(name),
    name,
    sort: Number.isFinite(sort) ? sort : (await store.listLevels(packId)).length,
    currentVersionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.putLevel(level);
  const { version, warnings } = await writeVersion(level, json, user, note || 'created', prepared);
  return { level: { ...level, currentVersionId: version.id }, version, warnings };
}

// The raw level JSON behind a level's current (or a named) version.
export async function levelJson(levelId, versionId) {
  const store = getStore();
  const level = await store.getLevel(levelId);
  if (!level) throw new HttpError(404, 'Level not found');
  const versions = await store.listVersions(levelId);
  const version = versionId ? versions.find((v) => v.id === versionId) : versions.find((v) => v.id === level.currentVersionId) || versions[0];
  if (!version) throw new HttpError(404, 'Level has no saved version');
  const text = await store.getPayload(version.sha256);
  if (!text) throw new HttpError(404, 'Level payload missing');
  return { level, version, text };
}
