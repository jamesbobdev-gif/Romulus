/* The other cloud AIs the Agent lane can use besides Claude: Gemini (a Gemini API key; Google ended "Login
   with Google" for personal accounts on 2026-06-18. With Google's Gemini CLI installed it gets the agent
   browser and the attachments; without it, the plain API with Google Search), ChatGPT (his ChatGPT plan through
   OpenAI's Codex CLI when he's signed in to it, else an OpenAI API key; web search either way) and OpenRouter (one API key, any
   of its models, only through providers that don't keep or train on what's sent), plus the ones with a free
   API tier that speak OpenAI's chat format (Grok, Groq, Cloudflare: see COMPAT). Each gets the
   same instructions and task data as Claude and answers with the same {"updates": [...]} JSON.
   The order and the keys live in this computer's config only (config.json → ai), never in sync.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const meter = require('./usage-meter');
const loop = require('./tool-loop');

/* The AIs with a free API tier and OpenAI's chat format: one key each, no tools (no files or Gmail; the agent browser
   only when he turns on compatBrowser, as free tiers browse poorly and run out fast).
   model: the default; prefer: which of its /models to use when that one is gone (they rename models often) */
const COMPAT = {
  xai: { name: 'Grok', base: 'https://api.x.ai/v1', model: 'grok-4-fast-reasoning', prefer: /^grok-4.*fast/ },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', prefer: /gpt-oss-120b|llama-3\.3-70b/ },
  // Workers AI: 10,000 free "neurons" a day (reset 00:00 UTC). Its address has his account ID in it (see cfEndpoint)
  cloudflare: { name: 'Cloudflare', model: '@cf/openai/gpt-oss-120b', prefer: /gpt-oss-120b|llama-4|llama-3\.3-70b/, account: true },
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
    compatBrowser: ai.compatBrowser === true, // Grok and Groq get the agent browser: off unless he turns it on
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
  cloudflare: [/gpt-oss-120b/, /llama-4-scout|qwen3|llama-3\.3-70b/, /gpt-oss-20b|mistral-small/],
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
// they gave up after one look at a page whose results were still loading (a flight search, 2026-10-21)
const KEEP_GOING_NOTE = ' Pages that load results with scripts (flights, tickets, stores) can look empty at first: wait ' +
  '(browser_wait_for) and look again, or try another site, before saying you couldn\'t. Don\'t stop with browser steps left ' +
  'while a skill above names another site or step to try.';
/* The AIs answering one request at a time get the agent browser through the app's own tool loop (agent/tool-loop.js).
   who: 'running as X'; also: their other tools ('web search'), or none */
const browserNote = (who, also) => '\n\n## This run\nYou are ' + who + ', standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. Your tools here: ' + (also ? also + ' and the ' : 'the ') +
  'browser_* tools (his agent browser). ' + (also ? 'Use the browser for anything search can\'t show current' :
    'There is no separate web search: to look something up, open a search page in the browser (https://duckduckgo.com/?q=...). Use the browser for anything current') +
  ' (showtimes, prices, stock, booking pages). You have about ' + loop.MAX_STEPS + ' browser steps, so go straight to the page ' +
  'that has the answer. No files or photos, no Gmail, and his mail and account pages are closed in the browser: if a ' +
  'task needs his mail, say so in the note.' + KEEP_GOING_NOTE + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';
// opts.browserMcpFile (browserCfgFor's config) → the started browser for run(browser), closed after; null when there's none
async function withBrowser(opts, run) {
  const browser = opts.browserMcpFile ? await loop.startBrowser(opts.browserMcpFile, opts.browserDenied || []).catch(() => null) : null;
  try {
    const r = await run(browser);
    if (opts.browserMcpFile && !browser) r.log = 'the agent browser didn\'t start: ran without it\n' + (r.log || '');
    return r;
  } finally { if (browser) browser.close(); }
}
// one POST → {r, j}, or {error} with the provider's "unreachable" failure
async function postJson(url, headers, body, ms, name) {
  try {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(ms), headers, body: JSON.stringify(body) });
    return { r, j: await r.json().catch(() => null) };
  } catch (e) { return { error: { why: name + ' unreachable (' + e.message + ')' } }; }
}
const loopLog = (r) => r.steps ? r.steps + ' browser step(s)\n' + (r.log || '') : r.log;
const withLog = (ok, r) => r.steps ? Object.assign(ok, { log: loopLog(r) }) : ok; // an answer, plus the browser steps when it used any

