/* The other cloud AIs the Agent lane can use besides Claude: Gemini (a Gemini API key; Google ended "Login
   with Google" for personal accounts on 2026-06-18. With Google's Gemini CLI installed it gets the agent
   browser and the attachments; without it, the plain API with Google Search), ChatGPT (his ChatGPT plan through
   OpenAI's Codex CLI when he's signed in to it, else an OpenAI API key; web search either way) and OpenRouter (one API key, any
   of its models, only through providers that don't keep or train on what's sent). Each gets the
   same instructions and task data as Claude and answers with the same {"updates": [...]} JSON.
   The order and the keys live in this computer's config only (config.json → ai), never in sync.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const meter = require('./usage-meter');

const PROVIDERS = ['claude', 'gemini', 'openai', 'openrouter'];
const NAMES = { claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT', openrouter: 'OpenRouter' };
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto'; // OpenRouter picks a model per request

/* config.json → ai: {order: [{id, on}], geminiKey, geminiModel, openaiVia, openaiKey, openaiModel, openrouterKey, openrouterModel, openrouterWeb, openrouterZdr} */
function settings(cfg) {
  const ai = (cfg && cfg.ai) || {};
  const seen = new Set();
  const order = (Array.isArray(ai.order) ? ai.order : []).filter((p) => p && PROVIDERS.includes(p.id) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ id: p.id, on: p.on !== false }));
  for (const id of PROVIDERS) if (!seen.has(id)) order.push({ id, on: id === 'claude' }); // Claude on by default, the rest off
  return {
    order,
    geminiKey: String(ai.geminiKey || '').trim(),
    geminiModel: String(ai.geminiModel || '').trim(),
    openaiKey: String(ai.openaiKey || '').trim(),
    openaiModel: String(ai.openaiModel || '').trim() || OPENAI_DEFAULT_MODEL,
    // 'chatgpt': his ChatGPT plan through the Codex CLI; 'key': the API key. Unset: the key if he saved one
    openaiVia: ai.openaiVia === 'chatgpt' || ai.openaiVia === 'key' ? ai.openaiVia : ai.openaiKey ? 'key' : 'chatgpt',
    openrouterKey: String(ai.openrouterKey || '').trim(),
    openrouterModel: String(ai.openrouterModel || '').trim() || OPENROUTER_DEFAULT_MODEL,
    openrouterWeb: ai.openrouterWeb !== false,
    openrouterZdr: ai.openrouterZdr !== false, // zero data retention only: on unless he turns it off
  };
}

/* ── Gemini CLI ── */
// an installed CLI's script (npm -g puts it under %APPDATA%\npm), run with node so no .cmd quoting is involved
let npmRoot; // asked once: npm is slow to start
function npmCli(pkgPath, binName) {
  if (npmRoot === undefined) {
    try { npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim(); } catch (e) { npmRoot = null; }
  }
  const roots = [path.join(process.env.APPDATA || '', 'npm', 'node_modules')];
  if (npmRoot) roots.unshift(npmRoot);
  for (const root of roots) {
    const dir = path.join(root, ...pkgPath.split('/'));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin[binName] || Object.values(pkg.bin)[0]);
      if (bin && fs.existsSync(path.join(dir, bin))) return { script: path.join(dir, bin), version: pkg.version };
    } catch (e) {}
  }
  return null;
}
const geminiCli = () => npmCli('@google/gemini-cli', 'gemini');
function geminiStatus(cfg) {
  const s = settings(cfg), cli = geminiCli();
  // the CLI is optional: without it Gemini runs through the API (no browser, no photos)
  return { installed: !!cli, version: cli && cli.version, hasKey: !!s.geminiKey, ready: !!s.geminiKey, mode: cli ? 'cli' : 'api' };
}

/* The workspace settings for a run: only reading tools (web search, web pages, the attachments and skills
   in the work folder) plus the agent browser, never the shell or file writing. */
