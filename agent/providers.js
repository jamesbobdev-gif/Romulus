/* The other cloud AIs the Agent lane can use besides Claude: Gemini (a Gemini API key; Google ended "Login
   with Google" for personal accounts on 2026-06-18. With Google's Gemini CLI installed it gets the agent
   browser and the attachments; without it, the plain API with Google Search), ChatGPT (his ChatGPT plan through
   OpenAI's Codex CLI when he's signed in to it, else an OpenAI API key; web search either way) and OpenRouter (one API key, any
   of its models, only through providers that don't keep or train on what's sent), plus the ones with a free
   API tier that speak OpenAI's chat format (Grok, Groq, Cerebras: see COMPAT). Each gets the
   same instructions and task data as Claude and answers with the same {"updates": [...]} JSON.
   The order and the keys live in this computer's config only (config.json → ai), never in sync.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const meter = require('./usage-meter');

/* The AIs with a free API tier and OpenAI's chat format: one key each, no tools (no browser, files or Gmail).
   model: the default; prefer: which of its /models to use when that one is gone (they rename models often) */
const COMPAT = {
  xai: { name: 'Grok', base: 'https://api.x.ai/v1', model: 'grok-4-fast-reasoning', prefer: /^grok-4.*fast/ },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', prefer: /gpt-oss-120b|llama-3\.3-70b/ },
  cerebras: { name: 'Cerebras', base: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', prefer: /gpt-oss-120b|qwen-3.*235b|llama-3\.3-70b/ },
};
const COMPAT_IDS = Object.keys(COMPAT);
const PROVIDERS = ['claude', 'gemini', 'openai', 'openrouter', ...COMPAT_IDS];
const NAMES = Object.assign({ claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT', openrouter: 'OpenRouter' },
  Object.fromEntries(COMPAT_IDS.map((id) => [id, COMPAT[id].name])));
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto'; // OpenRouter picks a model per request

/* config.json → ai: {order: [{id, on}], claudeModel, geminiKey, geminiModel, openaiVia, openaiKey, openaiModel, codexModel, openrouterKey, openrouterModel,
   openrouterWeb, openrouterZdr, and <id>Key, <id>Model for each COMPAT id}. A blank model is Auto: the best one that AI has (see Auto below) */
function settings(cfg) {
  const ai = (cfg && cfg.ai) || {};
  const seen = new Set();
  const order = (Array.isArray(ai.order) ? ai.order : []).filter((p) => p && PROVIDERS.includes(p.id) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ id: p.id, on: p.on !== false }));
  for (const id of PROVIDERS) if (!seen.has(id)) order.push({ id, on: id === 'claude' }); // Claude on by default, the rest off
  const compat = {};
  for (const id of COMPAT_IDS) {
    compat[id + 'Key'] = String(ai[id + 'Key'] || '').trim();
    compat[id + 'Model'] = String(ai[id + 'Model'] || '').trim();
  }
  return Object.assign(compat, {
    order,
    claudeModel: String(ai.claudeModel || '').trim(), // blank: Claude Code's own default for his plan
    codexModel: String(ai.codexModel || '').trim(), // blank: Codex's own default
    geminiKey: String(ai.geminiKey || '').trim(),
    geminiModel: String(ai.geminiModel || '').trim(),
    openaiKey: String(ai.openaiKey || '').trim(),
    openaiModel: String(ai.openaiModel || '').trim(),
    // 'chatgpt': his ChatGPT plan through the Codex CLI; 'key': the API key. Unset: the key if he saved one
    openaiVia: ai.openaiVia === 'chatgpt' || ai.openaiVia === 'key' ? ai.openaiVia : ai.openaiKey ? 'key' : 'chatgpt',
    openrouterKey: String(ai.openrouterKey || '').trim(),
    openrouterModel: String(ai.openrouterModel || '').trim() || OPENROUTER_DEFAULT_MODEL,
    openrouterWeb: ai.openrouterWeb !== false,
    openrouterZdr: ai.openrouterZdr !== false, // zero data retention only: on unless he turns it off
    claudeLast: ai.claudeLast !== false, // Claude only after the others: his Claude usage is kept for building the app
  });
}

/* ── Auto: the best model each AI has right now ──
   A model left blank in Settings is Auto. The AI's own model list (asked at most every few hours) is ranked by
   TIERS, best kind first and the newest version within a kind, and a run tries the best of each kind in turn:
   when one is busy, over its quota or gone, the next takes over. Without a list, the built-in defaults. */
