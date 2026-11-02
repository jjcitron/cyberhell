// Internal-traffic tagging for Cyberhell.
// Vendored from the shared growth kit (same codes as Climb). Reason codes only.
// Never returns a user-agent, IP, or email.
// Browser-safe: no Node builtins. The server passes env and headers in.

const SCHEMA_V = 1;
const GAME = 'cyberhell';

// Shared production hosts, plus this game's own host. A request to
// cyberhell.acidlemon.com in production is organic. Anything else is preview.
const CANONICAL_HOSTS = Object.freeze([
  'clashofsteelblades.acidlemon.com',
  'spacerunner3d.acidlemon.com',
  'cyberkart.acidlemon.com',
  'frontlines.acidlemon.com',
  'sumi-game.acidlemon.com',
  'brawler.acidlemon.com',
  'cyberhell.acidlemon.com',
  'cardclimb.acidlemon.com',
]);

// Shared QA hooks. `test` (?test=1) tags internal and does not drop the event.
// `nosplash` only skips the splash; it tags internal and is not a telemetry mute.
const TEST_PARAMS = Object.freeze([
  'qa',
  'nosplash',
  'selftest',
  'smoke',
  'e2e',
  'autotest',
  'test',
  'autorun',
  'qaSeconds',
  'skipmenu',
  'fastClear',
  'invulnerable',
  'sandbox',
  'skipIntro',
  'skipOpening',
  'testEditor',
  'editorPreview',
]);

const INTERNAL_STORAGE_KEY = 'acidlemon.internal';
const INTERNAL_COOKIE_NAME = 'acidlemon_internal';

const COOKIE_SET = 'acidlemon_internal=1; Domain=.acidlemon.com; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
const COOKIE_CLEAR = 'acidlemon_internal=; Domain=.acidlemon.com; Path=/; Max-Age=0; SameSite=Lax; Secure';

const REASON_ORDER = Object.freeze([
  'vercel_app',
  'preview_host',
  'localhost',
  'test_param',
  'automation_ua',
  'webdriver',
  'opt_out',
  'non_prod_env',
  'qa_session',
  'detect_error',
]);

const KNOWN_REASONS = new Set(REASON_ORDER);

// Client page UA. Server adds bot/crawler/spider (see SERVER_UA_RE).
const CLIENT_UA_RE = /HeadlessChrome|Playwright|Puppeteer|Lighthouse/i;
const SERVER_UA_RE = /HeadlessChrome|Playwright|Puppeteer|Lighthouse|bot|crawler|spider/i;

function normalizeHost(raw) {
  let host = String(raw || '').trim().toLowerCase();
  if (!host) return '';
  host = host.split(',')[0].trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end >= 0 ? host.slice(1, end) : host;
  } else {
    // Strip :port only when there is a single colon. IPv6 literals such as
    // ::1 contain more than one, and a naive :\d+$ strip would turn ::1 into ":".
    const colon = host.lastIndexOf(':');
    if (colon > 0 && host.indexOf(':') === colon && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }
  return host.replace(/\.$/, '');
}

function isLocalHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return host.endsWith('.local') || host.endsWith('.localhost');
}

function hostFromLocation(location) {
  if (!location) return '';
  const raw = location.hostname || location.host || '';
  return normalizeHost(raw);
}

function searchHasTestParam(search) {
  const params = new URLSearchParams(search || '');
  for (const key of TEST_PARAMS) {
    if (params.has(key)) return true;
  }
  return false;
}

function searchFromUrl(url) {
  if (!url) return '';
  const s = String(url);
  const q = s.indexOf('?');
  if (q < 0) return '';
  const hash = s.indexOf('#', q);
  return hash >= 0 ? s.slice(q, hash) : s.slice(q);
}

function headerValue(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const direct = headers.get(name);
    const fallback = direct == null || direct === '' ? headers.get(want) : direct;
    if (Array.isArray(fallback)) return String(fallback[0] || '');
    return fallback == null ? '' : String(fallback);
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const value = headers[key];
      if (Array.isArray(value)) return String(value[0] || '');
      return value == null ? '' : String(value);
    }
  }
  return '';
}

function storageGet(storage, key) {
  try {
    const value = storage?.getItem?.(key);
    return value == null ? null : String(value);
  } catch {
    return null;
  }
}

function readCookieString(env) {
  if (typeof env.cookie === 'string') return env.cookie;
  try {
    const doc = env.document !== undefined
      ? env.document
      : (typeof document !== 'undefined' ? document : null);
    return doc?.cookie || '';
  } catch {
    return '';
  }
}

function cookieIsOptOut(cookie) {
  const parts = String(cookie || '').split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === INTERNAL_COOKIE_NAME && value === '1') return true;
  }
  return false;
}

function assignCookie(env, value) {
  try {
    if (typeof env.setCookie === 'function') {
      env.setCookie(value);
      return;
    }
    const doc = env.document !== undefined
      ? env.document
      : (typeof document !== 'undefined' ? document : null);
    if (doc) doc.cookie = value;
  } catch {
    // Cookie write failures must not break detection or the game.
  }
}

// ?internal=1 sets the flag for this load. ?internal=0 clears it.
function syncInternalOpt(search, storage, env) {
  let flag = null;
  try {
    flag = new URLSearchParams(search || '').get('internal');
  } catch {
    return null;
  }
  if (flag !== '1' && flag !== '0') return null;
  if (flag === '1') {
    try { storage?.setItem?.(INTERNAL_STORAGE_KEY, '1'); } catch { /* ignore */ }
    assignCookie(env, COOKIE_SET);
  } else {
    try { storage?.removeItem?.(INTERNAL_STORAGE_KEY); } catch { /* ignore */ }
    assignCookie(env, COOKIE_CLEAR);
  }
  return flag;
}

