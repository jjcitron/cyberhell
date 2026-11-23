// Validation for the Sumi: Cyberhell grid editor. This deliberately owns a copy of the
// editor legend: the classic Cyberhell validator describes an unrelated sector/wall format.
import { HttpError } from './json.js';

export const SUMI_LEVEL_FORMAT = 'sumi-cyberhell-grid@1';
export const MAX_SUMI_LEVEL_BYTES = 512 * 1024;
export const SUMI_LEGEND_CHARS = '#.DGHJ%=_123OXYSR!K&@*MEB$PLTNCVW^{}~:;?hmyoxnqzw48suv9abcdefghijkl';

const GLYPHS = new Set(SUMI_LEGEND_CHARS);
const SUMI_LEVEL_NAME_RE = /^[\p{L}\p{N} ·—–:'()\-,.!?&#/+]+$/u;

export function requireSumiLevelName(name) {
  const raw = String(name ?? '');
  const clean = raw.trim();
  if (
    raw !== clean
    || [...clean].length < 1
    || [...clean].length > 96
    || !SUMI_LEVEL_NAME_RE.test(clean)
  ) {
    throw new HttpError(400, 'Invalid level name.');
  }
  return clean;
}

function validateMap(map, label, errors) {
  if (!Array.isArray(map)) {
    errors.push(`${label} must be an array of strings.`);
    return;
  }
  if (map.length < 8 || map.length > 256) errors.push(`${label} must have 8 to 256 rows.`);

  let width = null;
  let starts = 0;
  let exits = 0;
  for (let rowIndex = 0; rowIndex < map.length; rowIndex++) {
    const row = map[rowIndex];
    if (typeof row !== 'string') {
      errors.push(`${label} row ${rowIndex + 1} must be a string.`);
      continue;
    }
    if (width == null) width = row.length;
    else if (row.length !== width) errors.push(`${label} rows must all have the same length.`);
    for (const glyph of row) {
      if (!GLYPHS.has(glyph)) errors.push(`${label} row ${rowIndex + 1} contains unsupported glyph ${JSON.stringify(glyph)}.`);
      if (glyph === 'S') starts++;
      if (glyph === 'R') exits++;
    }
  }

  if (width != null && (width < 8 || width > 256)) errors.push(`${label} must have 8 to 256 columns.`);
  if (!starts) errors.push(`${label} must contain a player start (S).`);
  if (!exits) errors.push(`${label} must contain a time-rift exit (R).`);
}

function validateShape(level, label, errors, isPart) {
  if (!level || typeof level !== 'object' || Array.isArray(level)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  if (level.format !== SUMI_LEVEL_FORMAT) errors.push(`${label} format must be ${SUMI_LEVEL_FORMAT}.`);
  if (typeof level.title !== 'string' || !level.title.trim()) errors.push(`${label} must have a title.`);
  if (typeof level.theme !== 'string' || !level.theme.trim()) errors.push(`${label} must have a theme.`);
  validateMap(level.map, `${label} map`, errors);

  if (isPart && Object.hasOwn(level, 'parts')) errors.push(`${label} cannot contain nested parts.`);
  if (!isPart && level.parts !== undefined) {
    if (!Array.isArray(level.parts)) errors.push('Level parts must be an array.');
    else level.parts.forEach((part, index) => validateShape(part, `Part ${index + 1}`, errors, true));
  }
}

export function validateSumiLevel(level) {
  const errors = [];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(level));
  } catch {
    errors.push('Level must be valid JSON.');
  }
  if (bytes > MAX_SUMI_LEVEL_BYTES) errors.push(`Level payload must not exceed ${MAX_SUMI_LEVEL_BYTES} bytes.`);
  validateShape(level, 'Level', errors, false);
  return { ok: errors.length === 0, errors: [...new Set(errors)], bytes };
}