const GEMINI_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above are ' +
  'written for Claude and apply to you the same way, the hard rule most of all. Your tools here: google_web_search, ' +
  'web_fetch, read_file (attachments/ and skills/ in your folder) and, when listed, the browser_* tools. There is no ' +
  'Gmail in this run, and his mail and account pages are closed in the browser: if a task needs his mail, say so in the note.' +
  KEEP_GOING_NOTE + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';

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
// noLite: the tasks need real browsing (a `browser: yes` skill), which Flash-Lite can't do: it skips the browser
// and repeats the last note. Then Gemini passes rather than fall back to it, and the next AI takes the task.
const GEMINI_NO_LITE_WHY = 'only Flash-Lite is left, and it can’t do browser tasks';
async function geminiFallback(s, call, noLite) {
  const all = await geminiModels(s), tried = [];
  const models = noLite ? all.filter((m) => !/lite/i.test(m)) : all;
  if (!models.length) return { why: 'Gemini: ' + GEMINI_NO_LITE_WHY, log: 'models: ' + all.join(', ') + ' (Lite skipped: browser task)' };
  let r;
  for (let i = 0; i < models.length; i++) {
    r = await call(models[i], i === models.length - 1);
    tried.push(models[i] + (r.text ? '' : r.busy ? ' (busy)' : r.limit ? ' (over quota)' : r.gone ? ' (not available)' : ''));
    if (r.text) { lastUsed.gemini = models[i]; r.model = r.model || models[i]; }
    if (r.text || !(r.busy || r.limit || r.gone)) break;
  }
  r.log = 'models: ' + tried.join(' → ') + (models.length < all.length ? ' (Lite skipped: browser task)' : '') + '\n' + (r.log || '');
  // the stronger ones were busy or over quota: say Lite was skipped, so it isn't read as "out for the day"
  if (!r.text && models.length < all.length && (r.busy || r.limit)) { r.why = 'Gemini’s stronger models are busy or over quota, and ' + GEMINI_NO_LITE_WHY; r.limit = false; r.busy = false; }
  return r;
}

/* → Promise<{text, limit, auth, why}>; onProc gets the child process (so it can be stopped) */
async function runGemini(cfg, opts) {
  const s = settings(cfg), cli = geminiCli();
  if (!s.geminiKey) return { auth: true, why: 'no Gemini API key' };
  if (!cli || !opts.node) return runGeminiApi(cfg, opts); // no CLI: the API, the browser through the app's tool loop
  return geminiFallback(s, (model, last) => {
    writeGeminiWorkspace(opts.workDir, opts.browserMcpFile, opts.browserDenied || [], model);
    return runGeminiCli(s, cli, opts, model, last);
  }, opts.noLite);
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

/* Gemini without the CLI: generateContent with Google Search grounding, and the agent browser through the app's
   tool loop when the run has one. No files. */
const GEMINI_API_NOTE = '\n\n## This run\nYou are running as Gemini (Google), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is Google ' +
  'Search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';

async function runGeminiApi(cfg, opts) {
  const s = settings(cfg);
  if (!s.geminiKey) return { auth: true, why: 'no Gemini API key' };
  return withBrowser(opts, (browser) => geminiFallback(s, (model, last) => geminiApiCall(s, model, last, opts, browser), opts.noLite));
}
// a model that won't take Google Search and function tools together gets the browser alone
const GEMINI_MIX_RE = /function call|tool.{0,40}(not supported|unsupported|combin)|multiple tools/i;
async function geminiApiCall(s, model, last, { prompt, timeoutMs, note, onProc }, browser, noSearch) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const headers = { 'x-goog-api-key': s.geminiKey, 'Content-Type': 'application/json' };
  const tools = (noSearch ? [] : [{ google_search: {} }]).concat(browser ? loop.geminiTools(browser.tools) : []);
  const runNote = note != null ? note : browser ? browserNote('running as Gemini (Google)', noSearch ? '' : 'Google Search') : GEMINI_API_NOTE;
  const fail = (r, j) => {
    const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
    if (GEMINI_BADKEY_RE.test(msg)) return { log: msg, auth: true, why: GEMINI_BADKEY_WHY };
    if (browser && !noSearch && r.status === 400 && GEMINI_MIX_RE.test(msg)) return { log: msg, mix: true, why: 'Gemini (' + model + '): ' + String(msg).slice(0, 160) };
    if (r.status === 429 && last) meter.noteCall('gemini', { limited: true, perDay: meter.geminiDailyLimit(j && j.error) });
    return { log: msg, limit: r.status === 429, busy: r.status === 503, gone: r.status === 404,
      auth: r.status === 401 || r.status === 403 || /api.?key/i.test(msg),
      why: 'Gemini (' + model + '): ' + String(msg).slice(0, 160) };
  };
  const api = loop.geminiApi({ base: { tools }, text: prompt + runNote, fail,
    post: (body, ms) => postJson(url, headers, body, ms, 'Gemini') });
  const r = await loop.runLoop(api, browser || { tools: [] }, { timeoutMs: timeoutMs || 600000, onProc: browser && onProc });
  if (r.mix) return geminiApiCall(s, model, last, { prompt, timeoutMs, note, onProc }, browser, true);
  if (r.text) { meter.noteCall('gemini', { tokens: r.tokens }); return { text: r.text, log: 'api ' + model + (r.steps ? ', ' + loopLog(r) : '') }; }
  r.log = loopLog(r);
  return r;
}

