/* His Link wallet (Stripe's Link, the wallet AI agents like Meta's Muse and Instinct pay with): lets the
   Agent buy at a store where he has no card saved and no Shop Pay. The flow, as those agents do it:
   after his yes in the task, the browser launcher asks Link for a spend request (the store, the total,
   the items); he approves that exact amount in the Link app; Link answers with a one-time virtual card
   capped at it; the launcher types the card into the store's card form itself. The AI never sees the
   number: it is told the brand and the last four digits, and every page it reads afterwards has the
   number blanked out (agent/browser-proxy.js, which also keeps screenshots off once a card is on a page).
   Two sides share this file: the app (Settings: install Link's command-line tool, connect, status; the
   runner: what to tell the AI) and the browser launcher's copy next to agent/browser-proxy.js (spend
   requests, the card, kept only in that process's memory). Node built-ins only, so the copy runs on its
   own and the tests need no Electron. Link pays for US and Canadian customers; the store can be anywhere. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LINK_CLI = '@stripe/link-cli@1.2.0';
const CLIENT_NAME = 'Romulus'; // what the Link app shows when he approves the connection
const CARD_FRESH_MS = 12 * 60 * 60 * 1000; // an approved request (and its card) is reused this long
const APPROVAL_POLL_MS = 3000;
const LIMITS_FRESH_MS = 10 * 60 * 1000;

const dirFor = (userData) => path.join(userData, 'link-wallet');
const toolDirFor = (userData) => path.join(dirFor(userData), 'tool');
const cliFor = (userData) => path.join(toolDirFor(userData), 'node_modules', '@stripe', 'link-cli', 'dist', 'cli.js');
const authFileFor = (userData) => path.join(dirFor(userData), 'auth.json'); // Link's own sign-in file (its tool reads and rotates it)
const pendingFileFor = (userData) => path.join(dirFor(userData), 'pending.json'); // the spend request a task is paying with

/* Money as a checkout shows it → the currency's minor units: "$131.00" → 13100, "1,234.50" → 123450,
   131 → 13100. null for nothing, zero, a negative or "free". */
function cents(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  const s = String(v == null ? '' : v).replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!s || /-/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
const money = (c, currency) => (!currency || String(currency).toLowerCase() === 'usd' ? '$' : String(currency).toUpperCase() + ' ') + (Number(c || 0) / 100).toFixed(2);
const hostOf = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase() : ''; } catch (e) { return ''; } };
// a value for the tool's key:value lists (line items, totals), which split on commas and colons
const kv = (s, n) => String(s == null ? '' : s).replace(/[\s,:]+/g, ' ').trim().slice(0, n);

/* The tool's --format json output: a list of everything the command yielded (the last entry is the
   answer), or one object with a code and a message when it failed. Anything around it (a notice) is
   skipped. */
function parseOutput(text) {
  const t = String(text || '');
  const starts = ['[', '{'].map((c) => t.indexOf(c)).filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = t.lastIndexOf(t[start] === '[' ? ']' : '}');
  if (end < start) return null;
  let v; try { v = JSON.parse(t.slice(start, end + 1)); } catch (e) { return null; }
  if (Array.isArray(v)) return v.length ? v[v.length - 1] : null;
  return v && typeof v === 'object' ? v : null;
}

/* One command of Link's tool → {ok: true, data} or {ok: false, error, code}. node: the node to run it
   with; cli: its dist/cli.js; auth: his sign-in file. --format json tells it an agent is calling, so it
   draws no screens and checks for no updates; its skill installer is kept off too. */
function runner({ node, cli, auth, spawn: sp = spawn, timeoutMs = 90000 }) {
  return (args, opts = {}) => new Promise((resolve) => {
    let out = '', err = '', p, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const env = Object.assign({}, process.env, { NO_UPDATE_NOTIFIER: '1', LINK_CLI_SKIP_SKILL_INSTALL: '1' }, auth ? { LINK_AUTH_FILE: auth } : {});
    try { p = sp(node, [cli].concat(args, ['--format', 'json']), { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: e.message }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} finish({ ok: false, error: 'Link’s tool took too long' }); }, opts.timeoutMs || timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); finish({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(killer);
      const data = parseOutput(out) || parseOutput(err);
      if (code === 0 && data) return finish({ ok: true, data });
      const msg = data && data.message ? String(data.message) : ((err || out).trim().split('\n').filter(Boolean).slice(-1)[0] || ('Link’s tool stopped with code ' + code));
      finish({ ok: false, error: msg.replace(/\s+/g, ' ').slice(0, 300), code: data && data.code ? String(data.code) : undefined, data: data || undefined });
    });
  });
}

