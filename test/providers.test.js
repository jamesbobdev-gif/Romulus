const test = require('node:test');
const assert = require('node:assert');
const providers = require('../agent/providers');

test('settings defaults: Claude on, the rest off', () => {
  const s = providers.settings({});
  assert.deepStrictEqual(s.order, [{ id: 'claude', on: true }, { id: 'gemini', on: false }, { id: 'openai', on: false }, { id: 'openrouter', on: false },
    ...providers.COMPAT_IDS.map((id) => ({ id, on: false }))]);
  assert.strictEqual(s.openrouterModel, providers.OPENROUTER_DEFAULT_MODEL);
  assert.strictEqual(s.openrouterWeb, true);
});

test('settings keeps the saved order, drops unknown and duplicate ids', () => {
  const s = providers.settings({ ai: { order: [{ id: 'gemini' }, { id: 'bogus' }, { id: 'gemini', on: false }, { id: 'claude', on: false }] } });
  assert.deepStrictEqual(s.order, [{ id: 'gemini', on: true }, { id: 'claude', on: false }, { id: 'openai', on: false }, { id: 'openrouter', on: false },
    ...providers.COMPAT_IDS.map((id) => ({ id, on: false }))]);
});

test('Gemini without the CLI: the API with Google Search, the key in a header', async () => {
  const real = global.fetch; let sent;
  global.fetch = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"updates": []}' }] } }] }) }; };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k123' } }, { prompt: 'p' });
    assert.strictEqual(r.text, '{"updates": []}');
    assert.match(sent.url, /models\/gemini-4-argon:generateContent$/);
    assert.strictEqual(sent.init.headers['x-goog-api-key'], 'k123');
    assert.deepStrictEqual(JSON.parse(sent.init.body).tools, [{ google_search: {} }]);
  } finally { global.fetch = real; }
});

test('Gemini API: a 429 is out of usage, no key is a sign-in problem', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Resource exhausted' } }) });
  try {
    assert.strictEqual((await providers.runGeminiApi({ ai: { geminiKey: 'k' } }, { prompt: 'p' })).limit, true);
    assert.strictEqual((await providers.runGeminiApi({}, { prompt: 'p' })).auth, true);
  } finally { global.fetch = real; }
});

test('Gemini tries Argon, then Flash, then Flash-Lite while Google turns models away', async () => {
  const real = global.fetch, urls = [];
  const replies = [{ status: 429, error: { message: 'limit: 0, model: gemini-4-argon' } }, { status: 503, error: { message: 'high demand' } }];
  global.fetch = async (url) => { urls.push(url.match(/models\/([^:]+):/)[1]); const e = replies.shift();
    return e ? { ok: false, status: e.status, json: async () => ({ error: e.error }) } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k' } }, { prompt: 'p' });
    assert.strictEqual(r.text, 'ok');
    assert.deepStrictEqual(urls, ['gemini-4-argon', 'gemini-flash-latest', 'gemini-3.5-flash-lite']);
  } finally { global.fetch = real; }
});

test('Gemini on a browser task: Flash-Lite is skipped, so the next AI takes it', async () => {
  const real = global.fetch, urls = [];
  const replies = [{ status: 429, error: { message: 'limit: 0, model: gemini-4-argon' } }, { status: 503, error: { message: 'high demand' } }];
  global.fetch = async (url) => { urls.push(url.match(/models\/([^:]+):/)[1]); const e = replies.shift();
    return e ? { ok: false, status: e.status, json: async () => ({ error: e.error }) } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k' } }, { prompt: 'p', noLite: true });
    assert.ok(!r.text);
    assert.deepStrictEqual(urls, ['gemini-4-argon', 'gemini-flash-latest']);
    assert.match(r.why, /Flash-Lite/);
    assert.ok(!r.limit && !r.busy, 'not read as out for the day');
    // Lite chosen in Settings and nothing else: Gemini passes without a call
    urls.length = 0;
    const lite = await providers.runGeminiApi({ ai: { geminiKey: 'k', geminiModel: 'gemini-3.5-flash-lite' } }, { prompt: 'p', noLite: true });
    assert.deepStrictEqual(urls, []);
    assert.match(lite.why, /Flash-Lite/);
  } finally { global.fetch = real; }
});

