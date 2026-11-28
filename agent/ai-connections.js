/* AI connections: which cloud AIs the Agent lane may use, in order. Keys stay in config.json on this
   computer; the page only ever gets them back masked. The order, the models and the switches go to his
   other computers (agent/ai-choices-sync.js); keys, sign-ins and extra accounts never do. */
const providers = require('./providers');
const usage = require('./usage-limit');
const meter = require('./usage-meter');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { claudeExe, claudeEnv } = require('./platform');
const claudeAuth = require('./claude-auth');
const openrouterConnect = require('./openrouter-connect');
const accounts = require('./ai-accounts');

let ctx = null; // { userData, readConfig, writeConfig, agentLog, scheduleAgentRun, openExternal }
function init(c) {
  ctx = c; meter.init(c);
  // is Claude Code signed in? asked once at start, in the background; Settings asks again on demand
  setTimeout(() => { claudeAuth.refresh(readConfig()).catch(() => {}); }, 3000);
}
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
const scheduleAgentRun = () => ctx.scheduleAgentRun();
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
/* extra accounts (agent/ai-accounts.js): the config a run on one uses, and what it's called */
const acctCfg = (id, c) => accounts.cfgFor(c || readConfig(), id, { userData: ctx && ctx.userData(), compatIds: providers.COMPAT_IDS });
const nameOf = (id, c) => accounts.nameOf(id, c || readConfig(), providers.NAMES);
// an account id from the page: a known extra account, else null (the main account)
const acctId = (id) => accounts.isAccount(id) && accounts.find(readConfig(), String(id)) ? String(id) : null;