const TIERS = {
  gemini: [/^gemini.*(argon|-pro)/, /^gemini.*flash(?!-lite)/, /^gemini.*flash-lite/],
  openai: [/^gpt-\d+(\.\d+)?$/, /^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d+(\.\d+)?-nano$/],
  xai: [/^grok-\d+(\.\d+)?(-latest)?$/, /^grok-\d.*fast.*reasoning/, /^grok-\d.*fast/],
  groq: [/gpt-oss-120b/, /kimi-k2|llama-4-maverick|qwen3?-32b/, /llama-3\.3-70b/],
  cerebras: [/gpt-oss-120b|qwen-3.*235b/, /llama-4|llama-3\.3-70b|qwen-3/],
};
// not chat models, or a dated snapshot of one that has a plain name too
const SKIP_MODEL_RE = /embed|whisper|tts|audio|realtime|transcribe|image|imagen|vision|veo|guard|moderation|ocr|search|computer|robotics|live|aqa|codex|gemma|-\d{4}-\d{2}-\d{2}$/i;
function rankModels(id, models) {
  const tiers = TIERS[id] || [];
  const ver = (m) => /latest/.test(m) ? 999 : parseFloat((m.match(/\d+(?:\.\d+)?/) || [])[0]) || 0;
  const pre = (m) => /preview|exp|beta/i.test(m) ? 1 : 0;
  return [...new Set(models)].filter((m) => !SKIP_MODEL_RE.test(m)).map((m) => ({ m, t: tiers.findIndex((re) => re.test(m)) }))
    .filter((x) => x.t >= 0).sort((a, b) => a.t - b.t || pre(a.m) - pre(b.m) || ver(b.m) - ver(a.m) || a.m.length - b.m.length).map((x) => x.m);
}
// what Auto tries, in order: the best of each tier
function autoModels(id, models) {
  const seen = new Set();
  return rankModels(id, models).filter((m) => { const t = TIERS[id].findIndex((re) => re.test(m)); return !seen.has(t) && seen.add(t); });
}
const listCache = {}; // id → {key, at, models}
async function listJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = j && (j.error || j.detail); return { ok: false, error: (e && (e.message || (typeof e === 'string' ? e : ''))) || 'HTTP ' + r.status }; }
  return { ok: true, j };
}
const dataIds = (j) => (Array.isArray(j && j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean);
const LISTERS = {
  gemini: async (key) => { const r = await listJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key });
    return r.ok ? { ok: true, models: (Array.isArray(r.j && r.j.models) ? r.j.models : [])
      .filter((m) => m && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent')))
      .map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean) } : r; },
  openai: async (key) => { const r = await listJson('https://api.openai.com/v1/models', { Authorization: 'Bearer ' + key }); return r.ok ? { ok: true, models: dataIds(r.j) } : r; },
  openrouter: async (key) => { const r = await listJson('https://openrouter.ai/api/v1/models', { Authorization: 'Bearer ' + key }); return r.ok ? { ok: true, models: dataIds(r.j) } : r; },
};
// the key's models: kept 6 hours (10 minutes when they couldn't be read); [] when unknown
async function modelList(id, key) {
  const c = listCache[id];
  if (c && c.key === key && Date.now() - c.at < (c.models.length ? 6 * 3600e3 : 10 * 60e3)) return c.models;
  let r = null;
  try { r = COMPAT[id] ? await compatModels(id, key) : LISTERS[id] ? await LISTERS[id](key) : null; } catch (e) {}
  const models = r && r.ok && Array.isArray(r.models) ? r.models : [];
  listCache[id] = { key, at: Date.now(), models };
  return models;
}
const clearModelCache = () => { for (const k of Object.keys(listCache)) delete listCache[k]; };
// the model each AI answered with last (Settings shows what Auto is on)
const lastUsed = {};
const usedModels = () => Object.assign({}, lastUsed);
// tries each model in turn while one is busy, over its quota or gone
async function tryModels(id, models, call) {
  const tried = [];
  let r;
  for (const m of models) {
    r = await call(m);
    tried.push(m + (r.text ? '' : r.busy ? ' (busy)' : r.limit ? ' (over quota)' : r.gone ? ' (not available)' : ''));
    if (r.text) { lastUsed[id] = r.model || m; break; }
    if (!(r.busy || r.limit || r.gone)) break;
  }
  if (tried.length > 1) r.log = 'models: ' + tried.join(' → ') + '\n' + (r.log || '');
  return r;
}
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku']; // Claude Code's names for the newest of each
/* Settings' model menu: {ok, models (the ranked ones first), auto (what Auto would try first)} */
async function modelChoices(id, cfg) {
  const s = settings(cfg);
  if (id === 'claude') return { ok: true, models: CLAUDE_MODELS };
  if (id === 'codex') return { ok: true, models: await codexModelList() };
  const key = id === 'gemini' ? s.geminiKey : id === 'openai' ? s.openaiKey : id === 'openrouter' ? s.openrouterKey : s[id + 'Key'];
  if (!key) return { ok: false, error: 'no key saved', models: [] };
  const all = await modelList(id, key), ranked = rankModels(id, all);
  const rest = all.filter((m) => !ranked.includes(m) && (id === 'openrouter' || !SKIP_MODEL_RE.test(m))).sort();
  return { ok: all.length > 0, models: ranked.concat(rest), auto: TIERS[id] ? autoModels(id, all)[0] || null : null };
}

