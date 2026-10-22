const test = require('node:test');
const assert = require('node:assert');
const providers = require('../agent/providers');

const reply = (status, j) => ({ ok: status < 400, status, json: async () => j });

test('Grok and Groq join the pool, off until he turns them on', () => {
  for (const id of ['xai', 'groq']) assert.ok(providers.PROVIDERS.includes(id), id);
  // no free API tier without a card
  for (const id of ['mistral', 'cerebras']) assert.ok(!providers.PROVIDERS.includes(id), id);
  assert.strictEqual(providers.NAMES.xai, 'Grok');
  const s = providers.settings({ ai: { xaiKey: ' k ', groqModel: 'llama-3.3-70b-versatile' } });
  assert.strictEqual(s.xaiKey, 'k');
  assert.strictEqual(s.xaiModel, ''); // blank: Auto
  assert.strictEqual(s.groqModel, 'llama-3.3-70b-versatile');
  assert.ok(s.order.filter((p) => providers.COMPAT[p.id]).every((p) => !p.on));
});

test('a free-tier AI answers through its chat completions with its key and model', async () => {
  const real = global.fetch; let url, init;
  global.fetch = async (u, i) => { url = u; init = i; return reply(200, { model: 'grok-x', choices: [{ message: { content: '{"updates":[]}' } }], usage: { total_tokens: 5 } }); };
  try {
    const r = await providers.runCompat('xai', { ai: { xaiKey: 'k' } }, { prompt: 'p' });
    assert.strictEqual(url, 'https://api.x.ai/v1/chat/completions');
    assert.strictEqual(init.headers.Authorization, 'Bearer k');
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, providers.COMPAT.xai.model);
    assert.match(body.messages[0].content, /running as Grok/);
    assert.deepStrictEqual(r, { text: '{"updates":[]}', model: 'grok-x' });
  } finally { global.fetch = real; }
});

test('no key, a full quota, and a prompt too big for the free tier each say so', async () => {
  const real = global.fetch;
  try {
    assert.strictEqual((await providers.runCompat('groq', {}, { prompt: 'p' })).auth, true);
    global.fetch = async () => reply(429, { error: { message: 'Rate limit reached for requests per day' } });
    assert.strictEqual((await providers.runCompat('groq', { ai: { groqKey: 'k' } }, { prompt: 'p' })).limit, true);
    global.fetch = async () => reply(413, { error: { message: 'Request too large for model' } });
    const big = await providers.runCompat('groq', { ai: { groqKey: 'k' } }, { prompt: 'p' });
    assert.ok(!big.limit);
    assert.match(big.why, /too big for Groq/);
    global.fetch = async () => reply(401, { message: 'Unauthorized' });
    assert.strictEqual((await providers.runCompat('xai', { ai: { xaiKey: 'k' } }, { prompt: 'p' })).auth, true);
  } finally { global.fetch = real; }
});

test('a chosen model that is gone: it picks another from the key’s model list and tries once more', async () => {
  const real = global.fetch, models = [];
  global.fetch = async (u, i) => {
    if (u.endsWith('/models')) return reply(200, { data: [{ id: 'text-embedding' }, { id: 'llama-3.1-8b' }, { id: 'gpt-oss-120b-new' }] });
    const m = JSON.parse(i.body).model; models.push(m);
    return m === 'gpt-oss-120b-new' ? reply(200, { choices: [{ message: { content: 'ok' } }] }) : reply(404, { error: { message: 'model not found' } });
  };
  try {
    const r = await providers.runCompat('groq', { ai: { groqKey: 'k', groqModel: 'gpt-oss-120b' } }, { prompt: 'p', note: '' });
    assert.deepStrictEqual(models, ['gpt-oss-120b', 'gpt-oss-120b-new']);
    assert.strictEqual(r.text, 'ok');
  } finally { global.fetch = real; }
});