const maskKey = (k) => k ? k.slice(0, 6) + '…' + k.slice(-4) : '';
function aiStatus() {
  const c = readConfig(), s = providers.settings(c);
  const extra = accounts.list(c, providers.PROVIDERS);
  return { order: s.order, names: Object.assign({}, providers.NAMES, Object.fromEntries(extra.map((a) => [a.id, nameOf(a.id, c)]))), used: providers.usedModels(), claudeModel: s.claudeModel, claudeLast: s.claudeLast, helpers: (c.ai || {}).helpers !== false, claudeBlockedUntil: usage.blockedUntil() > Date.now() ? usage.blockedUntil() : 0,
    ready: cloudOrder({ accounts: true }).length > 0, // at least one cloud AI is switched on and able to run
    // Claude Code: installed? signed in (or an API key saved)?
    claude: Object.assign(claudeAuth.status(c), { key: maskKey(String((c.ai || {}).anthropicKey || '').trim()) }),
    gemini: Object.assign(providers.geminiStatus(c), { key: maskKey(s.geminiKey), model: s.geminiModel }),
    openai: { hasKey: !!s.openaiKey, key: maskKey(s.openaiKey), model: s.openaiModel, codexModel: s.codexModel, via: s.openaiVia, codex: providers.codexStatus() },
    openrouter: { hasKey: !!s.openrouterKey, key: maskKey(s.openrouterKey), model: s.openrouterModel, web: s.openrouterWeb, zdr: s.openrouterZdr, free: s.openrouterFree },
    // Grok, Groq: one key and a model each
    ...Object.fromEntries(providers.COMPAT_IDS.map((id) => [id, { compat: true, browser: s[id + 'Browser'], hasKey: !!s[id + 'Key'], key: maskKey(s[id + 'Key']), model: s[id + 'Model'], defaultModel: providers.COMPAT[id].model }])),
    accounts: accounts.list(c, providers.PROVIDERS).map((a) => accountStatus(a.id, c)) };
}
/* one extra account, for its card in Settings: {id, base, name, label, ready, held, and its sign-in or key} */
function accountStatus(id, c) {
  const base = accounts.baseOf(id), ac = acctCfg(id, c), s = providers.settings(ac), a = accounts.find(c, id) || {};
  const out = { id, base, name: nameOf(id, c), label: a.label || '', ready: cloudReady(id), held: accounts.heldUntil(id) };
  if (base === 'claude') Object.assign(out, claudeAuth.status(ac), { key: maskKey(String(ac.ai.anthropicKey || '').trim()) });
  else if (base === 'openai') Object.assign(out, { via: s.openaiVia, hasKey: !!s.openaiKey, key: maskKey(s.openaiKey), codex: providers.codexStatus(s.codexHome) });
  else { const k = base === 'gemini' ? s.geminiKey : base === 'openrouter' ? s.openrouterKey : s[base + 'Key']; Object.assign(out, { hasKey: !!k, key: maskKey(k) }); }
  return out;
}
handle('ai:status', () => aiStatus());
handle('ai:save', (_e, change) => {
  const c = readConfig(), ai = Object.assign({}, c.ai);
  change = change || {};
  if (Array.isArray(change.order)) ai.order = change.order.map((p) => ({ id: String(p.id), on: !!p.on }));
  // a change to one extra account: only its label and its own key
  if (change.account) {
    const id = acctId(change.account);
    if (id) { c.ai = accounts.update(ai, id, change, providers.COMPAT_IDS); accounts.clearHold(id); writeConfig(c); scheduleAgentRun(); }
    return aiStatus();
  }
  if (change.openaiVia === 'chatgpt' || change.openaiVia === 'key') ai.openaiVia = change.openaiVia;
  for (const k of ['claudeModel', 'anthropicKey', 'codexModel', 'geminiKey', 'geminiModel', 'openaiKey', 'openaiModel', 'openrouterKey', 'openrouterModel', ...providers.COMPAT_IDS.flatMap((id) => [id + 'Key', id + 'Model'])]) if (typeof change[k] === 'string') ai[k] = change[k].trim().slice(0, 300);
  for (const k of ['openrouterWeb', 'openrouterZdr', 'openrouterFree', 'helpers', 'claudeLast', ...providers.COMPAT_IDS.map((id) => id + 'Browser')]) if (typeof change[k] === 'boolean') ai[k] = change[k];
  c.ai = ai; writeConfig(c);
  scheduleAgentRun();
  if (ctx.aiChoicesChanged) ctx.aiChoicesChanged(); // his other computers follow
  return aiStatus();
});
// one more account of an AI (switched on, after that AI in the order), or one taken away with its sign-in folder
handle('ai:account-add', (_e, base, label) => {
  // the whole order first (an AI he never moved isn't saved in it yet), so the account lands right after its AI
  const c = readConfig(), r = accounts.add(Object.assign({}, c.ai, { order: providers.settings(c).order }), String(base || ''), { known: providers.PROVIDERS, label });
  if (r.error) return { ok: false, error: r.error, status: aiStatus() };
  c.ai = r.ai; writeConfig(c); agentLog('ai: added ' + nameOf(r.id, c));
  return { ok: true, id: r.id, status: aiStatus() };
});
handle('ai:account-remove', (_e, which) => {
  const id = acctId(which);
  if (!id) return { ok: false, error: 'no such account', status: aiStatus() };
  const c = readConfig(); agentLog('ai: removed ' + nameOf(id, c));
  c.ai = accounts.remove(c.ai || {}, id); writeConfig(c); accounts.clearHold(id);
  try { fs.rmSync(accounts.dirFor(ctx.userData(), id), { recursive: true, force: true }); } catch (e) {} // its sign-in goes with it
  scheduleAgentRun();
  return { ok: true, status: aiStatus() };
});
let geminiInstall = null;
handle('ai:gemini-install', () => {
  geminiInstall = geminiInstall || new Promise((resolve) => {
    agentLog('gemini: installing @google/gemini-cli');
    let out = '';
    const p = require('child_process').spawn('npm', ['install', '-g', '--no-audit', '--no-fund', '@google/gemini-cli'], { shell: true, windowsHide: true });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'npm exited ' + code }));
  }).finally(() => { geminiInstall = null; });
  return geminiInstall.then((r) => Object.assign(r, { status: aiStatus() }));
});
/* ChatGPT on his plan: OpenAI's Codex CLI, then `codex login`, which opens his browser to sign in with ChatGPT */
let codexInstall = null, codexLogin = null;
handle('ai:codex-install', () => {
  codexInstall = codexInstall || new Promise((resolve) => {
    agentLog('codex: installing @openai/codex');
    let out = '';
    const p = require('child_process').spawn('npm', ['install', '-g', '--no-audit', '--no-fund', '@openai/codex'], { shell: true, windowsHide: true });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'npm exited ' + code }));
  }).finally(() => { codexInstall = null; });
  return codexInstall.then((r) => Object.assign(r, { status: aiStatus() }));
});
handle('ai:codex-login', (_e, which) => {
  const cli = providers.codexCli();
  if (!cli) return { ok: false, error: 'install Codex first', status: aiStatus() };
  const id = acctId(which), home = id ? accounts.dirFor(ctx.userData(), id) : null; // an extra account signs in to its own folder
  if (home) try { fs.mkdirSync(home, { recursive: true }); } catch (e) {}
  codexLogin = codexLogin || new Promise((resolve) => {
    agentLog('codex: signing in with ChatGPT' + (id ? ' (' + nameOf(id) + ')' : ''));
    let out = '', p;
    try { p = require('child_process').spawn(process.execPath, [cli.script, 'login'], { windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }, home ? { CODEX_HOME: home } : {}) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 5 * 60 * 1000); // he has 5 minutes in the browser
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => { clearTimeout(killer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim().split('\n').slice(-2).join(' ').slice(0, 300) || 'sign-in didn’t finish' }); });
  }).finally(() => { codexLogin = null; });
  return codexLogin.then((r) => {
    if (r.ok) { const c = readConfig(); c.ai = id ? accounts.update(c.ai || {}, id, { openaiVia: 'chatgpt' }) : Object.assign({}, c.ai, { openaiVia: 'chatgpt' }); writeConfig(c); if (id) accounts.clearHold(id); scheduleAgentRun(); }
    return Object.assign(r, { status: aiStatus() });
  });
});
/* Claude Code: the official installer, a sign-in (opens a terminal running `claude auth login`, and watches
   for it to finish), a fresh look at whether it's signed in, and a one-word run to prove it works */