/* What he reads in the Link app when approving (the tool wants at least 100 characters): the store, the
   items, the total, and that it is his own task and his own yes behind it. */
function contextFor({ merchantName, merchantUrl, items, amount, currency, task, why }) {
  const list = (Array.isArray(items) ? items : []).slice(0, 12).map((it) => (Number(it.qty) > 1 ? Number(it.qty) + ' x ' : '') + String(it.name || '').trim().slice(0, 60) + (it.price ? ' (' + String(it.price).trim().slice(0, 16) + ')' : '')).filter((s) => s && s !== ' ').join('; ');
  let s = 'Buying from ' + String(merchantName || '').trim().slice(0, 80) + ' for the user, who asked for this in his Romulus task "' + String(task || 'a task').slice(0, 100) + '" and said yes to the order' +
    (why ? ' (' + String(why).trim().slice(0, 120) + ')' : '') + ': ' + (list || 'the items in his cart') + '. Total ' + money(amount, currency) + ' at ' + String(merchantUrl || '').slice(0, 200) + '.';
  if (s.length < 100) s += ' The card is for this one purchase at this store, for the amount shown.';
  return s.slice(0, 1000);
}
// one of his items as the tool's key:value line item (the price shown is that line's, so the unit price is it over the count)
function lineItem(it) {
  const qty = Math.max(1, Math.round(Number(it.qty) || 1));
  const line = cents(it.price);
  let s = 'name:' + (kv(it.name, 60) || 'item') + ',quantity:' + qty;
  if (line) s += ',unit_amount:' + Math.max(1, Math.round(line / qty));
  return s;
}
function totalsFor({ amount, subtotal, shipping, tax }) {
  const out = [];
  const sub = cents(subtotal), ship = cents(shipping), tx = cents(tax);
  if (sub) out.push('type:subtotal,display_text:Subtotal,amount:' + sub);
  if (ship) out.push('type:shipping,display_text:Shipping,amount:' + ship);
  if (tx) out.push('type:tax,display_text:Tax,amount:' + tx);
  out.push('type:total,display_text:Total,amount:' + amount);
  return out;
}

/* The launcher's side: spend requests and the card, for one run.
   {node, cli, auth, test, pending (the pending file), task (its title), spawn, now} */