/* ── ChatGPT (OpenAI's Responses API) ── */
const OPENAI_NOTE = '\n\n## This run\nYou are running as ChatGPT (OpenAI), standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run your only tool is web ' +
  'search: no browser, no files or photos, no Gmail. If a task needs a browser, his inbox or a photo, set it to needs-you ' +
  'and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';
// on his plan with the agent browser (Codex below): the same run, plus the browser_* tools
// (and on an API key, the same with the browser through the app's tool loop)
const CODEX_BROWSER_NOTE = browserNote('running as ChatGPT (OpenAI)', 'web search');

async function runOpenAI(cfg, opts) {
  const { prompt, timeoutMs, note, node, browserMcpFile, browserDenied, onProc } = opts;
  const s = settings(cfg);
  if (s.openaiVia === 'chatgpt') return runCodex({ prompt, timeoutMs, note, node, model: s.codexModel, browserMcpFile, browserDenied, onProc });
  if (!s.openaiKey) return { auth: true, why: 'no OpenAI API key' };
  const auto = s.openaiModel ? [] : autoModels('openai', await modelList('openai', s.openaiKey));
  return withBrowser(opts, (browser) => tryModels('openai', s.openaiModel ? [s.openaiModel] : auto.length ? auto : [OPENAI_DEFAULT_MODEL],
    (model) => openaiCall(s, model, opts, browser)));
}
async function openaiCall(s, model, { prompt, timeoutMs, note, onProc }, browser) {
  const fail = (r, j) => {
    const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
    return { log: msg, limit: r.status === 429, auth: r.status === 401 || r.status === 403,
      gone: r.status === 404 || /model.{0,40}(not found|does not exist|not exist)|model_not_found/i.test(msg),
      why: 'ChatGPT (' + model + '): ' + String(msg).slice(0, 160) };
  };
  // store: false — OpenAI doesn't keep the response for later retrieval
  const base = { model, tools: [{ type: 'web_search' }].concat(browser ? loop.responsesTools(browser.tools) : []), store: false };
  const api = loop.responsesApi({ base, input: prompt + (note != null ? note : browser ? CODEX_BROWSER_NOTE : OPENAI_NOTE), fail,
    post: (body, ms) => postJson('https://api.openai.com/v1/responses', { Authorization: 'Bearer ' + s.openaiKey, 'Content-Type': 'application/json' }, body, ms, 'ChatGPT') });
  const r = await loop.runLoop(api, browser || { tools: [] }, { timeoutMs: timeoutMs || 600000, onProc: browser && onProc });
  if (r.text) { meter.noteCall('openai', { tokens: r.tokens }); return withLog({ text: r.text, model: r.model || model }, r); }
  r.log = loopLog(r);
  return r;
}