test('Gemini: a model set in Settings goes first, Flash-Lite after it; a bad key stops there', async () => {
  const real = global.fetch, urls = [];
  global.fetch = async (url) => { urls.push(url.match(/models\/([^:]+):/)[1]); return { ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid' } }) }; };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k', geminiModel: 'gemini-3.8-flash' } }, { prompt: 'p' });
    assert.strictEqual(r.auth, true);
    assert.deepStrictEqual(urls, ['gemini-3.8-flash']);
  } finally { global.fetch = real; }
});

test('Gemini is ready with just a key', () => {
  assert.strictEqual(providers.geminiStatus({ ai: { geminiKey: 'k' } }).ready, true);
  assert.strictEqual(providers.geminiStatus({}).ready, false);
});

test('ChatGPT: Responses API with web search, nothing stored, text from the message', async () => {
  const real = global.fetch; let sent;
  global.fetch = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ model: 'gpt-5-mini',
    output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{"updates": []}' }] }] }) }; };
  try {
    const r = await providers.runOpenAI({ ai: { openaiKey: 'sk-1' } }, { prompt: 'p' });
    assert.strictEqual(r.text, '{"updates": []}');
    assert.strictEqual(sent.url, 'https://api.openai.com/v1/responses');
    assert.strictEqual(sent.init.headers.Authorization, 'Bearer sk-1');
    const body = JSON.parse(sent.init.body);
    assert.strictEqual(body.model, providers.OPENAI_DEFAULT_MODEL);
    assert.strictEqual(body.store, false);
    assert.deepStrictEqual(body.tools, [{ type: 'web_search' }]);
  } finally { global.fetch = real; }
});

test('ChatGPT: no key is a sign-in problem, a 429 is out of usage', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
  try {
    assert.strictEqual((await providers.runOpenAI({ ai: { openaiVia: 'key' } }, { prompt: 'p' })).auth, true);
    assert.strictEqual((await providers.runOpenAI({ ai: { openaiKey: 'k' } }, { prompt: 'p' })).limit, true);
  } finally { global.fetch = real; }
});

test('a custom note replaces the "This run" note (helpers want plain text)', async () => {
  const real = global.fetch; let body;
  global.fetch = async (url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; };
  try {
    await providers.runOpenRouter({ ai: { openrouterKey: 'k' } }, { prompt: 'p', note: '' });
    assert.strictEqual(body.messages[0].content, 'p');
  } finally { global.fetch = real; }
});

test('ChatGPT: the plan (Codex) unless he saved a key; his choice wins either way', () => {
  assert.strictEqual(providers.settings({}).openaiVia, 'chatgpt');
  assert.strictEqual(providers.settings({ ai: { openaiKey: 'k' } }).openaiVia, 'key');
  assert.strictEqual(providers.settings({ ai: { openaiKey: 'k', openaiVia: 'chatgpt' } }).openaiVia, 'chatgpt');
  assert.strictEqual(providers.settings({ ai: { openaiVia: 'bogus' } }).openaiVia, 'chatgpt');
});

