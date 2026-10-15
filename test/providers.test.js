const test = require('node:test');
const assert = require('node:assert');
const providers = require('../agent/providers');

test('settings defaults: Claude on, the rest off', () => {
  const s = providers.settings({});
  assert.deepStrictEqual(s.order, [{ id: 'claude', on: true }, { id: 'gemini', on: false }, { id: 'openai', on: false }, { id: 'openrouter', on: false }]);
  assert.strictEqual(s.openrouterModel, providers.OPENROUTER_DEFAULT_MODEL);
  assert.strictEqual(s.openrouterWeb, true);
});

test('settings keeps the saved order, drops unknown and duplicate ids', () => {
  const s = providers.settings({ ai: { order: [{ id: 'gemini' }, { id: 'bogus' }, { id: 'gemini', on: false }, { id: 'claude', on: false }] } });
  assert.deepStrictEqual(s.order, [{ id: 'gemini', on: true }, { id: 'claude', on: false }, { id: 'openai', on: false }, { id: 'openrouter', on: false }]);
});

test('Gemini without the CLI: the API with Google Search, the key in a header', async () => {
  const real = global.fetch; let sent;
  global.fetch = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"updates": []}' }] } }] }) }; };
  try {
    const r = await providers.runGeminiApi({ ai: { geminiKey: 'k123' } }, { prompt: 'p' });
    assert.strictEqual(r.text, '{"updates": []}');
    assert.match(sent.url, /models\/gemini-flash-latest:generateContent$/);
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
    assert.strictEqual((await providers.runOpenAI({}, { prompt: 'p' })).auth, true);
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