function wallet({ node, cli, auth, test, pending, task, spawn: sp, now = Date.now, log = () => {} }) {
  const run = runner({ node, cli, auth, spawn: sp });
  const cards = {}; // spend request id → the card itself: only ever in this process's memory, never written or logged
  let current = null; // the request this run is paying with
  const readPending = () => { try { const p = JSON.parse(fs.readFileSync(pending, 'utf8')); return p && p.id ? p : null; } catch (e) { return null; } };
  const writePending = (p) => {
    try {
      if (!p) { fs.rmSync(pending, { force: true }); return; }
      fs.mkdirSync(path.dirname(pending), { recursive: true }); fs.writeFileSync(pending, JSON.stringify(p));
    } catch (e) {}
  };
  const forget = () => { writePending(null); current = null; };
  // the card for an approved request, fetched once and held here → what the AI may know of it, or null
  async function hold(id) {
    if (!cards[id]) {
      const r = await run(['spend-request', 'retrieve', id, '--include', 'card']);
      const c = r.ok && r.data && r.data.card;
      if (!c || !c.number) return null;
      const number = String(c.number).replace(/\D/g, '');
      cards[id] = { number, cvc: String(c.cvc || ''), brand: String(c.brand || 'card'), last4: number.slice(-4),
        expMonth: Number(c.exp_month) || 0, expYear: Number(c.exp_year) || 0, billing: c.billing_address || null, validUntil: c.valid_until || null };
    }
    return shown(id);
  }
  function shown(id) {
    const c = cards[id]; if (!c) return null;
    return { brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, expiry: String(c.expMonth).padStart(2, '0') + '/' + String(c.expYear).slice(-2), billing: c.billing };
  }
  // a request's state → what the AI is told
  async function outcome(p, sr) {
    const st = sr.status;
    const base = { ok: true, id: p.id, status: st, amount: p.amount, currency: p.currency, merchant: p.merchantName, approvalUrl: sr.approval_url || p.approvalUrl || '' };
    if (st === 'approved') {
      const card = await hold(p.id);
      return card ? Object.assign(base, { card }) : Object.assign(base, { ok: false, status: 'approved', error: 'approved, but the card could not be fetched: try link_wait again' });
    }
    if (st === 'created' || st === 'pending_approval') return Object.assign(base, { status: 'pending' });
    if (st === 'requires_action') {
      const na = (sr.status_details && sr.status_details.requires_action && sr.status_details.requires_action.next_action) || {};
      if (na.resolution !== 'auto_resume') forget();
      return Object.assign(base, { status: 'action', message: String(na.display_message || 'Link needs something from him first').slice(0, 300), actionUrl: na.action_url || '', resolution: na.resolution || '' });
    }
    forget(); // denied, expired, canceled, failed, or already paid with (submitted, succeeded)
    return Object.assign(base, { status: st === 'succeeded' || st === 'submitted' ? 'used' : String(st || 'unknown') });
  }
  async function poll(p, ms) {
    const until = now() + ms;
    for (;;) {
      const r = await run(['spend-request', 'retrieve', p.id]);
      if (!r.ok) return { ok: false, id: p.id, status: 'error', error: r.error, approvalUrl: p.approvalUrl || '', amount: p.amount, currency: p.currency, merchant: p.merchantName };
      const o = await outcome(p, r.data);
      if (o.status !== 'pending' || now() + APPROVAL_POLL_MS > until) return o;
      await new Promise((res) => setTimeout(res, APPROVAL_POLL_MS));
    }
  }
  /* Ask for a card for this checkout: a request he has already approved for this store and amount is
     reused (its card is good for hours); one approved for another amount (tax showed up after the card)
     is raised and goes back to him; otherwise a new request. Then wait up to waitMs for his approval. */
  async function request({ merchantName, merchantUrl, total, items, subtotal, shipping, tax, why, currency, waitMs = 20000 }) {
    const amount = cents(total);
    if (!amount) return { ok: false, status: 'error', error: 'total must be the amount as the checkout shows it, like "$131.00"' };
    const host = hostOf(merchantUrl);
    if (!host) return { ok: false, status: 'error', error: 'merchant_url must be the store’s checkout page (https://…)' };
    currency = /^[a-z]{3}$/i.test(String(currency || '')) ? String(currency).toLowerCase() : 'usd';
    let p = readPending();
    if (p && (p.host !== host || !!p.test !== !!test || now() - Number(p.at || 0) > CARD_FRESH_MS)) {
      // another store's, or stale: withdraw it if it still waits, so he isn't left a dangling approval
      await run(['spend-request', 'cancel', p.id]).catch(() => {});
      forget(); p = null;
    }
    if (p) {
      const r = await run(['spend-request', 'retrieve', p.id]);
      const st = r.ok ? r.data.status : 'gone';
      if (st === 'approved' && p.amount === amount) { current = p; return outcome(p, r.data); }
      if (st === 'approved') { // the total changed: the same request, approved again for the new total
        const u = await run(['spend-request', 'update', p.id, '--amount', String(amount)]);
        const a = u.ok ? await run(['spend-request', 'request-approval', p.id]) : u;
        if (a.ok) { p.amount = amount; p.at = now(); writePending(p); current = p; log('raised to ' + money(amount, currency)); return poll(p, waitMs); }
      }
      if ((st === 'created' || st === 'pending_approval') && p.amount === amount) { current = p; return poll(p, waitMs); }
      if (st === 'approved' || st === 'created' || st === 'pending_approval') await run(['spend-request', 'cancel', p.id]).catch(() => {});
      forget(); p = null;
    }
    const args = ['spend-request', 'create', '--amount', String(amount), '--currency', currency,
      '--merchant-name', kv(merchantName, 80) || host, '--merchant-url', String(merchantUrl).slice(0, 500),
      '--context', contextFor({ merchantName: kv(merchantName, 80) || host, merchantUrl, items, amount, currency, task, why }),
      '--idempotency-key', 'romulus-' + require('crypto').randomUUID()];
    for (const it of (Array.isArray(items) ? items : []).slice(0, 20)) if (it && it.name) args.push('--line-item', lineItem(it));
    for (const t of totalsFor({ amount, subtotal, shipping, tax })) args.push('--total', t);
    if (test) args.push('--test');
    const r = await run(args);
    if (!r.ok) return { ok: false, status: 'error', error: r.error, code: r.code };
    p = { id: r.data.id, host, merchantName: kv(merchantName, 80) || host, amount, currency, at: now(), test: !!test, approvalUrl: r.data.approval_url || '' };
    writePending(p); current = p;
    log('asked for ' + money(amount, currency) + ' at ' + host + (test ? ' (test mode)' : ''));
    if (r.data.status && r.data.status !== 'created' && r.data.status !== 'pending_approval') return outcome(p, r.data);
    return poll(p, waitMs);
  }
  async function wait(seconds) {
    const p = readPending();
    if (!p) return { ok: false, status: 'error', error: 'nothing is waiting for his approval: call link_pay_request first' };
    current = p;
    return poll(p, Math.max(1, Math.min(Number(seconds) || 60, 90)) * 1000);
  }
  async function cancel() {
    const p = readPending();
    if (!p) return { ok: false, error: 'no Link request to withdraw' };
    await run(['spend-request', 'cancel', p.id]).catch(() => {});
    forget();
    return { ok: true };
  }
  const card = (id) => cards[id || (current && current.id)] || null;
  const secrets = () => Object.values(cards).map((c) => ({ number: c.number, cvc: c.cvc }));
  return { request, wait, cancel, card, shown, secrets, current: () => current, readPending };
}