/* ── Gemini CLI ── */
// an installed CLI's script (npm -g puts it under %APPDATA%\npm), run with node so no .cmd quoting is involved
let npmRoot; // asked once: npm is slow to start
function npmCli(pkgPath, binName) {
  if (npmRoot === undefined) {
    try { npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim(); } catch (e) { npmRoot = null; }
  }
  const roots = require('./platform').npmGlobalRoots();
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
async function geminiModels(s) {
  const first = s.geminiModel.replace(/^models\//, '');
  if (first) return [...new Set([first, GEMINI_LITE_MODEL])];
  const auto = autoModels('gemini', await modelList('gemini', s.geminiKey));
  return auto.length ? auto : [GEMINI_PREFERRED_MODEL, GEMINI_DEFAULT_MODEL, GEMINI_LITE_MODEL];
}
const GEMINI_BUSY_RE = /\b503\b|high demand|overloaded|"?UNAVAILABLE"?/i;
const GEMINI_LIMIT_RE = /quota|rate.?limit|resource.?exhausted|\b429\b|too many requests/i;
const GEMINI_GONE_RE = /no longer available|models\/\S+ is not found|ModelNotFound/i;
// a rejected key: checked before the quota words, which the CLI's retry messages can also contain
const GEMINI_BADKEY_RE = /API_KEY_INVALID|API key not valid|API key expired/i;
const GEMINI_BADKEY_WHY = 'Gemini’s API key isn’t valid: paste a new one in Settings → AI connections';
// tries each model in turn; only the last one's quota error counts on the usage meter
async function geminiFallback(s, call) {
  const models = await geminiModels(s), tried = [];
  let r;
  for (let i = 0; i < models.length; i++) {
    r = await call(models[i], i === models.length - 1);
    tried.push(models[i] + (r.text ? '' : r.busy ? ' (busy)' : r.limit ? ' (over quota)' : r.gone ? ' (not available)' : ''));
    if (r.text) lastUsed.gemini = models[i];
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
  if (s.openaiVia === 'chatgpt') return runCodex({ prompt, timeoutMs, note, node, model: s.codexModel });
  if (!s.openaiKey) return { auth: true, why: 'no OpenAI API key' };
  const auto = s.openaiModel ? [] : autoModels('openai', await modelList('openai', s.openaiKey));
  return tryModels('openai', s.openaiModel ? [s.openaiModel] : auto.length ? auto : [OPENAI_DEFAULT_MODEL],
    (model) => openaiCall(s, model, { prompt, timeoutMs, note }));
}
async function openaiCall(s, model, { prompt, timeoutMs, note }) {
  let r, j = null;
  try {
    r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs || 600000, 600000)),
      headers: { Authorization: 'Bearer ' + s.openaiKey, 'Content-Type': 'application/json' },
      // store: false — OpenAI doesn't keep the response for later retrieval
      body: JSON.stringify({ model, input: prompt + (note != null ? note : OPENAI_NOTE), tools: [{ type: 'web_search' }], store: false }) });
    j = await r.json().catch(() => null);
  } catch (e) { return { why: 'ChatGPT unreachable (' + e.message + ')' }; }
  const text = (j && Array.isArray(j.output) ? j.output : []).filter((o) => o && o.type === 'message')
    .flatMap((o) => Array.isArray(o.content) ? o.content : []).filter((c) => c && c.type === 'output_text').map((c) => c.text || '').join('');
  if (r.ok && text) { meter.noteCall('openai', { tokens: j.usage && j.usage.total_tokens }); return { text, model: j.model }; }
  const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
  return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 403,
    gone: r.status === 404 || /model.{0,40}(not found|does not exist|not exist)|model_not_found/i.test(msg),
    why: 'ChatGPT (' + model + '): ' + String(msg).slice(0, 160) };
}