function writeGeminiWorkspace(workDir, browserMcpFile, browserDenied, model) {
  const settingsDir = path.join(workDir, '.gemini');
  fs.mkdirSync(settingsDir, { recursive: true });
  const ws = {
    tools: { core: ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'glob'] },
    privacy: { usageStatisticsEnabled: false },
    security: { auth: { selectedType: 'gemini-api-key' } }, // the key below, never a cached Google login
    // the CLI's web search and web page tools use gemini-3-flash whatever --model says; free keys run out of it,
    // and then every search retries until the run times out. They use the run's model instead.
    modelConfigs: { customAliases: {
      'web-search': { extends: 'base', modelConfig: { model, generateContentConfig: { tools: [{ googleSearch: {} }] } } },
      'web-fetch': { extends: 'base', modelConfig: { model, generateContentConfig: { tools: [{ urlContext: {} }] } } },
    } },
    mcpServers: {},
  };
  if (browserMcpFile) {
    try {
      const b = JSON.parse(fs.readFileSync(browserMcpFile, 'utf8')).mcpServers.browser;
      ws.mcpServers.browser = { command: b.command, args: b.args, env: b.env, trust: true, // env: the mail guard (agent/agent-browser.js)
        excludeTools: browserDenied.map((n) => n.replace(/^mcp__browser__/, '')) };
    } catch (e) {}
  }
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(ws, null, 1));
}

// the other AIs tend to stop at 3 options and link articles about them: the prompt's ask, said again where it reads it
const CHOICES_NOTE = ' Offering choices? Give 6 or more `options` when there are that many good ones (the app shows 3 and ' +
  'he scrolls sideways for the rest), each `url` that option\'s own page, not an article or search page about it.';
const GEMINI_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above are ' +
  'written for Claude and apply to you the same way, the hard rule most of all. Your tools here: google_web_search, ' +
  'web_fetch, read_file (attachments/ and skills/ in your folder) and, when listed, the browser_* tools. There is no ' +
  'Gmail in this run, and his mail and account pages are closed in the browser: if a task needs his mail, say so in the note.' +
  CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';

