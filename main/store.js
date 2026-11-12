/* What the app keeps on this computer, in the user-data folder: the tasks file, config.json and the
   agent runner's diary. No Electron here: main.js passes in the folder and Electron's safeStorage. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let io = null; // { userData: () => folder, safeStorage, platform? (tests) }
function init(opts) { io = opts; mem = null; stampOf = null; plainOf.clear(); sealedOf.clear(); asyncOk = null; ownKeyBuf = null; }

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

/* A computer that runs the local model for every device (localModel.worker, on Linux) runs with nobody at it:
   a service that starts before anyone signs in. The Linux keyring isn't dependable there. Which key store
   Chromium picks depends on how the app was started, and a restart that picks another one leaves every key
   unreadable: the app then can't sync, take tasks or say it's there until someone sits down at it. So on that
   computer the secrets are sealed with a key the app keeps itself, in config.key next to config.json (readable
   by that user only), as 'enc:v2:' + base64(iv, tag, text) under AES-256-GCM. It opens the same way however
   the app was started. Secrets sealed the old way are opened once more and saved this way (load()). */
const ENC2 = 'enc:v2:';
const isSealed = (v) => typeof v === 'string' && (v.startsWith(ENC) || v.startsWith(ENC2));
const platform = () => (io && io.platform) || process.platform;
const keyFile = () => path.join(io.userData(), 'config.key');
const ownKeyMode = (cfg) => platform() === 'linux' && !!((cfg && cfg.localModel) || {}).worker;
let ownKeyBuf = null;
function ownKey(make) {
  if (ownKeyBuf) return ownKeyBuf;
  try {
    const k = Buffer.from(fs.readFileSync(keyFile(), 'utf8').trim(), 'base64');
    if (k.length === 32) return (ownKeyBuf = k);
  } catch (e) {}
  if (!make) return null;
  try {
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), k.toString('base64'), { mode: 0o600, flag: 'wx' }); // never over a key that's there
    return (ownKeyBuf = k);
  } catch (e) { return null; }
}
function sealOwn(v) {
  const k = ownKey(true);
  if (!k) return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return ENC2 + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function openOwn(v) { // the plain text, or null when the key file is gone or it wasn't sealed with it
  const k = ownKey(false);
  if (!k) return null;
  try {
    const b = Buffer.from(v.slice(ENC2.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
/* Linux, when safeStorage can't open an old 'enc:v1:' secret: one sealed with no keyring (the "basic" store,
   which is what a computer with nobody signed in used) is Chromium's 'v10' form, AES-128-CBC under a fixed
   key, and can be opened here whatever store this start picked. One sealed with a keyring ('v11') can't.
   → the text, or null */
function openBasic(buf) {
  if (platform() !== 'linux' || buf.length < 19 || buf.subarray(0, 3).toString('latin1') !== 'v10') return null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, ' '));
    const out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
    const text = out.toString('utf8');
    // the wrong key now and then gives valid padding: what comes out must still be plain text
    return Buffer.from(text, 'utf8').equals(out) && !/[\u0000-\u0008\u000e-\u001f�]/.test(text) ? text : null;
  } catch (e) { return null; }
}

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
async function sealText(v, keep, own) {
  if (typeof v !== 'string' || !v || isSealed(v)) return v;
  if (keep && sealedOf.has(v) && sealedOf.get(v).startsWith(own ? ENC2 : ENC)) return sealedOf.get(v);
  if (own) { // the app's own key (the local model's computer); no key file to be had: the usual way
    const out = sealOwn(v);
    if (out) { if (keep) remember(out, v, true); return out; }
  }
  if (!(await canEncryptAsync())) return v;
  const s = ss();
  const buf = hasAsync() ? await s.encryptStringAsync(v) : s.encryptString(v);
  const out = ENC + Buffer.from(buf).toString('base64');
  if (keep) remember(out, v, true);
  return out;
}
async function openText(v, keep) {
  if (!isSealed(v)) return v;
  if (plainOf.has(v)) return plainOf.get(v);
  if (v.startsWith(ENC2)) {
    const plain = openOwn(v);
    if (plain == null) return v;
    if (keep) remember(v, plain, true);
    return plain;
  }
  const s = ss();
  const buf = Buffer.from(v.slice(ENC.length), 'base64');
  try {
    let plain, again = false;
    if (hasAsync()) { const r = await s.decryptStringAsync(buf); plain = r.result; again = !!r.shouldReEncrypt; }
    else plain = s.decryptString(buf);
    // shouldReEncrypt: the key store moved on, so the next write seals it afresh rather than reusing this text
    if (keep) remember(v, plain, !again);
    return plain;
  } catch (e) {
    const plain = openBasic(buf);
    if (plain == null) return v;
    if (keep) remember(v, plain, false); // sealed afresh on the next write
    return plain;
  }
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
  if (typeof v !== 'string' || !v || isSealed(v)) return v;
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
  if (!isSealed(v)) return v;
  if (plainOf.has(v)) return plainOf.get(v);
  if (v.startsWith(ENC2)) {
    const plain = openOwn(v);
    if (plain == null) return v;
    remember(v, plain, true);
    return plain;
  }
  const s = ss(), buf = Buffer.from(v.slice(ENC.length), 'base64');
  try {
    if (s && typeof s.decryptString === 'function') {
      const plain = s.decryptString(buf);
      remember(v, plain, true);
      return plain;
    }
  } catch (e) {
    const plain = openBasic(buf);
    if (plain != null) { remember(v, plain, false); return plain; }
  }
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
  const own = ownKeyMode(cfg);
  await Promise.all(secretStrings(cfg).map((v) => sealText(v, true, own)));
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
    if (secretStrings(cfg).some(isSealed)) openAll(raw).then(() => { if (stampOf === st && !pending) mem = null; }).catch(() => {});
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
    // on the local model's own computer, every secret this start could open goes under the app's own key
    const opened = (v) => !isSealed(v) || plainOf.has(v);
    const move = ownKeyMode(cfg) && secretStrings(raw || {}).some((v) => v && !v.startsWith(ENC2) && opened(v));
    if (raw && (move || ((await canEncryptAsync()) && secretStrings(raw).some((v) => v && !isSealed(v))))) await writeConfig(cfg);
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
  sealValue, openValue, sealAsync, openAsync, SECRET_KEYS, isSealed };