test('Codex runs: shell, apps, its own browser and config off, read-only', () => {
  const a = providers.codexArgs('codex.js', 'out.txt');
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent'])
    assert.ok(a.some((x, i) => x === f && a[i - 1] === '--disable'), f);
  // web search runs through code mode on newer Codex: switching it off left ChatGPT with no search at all
  assert.ok(!a.includes('code_mode_host'));
  assert.ok(a.includes('--ignore-user-config') && a.includes('--ephemeral'));
  assert.strictEqual(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.strictEqual(a[a.length - 1], '-');
  assert.ok(!a.some((x) => /^mcp_servers\./.test(x)), 'no browser unless one is given');
});

test('Codex runs can get the agent browser: its MCP server as TOML overrides, risky tools off', () => {
  const browser = { command: 'C:\\node\\node.exe', args: ['C:\\x\\proxy.js', '["--a","b"]'],
    env: { TASKS_BROWSER_MAIL: 'block', TASKS_BROWSER_TAINT: 'C:\\x\\mail-seen.json' }, denied: ['browser_evaluate', 'browser_file_upload'] };
  const a = providers.codexArgs('codex.js', 'out.txt', null, browser);
  const val = (k) => { const x = a.find((s) => s.startsWith('mcp_servers.browser.' + k + '=')); return x && x.slice(x.indexOf('=') + 1); };
  assert.strictEqual(JSON.parse(val('command')), browser.command);
  assert.deepStrictEqual(JSON.parse(val('args')), browser.args);
  assert.deepStrictEqual(JSON.parse(val('disabled_tools')), browser.denied);
  assert.strictEqual(val('env'), '{ TASKS_BROWSER_MAIL = "block", TASKS_BROWSER_TAINT = "C:\\\\x\\\\mail-seen.json" }');
  assert.strictEqual(val('default_tools_approval_mode'), '"approve"');
  // still read-only, still none of Codex's own browser
  assert.ok(a.some((x, i) => x === 'browser_use' && a[i - 1] === '--disable'));
  assert.strictEqual(a[a.length - 1], '-');
});

/* ── the agent browser for the one-request AIs (agent/tool-loop.js): a fake MCP server and a fake model ── */
const fs = require('fs');
const os = require('os');
const path = require('path');
const loop = require('../agent/tool-loop');

// a stand-in for browser-proxy.js: newline JSON-RPC on stdio, three tools (one of them risky), every call written to FAKE_MCP_LOG
const FAKE_MCP = `
const fs = require('fs');
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'browser_navigate', description: 'Open a URL', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      { name: 'browser_snapshot', description: 'Read the page', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } },
      { name: 'browser_evaluate', description: 'Run code', inputSchema: { type: 'object', properties: {} } } ] } });
    else if (m.method === 'tools/call') {
      fs.appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ name: m.params.name, args: m.params.arguments, mail: process.env.TASKS_BROWSER_MAIL }) + '\\n');
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'page: Showtimes 7:00pm at ' + (m.params.arguments.url || 'here') }] } });
    }
  }
});
`;
function fakeBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fake-mcp-'));
  const script = path.join(dir, 'server.js'), logFile = path.join(dir, 'calls.log'), cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(script, FAKE_MCP);
  fs.writeFileSync(logFile, '');
  // the shape browserCfgFor writes (env: the mail guard), plus where the fake writes its calls
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: [script], env: { TASKS_BROWSER_MAIL: 'block', FAKE_MCP_LOG: logFile } } } }));
  return { cfg, calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const DENIED = ['mcp__browser__browser_evaluate'];
const SHOWTIMES = '{"updates":[{"id":"t1","showtimes":{"movie":"You Can See Everything","days":[]}}]}';
const reply = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });

test('tool loop: the MCP server\'s tools minus the risky ones, schemas cleaned, calls run through it', async () => {
  const fb = fakeBrowser();
  const b = await loop.startBrowser(fb.cfg, DENIED);
  try {
    assert.deepStrictEqual(b.tools.map((t) => t.name), ['browser_navigate', 'browser_snapshot']);
    assert.strictEqual(b.tools[0].schema.$schema, undefined);
    assert.strictEqual(b.tools[1].schema.properties.filename, undefined); // never saves to a file here
    assert.match(await b.call('browser_navigate', { url: 'https://x.test' }), /7:00pm at https:\/\/x\.test/);
    assert.match(await b.call('browser_evaluate', {}), /no tool called/); // hidden means not callable either
    assert.deepStrictEqual(fb.calls(), [{ name: 'browser_navigate', args: { url: 'https://x.test' }, mail: 'block' }]);
  } finally { b.close(); }
});

