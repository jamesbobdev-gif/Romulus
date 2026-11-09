/* What the app keeps on this computer, in the user-data folder: the tasks file, config.json and the
   agent runner's diary. No Electron here: main.js passes in the folder and Electron's safeStorage. */
const path = require('path');
const fs = require('fs');

let io = null; // { userData: () => folder, safeStorage }
function init(opts) { io = opts; mem = null; stampOf = null; plainOf.clear(); sealedOf.clear(); asyncOk = null; }

function dataFile() {
  return path.join(io.userData(), 'tasks.json');
}
function configFile() {
  return path.join(io.userData(), 'config.json');
}
/* Secrets in config.json (sign-in tokens, client secrets, sync keys, API keys, private calendar
   and webhook links) are stored encrypted with Windows' own encryption (safeStorage → DPAPI), so
   the file is useless if copied off this account. Everything else stays plain so it can still be
   hand-edited; a secret typed in by hand is picked up as-is and encrypted on the next save. */
const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'clientSecret', 'appPassword', 'key', 'syncKey',
  'geminiKey', 'openaiKey', 'anthropicKey', 'openrouterKey', 'xaiKey', 'groqKey', 'cloudflareKey', 'nvidiaKey', 'buyEmailUrl', 'calendarFeeds']);
const ENC = 'enc:v1:';

/* Electron 45 deprecates safeStorage's synchronous calls and 46 removes them, so encrypting and decrypting
   is asynchronous here, while readConfig/writeConfig stay synchronous for their hundreds of callers:
   - load() (at startup, once the app is ready) opens every secret in config.json and its .bak and remembers
     each sealed text with its plain value, both ways;
   - readConfig answers from the copy in memory, or reads the file again when something else changed it,
     opening secrets from what load() remembered;
   - writeConfig takes the new config at once (the next read sees it) and seals and writes it in the
     background, one write after another in order; flush() waits for those, and the app does before it quits.
   Data sealed by the old synchronous calls opens with the asynchronous ones (same key store). An Electron
   without the asynchronous calls (and the tests' stand-in) uses the synchronous ones. */
const plainOf = new Map(); // sealed text → plain
const sealedOf = new Map(); // plain → sealed text (so an unchanged secret isn't encrypted again on every write)
const REMEMBER_MAX = 2000;
function remember(sealed, plain, reuse) {
  if (plainOf.size > REMEMBER_MAX) { plainOf.clear(); sealedOf.clear(); }
  plainOf.set(sealed, plain);
  if (reuse) sealedOf.set(plain, sealed);
}
const ss = () => io && io.safeStorage;
/* Linux with no keyring: Chromium falls back to its "basic_text" backend, which says encryption is available but uses a
   fixed key, so a sealed value would only look sealed. Treat that as no encryption (the file stays plain, as SECURITY.md
   says for a headless hub) and say so once in the log. */
