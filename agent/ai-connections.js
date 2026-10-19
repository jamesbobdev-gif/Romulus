/* ⚙ AI connections: which cloud AIs the Agent lane may use, in order. Keys stay in config.json on this
   computer; the page only ever gets them back masked. */
const providers = require('./providers');
const usage = require('./usage-limit');
const meter = require('./usage-meter');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { claudeExe } = require('./platform');

let ctx = null; // { userData, readConfig, writeConfig, agentLog, scheduleAgentRun }
function init(c) { ctx = c; meter.init(c); }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
const scheduleAgentRun = () => ctx.scheduleAgentRun();
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const maskKey = (k) => k ? k.slice(0, 6) + '…' + k.slice(-4) : '';
function aiStatus() {
  const c = readConfig(), s = providers.settings(c);
  return { order: s.order, names: providers.NAMES, used: providers.usedModels(), claudeModel: s.claudeModel, claudeLast: s.claudeLast, helpers: (c.ai || {}).helpers !== false, claudeBlockedUntil: usage.blockedUntil() > Date.now() ? usage.blockedUntil() : 0,
    gemini: Object.assign(providers.geminiStatus(c), { key: maskKey(s.geminiKey), model: s.geminiModel }),
    openai: { hasKey: !!s.openaiKey, key: maskKey(s.openaiKey), model: s.openaiModel, codexModel: s.codexModel, via: s.openaiVia, codex: providers.codexStatus() },
    openrouter: { hasKey: !!s.openrouterKey, key: maskKey(s.openrouterKey), model: s.openrouterModel, web: s.openrouterWeb, zdr: s.openrouterZdr },
    // Grok, Groq: one key and a model each
    ...Object.fromEntries(providers.COMPAT_IDS.map((id) => [id, { compat: true, browser: s.compatBrowser, hasKey: !!s[id + 'Key'], key: maskKey(s[id + 'Key']), model: s[id + 'Model'], defaultModel: providers.COMPAT[id].model }])) };
}
handle('ai:status', () => aiStatus());
handle('ai:save', (_e, change) => {
  const c = readConfig(), ai = Object.assign({}, c.ai);
  change = change || {};
  if (Array.isArray(change.order)) ai.order = change.order.map((p) => ({ id: String(p.id), on: !!p.on }));
  if (change.openaiVia === 'chatgpt' || change.openaiVia === 'key') ai.openaiVia = change.openaiVia;
  for (const k of ['claudeModel', 'codexModel', 'geminiKey', 'geminiModel', 'openaiKey', 'openaiModel', 'openrouterKey', 'openrouterModel', ...providers.COMPAT_IDS.flatMap((id) => [id + 'Key', id + 'Model'])]) if (typeof change[k] === 'string') ai[k] = change[k].trim().slice(0, 300);
  for (const k of ['openrouterWeb', 'openrouterZdr', 'helpers', 'claudeLast', 'compatBrowser']) if (typeof change[k] === 'boolean') ai[k] = change[k];
  c.ai = ai; writeConfig(c);
  scheduleAgentRun();
  return aiStatus();
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
handle('ai:codex-login', () => {
  const cli = providers.codexCli();
  if (!cli) return { ok: false, error: 'install Codex first', status: aiStatus() };
  codexLogin = codexLogin || new Promise((resolve) => {
    agentLog('codex: signing in with ChatGPT');
    let out = '', p;
    try { p = require('child_process').spawn(process.execPath, [cli.script, 'login'], { windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 5 * 60 * 1000); // he has 5 minutes in the browser
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => { clearTimeout(killer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim().split('\n').slice(-2).join(' ').slice(0, 300) || 'sign-in didn’t finish' }); });
  }).finally(() => { codexLogin = null; });
  return codexLogin.then((r) => {
    if (r.ok) { const c = readConfig(); c.ai = Object.assign({}, c.ai, { openaiVia: 'chatgpt' }); writeConfig(c); scheduleAgentRun(); }
    return Object.assign(r, { status: aiStatus() });
  });
});
handle('ai:compat-check', async (_e, id) => { // Test key: the key's model list, and whether the saved model is on it
  if (!providers.COMPAT[id]) return { ok: false, error: 'unknown AI' };
  const s = providers.settings(readConfig());
  if (!s[id + 'Key']) return { ok: false, error: 'no key saved' };
  const r = await providers.compatModels(id, s[id + 'Key']);
  return r.ok ? { ok: true, count: r.models.length, hasModel: !s[id + 'Model'] || r.models.includes(s[id + 'Model']), suggest: providers.pickModel(id, r.models) } : r;
});
// Settings' model menus: that AI's models, best first
handle('ai:models', (_e, id) => providers.modelChoices(String(id), readConfig()));
handle('ai:openrouter-check', async () => {
  const s = providers.settings(readConfig());
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
        '--tools', '', '--strict-mcp-config'], { cwd: dir, windowsHide: true });
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
// the cloud AIs a task can be pinned to on the pill (t.cloud; its lane stays 'claude' on the server)
const PINNED_CLOUDS = ['gemini', 'openai', 'openrouter', ...providers.COMPAT_IDS];
function cloudReady(id) {
  const c = readConfig(), s = providers.settings(c);
  if (providers.COMPAT[id]) return !!s[id + 'Key'];
  return id === 'claude' || (id === 'gemini' ? providers.geminiStatus(c).ready : id === 'openai' ? (s.openaiVia === 'chatgpt' ? providers.codexStatus().signedIn : !!s.openaiKey) : !!s.openrouterKey);
}
// the connected cloud AIs, in his order, that can run right now; with "Save Claude for last" on, Claude goes after all the others
function cloudOrder() {
  const s = providers.settings(readConfig());
  const ids = s.order.filter((p) => p.on).map((p) => p.id).filter(cloudReady);
  return s.claudeLast ? ids.filter((id) => id !== 'claude').concat(ids.filter((id) => id === 'claude')) : ids;
}
const claudeLast = () => providers.settings(readConfig()).claudeLast;

/* who a run asks, in turn, until every task is answered: inbox runs Claude only (the others can't read
   Gmail and could reach the web); a task he put on Gemini or ChatGPT that one first, then the rest of his
   order. order = cloudOrder(), ready = cloudReady */
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
  if (some(u.ask) || some(u.cart) || some(u.cards) || some(u.options) || some(u.seats) || some(u.showtimes) || some(u.theaters)) return false;
  if (typeof u.cant === 'string' && u.cant.trim()) return true;
  return CANT.test(String(u.note || '')) || HANDOFF.test(String(u.note || ''));
}
function runOrder({ order, pinned, mailRun, ready }) {
  if (mailRun) return order.filter((id) => id === 'claude');
  if (!pinned) return order.slice();
  return (ready(pinned) ? [pinned] : []).concat(order.filter((id) => id !== pinned));
}

module.exports = { init, handlers, aiStatus, claudeLast, cloudOrder, cloudReady, runOrder, homeCloud, outOfUsage, couldntDo, PINNED_CLOUDS };
