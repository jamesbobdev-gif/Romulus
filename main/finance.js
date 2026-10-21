/* Finance: his bank accounts, read through SimpleFIN Bridge (bridge.simplefin.org), shown on the Finance tab.
   SimpleFIN is read-only by design: the access link it hands out can list balances and transactions, never
   move money. How the data is kept away from anyone else:
   - Everything (the access link and the downloaded transactions) lives in one file, finance.vault, in the
     user-data folder. It is encrypted with AES-256-GCM under a key made from his passphrase (scrypt), and
     the whole file is encrypted again with Windows' own encryption (safeStorage → DPAPI). The passphrase is
     never saved; the key is only in memory while the tab is unlocked, and is wiped when it locks.
   - It locks after 30 minutes without use, when the screen locks, and when the computer sleeps.
   - Windows Hello (main/finance-hello.js) can open it instead of the passphrase: after a passphrase unlock
     the key is also kept in finance.hello, sealed with Windows' encryption, and only used after Windows'
     own PIN / fingerprint / face prompt says it's him. (That's weaker than the passphrase alone against
     something already running as him on this computer; he chose it for convenience. Off: finance:setHello.)
   - It never leaves this computer: not in config.json (so "Send my settings" to the hub mini PC can't carry
     it), not in tasks.json or Supabase, not one of the hub's remote calls, and the Agent can't read it.
   - It only ever talks to simplefin.org over HTTPS, never follows redirects, and the log never gets amounts,
     names or the link.
   - Purchase emails (main/finance-mail.js) come the other way: his Gmail's receipts go to Claude to be read,
     and what they bought is kept in the vault too. Nothing from the bank goes with them.
   - Live stock prices (main/finance-stocks.js) come from Yahoo Finance's public chart data: only ticker
     symbols are sent, never shares, amounts or account names.
   - Lupa Au Palatine, his own model on the mini PC, can read it (forAgent) for a money question while it's
     unlocked here: agent/local-lane.js gives that tool only to Lupa, in runs with no web, browser or cloud
     helpers, and such a task is never handed to Claude or the other cloud AIs (agent/routing.js). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scrypt = require('util').promisify(crypto.scrypt);
const financeMail = require('./finance-mail');
const stocks = require('./finance-stocks');
const hello = require('./finance-hello');
// the SimpleFIN reading the phone shares (renderer/js/finance-core.js)
const { checkSimplefinUrl, cleanAccounts, mergeAccounts: mergeWith, downloadAccounts, txt } = require('../renderer/js/finance-core');

const VAULT = 'finance.vault';
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }; // ~128 MB per guess: slow to brute-force offline
const MIN_PASSPHRASE = 10;
const IDLE_LOCK_MS = 30 * 60 * 1000;
const MIN_REFRESH_MS = 15 * 60 * 1000; // SimpleFIN Bridge allows only a couple dozen refreshes a day
const STALE_MS = 6 * 60 * 60 * 1000; // older than this: refreshed by itself when he unlocks
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

/* ── Windows Hello: the vault key, sealed by Windows, for when Hello says it's him ── */
const helloFile = () => path.join(ctx.userData(), 'finance.hello');
const helloReady = () => fs.existsSync(helloFile());
const helloApi = () => ctx.hello || hello;
function forgetHello() { try { fs.unlinkSync(helloFile()); } catch (e) {} }
// after a passphrase unlock (unless he turned it off): only if Windows really encrypts it, and Hello is set up
async function rememberForHello() {
  if (!key || (vault && vault.hello === false) || !ctx.seal) return false;
  const k = Buffer.from(key);
  if (!(await helloApi().available().catch(() => false))) return false;
  const sealed = ctx.seal(k.toString('base64'));
  k.fill(0);
  if (typeof sealed !== 'string' || !sealed.startsWith('enc:')) return false; // never the key in the clear
  fs.writeFileSync(helloFile(), JSON.stringify({ v: 1, key: sealed }), { mode: 0o600 });
  return true;
}