test('OpenRouter with the browser: function tools, each call answered from MCP, then the JSON answer', async () => {
  const fb = fakeBrowser(), real = global.fetch, bodies = [];
  const turns = [
    { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_navigate', arguments: '{"url":"https://www.fandango.com/44109_movietimes"}' } }] } }] },
    { model: 'some/model', choices: [{ message: { content: SHOWTIMES } }], usage: { total_tokens: 9 } }];
  global.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(turns.shift()); };
  try {
    const r = await providers.runOpenRouter({ ai: { openrouterKey: 'k' } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.strictEqual(r.text, SHOWTIMES);
    assert.strictEqual(JSON.parse(r.text).updates[0].showtimes.movie, 'You Can See Everything');
    assert.deepStrictEqual(bodies[0].tools.map((t) => t.function.name), ['browser_navigate', 'browser_snapshot']);
    assert.strictEqual(bodies[0].tool_choice, 'auto');
    assert.match(bodies[0].messages[0].content, /browser_\* tools/); // the "This run" note says it has them
    assert.deepStrictEqual(bodies[0].provider, { data_collection: 'deny', zdr: true }); // still only private providers
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
    assert.strictEqual(toolMsg.tool_call_id, 'c1');
    assert.match(toolMsg.content, /Showtimes 7:00pm/);
    assert.deepStrictEqual(fb.calls().map((c) => c.name), ['browser_navigate']);
    assert.match(r.log, /1 browser step/);
  } finally { global.fetch = real; }
});

test('OpenRouter without a browser: no tools, the no-tools note', async () => {
  const real = global.fetch; let body;
  global.fetch = async (url, init) => { body = JSON.parse(init.body); return reply({ choices: [{ message: { content: 'ok' } }] }); };
  try {
    await providers.runOpenRouter({ ai: { openrouterKey: 'k' } }, { prompt: 'p' });
    assert.strictEqual(body.tools, undefined);
    assert.match(body.messages[0].content, /NO tools/);
  } finally { global.fetch = real; }
});

test('ChatGPT on a key with the browser: Responses API function calls fed back as function_call_output', async () => {
  const fb = fakeBrowser(), real = global.fetch, bodies = [];
  const turns = [
    { output: [{ type: 'reasoning', id: 'rs1', encrypted_content: 'x' }, { type: 'function_call', call_id: 'f1', name: 'browser_snapshot', arguments: '{}' }] },
    { model: 'gpt-5', output: [{ type: 'message', content: [{ type: 'output_text', text: SHOWTIMES }] }] }];
  global.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(turns.shift()); };
  try {
    const r = await providers.runOpenAI({ ai: { openaiKey: 'sk', openaiModel: 'gpt-5' } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.strictEqual(r.text, SHOWTIMES);
    assert.deepStrictEqual(bodies[0].tools.map((t) => t.name || t.type), ['web_search', 'browser_navigate', 'browser_snapshot']);
    assert.strictEqual(bodies[0].store, false);
    assert.ok(bodies[0].input[0].content.endsWith(providers.CODEX_BROWSER_NOTE));
    // the reasoning and the call go back with the result, as nothing is stored at OpenAI
    assert.deepStrictEqual(bodies[1].input.slice(1).map((i) => i.type), ['reasoning', 'function_call', 'function_call_output']);
    assert.match(bodies[1].input[3].output, /Showtimes/);
  } finally { global.fetch = real; }
});

test('Gemini API with the browser: functionDeclarations beside Google Search, functionResponse back', async () => {
  const fb = fakeBrowser(), real = global.fetch, bodies = [];
  const turns = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'browser_navigate', args: { url: 'https://a.test' } }, thoughtSignature: 'sig' }] } }] },
    { candidates: [{ content: { parts: [{ text: SHOWTIMES }] } }] }];
  global.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(turns.shift()); };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k', geminiModel: 'gemini-x' } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.strictEqual(r.text, SHOWTIMES);
    assert.deepStrictEqual(bodies[0].tools[0], { google_search: {} });
    assert.deepStrictEqual(bodies[0].tools[1].functionDeclarations.map((f) => f.name), ['browser_navigate', 'browser_snapshot']);
    assert.strictEqual(bodies[1].contents[1].parts[0].thoughtSignature, 'sig'); // the model's turn goes back as it came
    assert.match(bodies[1].contents[2].parts[0].functionResponse.response.result, /a\.test/);
  } finally { global.fetch = real; }
});