/* note (the API runners below): replaces the "This run" note, e.g. for a helper's plain-text answer */
/* Which Gemini models a run tries, in order: the one set in Settings, else Argon (the best, but free keys get none
   of it: limit 0 until billing is on) then Flash; Flash-Lite last, as it's the one that still answers when Google
   says the others are busy. A model Google turns away (busy, over its quota, gone) hands over to the next one. */
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const GEMINI_PREFERRED_MODEL = 'gemini-4-argon';
const GEMINI_LITE_MODEL = 'gemini-3.5-flash-lite';
function geminiModels(s) {
  const first = s.geminiModel.replace(/^models\//, '');
  return [...new Set(first ? [first, GEMINI_LITE_MODEL] : [GEMINI_PREFERRED_MODEL, GEMINI_DEFAULT_MODEL, GEMINI_LITE_MODEL])];
}
const GEMINI_BUSY_RE = /\b503\b|high demand|overloaded|"?UNAVAILABLE"?/i;
const GEMINI_LIMIT_RE = /quota|rate.?limit|resource.?exhausted|\b429\b|too many requests/i;
const GEMINI_GONE_RE = /no longer available|models\/\S+ is not found|ModelNotFound/i;
// a rejected key: checked before the quota words, which the CLI's retry messages can also contain
const GEMINI_BADKEY_RE = /API_KEY_INVALID|API key not valid|API key expired/i;
const GEMINI_BADKEY_WHY = 'Gemini’s API key isn’t valid: paste a new one in Settings → AI connections';
// tries each model in turn; only the last one's quota error counts on the usage meter
async function geminiFallback(s, call) {
  const models = geminiModels(s), tried = [];
  let r;
  for (let i = 0; i < models.length; i++) {
    r = await call(models[i], i === models.length - 1);
    tried.push(models[i] + (r.text ? '' : r.busy ? ' (busy)' : r.limit ? ' (over quota)' : r.gone ? ' (not available)' : ''));
    if (r.text || !(r.busy || r.limit || r.gone)) break;
  }
  r.log = 'models: ' + tried.join(' → ') + '\n' + (r.log || '');
  return r;
}

/* → Promise<{text, limit, auth, why}>; onProc gets the child process (so it can be stopped) */
async function runGemini(cfg, opts) {
  const s = settings(cfg), cli = geminiCli();
  if (!s.geminiKey) return { auth: true, why: 'no Gemini API key' };
  if (!cli || !opts.node) return runGeminiApi(cfg, { prompt: opts.prompt, timeoutMs: opts.timeoutMs }); // no CLI: the API, without the browser
  return geminiFallback(s, (model, last) => {
    writeGeminiWorkspace(opts.workDir, opts.browserMcpFile, opts.browserDenied || [], model);
    return runGeminiCli(s, cli, opts, model, last);
  });
}
function runGeminiCli(s, cli, { prompt, workDir, browserMcpFile, timeoutMs, node, onProc }, model, last) {
  // tools are already limited to reading ones above, so nothing is left to confirm (a headless run can't ask)
  const args = [cli.script, '--output-format', 'json', '--approval-mode', 'yolo', '-p', 'Follow the instructions and task data above.'];
  if (browserMcpFile) args.push('--allowed-mcp-server-names', 'browser');
  args.push('--model', model);
  // trust: newer CLIs (0.6x) exit with code 55 in an untrusted folder when headless; the work folder is ours
  const env = Object.assign({}, process.env, { GEMINI_TELEMETRY_ENABLED: 'false', GEMINI_API_KEY: s.geminiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true' });
  return new Promise((resolve) => {
    let out = '', err = '', done = false, refused = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(killer); resolve(r); } };
    let p;
    try { p = spawn(node, args, { cwd: workDir, env, windowsHide: true }); } catch (e) { return resolve({ why: 'could not start Gemini' }); }
    if (onProc) onProc(p);
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeoutMs || 15 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    // the CLI keeps retrying a busy or limited model until the run times out: with another model left to try,
    // stop at Google's first refusal so that one gets the time; the last model gets three tries
    p.stderr.on('data', (d) => {
      err += d;
      if (refused || (last && (err.match(/Attempt \d+ failed/g) || []).length < 3)) return;
      refused = GEMINI_BADKEY_RE.test(err) ? 'badkey' : GEMINI_BUSY_RE.test(err) ? 'busy' : GEMINI_LIMIT_RE.test(err) ? 'limit' : GEMINI_GONE_RE.test(err) ? 'gone' : null;
      if (refused) try { p.kill(); } catch (e) {}
    });
    p.on('error', (e) => finish({ why: 'could not start Gemini (' + e.message + ')' }));
    p.stdin.on('error', () => {});
    p.stdin.end(prompt + GEMINI_NOTE);
    p.on('close', (code) => {
      if (refused === 'badkey') return finish({ auth: true, log: err.slice(-2000), why: GEMINI_BADKEY_WHY });
      if (refused) {
        if (refused === 'limit' && last) meter.noteCall('gemini', { limited: true });
        return finish({ [refused]: true, log: err.slice(-2000),
          why: 'Gemini (' + model + ') ' + { busy: 'is busy', limit: 'is over its quota', gone: 'is not available' }[refused] });
      }
      let j = null; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) {}
      const text = j && typeof j.response === 'string' ? j.response : '';
      const all = (err + '\n' + out + '\n' + (j && j.error ? JSON.stringify(j.error) : '')).slice(-4000);
      if (text && !(j && j.error)) { meter.noteCall('gemini', {}); return finish({ text, log: all }); }
      if (GEMINI_BADKEY_RE.test(all)) return finish({ auth: true, log: all, why: GEMINI_BADKEY_WHY });
      const limit = GEMINI_LIMIT_RE.test(all);
      if (limit && last) meter.noteCall('gemini', { limited: true, perDay: /PerDay/i.test(all) ? Number((all.match(/"quotaValue"\s*:\s*"?(\d+)/) || [])[1]) || null : null });
      finish({ log: all, limit, busy: GEMINI_BUSY_RE.test(all), gone: GEMINI_GONE_RE.test(all),
        auth: /auth|sign.?in|log.?in|credential|api.?key|permission|\b401\b|\b403\b/i.test(all),
        why: 'Gemini exited with code ' + code });
    });
  });
}

/* Gemini without the CLI: one generateContent call with Google Search grounding. No browser, no files. */
const GEMINI_API_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is Google ' +
  'Search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';

async function runGeminiApi(cfg, { prompt, timeoutMs, note }) {
  const s = settings(cfg);
  if (!s.geminiKey) return { auth: true, why: 'no Gemini API key' };
  return geminiFallback(s, (model, last) => geminiApiCall(s, model, last, { prompt, timeoutMs, note }));
}
async function geminiApiCall(s, model, last, { prompt, timeoutMs, note }) {
  let r, j = null;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs || 600000, 600000)),
      headers: { 'x-goog-api-key': s.geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt + (note != null ? note : GEMINI_API_NOTE) }] }], tools: [{ google_search: {} }] }) });
    j = await r.json().catch(() => null);
  } catch (e) { return { why: 'Gemini unreachable (' + e.message + ')' }; }
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
  if (r.ok && text) { meter.noteCall('gemini', { tokens: j.usageMetadata && j.usageMetadata.totalTokenCount }); return { text, log: 'api ' + model }; }
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  if (GEMINI_BADKEY_RE.test(msg)) return { log: msg, auth: true, why: GEMINI_BADKEY_WHY };
  if (r.status === 429 && last) meter.noteCall('gemini', { limited: true, perDay: meter.geminiDailyLimit(j && j.error) });
  return { log: msg, limit: r.status === 429, busy: r.status === 503, gone: r.status === 404,
    auth: r.status === 401 || r.status === 403 || /api.?key/i.test(msg),
    why: 'Gemini (' + model + '): ' + String(msg).slice(0, 160) };
}