/* ── locking ── */
function lock(why) {
  const was = !!key;
  if (key) key.fill(0);
  key = null; vault = null; salt = null; lastQuotes = null; lastDaily = null;
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
const mergeAccounts = (old, fresh, now) => mergeWith(old, fresh, now);
const download = (accessUrl) => downloadAccounts(accessUrl, doFetch);
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

/* ── purchase emails (main/finance-mail.js): in the background after a refresh or an unlock ── */
const MAIL_EVERY_MS = 60 * 60 * 1000;
let mailBusy = false;
function lookAtMail(force) {
  if (mailBusy || !key) return;
  const was = vault.mail || {};
  if (!force && Date.now() - (was.last || 0) < MAIL_EVERY_MS) return;
  const gd = ctx.mail || require('./gmail-dates'); // {gmail, claudeJson, mailAllowed}
  // every Gmail account in Settings → Calendars with "Read receipts for Finance" on, each with its own seen ids
  let accts = [];
  try { accts = gd.receiptAccounts ? gd.receiptAccounts() : (gd.mailAllowed() ? [{ id: null }] : []); } catch (e) {}
  if (!accts.length) { vault.mail = Object.assign({}, was, { off: true }); return; }
  mailBusy = true;
  const k = key; // it locked meanwhile (key changed): what came is dropped
  const tell = () => { if (ctx.sendToRenderer) ctx.sendToRenderer('finance:updated', 'mail'); };
  // the first account's seen ids were kept in mail.seen before there could be more than one
  const seenBy = Object.assign({}, was.seenBy);
  if (!was.seenBy && was.seen && accts[0].id) seenBy[accts[0].id] = was.seen;
  (async () => {
    const got = [], errors = [];
    let checked = 0;
    for (const a of accts) {
      try {
        const r = await financeMail.lookForReceipts({ gmail: (sub) => gd.gmail(sub, a.id), ask: gd.claudeJson, seen: seenBy[a.id] });
        seenBy[a.id] = r.seen; got.push(...r.receipts); checked += r.checked;
      } catch (e) { errors.push((accts.length > 1 && a.email ? a.email + ': ' : '') + e.message); }
    }
    if (errors.length && errors.length === accts.length) throw new Error(errors.join('; '));
    return { receipts: got, checked, error: errors.length ? errors.join('; ') : null };
  })()
    .then((r) => {
      if (key !== k) return;
      const ids = new Set(r.receipts.map((x) => x.id));
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      vault.receipts = (vault.receipts || []).filter((x) => !ids.has(x.id) && x.at >= cutoff).concat(r.receipts)
        .sort((a, b) => b.at - a.at).slice(0, 1500);
      vault.mail = { seenBy, last: Date.now(), error: r.error ? txt(r.error, 200) : null };
      writeVault();
      log('emails: ' + r.checked + ' looked at in ' + accts.length + ' inbox' + (accts.length > 1 ? 'es' : '') + ', ' + r.receipts.length + ' purchases');
    })
    .catch((e) => {
      if (key !== k) return;
      vault.mail = Object.assign({}, was, { last: Date.now(), error: txt(e.message, 200), off: false });
      writeVault();
      log('emails: couldn’t look (' + txt(e.message, 80) + ')');
    })
    .finally(() => { mailBusy = false; if (key === k) tell(); });
  tell();
}

/* ── live stocks (main/finance-stocks.js): the tab asks every minute while it's open ── */
const QUOTE_MS = 55 * 1000;
const DAILY_MS = 3 * 60 * 60 * 1000;
let lastQuotes = null; // {at, quotes, warning}: today's prices, while unlocked (prices aren't saved)
let lastDaily = null; // {at, quotes}: a year of daily closes (the chart shows 3 months, 6 months or the year)
async function stocksNow(force) {
  const held = stocks.holdingsOf((vault.cache && vault.cache.accounts) || []);
  if (!held.length) return { held: 0, rows: [] };
  const symbols = held.map((h) => h.symbol).filter(Boolean);
  const k = key; // it locked meanwhile (key changed): what came is dropped
  let error = null;
  if (force || !lastQuotes || Date.now() - lastQuotes.at >= QUOTE_MS) {
    try {
      const got = await stocks.fetchQuotes(symbols, doFetch, '1d');
      if (key !== k) return { locked: true };
      lastQuotes = { at: Date.now(), quotes: got.quotes, warning: got.warning };
    } catch (e) { if (key !== k) return { locked: true }; error = e.message; }
  }
  if (!lastDaily || Date.now() - lastDaily.at >= DAILY_MS) {
    try {
      const got = await stocks.fetchQuotes(symbols, doFetch, '1y');
      if (key !== k) return { locked: true };
      lastDaily = { at: Date.now(), quotes: got.quotes };
    } catch (e) { if (key !== k) return { locked: true }; }
  }
  return stocks.stocksView(held, lastQuotes && lastQuotes.quotes, lastDaily && lastDaily.quotes, error, lastQuotes && lastQuotes.warning);
}

// "tasks-finance:1:" + the link and (when they fit in a scannable code) his corrections, as base64url JSON
function pairPayload(accessUrl, kinds) {
  const enc = (o) => 'tasks-finance:1:' + Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const withKinds = enc({ u: accessUrl, k: kinds || {} });
  return withKinds.length <= 1600 ? withKinds : enc({ u: accessUrl, k: {} });
}

// after either unlock: an old download refreshed, purchase emails looked at → a warning or undefined
async function afterUnlock() {
  let warning;
  if (Date.now() - ((vault.cache && vault.cache.fetchedAt) || 0) > STALE_MS) {
    try { await refresh(false); } catch (e) { warning = e.message; }
  }
  lookAtMail(false);
  return warning;
}

/* ── Lupa (agent/local-lane.js my_finances): his own model reading it, as plain text ── */
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toFixed(2);
const day = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : 'pending');
const isUnlocked = () => !!key;
/* args: {what: 'overview' | 'transactions' | 'statement', query?, from?, to? (YYYY-MM-DD)} → text for the model.
   Read-only; nothing in it is saved anywhere else. */