const claudeCfgOf = (which) => { const id = acctId(which); return id ? acctCfg(id) : readConfig(); };
handle('ai:claude-refresh', async (_e, which) => { await claudeAuth.refresh(claudeCfgOf(which)); return aiStatus(); });
handle('ai:claude-install', async () => {
  const r = await claudeAuth.install(agentLog);
  if (r.ok) await claudeAuth.refresh(readConfig()).catch(() => {});
  return Object.assign(r, { status: aiStatus() });
});
handle('ai:claude-login', async (_e, which) => {
  const r = await claudeAuth.login(claudeCfgOf(which), path.join(ctx.userData(), 'helper-run'), agentLog);
  if (r.ok) { if (acctId(which)) accounts.clearHold(acctId(which)); scheduleAgentRun(); }
  return Object.assign(r, { status: aiStatus() });
});
handle('ai:claude-check', (_e, which) => claudeAuth.check(claudeCfgOf(which), path.join(ctx.userData(), 'helper-run')));
/* OpenRouter without copy-and-paste: its PKCE sign-in in the browser makes a key for this app */
handle('ai:openrouter-connect', async (_e, which) => {
  agentLog('openrouter: connecting in the browser');
  const r = await openrouterConnect.connect({ openExternal: (u) => ctx.openExternal(u) });
  const id = acctId(which);
  if (r.ok && id) { const c = readConfig(); c.ai = accounts.update(c.ai || {}, id, { openrouterKey: r.key }); writeConfig(c); accounts.clearHold(id); scheduleAgentRun(); agentLog('openrouter: connected ' + nameOf(id, c)); }
  else if (r.ok) {
    const c = readConfig(), order = providers.settings(c).order.map((p) => ({ id: p.id, on: p.on || p.id === 'openrouter' }));
    c.ai = Object.assign({}, c.ai, { openrouterKey: r.key, order }); writeConfig(c); // signed in = switched on, so one click is enough
    providers.clearModelCache && providers.clearModelCache('openrouter');
    scheduleAgentRun(); agentLog('openrouter: connected');
  } else agentLog('openrouter: connect failed: ' + r.error);
  return { ok: r.ok, error: r.error, status: aiStatus() };
});
handle('ai:compat-check', async (_e, which) => { // Test key: the key's model list, and whether the saved model is on it
  const acct = acctId(which), id = accounts.baseOf(which);
  if (!providers.COMPAT[id]) return { ok: false, error: 'unknown AI' };
  const s = providers.settings(acct ? acctCfg(acct) : readConfig());
  if (!s[id + 'Key']) return { ok: false, error: 'no key saved' };
  const r = await providers.compatModels(id, s[id + 'Key']);
  return r.ok ? { ok: true, count: r.models.length, hasModel: !s[id + 'Model'] || r.models.includes(s[id + 'Model']), suggest: providers.pickModel(id, r.models) } : r;
});
// Settings' model menus: that AI's models, best first
handle('ai:models', (_e, id) => providers.modelChoices(String(id), readConfig()));
handle('ai:openrouter-check', async (_e, which) => {
  const acct = acctId(which), s = providers.settings(acct ? acctCfg(acct) : readConfig());
  return s.openrouterKey ? providers.openRouterCheck(s.openrouterKey) : { ok: false, error: 'no key saved' };
});
/* The usage bars: what each AI has used. Claude's numbers only come with a Claude run, so when they're
   stale (or he presses refresh) a one-word Haiku run fetches them; OpenRouter's credit comes from its /key; ChatGPT's plan limits
   from the Codex app-server (no run). */