let saidPlain = false;
function basicText() {
  const s = ss();
  try {
    if (!s || typeof s.getSelectedStorageBackend !== 'function' || s.getSelectedStorageBackend() !== 'basic_text') return false;
  } catch (e) { return false; }
  if (!saidPlain) { saidPlain = true; agentLog('config: no OS keyring on this computer, so keys and tokens in config.json are kept as plain text (readable by this user only)'); }
  return true;
}
const hasAsync = () => { const s = ss(); return !!(s && typeof s.encryptStringAsync === 'function' && typeof s.decryptStringAsync === 'function'); };
let asyncOk = null;
async function canEncryptAsync() {
  if (asyncOk !== null) return asyncOk;
  const s = ss();
  try { asyncOk = basicText() ? false : hasAsync() ? !!(await s.isAsyncEncryptionAvailable()) : !!(s && s.isEncryptionAvailable && s.isEncryptionAvailable()); }
  catch (e) { asyncOk = false; }
  return asyncOk;
}
// one string; `keep` remembers it (config secrets: small, and seen again and again; not a whole file's text)
async function sealText(v, keep) {
  if (typeof v !== 'string' || !v || v.startsWith(ENC)) return v;
  if (keep && sealedOf.has(v)) return sealedOf.get(v);
  if (!(await canEncryptAsync())) return v;
  const s = ss();
  const buf = hasAsync() ? await s.encryptStringAsync(v) : s.encryptString(v);
  const out = ENC + Buffer.from(buf).toString('base64');
  if (keep) remember(out, v, true);
  return out;
}
async function openText(v, keep) {
  if (typeof v !== 'string' || !v.startsWith(ENC)) return v;
  if (plainOf.has(v)) return plainOf.get(v);
  const s = ss();
  try {
    const buf = Buffer.from(v.slice(ENC.length), 'base64');
    let plain, again = false;
    if (hasAsync()) { const r = await s.decryptStringAsync(buf); plain = r.result; again = !!r.shouldReEncrypt; }
    else plain = s.decryptString(buf);
    // shouldReEncrypt: the key store moved on, so the next write seals it afresh rather than reusing this text
    if (keep) remember(v, plain, !again);
    return plain;
  } catch (e) { return v; }
}
// a string or an array of them (nested arrays too), the way config secrets come
const eachDeep = (v, fn) => (Array.isArray(v) ? Promise.all(v.map((x) => eachDeep(x, fn))) : fn(v));
const sealAsync = (v) => eachDeep(v, (x) => sealText(x, false));
const openAsync = (v) => eachDeep(v, (x) => openText(x, false));

/* Synchronous forms, for readConfig and anything else that can't wait: what load() and the writes
   remembered, else the old synchronous call where this Electron still has it, else left as it is
   (sealed, as when Windows can't open it). */
function sealValue(v) {
  if (Array.isArray(v)) return v.map(sealValue);
  if (typeof v !== 'string' || !v || v.startsWith(ENC)) return v;
  if (sealedOf.has(v)) return sealedOf.get(v);
  const s = ss();
  try {
    if (s && typeof s.encryptString === 'function' && s.isEncryptionAvailable() && !basicText()) {
      const out = ENC + Buffer.from(s.encryptString(v)).toString('base64');
      remember(out, v, true);
      return out;
    }
  } catch (e) {}
  return v;
}
function openValue(v) {
  if (Array.isArray(v)) return v.map(openValue);
  if (typeof v !== 'string' || !v.startsWith(ENC)) return v;
  if (plainOf.has(v)) return plainOf.get(v);
  const s = ss();
  try {
    if (s && typeof s.decryptString === 'function') {
      const plain = s.decryptString(Buffer.from(v.slice(ENC.length), 'base64'));
      remember(v, plain, true);
      return plain;
    }
  } catch (e) {}
  return v;
}
// fn applied to each secret value; calAccounts[].url is a private calendar link there (but not elsewhere)
function mapSecrets(o, fn, inCalAccounts) {
  if (Array.isArray(o)) return o.map((x) => mapSecrets(x, fn, inCalAccounts));
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = SECRET_KEYS.has(k) || (inCalAccounts && k === 'url') ? fn(v) : mapSecrets(v, fn, k === 'calAccounts');
  }
  return out;
}
// every secret string in a config, for doing them all at once
function secretStrings(o) {
  const out = [];
  const add = (v) => { if (Array.isArray(v)) v.forEach(add); else if (typeof v === 'string') out.push(v); };
  mapSecrets(o, (v) => { add(v); return v; });
  return out;
}
async function sealAll(cfg) {
  await Promise.all(secretStrings(cfg).map((v) => sealText(v, true)));
  const cached = (v) => (Array.isArray(v) ? v.map(cached) : (typeof v === 'string' && sealedOf.has(v) ? sealedOf.get(v) : v));
  return mapSecrets(cfg, cached);
}
async function openAll(raw) {
  await Promise.all(secretStrings(raw).map((v) => openText(v, true)));
}

