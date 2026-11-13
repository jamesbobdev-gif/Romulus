/* The screen helper's answers (main/overlay.js): one quick question, maybe with a picture of his screen,
   to the first AI that can take it. Not an Agent task: nothing is queued, synced or saved, and the AI gets
   no tools, browser, files or mail — only the question, the picture and the chat so far.
   - lane 'cloud': his AI connections in his order (cloudOrder), each called straight, no tool loop. The
     free-tier ones (Grok, Groq…) only answer without a picture; ChatGPT on his plan (Codex) is skipped.
   - lane 'local': his own model (Lupa) through Ollama, so the picture never leaves his machines.
   No Electron here, so it can be tested on its own (fetch and spawn are handed in). */
const fs = require('fs');
const path = require('path');
const providers = require('./providers');

const ASK_MS = 2 * 60 * 1000;
const LOCAL_MS = 4 * 60 * 1000; // the mini PC reads a picture slowly
// Claude Code's model names → the API's, for when he saved an Anthropic key (a straight call, no CLI)
const CLAUDE_API_MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

const RULES = 'You are the screen helper in the user\'s Romulus app. He pressed a shortcut and asked you something ' +
  'about what he is doing. When a screenshot is attached, it is his screen right now: read it closely (text, code, ' +
  'error messages, forms) and answer about what is actually there. Answer directly and briefly: the answer first, ' +
  'then only the detail he needs. Short Markdown (lists, `code`, code blocks) is fine. You have no tools and can\'t ' +
  'click or type anything for him: tell him what to do instead. If the picture doesn\'t show enough, say what you ' +
  'would need to see.';

/* the text sent with the picture: the rules, the chat so far (text only), and his question */
function promptText(question, history) {
  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .map((h) => 'He asked: ' + String(h.q || '').slice(0, 2000) + '\nYou answered: ' + String(h.a || '').slice(0, 4000));
  return RULES + (turns.length ? '\n\n## Earlier in this chat\n' + turns.join('\n\n') : '') +
    '\n\n## His question\n' + (String(question || '').trim() || 'What\'s on my screen, and what should I do next?');
}

/* who to ask, in turn: [{id, how}] where how is the call below that fits. A picture rules out the text-only ones */
function plan(cfg, { lane, order, local, image }) {
  if (lane === 'local') return local ? [{ id: 'local', how: 'ollama' }] : [];
  const s = providers.settings(cfg);
  const out = [];
  for (const id of order || []) {
    if (id === 'claude') out.push({ id, how: s.anthropicKey || String(((cfg || {}).ai || {}).anthropicKey || '').trim() ? 'anthropic' : 'claude-cli' });
    else if (id === 'gemini' && s.geminiKey) out.push({ id, how: 'gemini' });
    else if (id === 'openai' && s.openaiVia !== 'chatgpt' && s.openaiKey) out.push({ id, how: 'openai' });
    else if (id === 'openrouter' && s.openrouterKey) out.push({ id, how: 'openrouter' });
    else if (providers.COMPAT[id] && s[id + 'Key'] && !image && !providers.COMPAT[id].account) out.push({ id, how: 'compat' });
  }
  return out;
}

async function postJson(fetch, url, headers, body, ms) {
  const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(ms), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && (j.error || j.message);
    throw new Error((e && (typeof e === 'string' ? e : e.message)) || 'HTTP ' + r.status);
  }
  return j;
}
const dataUrl = (img) => 'data:' + img.mime + ';base64,' + img.b64;

/* one call → the answer's text (throws when there's none). maxTokens: a longer answer (agent/ai-json.js) */
async function callOne(step, cfg, { text, image, maxTokens }, deps) {
  const s = providers.settings(cfg), f = deps.fetch;
  const key = (k) => String(((cfg || {}).ai || {})[k] || s[k] || '').trim();
  if (step.how === 'anthropic') {
    const content = (image ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.b64 } }] : []).concat({ type: 'text', text });
    const j = await postJson(f, 'https://api.anthropic.com/v1/messages', { 'x-api-key': key('anthropicKey'), 'anthropic-version': '2023-06-01' },
      { model: CLAUDE_API_MODELS[s.claudeModel] || CLAUDE_API_MODELS.sonnet, max_tokens: maxTokens || 2000, messages: [{ role: 'user', content }] }, ASK_MS);
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  if (step.how === 'claude-cli') return deps.claudeCli(text, image);
  if (step.how === 'gemini') {
    const parts = (image ? [{ inline_data: { mime_type: image.mime, data: image.b64 } }] : []).concat({ text });
    const j = await postJson(f, 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(s.geminiModel || providers.GEMINI_DEFAULT_MODEL) + ':generateContent',
      { 'x-goog-api-key': s.geminiKey }, { contents: [{ role: 'user', parts }] }, ASK_MS);
    const c = j.candidates && j.candidates[0];
    return ((c && c.content && c.content.parts) || []).map((p) => p.text || '').join('');
  }
  if (step.how === 'openai') {
    const content = [{ type: 'input_text', text }].concat(image ? [{ type: 'input_image', image_url: dataUrl(image) }] : []);
    // store: false — OpenAI doesn't keep it
    const j = await postJson(f, 'https://api.openai.com/v1/responses', { Authorization: 'Bearer ' + s.openaiKey },
      { model: s.openaiModel || providers.OPENAI_DEFAULT_MODEL, store: false, input: [{ role: 'user', content }] }, ASK_MS);
    if (j.output_text) return j.output_text;
    return (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  }
  if (step.how === 'openrouter' || step.how === 'compat') {
    const content = [{ type: 'text', text }].concat(image ? [{ type: 'image_url', image_url: { url: dataUrl(image) } }] : []);
    const body = { messages: [{ role: 'user', content: image ? content : text }], max_tokens: maxTokens || 2000 };
    let url, auth;
    if (step.how === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions'; auth = s.openrouterKey; body.model = s.openrouterModel;
      // only providers that don't collect what's sent, as for the Agent (agent/providers.js)
      body.provider = s.openrouterZdr ? { data_collection: 'deny', zdr: true } : { data_collection: 'deny' };
    } else {
      const p = providers.COMPAT[step.id];
      url = p.base + '/chat/completions'; auth = s[step.id + 'Key']; body.model = s[step.id + 'Model'] || p.model;
    }
    const j = await postJson(f, url, { Authorization: 'Bearer ' + auth }, body, ASK_MS);
    const m = j.choices && j.choices[0] && j.choices[0].message;
    return (m && m.content) || '';
  }
  if (step.how === 'ollama') {
    const msg = { role: 'user', content: text };
    if (image) msg.images = [image.b64];
    const j = await postJson(f, deps.local.url + '/api/chat', {}, { model: deps.local.model, stream: false, think: false, messages: [msg] }, LOCAL_MS);
    return (j.message && j.message.content) || '';
  }
  throw new Error('unknown');
}