let claudeProbe = null;
function probeClaude() {
  claudeProbe = claudeProbe || new Promise((resolve) => {
    const cfg = readConfig();
    const exe = claudeExe(cfg);
    const dir = path.join(ctx.userData(), 'helper-run'); // empty: nothing of his to read
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    let out = '', p;
    try {
      p = require('child_process').spawn(exe, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--max-turns', '1',
        '--tools', '', '--strict-mcp-config'], { cwd: dir, windowsHide: true, env: claudeEnv(cfg) });
    } catch (e) { return resolve(); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(killer); resolve(); });
    p.stdin.on('error', () => {}); p.stdin.end('Reply with the word ok.');
    p.on('close', () => { clearTimeout(killer); meter.readClaudeStream(out); resolve(); });
  }).finally(() => { claudeProbe = null; });
  return claudeProbe;
}
let creditAt = 0;
handle('ai:usage', async (_e, refresh) => {
  const s = providers.settings(readConfig());
  const on = (id) => s.order.some((p) => p.id === id && p.on);
  const waits = [];
  if (on('claude') && (refresh || Date.now() - meter.claudeCheckedAt() > 20 * 60 * 1000)) waits.push(probeClaude());
  if (s.openrouterKey && (refresh || Date.now() - creditAt > 10 * 60 * 1000)) { creditAt = Date.now(); waits.push(providers.openRouterCheck(s.openrouterKey)); }
  if (on('openai') && s.openaiVia === 'chatgpt' && (refresh || Date.now() - meter.codexCheckedAt() > 10 * 60 * 1000))
    waits.push(providers.codexLimits().then((r) => meter.noteCodex(r)));
  await Promise.all(waits);
  return meter.snapshot();
});
// the readings as they stand, asking no AI anything: for sharing them with his other devices (renderer/js/usage-share.js)
handle('ai:usage-peek', () => meter.snapshot());
// the cloud AIs a task can be pinned to on the pill (t.cloud; its lane stays 'claude' on the server)
const PINNED_CLOUDS = ['gemini', 'openai', 'openrouter', ...providers.COMPAT_IDS];
function cloudReady(id) {
  if (accounts.isAccount(id)) { // an extra account: its own key or sign-in, and not waiting out its usage
    if (!accounts.find(readConfig(), id) || accounts.heldUntil(id)) return false;
    return readyWith(accounts.baseOf(id), acctCfg(id));
  }
  return readyWith(id, readConfig());
}
function readyWith(id, c) {
  const s = providers.settings(c);
  if (providers.COMPAT[id]) return !!s[id + 'Key'];
  if (id === 'claude') return claudeAuth.status(c).ready; // installed, and signed in or with an API key
  return (id === 'gemini' ? providers.geminiStatus(c).ready : id === 'openai' ? (s.openaiVia === 'chatgpt' ? providers.codexStatus(s.codexHome).signedIn : !!s.openaiKey) : !!s.openrouterKey);
}
/* the connected cloud AIs, in his order, that can run right now; with "Save Claude for last" on, Claude goes after all the others.
   accounts: with his extra accounts too (claude~2...). Only the Agent run and the helpers know how to run one; everything
   else (screen helper, legion, mail dates) gets the main accounts */
function cloudOrder({ accounts: withAccounts = false } = {}) {
  const s = providers.settings(readConfig());
  const ids = s.order.filter((p) => p.on && (withAccounts || !accounts.isAccount(p.id))).map((p) => p.id).filter(cloudReady);
  const isClaude = (id) => accounts.baseOf(id) === 'claude';
  return s.claudeLast ? ids.filter((id) => !isClaude(id)).concat(ids.filter(isClaude)) : ids;
}
const claudeLast = () => providers.settings(readConfig()).claudeLast;
/* how much cloud usage is left across his connected AIs, for auto routing: the most any one of them has left
   (a run moves on to the next AI when one runs out, so the pool is only low when all of them are).
   → {left: 0..1 or null (no limit to measure, counts as plenty), tight (under 10% left), out (none left), best: id} */
