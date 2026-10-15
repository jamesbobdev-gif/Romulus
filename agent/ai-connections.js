/* ⚙ AI connections: which cloud AIs the Agent lane may use, in order. Keys stay in config.json on this
   computer; the page only ever gets them back masked. */
const providers = require('./providers');
const usage = require('./usage-limit');

let ctx = null; // { readConfig, writeConfig, agentLog, scheduleAgentRun }
function init(c) { ctx = c; }
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
    openai: { hasKey: !!s.openaiKey, key: maskKey(s.openaiKey), model: s.openaiModel },
    openrouter: { hasKey: !!s.openrouterKey, key: maskKey(s.openrouterKey), model: s.openrouterModel, web: s.openrouterWeb, zdr: s.openrouterZdr } };
}
handle('ai:status', () => aiStatus());
handle('ai:save', (_e, change) => {
  const c = readConfig(), ai = Object.assign({}, c.ai);
  change = change || {};
  if (Array.isArray(change.order)) ai.order = change.order.map((p) => ({ id: String(p.id), on: !!p.on }));
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
handle('ai:openrouter-check', async () => {
  const s = providers.settings(readConfig());
  return s.openrouterKey ? providers.openRouterCheck(s.openrouterKey) : { ok: false, error: 'no key saved' };
});
// the cloud AIs a task can be pinned to on the pill (t.cloud; its lane stays 'claude' on the server)
const PINNED_CLOUDS = ['gemini', 'openai'];
function cloudReady(id) {
  const c = readConfig(), s = providers.settings(c);
  return id === 'claude' || (id === 'gemini' ? providers.geminiStatus(c).ready : id === 'openai' ? !!s.openaiKey : !!s.openrouterKey);
}
// the connected cloud AIs, in his order, that can run right now
function cloudOrder() {
  return providers.settings(readConfig()).order.filter((p) => p.on).map((p) => p.id).filter(cloudReady);
}

module.exports = { init, handlers, aiStatus, cloudOrder, cloudReady, PINNED_CLOUDS };
