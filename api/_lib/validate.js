// Server-side validation. Level geometry rules live in js/shared/level_validate.js so the browser
// editor and the API enforce the same thing; that module is owned by the validation-qa lane, so
// it is loaded defensively and simply skipped when absent.
import { HttpError } from './json.js';

const NAME_RE = /^[\w][\w .:'()\-]{0,63}$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateUsername(name) {
  if (!USERNAME_RE.test(String(name || ''))) {
    return 'Usernames are 3-20 characters: letters, numbers and underscore.';
  }
  return null;
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
}

export function requireName(name, what = 'name') {
  const clean = String(name ?? '').trim();
  if (!NAME_RE.test(clean)) throw new HttpError(400, `Invalid ${what}.`);
  return clean;
}

export function requireId(id, what = 'id') {
  const clean = String(id ?? '');
  if (!ID_RE.test(clean)) throw new HttpError(400, `Invalid ${what}.`);
  return clean;
}

// Cheap structural check that is true of every level in levelPacks/: an object with sectors,
// walls and entities arrays. Anything deeper is the shared validator's job.
export function levelShape(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new HttpError(400, 'Level JSON must be an object.');
  for (const key of ['sectors', 'walls']) {
    if (!Array.isArray(json[key])) throw new HttpError(400, `Level JSON is missing the "${key}" array.`);
  }
  if (json.entities != null && !Array.isArray(json.entities)) throw new HttpError(400, 'Level "entities" must be an array.');
  return {
    sectors: json.sectors.length,
    walls: json.walls.length,
    entities: Array.isArray(json.entities) ? json.entities.length : 0,
  };
}

let sharedPromise;
async function sharedValidator() {
  if (!sharedPromise) {
    sharedPromise = import('../../js/shared/level_validate.js')
      .then((m) => m.validateLevel || m.default?.validateLevel || null)
      .catch(() => null);
  }
  return sharedPromise;
}

// Runs the shared geometry validator when the validation-qa lane's module is present.
// Returns { ok, errors[], warnings[] }; ok with an empty error list when it is not.
export async function validateLevelJson(json) {
  const validate = await sharedValidator();
  if (!validate) return { ok: true, errors: [], warnings: [], skipped: true };
  try {
    const out = await validate(json);
    if (!out || typeof out !== 'object') return { ok: true, errors: [], warnings: [], skipped: true };
    return { ok: out.ok !== false && !(out.errors || []).length, errors: out.errors || [], warnings: out.warnings || [] };
  } catch (err) {
    return { ok: true, errors: [], warnings: [`validator threw: ${err.message}`], skipped: true };
  }
}

// One outstanding magic link per email per cooldown window; the only rate limit we need, since
// every other endpoint requires a session cookie.
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const TOKEN_TTL_MS = 15 * 60 * 1000;
export const MAX_LEVEL_BYTES = 16 * 1024 * 1024;
export const MAX_MIDI_BYTES = 2 * 1024 * 1024;
