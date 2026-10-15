/* The other cloud AIs the Agent lane can use besides Claude: Gemini (a Gemini API key; Google ended "Login
   with Google" for personal accounts on 2026-06-18. With Google's Gemini CLI installed it gets the agent
   browser and the attachments; without it, the plain API with Google Search), ChatGPT (an OpenAI API key, with
   OpenAI's web search; separate from a ChatGPT subscription) and OpenRouter (one API key, any
   of its models, only through providers that don't keep or train on what's sent). Each gets the
   same instructions and task data as Claude and answers with the same {"updates": [...]} JSON.
   The order and the keys live in this computer's config only (config.json → ai), never in sync.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PROVIDERS = ['claude', 'gemini', 'openai', 'openrouter'];
const NAMES = { claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT', openrouter: 'OpenRouter' };
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto'; // OpenRouter picks a model per request

/* config.json → ai: {order: [{id, on}], geminiKey, geminiModel, openaiKey, openaiModel, openrouterKey, openrouterModel, openrouterWeb, openrouterZdr} */
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
    openrouterKey: String(ai.openrouterKey || '').trim(),
    openrouterModel: String(ai.openrouterModel || '').trim() || OPENROUTER_DEFAULT_MODEL,
    openrouterWeb: ai.openrouterWeb !== false,
    openrouterZdr: ai.openrouterZdr !== false, // zero data retention only: on unless he turns it off
  };
}

/* ── Gemini CLI ── */
// the installed CLI's script (npm -g puts it under %APPDATA%\npm), run with node so no .cmd quoting is involved
let npmRoot; // asked once: npm is slow to start
function geminiCli() {
  if (npmRoot === undefined) {
    try { npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim(); } catch (e) { npmRoot = null; }
  }
  const roots = [path.join(process.env.APPDATA || '', 'npm', 'node_modules')];
  if (npmRoot) roots.unshift(npmRoot);
  for (const root of roots) {
    const dir = path.join(root, '@google', 'gemini-cli');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.gemini || Object.values(pkg.bin)[0]);
      if (bin && fs.existsSync(path.join(dir, bin))) return { script: path.join(dir, bin), version: pkg.version };
    } catch (e) {}
  }
  return null;
}
function geminiStatus(cfg) {
  const s = settings(cfg), cli = geminiCli();
  // the CLI is optional: without it Gemini runs through the API (no browser, no photos)
  return { installed: !!cli, version: cli && cli.version, hasKey: !!s.geminiKey, ready: !!s.geminiKey, mode: cli ? 'cli' : 'api' };
}

/* The workspace settings for a run: only reading tools (web search, web pages, the attachments and skills
   in the work folder) plus the agent browser, never the shell or file writing. */
function writeGeminiWorkspace(workDir, browserMcpFile, browserDenied) {
  const settingsDir = path.join(workDir, '.gemini');
  fs.mkdirSync(settingsDir, { recursive: true });
  const ws = {
    tools: { core: ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'glob'] },
    privacy: { usageStatisticsEnabled: false },
    security: { auth: { selectedType: 'gemini-api-key' } }, // the key below, never a cached Google login
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

const GEMINI_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above are ' +
  'written for Claude and apply to you the same way, the hard rule most of all. Your tools here: google_web_search, ' +
  'web_fetch, read_file (attachments/ and skills/ in your folder) and, when listed, the browser_* tools. There is no ' +
  'Gmail in this run, and his mail and account pages are closed in the browser: if a task needs his mail, say so in the note. Reply with ONLY the JSON object described above.\n';

/* note (the API runners below): replaces the "This run" note, e.g. for a helper's plain-text answer */
/* → Promise<{text, limit, auth, why}>; onProc gets the child process (so it can be stopped) */
function runGemini(cfg, { prompt, workDir, browserMcpFile, browserDenied, timeoutMs, node, onProc }) {
  const s = settings(cfg), cli = geminiCli();
  if (!s.geminiKey) return Promise.resolve({ auth: true, why: 'no Gemini API key' });
  if (!cli || !node) return runGeminiApi(cfg, { prompt, timeoutMs }); // no CLI: the API, without the browser
  writeGeminiWorkspace(workDir, browserMcpFile, browserDenied || []);
  // tools are already limited to reading ones above, so nothing is left to confirm (a headless run can't ask)
  const args = [cli.script, '--output-format', 'json', '--approval-mode', 'yolo', '-p', 'Follow the instructions and task data above.'];
  if (browserMcpFile) args.push('--allowed-mcp-server-names', 'browser');
  if (s.geminiModel) args.push('--model', s.geminiModel);
  const env = Object.assign({}, process.env, { GEMINI_TELEMETRY_ENABLED: 'false', GEMINI_API_KEY: s.geminiKey });
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(killer); resolve(r); } };
    let p;
    try { p = spawn(node, args, { cwd: workDir, env, windowsHide: true }); } catch (e) { return resolve({ why: 'could not start Gemini' }); }
    if (onProc) onProc(p);
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeoutMs || 15 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => finish({ why: 'could not start Gemini (' + e.message + ')' }));
    p.stdin.on('error', () => {});
    p.stdin.end(prompt + GEMINI_NOTE);
    p.on('close', (code) => {
      let j = null; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) {}
      const text = j && typeof j.response === 'string' ? j.response : '';
      const all = (err + '\n' + out + '\n' + (j && j.error ? JSON.stringify(j.error) : '')).slice(-4000);
      if (text && !(j && j.error)) return finish({ text, log: all });
      finish({ log: all,
        limit: /quota|rate.?limit|resource.?exhausted|\b429\b|too many requests/i.test(all),
        auth: /auth|sign.?in|log.?in|credential|api.?key|permission|\b401\b|\b403\b/i.test(all),
        why: 'Gemini exited with code ' + code });
    });
  });
}

/* Gemini without the CLI: one generateContent call with Google Search grounding. No browser, no files. */
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const GEMINI_API_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is Google ' +
  'Search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need. Reply with ONLY the JSON object described above.\n';

async function runGeminiApi(cfg, { prompt, timeoutMs, note }) {
  const s = settings(cfg);
  if (!s.geminiKey) return { auth: true, why: 'no Gemini API key' };
  const model = (s.geminiModel || GEMINI_DEFAULT_MODEL).replace(/^models\//, '');
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
  if (r.ok && text) return { text, log: 'api ' + model };
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 403 || /api.?key/i.test(msg),
    why: 'Gemini: ' + String(msg).slice(0, 160) };
}

/* ── ChatGPT (OpenAI's Responses API) ── */
const OPENAI_NOTE = '\n\n## This run\nYou are running as ChatGPT (OpenAI), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is web ' +
  'search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need. Reply with ONLY the JSON object described above.\n';

async function runOpenAI(cfg, { prompt, timeoutMs, note }) {
  const s = settings(cfg);
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
  if (r.ok && text) return { text, model: j.model };
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 403,
    why: 'ChatGPT: ' + String(msg).slice(0, 160) };
}

/* ── OpenRouter ── */
const OPENROUTER_NOTE = '\n\n## This run\nYou are answering through OpenRouter, standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no files, no Gmail (web search results may be added for you). Answer what you can from what you know and those ' +
  'results; if a task needs a browser, his inbox or a photo, set it to needs-you and say what you\'d need. Reply with ONLY ' +
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
  if (r.ok && text) return { text: String(text), model: j.model };
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
    return { ok: true, label: d.label || null, usage: d.usage, limit: d.limit };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { PROVIDERS, NAMES, OPENROUTER_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, runOpenAI, settings, geminiCli, geminiStatus, runGemini, runGeminiApi, runOpenRouter, openRouterCheck };