/* ── ChatGPT (OpenAI's Responses API) ── */
const OPENAI_NOTE = '\n\n## This run\nYou are running as ChatGPT (OpenAI), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is web ' +
  'search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';

async function runOpenAI(cfg, { prompt, timeoutMs, note, node }) {
  const s = settings(cfg);
  if (s.openaiVia === 'chatgpt') return runCodex({ prompt, timeoutMs, note, node });
  if (!s.openaiKey) return { auth: true, why: 'no OpenAI API key' };
  let r, j = null;
  try {
    r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs || 600000, 600000)),
      headers: { Authorization: 'Bearer ' + s.openaiKey, 'Content-Type': 'application/json' },
      // store: false — OpenAI doesn't keep the response for later retrieval
      body: JSON.stringify({ model: s.openaiModel, input: prompt + (note != null ? note : OPENAI_NOTE), tools: [{ type: 'web_search' }], store: false }) });
    j = await r.json().catch(() => null);
  } catch (e) { return { why: 'ChatGPT unreachable (' + e.message + ')' }; }
  const text = (j && Array.isArray(j.output) ? j.output : []).filter((o) => o && o.type === 'message')
    .flatMap((o) => Array.isArray(o.content) ? o.content : []).filter((c) => c && c.type === 'output_text').map((c) => c.text || '').join('');
  if (r.ok && text) { meter.noteCall('openai', { tokens: j.usage && j.usage.total_tokens }); return { text, model: j.model }; }
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 403,
    why: 'ChatGPT: ' + String(msg).slice(0, 160) };
}

/* ── ChatGPT on his plan: OpenAI's Codex CLI, signed in with his ChatGPT account (`codex login`), so runs
   use his plan's Codex allowance instead of a paid API key. Codex is a coding agent: a run here gets web
   search only. Its shell, code runner, apps, plugins, browser and sub-agents are switched off, its own
   config (MCP servers) is skipped, the sandbox is read-only and the work folder is empty. ── */
