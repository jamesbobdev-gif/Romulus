/* The other cloud AIs the Agent lane can use besides Claude: Gemini (Google's Gemini CLI, signed in with
   a Google account or a Gemini API key) and OpenRouter (one API key, any of its models). Each gets the
   same instructions and task data as Claude and answers with the same {"updates": [...]} JSON.
   The order and the keys live in this computer's config only (config.json → ai), never in sync.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const PROVIDERS = ['claude', 'gemini', 'openrouter'];
const NAMES = { claude: 'Claude', gemini: 'Gemini', openrouter: 'OpenRouter' };
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto'; // OpenRouter picks a model per request

/* config.json → ai: {order: [{id, on}], geminiKey, geminiModel, openrouterKey, openrouterModel, openrouterWeb} */
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
    openrouterKey: String(ai.openrouterKey || '').trim(),
    openrouterModel: String(ai.openrouterModel || '').trim() || OPENROUTER_DEFAULT_MODEL,
    openrouterWeb: ai.openrouterWeb !== false,
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
const geminiHome = () => path.join(os.homedir(), '.gemini');
// signed in with Google (the CLI caches its OAuth tokens here after the first sign-in)
const geminiSignedIn = () => fs.existsSync(path.join(geminiHome(), 'oauth_creds.json'));

function geminiStatus(cfg) {
  const s = settings(cfg), cli = geminiCli();
  return { installed: !!cli, version: cli && cli.version, signedIn: geminiSignedIn(), hasKey: !!s.geminiKey,
    ready: !!cli && (geminiSignedIn() || !!s.geminiKey) };
}

/* The workspace settings for a run: only reading tools (web search, web pages, the attachments and skills
   in the work folder) plus the agent browser, never the shell or file writing. */
function writeGeminiWorkspace(workDir, browserMcpFile, browserDenied) {
  const settingsDir = path.join(workDir, '.gemini');
  fs.mkdirSync(settingsDir, { recursive: true });
  const ws = {
    tools: { core: ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'glob'] },
    privacy: { usageStatisticsEnabled: false },
    mcpServers: {},
  };
  if (browserMcpFile) {
    try {
      const b = JSON.parse(fs.readFileSync(browserMcpFile, 'utf8')).mcpServers.browser;
      ws.mcpServers.browser = { command: b.command, args: b.args, env: b.env, trust: true, // env: the mail guard (main.js)
        excludeTools: browserDenied.map((n) => n.replace(/^mcp__browser__/, '')) };
    } catch (e) {}
  }
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(ws, null, 1));
}

const GEMINI_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above are ' +
  'written for Claude and apply to you the same way, the hard rule most of all. Your tools here: google_web_search, ' +
  'web_fetch, read_file (attachments/ and skills/ in your folder) and, when listed, the browser_* tools. There is no ' +
  'Gmail in this run, and his mail and account pages are closed in the browser: if a task needs his mail, say so in the note. Reply with ONLY the JSON object described above.\n';

/* → Promise<{text, limit, auth, why}>; onProc gets the child process (so it can be stopped) */
function runGemini(cfg, { prompt, workDir, browserMcpFile, browserDenied, timeoutMs, node, onProc }) {
  const s = settings(cfg), cli = geminiCli();
  if (!cli) return Promise.resolve({ why: 'Gemini CLI isn’t installed' });
  if (!node) return Promise.resolve({ why: 'Node isn’t installed' });
  writeGeminiWorkspace(workDir, browserMcpFile, browserDenied || []);
  // tools are already limited to reading ones above, so nothing is left to confirm (a headless run can't ask)
  const args = [cli.script, '--output-format', 'json', '--approval-mode', 'yolo', '-p', 'Follow the instructions and task data above.'];
  if (browserMcpFile) args.push('--allowed-mcp-server-names', 'browser');
  if (s.geminiModel) args.push('--model', s.geminiModel);
  const env = Object.assign({}, process.env, { GEMINI_TELEMETRY_ENABLED: 'false' });
  if (s.geminiKey && !geminiSignedIn()) env.GEMINI_API_KEY = s.geminiKey; // a Google sign-in wins when both are there
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

/* ── OpenRouter ── */
const OPENROUTER_NOTE = '\n\n## This run\nYou are answering through OpenRouter, standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no files, no Gmail (web search results may be added for you). Answer what you can from what you know and those ' +
  'results; if a task needs a browser, his inbox or a photo, set it to needs-you and say what you\'d need. Reply with ONLY ' +
  'the JSON object described above.\n';

async function runOpenRouter(cfg, { prompt, timeoutMs }) {
  const s = settings(cfg);
  if (!s.openrouterKey) return { why: 'no OpenRouter key' };
  const body = { model: s.openrouterModel, messages: [{ role: 'user', content: prompt + OPENROUTER_NOTE }] };
  if (s.openrouterWeb) body.plugins = [{ id: 'web' }];
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

module.exports = { PROVIDERS, NAMES, OPENROUTER_DEFAULT_MODEL, settings, geminiCli, geminiStatus, runGemini, runOpenRouter, openRouterCheck };