/* ── ChatGPT on his plan: OpenAI's Codex CLI, signed in with his ChatGPT account (`codex login`), so runs
   use his plan's Codex allowance instead of a paid API key. Codex is a coding agent: a run here gets web
   search only. Its shell, apps, plugins, browser and sub-agents are switched off, its own config (MCP
   servers) is skipped, the sandbox is read-only and the work folder is empty. Code mode stays on: newer
   Codex runs web search through it, and with no shell it has nothing else to call. ── */
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
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'tool_suggest', 'multi_agent', 'hooks', 'goals', 'sleep_tool'];
function codexArgs(script, outFile, model) {
  const a = [script, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'web_search="live"', '-o', outFile];
  if (model) a.push('-m', model); // none: Codex's own default
  for (const f of CODEX_OFF) a.push('--disable', f);
  a.push('-'); // the prompt comes on stdin
  return a;
}
const CODEX_LIMIT_RE = /usage limit|rate.?limit|\b429\b|too many requests|quota/i;
const CODEX_AUTH_RE = /not logged in|log ?in again|sign ?in again|unauthori[sz]ed|\b401\b|token.*(expired|invalid|revoked)|refresh token/i;
// node: a real node, or none (Electron's own, run as node)
function runCodex({ prompt, timeoutMs, note, node, model: chosen }) {
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
    try { p = spawn(node || process.execPath, codexArgs(cli.script, outFile, chosen), { cwd: workDir, env, windowsHide: true }); }
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
        if (model || chosen) lastUsed.codex = model || chosen;
        return finish({ text, model, log });
      }
      const limit = CODEX_LIMIT_RE.test(log);
      finish({ log, limit, auth: !limit && CODEX_AUTH_RE.test(log),
        why: 'ChatGPT (Codex) ' + (limit ? 'is out of usage on your plan' : 'exited with code ' + code) });
    });
  });
}

/* one request to the Codex app-server (JSON-RPC on stdin/stdout): no run, so nothing is used up. → the result, or null */
function codexAsk(method, params, { node } = {}) {
  const cli = codexCli();
  if (!cli || !codexSignedIn()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '', done = false, p;
    const finish = (r) => { if (!done) { done = true; clearTimeout(killer); try { p.kill(); } catch (e) {} resolve(r); } };
    const env = Object.assign({}, process.env, node ? {} : { ELECTRON_RUN_AS_NODE: '1' });
    try { p = spawn(node || process.execPath, [cli.script, 'app-server'], { cwd: os.tmpdir(), env, windowsHide: true }); }
    catch (e) { return resolve(null); }
    const killer = setTimeout(() => finish(null), 20000);
    p.on('error', () => finish(null));
    p.on('close', () => finish(null));
    p.stderr.on('data', () => {});
    p.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.id === 2) finish(j.result || null);
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'tasks', version: '1' } } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n' +
      JSON.stringify(Object.assign({ jsonrpc: '2.0', id: 2, method }, params ? { params } : {})) + '\n');
  });
}
/* his plan's Codex limits (account/rateLimits/read). Resolves {primary, secondary, reached, plan} with windows
   of {usedPercent, windowDurationMins, resetsAt}, or null when it can't be read */