/* ---------- the app's side ---------- */
let ctx = null; // { userData, readConfig, writeConfig, agentLog, openExternal }
function init(c) { ctx = c; }
const log = (m) => { try { ctx.agentLog('link: ' + m); } catch (e) {} };
const nodeExe = () => require('./platform').findNode(); // here only: the launcher's copy of this file has no platform.js beside it
const paths = () => ({ cli: cliFor(ctx.userData()), auth: authFileFor(ctx.userData()), pending: pendingFileFor(ctx.userData()) });
const settings = () => Object.assign({ test: false }, (ctx.readConfig() || {}).link || {});

// what Link's sign-in file says: connected, or a sign-in he started and hasn't finished
function readAuth(file, now = Date.now()) {
  let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { connected: false, pending: null }; }
  const a = j && j.auth;
  if (a && a.access_token) return { connected: true, scope: String(a.scope || ''), pending: null };
  const p = j && j.pendingDeviceAuth;
  if (p && p.verification_url && Number(p.expires_at) > now) return { connected: false, pending: { url: String(p.verification_url), phrase: String(p.phrase || ''), expiresAt: Number(p.expires_at) } };
  return { connected: false, pending: null };
}
let installing = null;
async function ensureCli() { // → true once Link's tool is in place (installed with npm the first time, like the browser tool)
  const { cli } = paths();
  if (fs.existsSync(cli)) return true;
  const node = nodeExe();
  if (!node) return false;
  installing = installing || new Promise((resolve) => {
    const toolDir = toolDirFor(ctx.userData());
    fs.mkdirSync(toolDir, { recursive: true });
    if (!fs.existsSync(path.join(toolDir, 'package.json'))) fs.writeFileSync(path.join(toolDir, 'package.json'), '{"private":true}');
    log('installing ' + LINK_CLI);
    const env = Object.assign({}, process.env, { PATH: path.dirname(node) + path.delimiter + (process.env.PATH || ''), LINK_CLI_SKIP_SKILL_INSTALL: '1' });
    // --ignore-scripts: its install script would add its agent skill to this computer's global skills folder
    const p = require('child_process').spawn('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', LINK_CLI], { cwd: toolDir, shell: true, windowsHide: true, env });
    p.on('error', () => resolve()); p.on('close', () => resolve());
  }).finally(() => { installing = null; });
  await installing;
  if (!fs.existsSync(cli)) { log('install failed'); return false; }
  return true;
}
const cliRun = () => { const { cli, auth } = paths(); return runner({ node: nodeExe(), cli, auth }); };
let limits = { at: 0, data: null, email: '' };
async function refreshLimits() {
  const r = await cliRun()(['user-info', 'retrieve'], { timeoutMs: 20000 }); // a run's start waits for this at most every ten minutes
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  limits = { at: Date.now(), data: d.agent_wallet_spend_limits || null, email: String(d.email || (d.user && d.user.email) || '').slice(0, 120), verify: d.agent_wallet_verification_requirement || null };
}
let address = { at: 0, data: null };
async function defaultAddress() { // his Link shipping address, for checkouts
  if (Date.now() - address.at < LIMITS_FRESH_MS) return address.data;
  const r = await cliRun()(['shipping-address', 'list'], { timeoutMs: 20000 });
  const list = r.ok ? (Array.isArray(r.data) ? r.data : Array.isArray(r.data.data) ? r.data.data : []) : [];
  const d = list.find((x) => x && x.is_default && x.address) || list.find((x) => x && x.address) || null;
  address = { at: Date.now(), data: d ? d.address : null };
  return address.data;
}
const oneLineAddress = (a) => a ? [a.name, a.line_1, a.line_2, [a.locality, a.administrative_area].filter(Boolean).join(', '), a.postal_code, a.country_code].filter(Boolean).join(', ') : '';
/* {node, installed, connected, scope, pending: {url, phrase} while a sign-in waits, test, limits, email}.
   poll: a sign-in is waiting, so ask Link's tool (which finishes it once he has approved in the Link app). */