/* {question, image: {mime, b64} | null, history, lane} → {text, via} or {why}
   deps: {fetch, order: the cloud AIs in his order, notReady: ids turned on but not connected, local: {url, model} | null, claudeCli(text, image) → text} */
async function ask(cfg, { question, image, history, lane, maxTokens }, deps) {
  const steps = plan(cfg, { lane, order: deps.order, local: deps.local, image });
  if (!steps.length) {
    return { why: lane === 'local' ? 'Lupa isn’t set up on this computer (Settings → Local model).'
      : image ? 'None of your AI connections on this computer can read a screenshot. Add a Claude, Gemini, OpenAI or OpenRouter key in Settings → AI connections, or switch to Lupa.'
        : 'No AI is connected on this computer (Settings → AI connections).' };
  }
  const text = promptText(question, history), tried = [];
  for (const step of steps) {
    try {
      const out = String(await callOne(step, cfg, { text, image, maxTokens }, deps) || '').trim();
      if (out) return { text: out, via: step.id === 'local' ? 'Lupa' : providers.NAMES[step.id] || step.id };
      tried.push((providers.NAMES[step.id] || step.id) + ': no answer');
    } catch (e) {
      tried.push((step.id === 'local' ? 'Lupa' : providers.NAMES[step.id] || step.id) + ': ' + String(e && e.message || e).slice(0, 160));
    }
  }
  return { why: 'No answer. ' + tried.concat(skipped(steps, { image, lane }, deps)).join(' · ') };
}

/* the ones in his order that weren't asked, and why, so a "No answer" doesn't hide them.
   deps.notReady: turned on in his order but not connected on this computer (Claude Code signed out…) */
function skipped(steps, { image, lane }, deps) {
  if (lane === 'local') return [];
  const name = (id) => providers.NAMES[id] || id;
  const out = (deps.notReady || []).map((id) => name(id) + (id === 'claude' ? ': Claude Code isn’t signed in on this computer' : ': not connected'));
  const textOnly = image ? (deps.order || []).filter((id) => providers.COMPAT[id] && !steps.some((s) => s.id === id)) : [];
  if (textOnly.length) out.push(textOnly.map(name).join(', ') + ': can’t read a screenshot');
  return out;
}

/* Claude on his Claude Code sign-in (no API key): the picture goes in an empty folder and the CLI may only
   Read it. spawn and exe are handed in; dir is wiped before each run */
function claudeCliRunner({ spawn, exe, env, dir, model }) {
  return (text, image) => new Promise((resolve, reject) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    let prompt = text;
    if (image) {
      const file = 'screen.' + (image.mime === 'image/png' ? 'png' : 'jpg');
      fs.writeFileSync(path.join(dir, file), Buffer.from(image.b64, 'base64'));
      prompt = 'First Read ./' + file + ' in this folder: it is the screenshot.\n\n' + text;
    }
    let out = '', p;
    try {
      p = spawn(exe, ['-p', '--output-format', 'json', '--model', model || 'sonnet', '--max-turns', '3', '--tools', 'Read', '--strict-mcp-config',
        '--allowedTools', 'Read', '--disallowedTools', 'Bash,PowerShell,Write,Edit,NotebookEdit,Agent,WebSearch,WebFetch'], { cwd: dir, windowsHide: true, env });
    } catch (e) { return reject(new Error('could not start Claude Code')); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, ASK_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    p.on('error', (e) => { clearTimeout(killer); reject(e); });
    p.stdin.on('error', () => {}); p.stdin.end(prompt);
    p.on('close', () => {
      clearTimeout(killer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      let j = null; try { j = JSON.parse(out); } catch (e) {}
      if (j && !j.is_error && typeof j.result === 'string') resolve(j.result);
      else reject(new Error((j && j.result) ? String(j.result).slice(0, 160) : 'Claude Code gave no answer'));
    });
  });
}

module.exports = { ask, plan, callOne, promptText, claudeCliRunner, CLAUDE_API_MODELS }; // callOne: also "Do it" (agent/pc-control.js)