function forAgent(args) {
  if (!key) return 'Finance is locked on his computer. Tell him to unlock the Finance tab there (Windows Hello or his passphrase), then reply to this task.';
  stillHere();
  const a = args || {};
  const accounts = (vault.cache && vault.cache.accounts) || [];
  if (!accounts.length) return 'Finance has no accounts downloaded yet.';
  const costs = require('../renderer/js/finance-costs'), stmt = require('../renderer/js/finance-statements');
  const what = ['transactions', 'statement'].includes(a.what) ? a.what : 'overview';
  log('Lupa read ' + what); // what, never amounts
  if (what === 'transactions') {
    const q = String(a.query || '').trim().toLowerCase();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(a.from || '') ? new Date(a.from + 'T00:00:00').getTime() / 1000 : 0;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(a.to || '') ? new Date(a.to + 'T23:59:59').getTime() / 1000 : Infinity;
    const rows = [];
    accounts.forEach((acct) => (acct.transactions || []).forEach((t) => {
      const when = t.posted || Date.now() / 1000;
      if (when < from || when > to) return;
      if (q && ![t.description, t.bank, t.memo].join(' ').toLowerCase().includes(q)) return;
      rows.push({ t, acct });
    }));
    rows.sort((x, y) => (y.t.posted || Infinity) - (x.t.posted || Infinity));
    const out = rows.filter((r) => r.t.amount < 0).reduce((s, r) => s - r.t.amount, 0), inn = rows.filter((r) => r.t.amount > 0).reduce((s, r) => s + r.t.amount, 0);
    return rows.length + ' transaction(s)' + (q ? ' matching "' + q + '"' : '') + ': ' + money(out) + ' out, ' + money(inn) + ' in.\n' +
      rows.slice(0, 80).map((r) => day(r.t.posted) + '  ' + money(r.t.amount) + '  ' + r.t.description + (r.t.bank ? ' [' + r.t.bank + ']' : '') + '  (' + r.acct.name + ')').join('\n') +
      (rows.length > 80 ? '\n…and ' + (rows.length - 80) + ' more (narrow it with query or dates).' : '');
  }
  if (what === 'statement') {
    const s = stmt.incomeStatement(accounts, vault.kinds);
    const line = (name, vals) => name + ': ' + vals.map(money).join(' | ');
    return 'Income statement, columns: ' + s.cols.map((c) => c.label + (c.partial ? ' (so far)' : '')).join(' | ') + '\n' +
      [line('Income', s.incomeTotal), line('Variable costs', s.variableTotal), line('Contribution margin', s.contribution),
        line('Fixed costs', s.fixedTotal), line('Net income', s.net)].join('\n') +
      '\nBiggest variable costs: ' + s.variable.slice(0, 6).map((r) => r.name + ' ' + r.vals.map(money).join('/')).join('; ') +
      '\nFixed costs: ' + s.fixed.map((r) => r.name + ' ' + r.vals.map(money).join('/')).join('; ');
  }
  const c = costs.costsOf([].concat(...accounts.map((x) => x.transactions || [])), vault.kinds);
  const net = accounts.reduce((sum, x) => sum + x.balance, 0);
  const held = stocks.holdingsOf(accounts);
  return 'Accounts:\n' + accounts.map((x) => '- ' + (x.org ? x.org + ' ' : '') + x.name + ': ' + money(x.balance)).join('\n') +
    '\nNet (all accounts, cards and loans negative): ' + money(net) +
    '\nMonthly bills (fixed costs), about ' + money(c.fixedTotal) + ' a month: ' + c.fixed.map((f) => f.name + ' ' + money(f.monthly)).join('; ') +
    '\nEverything else bought (variable), by month: ' + c.months.map((m) => m.label + (m.partial ? ' so far' : '') + ' ' + money(m.total)).join('; ') +
    (held.length ? '\nStocks (brokerage values): ' + held.map((h) => (h.symbol || h.name) + ' ' + h.shares + ' sh ' + money(h.value)).join('; ') : '') +
    '\nLast downloaded from the bank: ' + new Date((vault.cache && vault.cache.fetchedAt) || 0).toLocaleString();
}