test('Grok/Groq: no browser unless it is turned on for that one', async () => {
  const fb = fakeBrowser(), real = global.fetch, bodies = [];
  global.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return reply({ choices: [{ message: { content: 'ok' } }] }); };
  try {
    assert.strictEqual(providers.settings({}).groqBrowser, false);
    // the old one switch still counts until he sets one of his own
    assert.strictEqual(providers.settings({ ai: { compatBrowser: true } }).xaiBrowser, true);
    assert.strictEqual(providers.settings({ ai: { compatBrowser: true, xaiBrowser: false } }).xaiBrowser, false);
    await providers.runCompat('groq', { ai: { groqKey: 'k', groqModel: 'm', xaiBrowser: true } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.strictEqual(bodies[0].tools, undefined);
    await providers.runCompat('groq', { ai: { groqKey: 'k', groqModel: 'm', groqBrowser: true } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.deepStrictEqual(bodies[1].tools.map((t) => t.function.name), ['browser_navigate', 'browser_snapshot']);
    assert.match(bodies[1].messages[0].content, /duckduckgo/); // no web search of its own: it searches in the browser
  } finally { global.fetch = real; }
});

test('tool loop: out of steps, one last request that may not call a tool', async () => {
  const fb = fakeBrowser(), b = await loop.startBrowser(fb.cfg, DENIED), bodies = [];
  const call = { choices: [{ message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] } }] };
  try {
    const api = loop.chatApi({ base: { model: 'm', tools: loop.chatTools(b.tools) }, content: 'p', fail: () => ({ why: 'bad' }),
      post: async (body) => { bodies.push(JSON.parse(JSON.stringify(body))); return { r: { ok: true }, j: body.tool_choice === 'none' ? { choices: [{ message: { content: 'final' } }] } : call }; } });
    const r = await loop.runLoop(api, b, { maxSteps: 3 });
    assert.strictEqual(r.text, 'final');
    assert.strictEqual(r.steps, 3);
    assert.strictEqual(bodies.length, 4);
    assert.strictEqual(bodies[3].tool_choice, 'none');
    assert.match(bodies[3].messages[bodies[3].messages.length - 1].content, /out of browser steps/);
    assert.strictEqual(fb.calls().length, 3);
  } finally { b.close(); }
});

test('tool loop: an API error mid-run comes back as that provider\'s failure', async () => {
  const fb = fakeBrowser(), real = global.fetch;
  const turns = [reply({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'browser_snapshot', arguments: '{}' } }] } }] }), reply({ error: { message: 'Rate limited' } }, 429)];
  global.fetch = async () => turns.shift();
  try {
    const r = await providers.runOpenRouter({ ai: { openrouterKey: 'k' } }, { prompt: 'p', browserMcpFile: fb.cfg, browserDenied: DENIED });
    assert.strictEqual(r.limit, true);
    assert.strictEqual(r.text, undefined);
  } finally { global.fetch = real; }
});

test('a browser that won\'t start: the run goes on without it', async () => {
  const real = global.fetch; let body;
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fake-mcp-')), 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: ['-e', 'process.exit(1)'] } } }));
  global.fetch = async (url, init) => { body = JSON.parse(init.body); return reply({ choices: [{ message: { content: 'ok' } }] }); };
  try {
    const r = await providers.runOpenRouter({ ai: { openrouterKey: 'k' } }, { prompt: 'p', browserMcpFile: cfg });
    assert.strictEqual(r.text, 'ok');
    assert.strictEqual(body.tools, undefined);
    assert.match(r.log, /didn't start/);
  } finally { global.fetch = real; }
});

test('tool loop: only the newest results stay whole, older page outlines are cut short', async () => {
  let sent;
  const api = loop.chatApi({ base: { model: 'm' }, content: 'p', fail: () => ({ why: 'x' }),
    post: async (b) => { sent = b; return { r: { ok: true }, j: { choices: [{ message: { content: 'ok' } }] } }; } });
  for (let i = 0; i < 5; i++) api.feed([{ id: 'c' + i, name: 'browser_snapshot' }], ['x'.repeat(5000)]);
  await api.step(true, 1000); // the conversation as it's sent
  const lens = sent.messages.filter((m) => m.role === 'tool').map((m) => m.content.length);
  assert.ok(lens.slice(0, 5 - loop.KEEP_WHOLE).every((n) => n < 1600), String(lens));
  assert.ok(lens.slice(5 - loop.KEEP_WHOLE).every((n) => n === 5000), String(lens));
});
