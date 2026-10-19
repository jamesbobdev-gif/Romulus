/* The agent browser for the AIs that answer one web request at a time (OpenRouter, ChatGPT on a key, Gemini
   without its CLI, and Grok/Groq when he turns it on): the app itself is the MCP client. It starts the browser
   launcher from a run's MCP config (agent/agent-browser.js → browserCfgFor, so agent/browser-proxy.js and its
   mail and buying guards sit in between), offers its tools minus the risky ones as function tools, runs each
   call the model asks for and hands back the result, until the model answers with text (its JSON) or the
   steps or the time run out. No Electron here, so it can be tested on its own. */
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_STEPS = 40;
const RESULT_MAX = 40000; // a page outline can be huge: the model gets the start of it
const OUT_OF_STEPS = 'You are out of browser steps for this run. Answer now, with ONLY the JSON object described above, ' +
  'from what you found; say in the note what you could not check.';

// a tool's input schema without the parts the APIs choke on ($schema) or the model never needs (saving to a file)
function cleanSchema(schema) {
  const s = JSON.parse(JSON.stringify(schema || { type: 'object', properties: {} }));
  delete s.$schema;
  if (s.properties) delete s.properties.filename;
  if (Array.isArray(s.required)) s.required = s.required.filter((r) => r !== 'filename');
  if (!s.type) s.type = 'object';
  if (!s.properties) s.properties = {};
  return s;
}

/* → {tools: [{name, description, schema}], call(name, args) → text, close(), proc}, or null when it won't start.
   denied: tool names to hide (mcp__browser__x or x) */
async function startBrowser(cfgFile, denied, { startMs = 60000 } = {}) {
  let b;
  try { b = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.browser; } catch (e) { return null; }
  if (!b || !b.command) return null;
  let p;
  try { p = spawn(b.command, b.args || [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: Object.assign({}, process.env, b.env || {}) }); }
  catch (e) { return null; }
  let buf = '', id = 0, dead = false;
  const pending = {};
  const settleAll = (why) => { for (const k of Object.keys(pending)) { pending[k]({ error: { message: why } }); delete pending[k]; } };
  p.on('error', () => { dead = true; settleAll('the browser could not start'); });
  p.on('exit', () => { dead = true; settleAll('the browser stopped'); });
  p.stdin.on('error', () => {});
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id != null && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } } catch (e) {}
    }
  });
  const rpc = (method, params, ms) => new Promise((resolve) => {
    if (dead) return resolve({ error: { message: 'the browser stopped' } });
    const n = ++id;
    const t = setTimeout(() => { if (pending[n]) { delete pending[n]; resolve({ error: { message: 'timed out' } }); } }, ms);
    pending[n] = (m) => { clearTimeout(t); resolve(m); };
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const close = () => { dead = true; try { p.kill(); } catch (e) {} };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tasks', version: '1' } }, startMs);
  if (init.error) { close(); return null; }
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {}, startMs);
  const hide = new Set((denied || []).map((n) => String(n).replace(/^mcp__browser__/, '')));
  const tools = ((list.result && list.result.tools) || []).filter((t) => t && t.name && !hide.has(t.name))
    .map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 1000), schema: cleanSchema(t.inputSchema) }));
  if (!tools.length) { close(); return null; }
  return {
    tools, proc: p, close,
    async call(name, args, ms = 120000) {
      if (!tools.some((t) => t.name === name)) return 'There is no tool called ' + name + ' in this run.';
      const m = await rpc('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, ms);
      if (m.error) return 'Browser error: ' + m.error.message;
      const content = (m.result && Array.isArray(m.result.content)) ? m.result.content : [];
      let text = content.map((c) => c.type === 'text' ? c.text || '' : c.type === 'image' ? '[a screenshot was taken; you can\'t see images here, use browser_snapshot to read the page]' : '').join('\n');
      if (text.length > RESULT_MAX) text = text.slice(0, RESULT_MAX) + '\n[… cut off here: use browser_find or scroll to see more]';
      return (m.result && m.result.isError ? 'Refused or failed: ' : '') + (text || '(done)');
    },
  };
}

/* The loop. api (one per request format, below) keeps the conversation:
     api.step(withTools, ms) → {error: <the provider's failure object>} | {calls: [{id, name, args}], text, tokens}
     api.feed(calls, outputs) adds the tool results
   → {text, tokens, steps, log} or the step's error object (with steps, log) */
async function runLoop(api, browser, { timeoutMs = 600000, maxSteps = MAX_STEPS, onProc } = {}) {
  const deadline = Date.now() + timeoutMs, log = [];
  let steps = 0, tokens = 0, stopped = false;
  if (onProc) onProc({ kill() { stopped = true; browser.close(); } }); // Retry / sleep: stops at the next step
  for (;;) {
    const left = deadline - Date.now();
    if (stopped) return { why: 'stopped', steps, log: log.join('\n') };
    // out of steps, or under two minutes left: one last request without tools
    const last = steps >= maxSteps || left < 120000;
    if (left <= 5000) return { why: 'ran out of time using the browser', steps, log: log.join('\n') };
    const r = await api.step(!last, Math.min(left, 600000));
    if (r.error) return Object.assign(r.error, { steps, log: [...log, r.error.log || ''].join('\n') });
    tokens += r.tokens || 0;
    if (!r.calls || !r.calls.length || last) return { text: r.text || '', tokens, steps, model: r.model, log: log.join('\n') };
    const outputs = [];
    for (const c of r.calls) {
      steps++;
      if (stopped) { outputs.push('stopped'); continue; }
      const out = await browser.call(c.name, c.args, Math.max(5000, Math.min(120000, deadline - Date.now() - 60000)));
      log.push(c.name + ' ' + JSON.stringify(c.args || {}).slice(0, 200) + ' → ' + out.slice(0, 160).replace(/\s+/g, ' '));
      outputs.push(out);
    }
    api.feed(r.calls, outputs, steps >= maxSteps || deadline - Date.now() < 120000 ? OUT_OF_STEPS : null);
  }
}
/* Every request carries the whole conversation, so old page outlines would be paid for again on each step:
   only the newest few results stay whole, older ones keep their start. held: [obj, key] of each result */