const TIGHT = 0.1;
function cloudRoom(ids, snap, claudeHeld) {
  let left = -1, best = null;
  for (const id of ids) {
    const r = id === 'claude' && claudeHeld ? 0 : meter.roomLeft(id, snap);
    if (r == null) return { left: null, tight: false, out: false, best: id };
    if (r > left) { left = r; best = id; }
  }
  if (best == null) return { left: null, tight: false, out: false, best: null }; // nothing connected: routing's cloudUp covers that
  return { left, tight: left < TIGHT, out: left <= 0, best };
}
// an extra account that can run (agent/ai-accounts.js) has room nobody measures: the pool isn't low while one is there
const cloudRoomNow = () => {
  const room = cloudRoom(cloudOrder(), meter.snapshot(), Date.now() < usage.blockedUntil());
  if (!(room.tight || room.out) || !cloudOrder({ accounts: true }).some(accounts.isAccount)) return room;
  return Object.assign({}, room, { left: null, tight: false, out: false });
};

/* who a run asks, in turn, until every task is answered: his order (inbox runs too: each AI gets the app's
   own mail tools there and no web, agent/mail-mcp.js); a task he put on Gemini or ChatGPT that one
   first, then the rest of his order. order = cloudOrder(), ready = cloudReady */
/* the cloud AI a task is on: the one he picked (the pill), else whoever answered it last. It is asked
   first; when it fails, the next AI in his order takes over (and the pill moves with it). null = new.
   saveClaude ("Save Claude for last"): Claude having answered last doesn't keep the task on Claude; only his pick on the pill does */
function homeCloud(t, saveClaude) {
  if (PINNED_CLOUDS.includes(t.cloud) || t.cloud === 'claude') return t.cloud; // 'claude' = he switched it back to Claude
  const last = (Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'claude').slice(-1)[0];
  if (!last || last.lane === 'local') return null;
  return PINNED_CLOUDS.includes(last.via) ? last.via : saveClaude ? null : 'claude';
}
// a try that failed because that AI has no usage left
const outOfUsage = (r) => !!(r && (r.limit || r.resetAt));
/* an answer that says it couldn't do the task ("I couldn't verify any showtimes…"): the next AI gets a go
   at it instead of it coming back to him. Asking him something, offering picks or waiting on his yes
   isn't that. `cant` = the AI said so itself */
const CANT = /\b(i )?(couldn['’]t|could not|can['’]t|cannot|wasn['’]t able|was not able|unable to|didn['’]t find|did not find|no way to)\b/i;
// "handing over to Claude", "needs browser access": it passed the task on in its note instead of leaving it out
const HANDOFF = /\b(hand(s|ing|ed)?|pass(es|ing|ed)?)\b[^.]{0,20}\b(over|off|on|it)\b[^.]{0,20}\bclaude\b|\bneeds? (browser access|a browser)\b/i;
function couldntDo(u) {
  if (!u || u.status === 'done') return false;
  const some = (x) => Array.isArray(x) ? x.length > 0 : !!(x && typeof x === 'object');
  if (some(u.ask) || some(u.cart) || some(u.draft) || some(u.cards) || some(u.options) || some(u.seats) || some(u.showtimes) || some(u.theaters)) return false;
  if (typeof u.cant === 'string' && u.cant.trim()) return true;
  return CANT.test(String(u.note || '')) || HANDOFF.test(String(u.note || ''));
}
// a task on an AI tries that AI first, then its other accounts, then the rest of his order.
// His yes to an order is the same: every AI's browser gets his yes (agent/runner.js), so the AI that asked, which
// has the checkout open, places it. (It used to go to Claude only, and when Claude was out of usage the others
// reached the button, were refused, and asked him for yes again and again.)
function runOrder({ order, pinned, ready }) {
  if (!pinned) return order.slice();
  const mine = order.filter((id) => id !== pinned && accounts.baseOf(id) === pinned);
  return (ready(pinned) ? [pinned] : []).concat(mine, order.filter((id) => id !== pinned && !mine.includes(id)));
}

module.exports = { init, handlers, aiStatus, acctCfg, nameOf, claudeLast, cloudOrder, cloudRoom, cloudRoomNow, cloudReady, runOrder, homeCloud, outOfUsage, couldntDo, PINNED_CLOUDS };
