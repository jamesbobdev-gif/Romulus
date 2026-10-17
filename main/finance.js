/* Finance: his bank accounts, read through SimpleFIN Bridge (bridge.simplefin.org), shown on the Finance tab.
   SimpleFIN is read-only by design: the access link it hands out can list balances and transactions, never
   move money. How the data is kept away from anyone else:
   - Everything (the access link and the downloaded transactions) lives in one file, finance.vault, in the
     user-data folder. It is encrypted with AES-256-GCM under a key made from his passphrase (scrypt), and
     the whole file is encrypted again with Windows' own encryption (safeStorage → DPAPI). The passphrase is
     never saved; the key is only in memory while the tab is unlocked, and is wiped when it locks.
   - It locks after 10 minutes without use, when the screen locks, and when the computer sleeps.
   - It never leaves this computer: not in config.json (so "Send my settings" to the hub mini PC can't carry
     it), not in tasks.json or Supabase, not one of the hub's remote calls, and the Agent can't read it.
   - It only ever talks to simplefin.org over HTTPS, never follows redirects, and the log never gets amounts,
     names or the link. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scrypt = require('util').promisify(crypto.scrypt);

const VAULT = 'finance.vault';
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }; // ~128 MB per guess: slow to brute-force offline
const MIN_PASSPHRASE = 10;
const IDLE_LOCK_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 15 * 60 * 1000; // SimpleFIN Bridge allows only a couple dozen refreshes a day
const STALE_MS = 6 * 60 * 60 * 1000; // older than this: refreshed by itself when he unlocks
const FETCH_DAYS = 90;
const KEEP_DAYS = 400; // history builds up past SimpleFIN's window, a year and a bit
const AAD = Buffer.from('tasks-finance-v1');

let ctx = null; // { userData, agentLog, sendToRenderer, powerMonitor, seal, unseal, fetch? }
let key = null; // the AES key while unlocked
let salt = null;
let vault = null; // { accessUrl, cache: { fetchedAt, accounts, errors } } while unlocked
let idleTimer = null;
let wrong = 0, waitUntil = 0;
let watching = false;

function init(c) { ctx = c; }
const log = (m) => ctx.agentLog && ctx.agentLog('finance: ' + m);
const file = () => path.join(ctx.userData(), VAULT);
const doFetch = (...a) => (ctx.fetch || fetch)(...a);

/* ── the vault file ── */
// async, so the window doesn't freeze while it works
function deriveKey(passphrase, s, p) {
  const o = p || KDF;
  return scrypt(String(passphrase).normalize('NFKC'), s, 32, { N: o.N, r: o.r, p: o.p, maxmem: KDF.maxmem });
}
function encrypt(obj, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(box, k) {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}
function readVaultFile() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch (e) { return null; }
  const opened = ctx.unseal ? ctx.unseal(text) : text;
  try { return JSON.parse(opened); } catch (e) { throw new Error('The finance file can’t be read on this account (it only opens for the Windows user that made it).'); }
}
function writeVault() {
  const out = Object.assign({ v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') }, encrypt(vault, key));
  const text = JSON.stringify(out);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, ctx.seal ? ctx.seal(text) : text, { mode: 0o600 });
  fs.renameSync(tmp, file());
}
const isSetUp = () => fs.existsSync(file());

/* ── locking ── */
function lock(why) {
  const was = !!key;
  if (key) key.fill(0);
  key = null; vault = null; salt = null;
  clearTimeout(idleTimer); idleTimer = null;
  if (was) { log('locked (' + (why || 'asked') + ')'); if (ctx.sendToRenderer) ctx.sendToRenderer('finance:locked', why || 'asked'); }
}
function stillHere() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lock('idle'), IDLE_LOCK_MS);
  if (idleTimer.unref) idleTimer.unref();
}
function watchPower() {
  if (watching || !ctx.powerMonitor) return;
  watching = true;
  for (const ev of ['lock-screen', 'suspend']) { try { ctx.powerMonitor.on(ev, () => lock(ev)); } catch (e) {} }
}
async function unlockWith(passphrase, v) {
  const s = Buffer.from(v.salt, 'base64');
  const k = await deriveKey(passphrase, s, v);
  const inside = decrypt(v, k); // throws on a wrong passphrase (the GCM tag doesn't match)
  key = k; salt = s; vault = inside;
  watchPower(); stillHere();
}