test('Auto ranks a key’s models best first, newest within a kind, and skips non-chat ones', () => {
  assert.deepStrictEqual(providers.rankModels('openai', ['gpt-5-mini', 'gpt-5.2', 'gpt-5', 'text-embedding-3', 'gpt-5.2-2026-01-01', 'gpt-realtime', 'gpt-5.2-nano']),
    ['gpt-5.2', 'gpt-5', 'gpt-5-mini', 'gpt-5.2-nano']);
  assert.deepStrictEqual(providers.autoModels('gemini', ['gemini-3.5-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-embedding-001', 'gemini-3-pro']),
    ['gemini-4-argon', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
});

test('Auto: the best model on the key first; one over its quota hands over to the next', async () => {
  providers.clearModelCache();
  const real = global.fetch, models = [];
  global.fetch = async (u, i) => {
    if (u.endsWith('/models')) return reply(200, { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }] });
    const m = JSON.parse(i.body).model; models.push(m);
    return m === 'openai/gpt-oss-120b' ? reply(429, { error: { message: 'Rate limit reached for requests per day' } }) : reply(200, { choices: [{ message: { content: 'ok' } }] });
  };
  try {
    const r = await providers.runCompat('groq', { ai: { groqKey: 'k2' } }, { prompt: 'p', note: '' });
    assert.deepStrictEqual(models, ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
    assert.strictEqual(r.text, 'ok');
    assert.strictEqual(providers.usedModels().groq, 'llama-3.3-70b-versatile');
    const menu = await providers.modelChoices('groq', { ai: { groqKey: 'k2' } });
    assert.deepStrictEqual(menu.models, ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
    assert.strictEqual(menu.auto, 'openai/gpt-oss-120b');
  } finally { global.fetch = real; providers.clearModelCache(); }
});

test('Cloudflare: account ID and token pasted together, its own model list, then its chat address', async () => {
  const real = global.fetch; const calls = [];
  const acct = 'a'.repeat(32), token = 'tok_' + 'x'.repeat(36);
  global.fetch = async (u, i) => {
    calls.push({ u, auth: i.headers.Authorization, body: i.body && JSON.parse(i.body) });
    if (/models\/search/.test(u)) return reply(200, { result: [{ name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }, { name: '@cf/openai/gpt-oss-120b' }] });
    return reply(200, { model: '@cf/openai/gpt-oss-120b', choices: [{ message: { content: '{"updates":[]}' } }] });
  };
  try {
    providers.clearModelCache();
    const r = await providers.runCompat('cloudflare', { ai: { cloudflareKey: token + ' ' + acct } }, { prompt: 'p' });
    assert.strictEqual(calls[0].u, 'https://api.cloudflare.com/client/v4/accounts/' + acct + '/ai/models/search?task=Text%20Generation&per_page=200');
    assert.strictEqual(calls[1].u, 'https://api.cloudflare.com/client/v4/accounts/' + acct + '/ai/v1/chat/completions');
    assert.strictEqual(calls[1].auth, 'Bearer ' + token);
    assert.strictEqual(calls[1].body.model, '@cf/openai/gpt-oss-120b'); // Auto: the best it has
    assert.strictEqual(r.text, '{"updates":[]}');
  } finally { global.fetch = real; providers.clearModelCache(); }
});

test('Cloudflare: just the token looks up its account; the daily neuron cap counts as out of usage', async () => {
  const real = global.fetch; const urls = [];
  global.fetch = async (u) => {
    urls.push(u);
    if (u.endsWith('/accounts')) return reply(200, { result: [{ id: 'b'.repeat(32) }] });
    return reply(429, { errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] });
  };
  try {
    const r = await providers.runCompat('cloudflare', { ai: { cloudflareKey: 'tok_only', cloudflareModel: '@cf/openai/gpt-oss-120b' } }, { prompt: 'p' });
    assert.ok(urls[1].includes('/accounts/' + 'b'.repeat(32) + '/ai/v1/'));
    assert.strictEqual(r.limit, true);
  } finally { global.fetch = real; }
});

test('NVIDIA: its free key on integrate.api.nvidia.com, Auto picks gpt-oss-120b from its models', async () => {
  const real = global.fetch, calls = [];
  global.fetch = async (u, i) => {
    calls.push({ u, i });
    if (u.endsWith('/models')) return reply(200, { data: [{ id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'meta/llama-3.3-70b-instruct' }, { id: 'openai/gpt-oss-120b' }] });
    return reply(200, { choices: [{ message: { content: '{"updates":[]}' } }] });
  };
  try {
    providers.clearModelCache();
    assert.strictEqual(providers.NAMES.nvidia, 'NVIDIA');
    const r = await providers.runCompat('nvidia', { ai: { nvidiaKey: 'nvapi-x' } }, { prompt: 'p' });
    assert.strictEqual(calls[1].u, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.strictEqual(calls[1].i.headers.Authorization, 'Bearer nvapi-x');
    assert.strictEqual(JSON.parse(calls[1].i.body).model, 'openai/gpt-oss-120b');
    assert.strictEqual(r.text, '{"updates":[]}');
  } finally { global.fetch = real; }
});

test('OpenRouter on Auto: its free models first (known kinds, then any by size), then the paid pick when they fail', async () => {
  const real = global.fetch, models = [];
  global.fetch = async (u, i) => {
    if (u.endsWith('/models')) return reply(200, { data: [{ id: 'openai/gpt-5' }, { id: 'meta-llama/llama-3.3-70b-instruct:free' }, { id: 'deepseek/deepseek-chat-v3.1:free' }, { id: 'google/gemma-3-4b-it:free' }] });
    const b = JSON.parse(i.body); models.push(b.model);
    assert.deepStrictEqual(b.provider, { data_collection: 'deny', zdr: true }); // his privacy settings still hold
    if (b.model.endsWith(':free')) return reply(404, { error: { message: 'No endpoints found matching your data policy' } });
    return reply(200, { choices: [{ message: { content: 'ok' } }] });
  };
  try {
    providers.clearModelCache();
    const r = await providers.runOpenRouter({ ai: { openrouterKey: 'kf' } }, { prompt: 'p' });
    assert.deepStrictEqual(models, ['deepseek/deepseek-chat-v3.1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-4b-it:free', 'openrouter/auto']);
    assert.strictEqual(r.text, 'ok');
    // off, or a model he picked: straight to it
    models.length = 0;
    await providers.runOpenRouter({ ai: { openrouterKey: 'kf', openrouterFree: false } }, { prompt: 'p' });
    await providers.runOpenRouter({ ai: { openrouterKey: 'kf', openrouterModel: 'openai/gpt-5' } }, { prompt: 'p' });
    assert.deepStrictEqual(models, ['openrouter/auto', 'openai/gpt-5']);
  } finally { global.fetch = real; }
});
