/* ⚙ AI connections: which cloud AIs the Agent lane may use, in order. Keys stay in config.json on this
   computer; the page only ever gets them back masked. */
const providers = require('./providers');
const usage = require('./usage-limit');
const meter = require('./usage-meter');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
  return { order: s.order, names: providers.NAMES, helpers: (c.ai || {}).helpers !== false, claudeBlockedUntil: usage.blockedUntil() > Date.now() ? usage.blockedUntil() : 0,
    gemini: Object.assign(providers.geminiStatus(c), { key: maskKey(s.geminiKey), model: s.geminiModel }),
    openai: { hasKey: !!s.openaiKey, key: maskKey(s.openaiKey), model: s.openaiModel, via: s.openaiVia, codex: providers.codexStatus() },
    openrouter: { hasKey: !!s.openrouterKey, key: maskKey(s.openrouterKey), model: s.openrouterModel, web: s.openrouterWeb, zdr: s.openrouterZdr } };
}
handle('ai:status', () => aiStatus());
handle('ai:save', (_e, change) => {
  const c = readConfig(), ai = Object.assign({}, c.ai);
  change = change || {};
  if (Array.isArray(change.order)) ai.order = change.order.map((p) => ({ id: String(p.id), on: !!p.on }));
  if (change.openaiVia === 'chatgpt' || change.openaiVia === 'key') ai.openaiVia = change.openaiVia;
  for (const k of ['geminiKey', 'geminiModel', 'openaiKey', 'openaiModel', 'openrouterKey', 'openrouterModel']) if (typeof change[k] === 'string') ai[k] = change[k].trim().slice(0, 300);
  for (const k of ['openrouterWeb', 'openrouterZdr', 'helpers']) if (typeof change[k] === 'boolean') ai[k] = change[k];
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
handle('ai:openrouter-check', async () => {
  const s = providers.settings(readConfig());
  return s.openrouterKey ? providers.openRouterCheck(s.openrouterKey) : { ok: false, error: 'no key saved' };
});
/* The usage bars: what each AI has used. Claude's numbers only come with a Claude run, so when they're
   stale (or he presses refresh) a one-word Haiku run fetches them; OpenRouter's credit comes from its /key. */
let claudeProbe = null;
function probeClaude() {
  claudeProbe = claudeProbe || new Promise((resolve) => {
    const cfg = readConfig();
    const exe = (cfg.agentRunner || {}).command || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
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
  await Promise.all(waits);
  return meter.snapshot();
});
// the cloud AIs a task can be pinned to on the pill (t.cloud; its lane stays 'claude' on the server)
const PINNED_CLOUDS = ['gemini', 'openai'];
function cloudReady(id) {
  const c = readConfig(), s = providers.settings(c);
  return id === 'claude' || (id === 'gemini' ? providers.geminiStatus(c).ready : id === 'openai' ? (s.openaiVia === 'chatgpt' ? providers.codexStatus().signedIn : !!s.openaiKey) : !!s.openrouterKey);
}
// the connected cloud AIs, in his order, that can run right now
function cloudOrder() {
  return providers.settings(readConfig()).order.filter((p) => p.on).map((p) => p.id).filter(cloudReady);
}

/* who a run asks, in turn, until every task is answered: inbox runs Claude only (the others can't read
   Gmail and could reach the web); a task he put on Gemini or ChatGPT that one first, then the rest of his
   order. order = cloudOrder(), ready = cloudReady */
function runOrder({ order, pinned, mailRun, ready }) {
  if (mailRun) return order.filter((id) => id === 'claude');
  if (!pinned) return order.slice();
  return (ready(pinned) ? [pinned] : []).concat(order.filter((id) => id !== pinned));
}

module.exports = { init, handlers, aiStatus, cloudOrder, cloudReady, runOrder, PINNED_CLOUDS };