/* ── SimpleFIN ── */
// only simplefin.org, only HTTPS: a pasted token can't point this at anything else
function checkSimplefinUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  const host = x.hostname.toLowerCase();
  if (x.protocol !== 'https:' || !(host === 'simplefin.org' || host.endsWith('.simplefin.org'))) return null;
  return x;
}
function claimUrlFromToken(token) {
  const t = String(token || '').trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]{20,2000}$/.test(t)) return null;
  const decoded = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
  return checkSimplefinUrl(decoded) ? decoded : null;
}
async function claim(token) {
  const claimUrl = claimUrlFromToken(token);
  if (!claimUrl) throw new Error('That isn’t a SimpleFIN setup token. Copy the whole token from bridge.simplefin.org.');
  let r;
  try { r = await doFetch(claimUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error('Couldn’t reach SimpleFIN. Are you online?'); }
  if (r.status === 403) throw new Error('SimpleFIN says that token was already used. If you didn’t use it, someone else may have: disable it on bridge.simplefin.org and make a new one.');
  if (!r.ok) throw new Error('SimpleFIN refused the token (HTTP ' + r.status + ').');
  const accessUrl = String(await r.text()).trim();
  const x = checkSimplefinUrl(accessUrl);
  if (!x || !x.username || !x.password) throw new Error('SimpleFIN answered with something unexpected. Try a new token.');
  return accessUrl;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 200);
// what SimpleFIN sent, cut down to the fields the tab shows (nothing else from it is kept)
function cleanAccounts(body) {
  const conns = {};
  for (const c of Array.isArray(body.connections) ? body.connections : []) if (c && c.conn_id) conns[c.conn_id] = c.org_name || c.name;
  return (Array.isArray(body.accounts) ? body.accounts : []).filter((a) => a && a.id).map((a) => ({
    id: txt(a.id, 120), name: txt(a.name, 120),
    org: txt(conns[a.conn_id] || (a.org && (a.org.name || a.org.domain)) || '', 120),
    currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'USD',
    balance: num(a.balance), available: a['available-balance'] == null ? null : num(a['available-balance']),
    balanceDate: num(a['balance-date']),
    transactions: (Array.isArray(a.transactions) ? a.transactions : []).filter((t) => t && t.id).map((t) => ({
      id: txt(t.id, 160), posted: num(t.posted) || num(t.transacted_at), amount: num(t.amount),
      description: txt(t.payee || t.description, 200), pending: !!t.pending || !num(t.posted),
    })),
  }));
}
const errorsOf = (body) => (Array.isArray(body.errlist) ? body.errlist.map((e) => e && e.msg) : Array.isArray(body.errors) ? body.errors : [])
  .filter(Boolean).map((m) => txt(m, 300)).slice(0, 10);
// new download + what was kept before: transactions add up past SimpleFIN's window; pending ones are replaced
function mergeAccounts(old, fresh, now) {
  const cutoff = now / 1000 - KEEP_DAYS * 86400;
  const before = {};
  for (const a of old || []) before[a.id] = a;
  return fresh.map((a) => {
    const seen = new Set(a.transactions.map((t) => t.id));
    const kept = ((before[a.id] || {}).transactions || []).filter((t) => !seen.has(t.id) && !t.pending && t.posted >= cutoff);
    const all = a.transactions.concat(kept).sort((x, y) => (y.posted || Infinity) - (x.posted || Infinity));
    return Object.assign({}, a, { transactions: all });
  });
}
async function download(accessUrl) {
  const x = checkSimplefinUrl(accessUrl);
  if (!x) throw new Error('The saved SimpleFIN link isn’t valid. Forget it and connect again.');
  const auth = 'Basic ' + Buffer.from(decodeURIComponent(x.username) + ':' + decodeURIComponent(x.password)).toString('base64');
  x.username = ''; x.password = '';
  const base = x.toString().replace(/\/+$/, '');
  const start = Math.floor(Date.now() / 1000) - FETCH_DAYS * 86400;
  let r;
  try { r = await doFetch(base + '/accounts?version=2&pending=1&start-date=' + start, { headers: { Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(90000) }); }
  catch (e) { throw new Error('Couldn’t reach SimpleFIN. Are you online?'); }
  if (r.status === 403) throw new Error('SimpleFIN turned this connection off (or it was disabled on bridge.simplefin.org). Forget it and connect again with a new token.');
  if (r.status === 402) throw new Error('SimpleFIN says the subscription needs paying.');
  if (!r.ok) throw new Error('SimpleFIN had a problem (HTTP ' + r.status + '). Try again later.');
  const body = await r.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('SimpleFIN sent something unreadable.');
  return { accounts: cleanAccounts(body), errors: errorsOf(body) };
}
async function refresh(force) {
  const last = (vault.cache && vault.cache.fetchedAt) || 0;
  if (Date.now() - last < MIN_REFRESH_MS) {
    if (force) return { ok: false, error: 'Updated ' + Math.round((Date.now() - last) / 60000) + ' min ago. SimpleFIN allows a refresh every 15 minutes.' };
    return { ok: true, skipped: true };
  }
  const got = await download(vault.accessUrl);
  if (!key) return { ok: false, error: 'locked' }; // it locked while downloading: drop what came
  vault.cache = { fetchedAt: Date.now(), accounts: mergeAccounts(vault.cache && vault.cache.accounts, got.accounts, Date.now()), errors: got.errors };
  writeVault();
  log('refreshed ' + got.accounts.length + ' accounts' + (got.errors.length ? ', ' + got.errors.length + ' bank messages' : ''));
  return { ok: true };
}

/* ── what the tab calls ── */
function status() {
  return { setUp: isSetUp(), unlocked: !!key, fetchedAt: vault && vault.cache ? vault.cache.fetchedAt || 0 : 0,
    waitSeconds: Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)), minPassphrase: MIN_PASSPHRASE };
}
const handlers = {
  'finance:status': () => status(),
  'finance:setup': async (_e, token, passphrase) => {
    if (isSetUp()) return { ok: false, error: 'Finance is already connected. Forget it first to connect again.' };
    if (String(passphrase || '').length < MIN_PASSPHRASE) return { ok: false, error: 'Use a passphrase of at least ' + MIN_PASSPHRASE + ' characters.' };
    let accessUrl;
    try { accessUrl = await claim(token); } catch (e) { return { ok: false, error: e.message }; }
    const s = crypto.randomBytes(16);
    const k = await deriveKey(passphrase, s);
    salt = s; key = k;
    vault = { accessUrl, cache: { fetchedAt: 0, accounts: [], errors: [] } };
    writeVault();
    watchPower(); stillHere();
    log('connected');
    try { await refresh(false); } catch (e) { return { ok: true, warning: e.message }; }
    return { ok: true };
  },
  'finance:unlock': async (_e, passphrase) => {
    if (key) { stillHere(); return { ok: true }; }
    if (Date.now() < waitUntil) return { ok: false, error: 'Too many wrong tries. Wait ' + status().waitSeconds + ' seconds.' };
    let v;
    try { v = readVaultFile(); } catch (e) { return { ok: false, error: e.message }; }
    if (!v) return { ok: false, error: 'Finance isn’t connected.' };
    try { await unlockWith(passphrase, v); }
    catch (e) {
      wrong++;
      if (wrong >= 3) waitUntil = Date.now() + Math.min(300, 2 ** (wrong - 3) * 5) * 1000;
      log('wrong passphrase (' + wrong + ')');
      return { ok: false, error: 'Wrong passphrase.' };
    }
    wrong = 0; waitUntil = 0;
    log('unlocked');
    let warning;
    if (Date.now() - ((vault.cache && vault.cache.fetchedAt) || 0) > STALE_MS) {
      try { await refresh(false); } catch (e) { warning = e.message; }
    }
    return { ok: true, warning };
  },
  'finance:lock': () => { lock('asked'); return true; },
  'finance:data': () => {
    if (!key) return { locked: true };
    stillHere();
    const c = vault.cache || {};
    return { locked: false, fetchedAt: c.fetchedAt || 0, accounts: c.accounts || [], errors: c.errors || [] };
  },
  'finance:refresh': async () => {
    if (!key) return { ok: false, error: 'locked' };
    stillHere();
    try { return await refresh(true); } catch (e) { return { ok: false, error: e.message }; }
  },
  // deletes the local file only; the connection itself is turned off on bridge.simplefin.org
  'finance:forget': () => {
    lock('forgotten');
    try { fs.unlinkSync(file()); } catch (e) {}
    log('forgotten');
    return { ok: true };
  },
};

module.exports = { init, handlers, lock, claimUrlFromToken, checkSimplefinUrl, cleanAccounts, mergeAccounts, MIN_PASSPHRASE, _kdf: KDF };