async function status({ poll } = {}) {
  const node = nodeExe();
  const { cli, auth } = paths();
  const installed = fs.existsSync(cli);
  let a = readAuth(auth);
  if (poll && installed && node && !a.connected && a.pending) { await cliRun()(['auth', 'status']); a = readAuth(auth); }
  if (a.connected && installed && node && Date.now() - limits.at > LIMITS_FRESH_MS) await refreshLimits().catch((e) => { log('limits: ' + e.message); limits.at = Date.now(); });
  return { node: !!node, installed, connected: a.connected, scope: a.scope || '', pending: a.connected ? null : a.pending, test: !!settings().test,
    limits: a.connected ? limits.data : null, email: a.connected ? limits.email : '', verify: a.connected ? limits.verify : null };
}
// start the sign-in: Link's tool asks for a device code; he opens the link and enters the phrase in the Link app
async function connect() {
  if (!nodeExe()) return { ok: false, error: 'Node.js isn’t installed (the Agent’s browser needs it too: see Setup)' };
  if (!(await ensureCli())) return { ok: false, error: 'couldn’t install Link’s tool (is npm on the PATH?)' };
  const { auth } = paths();
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  // payments only: no reading of his bank transactions or balances
  const r = await cliRun()(['auth', 'login', '--client-name', CLIENT_NAME, '--interval', '0', '--no-financial-insights']);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.data.verification_url) return { ok: false, error: 'Link didn’t give a sign-in link' };
  log('sign-in started');
  return { ok: true, url: String(r.data.verification_url), phrase: String(r.data.phrase || '') };
}
async function disconnect() {
  const { cli, auth, pending } = paths();
  if (fs.existsSync(cli) && nodeExe()) await cliRun()(['auth', 'logout']).catch(() => {});
  try { fs.rmSync(auth, { force: true }); fs.rmSync(pending, { force: true }); } catch (e) {}
  limits = { at: 0, data: null, email: '' }; address = { at: 0, data: null };
  log('disconnected');
  return status();
}
function save(change) {
  const c = ctx.readConfig();
  c.link = Object.assign({}, c.link, { test: !!(change && change.test) });
  ctx.writeConfig(c);
  return status();
}
// what the AI is told about the wallet in a run that has it
function promptPart({ test, limits: lim, address: addr }) {
  const per = lim && lim.per_transaction && lim.per_transaction.limit != null ? money(lim.per_transaction.limit) : '';
  const day = lim && lim.daily && lim.daily.remaining != null ? money(lim.daily.remaining) : '';
  return '\n\n## His Link wallet\nConnected' + (test ? ' in TEST MODE: the cards are fakes and nothing is charged (say so in the note)' : '') +
    '. It pays at a store where he has no saved card and no Shop Pay, with a one-time card: the shopping skill’s "Paying with Link" says the steps ' +
    '(after his yes: link_pay_request, his approval in the Link app, link_enter_card, then the order button). You never see or type the card number.' +
    (per ? ' Up to ' + per + ' per purchase' + (day ? ', ' + day + ' left today' : '') + '.' : '') +
    (addr ? '\nHis Link shipping address, for checkouts (unless his preferences give another): ' + oneLineAddress(addr) : '') + '\n';
}
// for a run with the agent browser: where the launcher finds Link, and the AI's instructions; null when not connected
async function forRun() {
  const s = await status();
  if (!s.node || !s.installed || !s.connected) return null;
  const { cli, auth, pending } = paths();
  const addr = await defaultAddress().catch(() => null);
  return { cli, auth, pending, test: s.test, part: promptPart({ test: s.test, limits: s.limits, address: addr }) };
}
const LINK_SITE = /^https:\/\/([a-z0-9-]+\.)*(link\.com|stripe\.com)(\/|$)/i;
const handlers = {
  'link:status': (_e, opts) => status(opts || {}),
  'link:connect': () => connect(),
  'link:disconnect': () => disconnect(),
  'link:save': (_e, change) => save(change),
  'link:open': (_e, url) => { if (LINK_SITE.test(String(url || ''))) { ctx.openExternal(String(url)); return true; } return false; },
};

module.exports = { init, handlers, LINK_CLI, CLIENT_NAME, CARD_FRESH_MS, dirFor, cliFor, authFileFor, pendingFileFor, cents, money, hostOf, kv, parseOutput, runner,
  contextFor, lineItem, totalsFor, wallet, readAuth, promptPart, oneLineAddress, status, connect, disconnect, forRun, ensureCli };