async function codexLimits(opts) {
  const res = await codexAsk('account/rateLimits/read', null, opts);
  const r = res && res.rateLimits;
  return r ? { primary: r.primary || null, secondary: r.secondary || null, plan: r.planType || null,
    reached: !!r.rateLimitReachedType || res.ordinaryUsageAllowed === false } : null;
}
// the models his plan offers in Codex (model/list), for Settings; [] when it can't be read
async function codexModelList(opts) {
  const res = await codexAsk('model/list', {}, opts);
  const list = res && (res.data || res.models || res.items);
  return (Array.isArray(list) ? list : []).map((m) => typeof m === 'string' ? m : m && (m.model || m.id || m.slug)).filter(Boolean);
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
  if (r.ok && text) { meter.noteCall('openrouter', { tokens: j.usage && j.usage.total_tokens }); lastUsed.openrouter = j.model || s.openrouterModel; return { text: String(text), model: j.model }; }
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

/* ── Grok, Groq, Cerebras: OpenAI's chat format, one key each ── */
const compatNote = (name) => '\n\n## This run\nYou are running as ' + name + ', standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no web search, no files, no Gmail. Answer what you can from what you know; if a task needs a browser, current ' +
  'prices, his inbox or a photo, set it to needs-you and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';
const COMPAT_GONE_RE = /model.{0,40}(not found|does not exist|not exist|decommissioned|deprecated|no longer|invalid model|unknown model)|model_not_found/i;
const COMPAT_BIG_RE = /too large|context.?length|maximum context|too many tokens|reduce the length|tokens per minute/i;

async function compatCall(id, key, model, content, timeoutMs) {
  const p = COMPAT[id];
  let r, j = null;
  try {
    r = await fetch(p.base + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs || 600000, 600000)),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }] }) });
    j = await r.json().catch(() => null);
  } catch (e) { return { why: p.name + ' unreachable (' + e.message + ')' }; }
  const msg0 = j && j.choices && j.choices[0] && j.choices[0].message;
  const text = msg0 && (typeof msg0.content === 'string' ? msg0.content
    : Array.isArray(msg0.content) ? msg0.content.map((c) => (c && c.text) || '').join('') : '');
  if (r.ok && text) { meter.noteCall(id, { tokens: j.usage && j.usage.total_tokens }); return { text: String(text), model: j.model || model }; }
  const e = j && (j.error || j.detail || j.message);
  const msg = (e && (typeof e === 'string' ? e : e.message || JSON.stringify(e))) || ('HTTP ' + r.status);
  // too big for a free tier's per-request or per-minute token cap: a 413, or a 429 that says so
  const big = r.status === 413 || COMPAT_BIG_RE.test(msg);
  if (r.status === 429 && !big) meter.noteCall(id, { limited: true });
  return { log: msg, limit: r.status === 429 && !big, auth: r.status === 401 || r.status === 403,
    gone: r.status === 404 || COMPAT_GONE_RE.test(msg),
    why: big ? 'this was too big for ' + p.name + '’s free tier' : p.name + ' (' + model + '): ' + String(msg).slice(0, 160) };
}
// the key's models → {ok, models} (also Settings' "Test key")
async function compatModels(id, key) {
  try {
    const r = await fetch(COMPAT[id].base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = j && (j.error || j.detail); return { ok: false, error: (e && (e.message || (typeof e === 'string' ? e : ''))) || 'HTTP ' + r.status }; }
    return { ok: true, models: (Array.isArray(j && j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
}
// a model to use instead of one that's gone: the preferred kind, else the first chat-looking one
function pickModel(id, models, not) {
  const ok = models.filter((m) => m !== not && !/embed|whisper|tts|guard|moderation|image|vision-only|audio|ocr/i.test(m));
  return ok.find((m) => COMPAT[id].prefer.test(m)) || ok[0] || null;
}
async function runCompat(id, cfg, { prompt, timeoutMs, note }) {
  const p = COMPAT[id], s = settings(cfg), key = s[id + 'Key'], model = s[id + 'Model'];
  if (!p) return { why: 'unknown AI ' + id };
  if (!key) return { auth: true, why: 'no ' + p.name + ' API key' };
  const content = prompt + (note != null ? note : compatNote(p.name));
  if (!model) { // Auto
    const auto = autoModels(id, await modelList(id, key));
    return tryModels(id, auto.length ? auto : [p.model], (m) => compatCall(id, key, m, content, timeoutMs));
  }
  const r = await compatCall(id, key, model, content, timeoutMs);
  if (r.text) lastUsed[id] = r.model || model;
  if (!r.gone) return r;
  const list = await compatModels(id, key), next = list.ok && pickModel(id, list.models, model);
  if (!next) return r;
  const r2 = await compatCall(id, key, next, content, timeoutMs);
  if (r2.text) lastUsed[id] = r2.model || next;
  r2.log = model + ' is gone, tried ' + next + '\n' + (r2.log || '');
  return r2;
}

module.exports = { rankModels, autoModels, modelChoices, usedModels, clearModelCache, CLAUDE_MODELS, PROVIDERS, NAMES, COMPAT, COMPAT_IDS, runCompat, compatModels, pickModel, OPENROUTER_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, runOpenAI, settings, geminiCli, codexCli, codexStatus, codexArgs, codexLimits, geminiStatus, runGemini, runGeminiApi, runOpenRouter, openRouterCheck };
