/* What the app keeps on this computer, in the user-data folder: the tasks file, config.json and the
   agent runner's diary. No Electron here: main.js passes in the folder and Electron's safeStorage. */
const path = require('path');
const fs = require('fs');

let io = null; // { userData: () => folder, safeStorage }
function init(opts) { io = opts; }

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
const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'clientSecret', 'key', 'syncKey',
  'geminiKey', 'openaiKey', 'anthropicKey', 'openrouterKey', 'xaiKey', 'groqKey', 'cloudflareKey', 'nvidiaKey', 'buyEmailUrl', 'calendarFeeds', 'hubToken']);
const ENC = 'enc:v1:';
function canEncrypt() { try { return io.safeStorage.isEncryptionAvailable(); } catch (e) { return false; } }
function sealValue(v) {
  if (Array.isArray(v)) return v.map(sealValue);
  if (typeof v !== 'string' || !v || v.startsWith(ENC) || !canEncrypt()) return v;
  return ENC + io.safeStorage.encryptString(v).toString('base64');
}
function openValue(v) {
  if (Array.isArray(v)) return v.map(openValue);
  if (typeof v !== 'string' || !v.startsWith(ENC)) return v;
  try { return io.safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64')); } catch (e) { return v; }
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
function readConfig() {
  try { return mapSecrets(readSealed(), openValue); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  const file = configFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + TMP, JSON.stringify(mapSecrets(cfg, sealValue)));
    // the file being replaced becomes the last good copy, but only if it parses: a broken one must not bury a good .bak
    if (readRaw(file)) { try { fs.copyFileSync(file, file + BAK); } catch (e) {} }
    fs.renameSync(file + TMP, file); // atomic: config.json is always whole
  } catch (e) { console.error('config: write failed: ' + e.message); }
}
// encrypt any secrets still sitting in config.json as plain text (older versions, or typed in by hand)
function sealPlainSecrets() {
  try { const raw = readRaw(configFile()); if (raw && canEncrypt()) writeConfig(mapSecrets(raw, openValue)); } catch (e) {}
}

// small rolling diary of what the runner did, for "why didn't it answer?" questions
function agentLog(msg) {
  try {
    const f = path.join(io.userData(), 'agent-runner.log');
    try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.old'); } catch (e) {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

module.exports = { init, dataFile, configFile, readConfig, writeConfig, sealPlainSecrets, agentLog, mapSecrets, sealValue, openValue, SECRET_KEYS };