const KEEP_WHOLE = 3, OLD_MAX = 1500;
function shrinkOld(held) {
  for (const [o, k] of held.slice(0, -KEEP_WHOLE)) {
    if (typeof o[k] === 'string' && o[k].length > OLD_MAX) o[k] = o[k].slice(0, OLD_MAX) + '\n[… older result, cut short]';
  }
}
const parseArgs = (s) => { if (s && typeof s === 'object') return s; try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };

/* OpenAI's chat format (OpenRouter, Grok, Groq). post(body, ms) → {r, j} | {error}; done(r, j) → the failure object when not ok */
function chatApi({ base, content, post, fail }) {
  const messages = [{ role: 'user', content }], held = [];
  return {
    async step(withTools, ms) {
      const body = Object.assign({}, base, { messages });
      // the last request keeps the tools listed (the conversation has calls in it) but may not call one
      if (base.tools) body.tool_choice = withTools ? 'auto' : 'none';
      const x = await post(body, ms);
      if (x.error) return { error: x.error };
      const { r, j } = x;
      const m = j && j.choices && j.choices[0] && j.choices[0].message;
      const text = m && (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join('') : '');
      const calls = (m && Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((c) => c && c.function)
        .map((c, i) => ({ id: c.id || 'call_' + Date.now() + '_' + i, name: c.function.name, args: parseArgs(c.function.arguments), raw: c }));
      if (!r.ok || (!text && !calls.length)) return { error: fail(r, j) };
      if (calls.length) messages.push({ role: 'assistant', content: text || '', tool_calls: calls.map((c) => Object.assign({}, c.raw, { id: c.id, type: 'function' })) });
      return { text, calls, tokens: j.usage && j.usage.total_tokens, model: j.model };
    },
    feed(calls, outputs, nudge) {
      calls.forEach((c, i) => { const m = { role: 'tool', tool_call_id: c.id, content: outputs[i] }; messages.push(m); held.push([m, 'content']); });
      shrinkOld(held);
      if (nudge) messages.push({ role: 'user', content: nudge });
    },
  };
}
const chatTools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));

/* OpenAI's Responses API (ChatGPT on a key). Nothing is stored at OpenAI, so each request carries the whole
   conversation, its reasoning included (encrypted) */
function responsesApi({ base, input, post, fail }) {
  const items = [{ role: 'user', content: input }], held = [];
  const browsing = Array.isArray(base.tools) && base.tools.some((t) => t.type === 'function');
  return {
    async step(withTools, ms) {
      const body = Object.assign({}, base, { input: items }, browsing ? { include: ['reasoning.encrypted_content'] } : {});
      if (!withTools) body.tool_choice = 'none';
      const x = await post(body, ms);
      if (x.error) return { error: x.error };
      const { r, j } = x;
      const out = j && Array.isArray(j.output) ? j.output : [];
      const text = out.filter((o) => o && o.type === 'message').flatMap((o) => Array.isArray(o.content) ? o.content : [])
        .filter((c) => c && c.type === 'output_text').map((c) => c.text || '').join('');
      const calls = out.filter((o) => o && o.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) }));
      if (!r.ok || (!text && !calls.length)) return { error: fail(r, j) };
      if (calls.length) items.push(...out.filter((o) => o && o.type !== 'web_search_call'));
      return { text, calls, tokens: j.usage && j.usage.total_tokens, model: j.model };
    },
    feed(calls, outputs, nudge) {
      calls.forEach((c, i) => { const o = { type: 'function_call_output', call_id: c.id, output: outputs[i] }; items.push(o); held.push([o, 'output']); });
      shrinkOld(held);
      if (nudge) items.push({ role: 'user', content: nudge });
    },
  };
}
const responsesTools = (tools) => tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false }));

/* Gemini's generateContent. parametersJsonSchema takes the tools' JSON Schema as it is */
function geminiApi({ base, text, post, fail }) {
  const contents = [{ role: 'user', parts: [{ text }] }], held = [];
  return {
    async step(withTools, ms) {
      const body = Object.assign({}, base, { contents });
      if (!withTools) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      const x = await post(body, ms);
      if (x.error) return { error: x.error };
      const { r, j } = x;
      const cand = j && j.candidates && j.candidates[0];
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      const said = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      const calls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id || 'fc' + i, name: p.functionCall.name, args: p.functionCall.args || {} }));
      if (!r.ok || (!said && !calls.length)) return { error: fail(r, j) };
      if (calls.length) contents.push({ role: 'model', parts }); // thought signatures go back as they came
      return { text: said, calls, tokens: j.usageMetadata && j.usageMetadata.totalTokenCount };
    },
    feed(calls, outputs, nudge) {
      const parts = calls.map((c, i) => ({ functionResponse: Object.assign(c.id && !/^fc\d+$/.test(c.id) ? { id: c.id } : {}, { name: c.name, response: { result: outputs[i] } }) }));
      parts.forEach((p) => held.push([p.functionResponse.response, 'result']));
      shrinkOld(held);
      if (nudge) parts.push({ text: nudge });
      contents.push({ role: 'user', parts });
    },
  };
}
const geminiTools = (tools) => [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }];

module.exports = { MAX_STEPS, KEEP_WHOLE, cleanSchema, startBrowser, runLoop, chatApi, chatTools, responsesApi, responsesTools, geminiApi, geminiTools };