/* ── ChatGPT on his plan: OpenAI's Codex CLI, signed in with his ChatGPT account (`codex login`), so runs
   use his plan's Codex allowance instead of a paid API key. Codex is a coding agent: a run here gets web
   search and, like Gemini, the agent browser (mail closed: see browserCfgFor). Its shell, apps, plugins, own
   browser and sub-agents are switched off, its own config (MCP servers) is skipped, the sandbox is read-only
   and the work folder is empty. Code mode stays on: newer
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
// a JSON string or array of strings is also TOML; an object becomes a TOML inline table
const toml = (v) => v && typeof v === 'object' && !Array.isArray(v)
  ? '{ ' + Object.keys(v).map((k) => k + ' = ' + JSON.stringify(String(v[k]))).join(', ') + ' }' : JSON.stringify(v);
function codexArgs(script, outFile, model, browser) {
  const a = [script, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'web_search="live"', '-o', outFile];
  if (model) a.push('-m', model); // none: Codex's own default
  if (browser) { // the agent browser (browserCfgFor's MCP server), risky tools left out; a headless run can't ask, so its tools need no yes
    const m = 'mcp_servers.browser.';
    a.push('-c', m + 'command=' + toml(browser.command), '-c', m + 'args=' + toml(browser.args || []));
    if (browser.env) a.push('-c', m + 'env=' + toml(browser.env));
    if (browser.denied && browser.denied.length) a.push('-c', m + 'disabled_tools=' + toml(browser.denied));
    a.push('-c', m + 'default_tools_approval_mode="approve"', '-c', m + 'startup_timeout_sec=60', '-c', m + 'tool_timeout_sec=120');
  }
  for (const f of CODEX_OFF) a.push('--disable', f);
  a.push('-'); // the prompt comes on stdin
  return a;
}
const CODEX_LIMIT_RE = /usage limit|rate.?limit|\b429\b|too many requests|quota/i;
const CODEX_AUTH_RE = /not logged in|log ?in again|sign ?in again|unauthori[sz]ed|\b401\b|token.*(expired|invalid|revoked)|refresh token/i;
// node: a real node, or none (Electron's own, run as node)
function codexBrowser(browserMcpFile, browserDenied) {
  if (!browserMcpFile) return null;
  try {
    const b = JSON.parse(fs.readFileSync(browserMcpFile, 'utf8')).mcpServers.browser;
    return { command: b.command, args: b.args, env: b.env, denied: (browserDenied || []).map((n) => n.replace(/^mcp__browser__/, '')) };
  } catch (e) { return null; }
}
function runCodex({ prompt, timeoutMs, note, node, model: chosen, browserMcpFile, browserDenied, onProc }) {
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
    const browser = codexBrowser(browserMcpFile, browserDenied);
    try { p = spawn(node || process.execPath, codexArgs(cli.script, outFile, chosen, browser), { cwd: workDir, env, windowsHide: true }); }
    catch (e) { return resolve({ why: 'could not start Codex' }); }
    if (onProc) onProc(p);
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, Math.min(timeoutMs || 600000, 15 * 60 * 1000));
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', (e) => finish({ why: 'could not start Codex (' + e.message + ')' }));
    p.stdin.on('error', () => {});
    p.stdin.end(prompt + (note != null ? note : browser ? CODEX_BROWSER_NOTE : OPENAI_NOTE));
    p.on('close', (code) => {
      let text = ''; try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch (e) {}
      const log = err.slice(-12000), model = (err.match(/^model:\s*(\S+)/m) || [])[1];
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
// without the agent browser (with it: browserNote)
const OPENROUTER_NOTE = '\n\n## This run\nYou are answering through OpenRouter, standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no files, no Gmail (web search results may be added for you). Answer what you can from what you know and those ' +
  'results; if a task needs a browser, his inbox or a photo, set it to needs-you and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY ' +
  'the JSON object described above.\n';

async function runOpenRouter(cfg, opts) {
  const { prompt, timeoutMs, note, onProc } = opts;
  const s = settings(cfg);
  if (!s.openrouterKey) return { why: 'no OpenRouter key' };
  return withBrowser(opts, async (browser) => {
    // max_tokens: OpenRouter holds back credit for the model's whole output limit (131k on some), and a low
    // balance then refuses every request; the JSON answer never needs that much
    const base = { model: s.openrouterModel, max_tokens: 16000 };
    if (browser) base.tools = loop.chatTools(browser.tools); // OpenRouter then only routes to models that call tools
    if (s.openrouterWeb) base.plugins = [{ id: 'web' }];
    // only providers that don't collect what's sent; with ZDR, only ones that don't keep it at all
    base.provider = s.openrouterZdr ? { data_collection: 'deny', zdr: true } : { data_collection: 'deny' };
    const fail = (r, j) => {
      const msg = (j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
      // out of credit (a 402, or "exceed your available credits"): out of usage, not a sign-in problem
      const broke = /credits/i.test(msg);
      return { log: msg, limit: r.status === 429 || broke, auth: !broke && (r.status === 401 || r.status === 402 || r.status === 403),
        why: broke ? 'OpenRouter is out of credit: add some at openrouter.ai/credits' : 'OpenRouter: ' + String(msg).slice(0, 160) };
    };
    const runNote = note != null ? note : browser ? browserNote('answering through OpenRouter', s.openrouterWeb ? 'web search results (added for you)' : '') : OPENROUTER_NOTE;
    const api = loop.chatApi({ base, content: prompt + runNote, fail,
      post: (body, ms) => postJson('https://openrouter.ai/api/v1/chat/completions', { Authorization: 'Bearer ' + s.openrouterKey, 'Content-Type': 'application/json', 'X-Title': 'Tasks' }, body, ms, 'OpenRouter') });
    const r = await loop.runLoop(api, browser || { tools: [] }, { timeoutMs: timeoutMs || 600000, onProc: browser && onProc });
    if (r.text) { meter.noteCall('openrouter', { tokens: r.tokens }); lastUsed.openrouter = r.model || s.openrouterModel; return withLog({ text: String(r.text), model: lastUsed.openrouter }, r); }
    r.log = loopLog(r);
    return r;
  });
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

/* ── Grok, Groq: OpenAI's chat format, one key each ── */
const compatNote = (name) => '\n\n## This run\nYou are running as ' + name + ', standing in for Claude: the instructions above ' +
  'are written for Claude and apply to you the same way, the hard rule most of all. In this run you have NO tools: no ' +
  'browser, no web search, no files, no Gmail. Answer what you can from what you know; if a task needs a browser, current ' +
  'prices, his inbox or a photo, set it to needs-you and say what you\'d need.' + CHOICES_NOTE + ' Reply with ONLY the JSON object described above.\n';