/* ── what the tab calls ── */
function status() {
  return { setUp: isSetUp(), unlocked: !!key, fetchedAt: vault && vault.cache ? vault.cache.fetchedAt || 0 : 0,
    waitSeconds: Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)), minPassphrase: MIN_PASSPHRASE, hello: helloReady() };
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
    rememberForHello().catch(() => false);
    lookAtMail(true);
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
    await rememberForHello().catch(() => false);
    return { ok: true, warning: await afterUnlock() };
  },
  // Windows' own prompt (PIN, fingerprint or face), then the key kept for it
  'finance:helloUnlock': async () => {
    if (key) { stillHere(); return { ok: true }; }
    if (!helloReady()) return { ok: false, error: 'Unlock with your passphrase once, then Windows Hello can open Finance.' };
    const result = await helloApi().verify('Unlock Finance', ctx.windowHandle ? ctx.windowHandle() : null);
    if (result !== 'Verified') { log('Windows Hello: ' + (result || 'not asked')); return { ok: false, cancelled: result === 'Canceled', error: hello.why(result) }; }
    if (key) { stillHere(); return { ok: true }; }
    let v, k;
    try {
      v = readVaultFile();
      const raw = ctx.unseal(JSON.parse(fs.readFileSync(helloFile(), 'utf8')).key);
      if (!raw || raw.startsWith('enc:')) throw new Error('sealed');
      k = Buffer.from(raw, 'base64');
      vault = decrypt(v, k); key = k; salt = Buffer.from(v.salt, 'base64');
    } catch (e) {
      forgetHello(); // stale (the vault was made again) or unreadable: back to the passphrase, which sets it up again
      return { ok: false, error: 'Windows Hello can’t open Finance any more. Use your passphrase once and it will work again.' };
    }
    watchPower(); stillHere();
    log('unlocked with Windows Hello');
    return { ok: true, warning: await afterUnlock() };
  },
  // on: kept for Hello now (he's unlocked); off: the sealed copy is deleted
  'finance:setHello': async (_e, on) => {
    if (!key) return { ok: false, error: 'locked' };
    stillHere();
    vault.hello = !!on; writeVault();
    if (on) { if (!(await rememberForHello())) return { ok: false, error: 'Windows Hello isn’t set up on this computer (Settings → Accounts → Sign-in options).', hello: false }; }
    else forgetHello();
    return { ok: true, hello: helloReady() };
  },
  'finance:lock': () => { lock('asked'); return true; },
  // the tab is (or stops being) on screen: no screenshots, screen sharing or screen-reading AI of it
  'finance:screen': (_e, on) => { if (ctx.protectWindow) ctx.protectWindow(!!on); return true; },
  'finance:data': () => {
    if (!key) return { locked: true };
    stillHere();
    const c = vault.cache || {};
    const m = vault.mail || {};
    return { locked: false, fetchedAt: c.fetchedAt || 0, accounts: c.accounts || [], errors: c.errors || [], kinds: vault.kinds || {}, hello: helloReady(),
      receipts: vault.receipts || [], mail: { last: m.last || 0, error: m.error || null, off: !!m.off, busy: mailBusy } };
  },
  // his correction for a payee on the cost charts: fixed, variable, not spending ('skip'), or back to the guess (null);
  // for money in, the key is 'in:' + payee and the kind 'income' or 'skip' (finance-statements.js)
  'finance:setKind': (_e, payee, kind) => {
    if (!key) return { ok: false, error: 'locked' };
    stillHere();
    const k = txt(payee, 80).trim();
    if (!k || (kind != null && !['fixed', 'variable', 'skip', 'income'].includes(kind))) return { ok: false, error: 'bad kind' };
    const kinds = Object.assign({}, vault.kinds);
    if (kind == null) delete kinds[k]; else kinds[k] = kind;
    if (Object.keys(kinds).length > 2000) return { ok: false, error: 'too many' };
    vault.kinds = kinds;
    writeVault();
    return { ok: true, kinds };
  },
  // the tab's minute-by-minute check doesn't count as using it (it still locks after 10 idle minutes)
  'finance:stocks': async (_e, force) => {
    if (!key) return { locked: true };
    if (force) stillHere();
    try { return await stocksNow(!!force); } catch (e) { return { error: e.message, rows: [] }; }
  },
  /* pairing the phone (mobile/finance-phone.js): a QR code with the SimpleFIN link and his fixed/variable
     corrections, shown on this screen only when he asks. It goes straight to the phone's camera, never
     over the internet. Anyone who scans it can read the accounts, so the tab hides it after 2 minutes. */
  'finance:pairCode': async () => {
    if (!key) return { ok: false, error: 'locked' };
    stillHere();
    const text = pairPayload(vault.accessUrl, vault.kinds);
    const svg = await require('qrcode').toString(text, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 });
    log('showed the phone pairing code');
    return { ok: true, svg };
  },
  'finance:refresh': async () => {
    if (!key) return { ok: false, error: 'locked' };
    stillHere();
    lookAtMail(true);
    try { return await refresh(true); } catch (e) { return { ok: false, error: e.message }; }
  },
  // deletes the local file only; the connection itself is turned off on bridge.simplefin.org
  'finance:forget': () => {
    lock('forgotten');
    try { fs.unlinkSync(file()); } catch (e) {}
    forgetHello();
    log('forgotten');
    return { ok: true };
  },
};

module.exports = { init, handlers, lock, forAgent, isUnlocked, claimUrlFromToken, checkSimplefinUrl, cleanAccounts, mergeAccounts, pairPayload, MIN_PASSPHRASE, _kdf: KDF };