/* config.json holds every sign-in, sync key and API key, and most callers read it, change one thing and
   write it back. So a read must never come back empty just because the file was briefly locked (antivirus,
   a backup tool) or half-written by a crash: that empty object would be written back and every secret lost.
   The last good copy is kept as config.json.bak and read when config.json is missing or won't parse; a
   write goes to a temp file first and is renamed into place. */
const BAK = '.bak', TMP = '.tmp';
// the parsed file (secrets still sealed), or null when it is missing or unreadable
function readRaw(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') console.error('config: cannot read ' + file + ': ' + e.message); return null; }
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { console.error('config: ' + file + ' is not valid JSON'); return null; }
}
function readSealed() {
  const main = readRaw(configFile());
  if (main) return main;
  const bak = readRaw(configFile() + BAK);
  if (bak) console.error('config: using the last good copy (config.json' + BAK + ')');
  return bak || {};
}

// the config as last read or written (secrets open), and which version of the file it matches
let mem = null, stampOf = null, pending = 0, writes = Promise.resolve();
const clone = (o) => JSON.parse(JSON.stringify(o));
function stamp() {
  try { const st = fs.statSync(configFile()); return st.mtimeMs + ':' + st.size; } catch (e) { return 'none'; }
}
function readConfig() {
  try {
    if (mem && (pending > 0 || stamp() === stampOf)) return clone(mem);
    const st = stamp();
    const raw = readSealed();
    const cfg = mapSecrets(raw, openValue);
    mem = clone(cfg); stampOf = st;
    // something else wrote secrets this process hasn't seen: open them, and the next read has them
    if (secretStrings(cfg).some((v) => v.startsWith(ENC))) openAll(raw).then(() => { if (stampOf === st && !pending) mem = null; }).catch(() => {});
    return cfg;
  } catch (e) { return {}; }
}
function writeFile(sealed) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + TMP, JSON.stringify(sealed));
  // the file being replaced becomes the last good copy, but only if it parses: a broken one must not bury a good .bak
  if (readRaw(file)) { try { fs.copyFileSync(file, file + BAK); } catch (e) {} }
  fs.renameSync(file + TMP, file); // atomic: config.json is always whole
}
// the next read sees cfg at once; the file has it once the returned promise settles
function writeConfig(cfg) {
  let snap;
  try { snap = clone(cfg || {}); } catch (e) { console.error('config: write failed: ' + e.message); return Promise.resolve(); }
  mem = clone(snap); pending++;
  writes = writes.then(() => sealAll(snap)).then((sealed) => { writeFile(sealed); stampOf = stamp(); })
    .catch((e) => console.error('config: write failed: ' + e.message))
    .finally(() => { pending--; });
  return writes;
}
// every write so far is on disk
function flush() { return writes; }
const writing = () => pending > 0;

/* At startup, once Electron is ready: open every secret in config.json and its .bak, then encrypt any
   still sitting there as plain text (older versions, or typed in by hand). */
async function load() {
  try {
    const raw = readRaw(configFile()), bak = readRaw(configFile() + BAK);
    await Promise.all([raw, bak].filter(Boolean).map(openAll));
    mem = null; // whatever was read before this, with secrets it couldn't open yet, is read again
    const cfg = readConfig();
    if (raw && (await canEncryptAsync()) && secretStrings(raw).some((v) => v && !v.startsWith(ENC))) await writeConfig(cfg);
  } catch (e) { console.error('config: load failed: ' + e.message); }
}
const sealPlainSecrets = load;

// small rolling diary of what the runner did, for "why didn't it answer?" questions
function agentLog(msg) {
  try {
    const f = path.join(io.userData(), 'agent-runner.log');
    try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.old'); } catch (e) {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

module.exports = { init, dataFile, configFile, readConfig, writeConfig, flush, writing, load, sealPlainSecrets, agentLog, mapSecrets,
  sealValue, openValue, sealAsync, openAsync, SECRET_KEYS };