const COMPAT_GONE_RE = /model.{0,40}(not found|does not exist|not exist|decommissioned|deprecated|no longer|invalid model|unknown model)|model_not_found/i;
const COMPAT_BIG_RE = /too large|context.?length|maximum context|too many tokens|reduce the length|tokens per minute/i;

/* Cloudflare's key is his account ID plus an API token, pasted together in any order (the 32-hex one is the
   account). Just the token: the account it belongs to is looked up. → {base, token} or {error} */
const CF_API = 'https://api.cloudflare.com/client/v4';
const cfAccounts = {}; // token → account ID
async function cfEndpoint(key) {
  const acct = (String(key).match(/\b[0-9a-f]{32}\b/i) || [])[0];
  const token = String(key).replace(acct || '', ' ').split(/[\s:,;|]+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  if (!token) return { error: 'no API token in the key' };
  let id = acct || cfAccounts[token];
  if (!id) {
    try {
      const r = await fetch(CF_API + '/accounts', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      id = j && Array.isArray(j.result) && j.result[0] && j.result[0].id;
      if (!id) return { error: cfError(j) || 'couldn’t find the account: paste the account ID too (it’s on the Workers AI page)' };
      cfAccounts[token] = id;
    } catch (e) { return { error: e.message }; }
  }
  return { base: CF_API + '/accounts/' + id + '/ai/v1', root: CF_API + '/accounts/' + id, token };
}
const cfError = (j) => j && Array.isArray(j.errors) && j.errors[0] && String(j.errors[0].message || '');
// where each compat AI is and what to sign with
async function compatEndpoint(id, key) {
  return COMPAT[id].account ? cfEndpoint(key) : { base: COMPAT[id].base, token: key };
}
// Cloudflare's "used up your daily free allocation of 10,000 neurons"
const COMPAT_DAILY_RE = /daily free allocation|neurons/i;
const COMPAT_BROKE_RE = /credits|spending limit|insufficient (balance|funds|quota)/i;

async function compatCall(id, key, model, content, timeoutMs, browser, onProc) {
  const p = COMPAT[id];
  const ep = await compatEndpoint(id, key);
  if (ep.error) return { auth: true, why: p.name + ': ' + ep.error, log: ep.error };
  const fail = (r, j) => {
    const e = j && (j.error || j.detail || j.message || cfError(j));
    const msg = (e && (typeof e === 'string' ? e : e.message || JSON.stringify(e))) || ('HTTP ' + r.status);
    // too big for a free tier's per-request or per-minute token cap: a 413, or a 429 that says so
    const big = r.status === 413 || COMPAT_BIG_RE.test(msg);
    const daily = COMPAT_DAILY_RE.test(msg);
    // out of credit or over its spending limit (xAI says so with a 403): out of usage, not a sign-in problem
    const broke = COMPAT_BROKE_RE.test(msg);
    if ((r.status === 429 || daily) && !big) meter.noteCall(id, { limited: true });
    return { log: msg, limit: (r.status === 429 || daily || broke) && !big, auth: !broke && (r.status === 401 || r.status === 403),
      gone: r.status === 404 || COMPAT_GONE_RE.test(msg),
      why: big ? 'this was too big for ' + p.name + '’s free tier' : broke ? p.name + ' is out of credit or at its spending limit'
        : p.name + ' (' + model + '): ' + String(msg).slice(0, 160) };
  };
  const base = browser ? { model, tools: loop.chatTools(browser.tools) } : { model };
  const api = loop.chatApi({ base, content, fail,
    post: (body, ms) => postJson(ep.base + '/chat/completions', { Authorization: 'Bearer ' + ep.token, 'Content-Type': 'application/json' }, body, ms, p.name) });
  const r = await loop.runLoop(api, browser || { tools: [] }, { timeoutMs: timeoutMs || 600000, onProc: browser && onProc });
  if (r.text) { meter.noteCall(id, { tokens: r.tokens }); return withLog({ text: String(r.text), model: r.model || model }, r); }
  r.log = loopLog(r);
  return r;
}
// the key's models → {ok, models} (also Settings' "Test key")
async function compatModels(id, key) {
  try {
    const ep = await compatEndpoint(id, key);
    if (ep.error) return { ok: false, error: ep.error };
    // Cloudflare has no /models on its OpenAI-style address: its own model search instead
    const url = ep.root ? ep.root + '/ai/models/search?task=Text%20Generation&per_page=200' : ep.base + '/models';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + ep.token }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = j && (j.error || j.detail || cfError(j)); return { ok: false, error: (e && (e.message || (typeof e === 'string' ? e : ''))) || 'HTTP ' + r.status }; }
    if (ep.root) return { ok: true, models: (Array.isArray(j && j.result) ? j.result : []).map((m) => m && m.name).filter(Boolean) };
    return { ok: true, models: (Array.isArray(j && j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
}
// a model to use instead of one that's gone: the preferred kind, else the first chat-looking one
function pickModel(id, models, not) {
  const ok = models.filter((m) => m !== not && !/embed|whisper|tts|guard|moderation|image|vision-only|audio|ocr/i.test(m));
  return ok.find((m) => COMPAT[id].prefer.test(m)) || ok[0] || null;
}
async function runCompat(id, cfg, opts) {
  const p = COMPAT[id], s = settings(cfg);
  if (!p) return { why: 'unknown AI ' + id };
  if (!s[id + 'Key']) return { auth: true, why: 'no ' + p.name + ' API key' };
  // the agent browser only when he turned it on for them
  return withBrowser(s.compatBrowser ? opts : Object.assign({}, opts, { browserMcpFile: null }), (browser) => compatRun(id, s, opts, browser));
}
async function compatRun(id, s, { prompt, timeoutMs, note, onProc }, browser) {
  const p = COMPAT[id], key = s[id + 'Key'], model = s[id + 'Model'];
  const content = prompt + (note != null ? note : browser ? browserNote('running as ' + p.name, '') : compatNote(p.name));
  if (!model) { // Auto
    const auto = autoModels(id, await modelList(id, key));
    return tryModels(id, auto.length ? auto : [p.model], (m) => compatCall(id, key, m, content, timeoutMs, browser, onProc));
  }
  const r = await compatCall(id, key, model, content, timeoutMs, browser, onProc);
  if (r.text) lastUsed[id] = r.model || model;
  if (!r.gone) return r;
  const list = await compatModels(id, key), next = list.ok && pickModel(id, list.models, model);
  if (!next) return r;
  const r2 = await compatCall(id, key, next, content, timeoutMs, browser, onProc);
  if (r2.text) lastUsed[id] = r2.model || next;
  r2.log = model + ' is gone, tried ' + next + '\n' + (r2.log || '');
  return r2;
}

module.exports = { rankModels, autoModels, modelChoices, usedModels, clearModelCache, CLAUDE_MODELS, PROVIDERS, NAMES, COMPAT, COMPAT_IDS, runCompat, compatModels, pickModel, OPENROUTER_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, runOpenAI, settings, geminiCli, codexCli, codexStatus, codexArgs, codexLimits, geminiStatus, runGemini, runGeminiApi, runOpenRouter, openRouterCheck, CODEX_BROWSER_NOTE };