// Host reasons stack. A *.vercel.app host is also outside the canonical list,
// and localhost is too. `protocol` is '' on the server, which has no file: URL.
function hostReasons(host, protocol) {
  const reasons = [];
  if (protocol === 'file:' || isLocalHost(host)) reasons.push('localhost');
  if (String(host || '').endsWith('.vercel.app')) reasons.push('vercel_app');
  if (!CANONICAL_HOSTS.includes(host)) reasons.push('preview_host');
  return reasons;
}

/**
 * Client detection. Never throws.
 * On an unexpected failure returns { internal: true, reasons: ['detect_error'] }.
 */
function detectInternal(env = {}) {
  try {
    const location = env.location !== undefined ? env.location : globalThis.location;
    const protocol = location?.protocol || '';
    const search = location?.search || '';
    const host = hostFromLocation(location);
    const nav = env.navigator !== undefined ? env.navigator : globalThis.navigator;
    const storage = env.storage !== undefined ? env.storage : globalThis.localStorage;

    const flag = syncInternalOpt(search, storage, env);
    const reasons = hostReasons(host, protocol);
    if (searchHasTestParam(search)) reasons.push('test_param');

    const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
    if (CLIENT_UA_RE.test(ua)) reasons.push('automation_ua');
    if (nav?.webdriver === true) reasons.push('webdriver');

    const stored = storageGet(storage, INTERNAL_STORAGE_KEY) === '1';
    if (flag === '1' || stored || cookieIsOptOut(readCookieString(env))) reasons.push('opt_out');

    const ordered = sanitizeReasons(reasons);
    return { internal: ordered.length > 0, reasons: ordered };
  } catch {
    return { internal: true, reasons: ['detect_error'] };
  }
}

function isQaSessionId(id) {
  if (typeof id !== 'string' || !id) return false;
  const value = id.toLowerCase();
  return value.startsWith('qa_') || value.startsWith('test_');
}

function queryHasTestParam(query) {
  if (!query || typeof query !== 'object') return false;
  for (const key of TEST_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(query, key) && query[key] != null) return true;
  }
  return false;
}

function headerIsTest(headers) {
  const raw = headerValue(headers, 'x-test') || headerValue(headers, 'test');
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

/**
 * Server-side reasons. The user-agent header is matched here and dropped.
 * Only reason codes are returned.
 */
function serverInternalReasons({
  host = '',
  envName = '',
  url = '',
  headers = null,
  query = null,
  sessionId = '',
} = {}) {
  const normalized = normalizeHost(host);
  // Server host classes are vercel_app and preview_host (localhost counts as
  // preview_host). The client adds its own `localhost` reason, which merges in.
  const reasons = [];
  if (normalized.endsWith('.vercel.app')) reasons.push('vercel_app');
  if (!CANONICAL_HOSTS.includes(normalized)) reasons.push('preview_host');
  if (envName !== 'production') reasons.push('non_prod_env');
  if (searchHasTestParam(searchFromUrl(url)) || queryHasTestParam(query) || headerIsTest(headers)) {
    reasons.push('test_param');
  }
  const ua = headerValue(headers, 'user-agent');
  if (ua && SERVER_UA_RE.test(ua)) reasons.push('automation_ua');
  if (isQaSessionId(sessionId)) reasons.push('qa_session');
  return reasons;
}

function sanitizeReasons(list) {
  if (!Array.isArray(list)) return [];
  const found = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const code = item.trim();
    if (KNOWN_REASONS.has(code)) found.add(code);
  }
  return REASON_ORDER.filter((code) => found.has(code));
}

/**
 * Client reasons are unioned in. A client `internal: false` cannot drop a
 * server reason. `internal` is true if the client says so or any reason remains.
 */
function mergeInternal(clientInternal, clientReasons, serverReasons) {
  const reasons = sanitizeReasons([
    ...sanitizeReasons(serverReasons),
    ...sanitizeReasons(clientReasons),
  ]);
  return {
    internal: clientInternal === true || reasons.length > 0,
    reasons,
  };
}

var CyberGrowthApi = {
  SCHEMA_V: SCHEMA_V,
  GAME: GAME,
  CANONICAL_HOSTS: CANONICAL_HOSTS,
  TEST_PARAMS: TEST_PARAMS,
  INTERNAL_STORAGE_KEY: INTERNAL_STORAGE_KEY,
  INTERNAL_COOKIE_NAME: INTERNAL_COOKIE_NAME,
  COOKIE_SET: COOKIE_SET,
  COOKIE_CLEAR: COOKIE_CLEAR,
  REASON_ORDER: REASON_ORDER,
  normalizeHost: normalizeHost,
  isLocalHost: isLocalHost,
  searchHasTestParam: searchHasTestParam,
  headerValue: headerValue,
  detectInternal: detectInternal,
  isQaSessionId: isQaSessionId,
  serverInternalReasons: serverInternalReasons,
  sanitizeReasons: sanitizeReasons,
  mergeInternal: mergeInternal
};
// js/ is CommonJS for the Node QA scripts. Browsers ignore module and read window.
if (typeof module === 'object' && module.exports) module.exports = CyberGrowthApi;
if (typeof window !== 'undefined') window.CyberGrowth = CyberGrowthApi;