const codexCli = () => npmCli('@openai/codex', 'codex');
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// signed in with ChatGPT? Only auth_mode is looked at, never the tokens
function codexSignedIn() {
  try { return JSON.parse(fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8')).auth_mode === 'chatgpt'; } catch (e) { return false; }
}
function codexStatus() {
  const cli = codexCli();
  return { installed: !!cli, version: cli && cli.version, signedIn: !!cli && codexSignedIn() };
}
const CODEX_OFF = ['shell_tool', 'unified_exec', 'code_mode_host', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'tool_suggest', 'multi_agent', 'hooks', 'goals', 'sleep_tool'];
function codexArgs(script, outFile) {
  const a = [script, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'web_search="live"', '-o', outFile];
  for (const f of CODEX_OFF) a.push('--disable', f);
  a.push('-'); // the prompt comes on stdin
  return a;
}
const CODEX_LIMIT_RE = /usage limit|rate.?limit|\b429\b|too many requests|quota/i;
const CODEX_AUTH_RE = /not logged in|log ?in again|sign ?in again|unauthori[sz]ed|\b401\b|token.*(expired|invalid|revoked)|refresh token/i;
// node: a real node, or none (Electron's own, run as node)
function runCodex({ prompt, timeoutMs, note, node }) {
  const cli = codexCli();
  if (!cli) return Promise.resolve({ auth: true, why: 'the Codex CLI isn’t installed: press Install in Settings → AI connections' });
  if (!codexSignedIn()) return Promise.resolve({ auth: true, why: 'ChatGPT isn’t signed in: press Sign in with ChatGPT in Settings → AI connections' });
  const workDir = path.join(os.tmpdir(), 'tasks-codex-run'); // empty: nothing of his to read
  const outFile = path.join(os.tmpdir(), 'tasks-codex-last.txt');
  try { fs.rmSync(workDir, { recursive: true, force: true }); fs.mkdirSync(workDir, { recursive: true }); fs.rmSync(outFile, { force: true }); } catch (e) {}
  return new Promise((resolve) => {
    let err = '', done = false, p;
    const finish = (r) => { if (!done) { done = true; clearTimeout(killer); resolve(r); } };
    const env = Object.assign({}, process.env, node ? {} : { ELECTRON_RUN_AS_NODE: '1' });
    try { p = spawn(node || process.execPath, codexArgs(cli.script, outFile), { cwd: workDir, env, windowsHide: true }); }
    catch (e) { return resolve({ why: 'could not start Codex' }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, Math.min(timeoutMs || 600000, 15 * 60 * 1000));
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', (e) => finish({ why: 'could not start Codex (' + e.message + ')' }));
    p.stdin.on('error', () => {});
    p.stdin.end(prompt + (note != null ? note : OPENAI_NOTE));
    p.on('close', (code) => {
      let text = ''; try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch (e) {}
      const log = err.slice(-3000), model = (err.match(/^model:\s*(\S+)/m) || [])[1];
      if (code === 0 && text) {
        meter.noteCall('openai', { tokens: Number(((err.match(/tokens used\s*\n\s*([\d,]+)/i) || [])[1] || '').replace(/,/g, '')) || null });
        return finish({ text, model, log });
      }
      const limit = CODEX_LIMIT_RE.test(log);
      finish({ log, limit, auth: !limit && CODEX_AUTH_RE.test(log),
        why: 'ChatGPT (Codex) ' + (limit ? 'is out of usage on your plan' : 'exited with code ' + code) });
    });
  });
}

/* ── OpenRouter ── */
const OPENROUTER_NOTE = '\n\n## This run\nYou are answering through OpenRouter, standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no files, no Gmail (web search results may be added for you). Answer what you can from what you know and those ' +
  'results; if a task needs a browser, his inbox or a photo, set it to needs-you and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY ' +
  'the JSON object described above.\n';

async function runOpenRouter(cfg, { prompt, timeoutMs, note }) {
  const s = settings(cfg);
  if (!s.openrouterKey) return { why: 'no OpenRouter key' };
  const body = { model: s.openrouterModel, messages: [{ role: 'user', content: prompt + (note != null ? note : OPENROUTER_NOTE) }] };
  if (s.openrouterWeb) body.plugins = [{ id: 'web' }];
  // only providers that don't collect what's sent; with ZDR, only ones that don't keep it at all
  body.provider = s.openrouterZdr ? { data_collection: 'deny', zdr: true } : { data_collection: 'deny' };
  let r, j = null;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs || 600000, 600000)),
      headers: { Authorization: 'Bearer ' + s.openrouterKey, 'Content-Type': 'application/json', 'X-Title': 'Tasks' },
      body: JSON.stringify(body) });
    j = await r.json().catch(() => null);
  } catch (e) { return { why: 'OpenRouter unreachable (' + e.message + ')' }; }
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (r.ok && text) { meter.noteCall('openrouter', { tokens: j.usage && j.usage.total_tokens }); return { text: String(text), model: j.model }; }
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 402 || r.status === 403,
    why: 'OpenRouter: ' + String(msg).slice(0, 160) };
}

async function openRouterCheck(key) { // → {ok, label, credits} for Settings
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || 'HTTP ' + r.status };
    const d = (j && j.data) || {};
    meter.noteCredit(d.usage, d.limit);
    return { ok: true, label: d.label || null, usage: d.usage, limit: d.limit };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { PROVIDERS, NAMES, OPENROUTER_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, runOpenAI, settings, geminiCli, codexCli, codexStatus, codexArgs, geminiStatus, runGemini, runGeminiApi, runOpenRouter, openRouterCheck };
