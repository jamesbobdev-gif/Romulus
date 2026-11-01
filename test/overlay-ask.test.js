const test = require('node:test');
const assert = require('node:assert');
const { ask, plan, promptText } = require('../agent/overlay-ask');

const IMG = { mime: 'image/jpeg', b64: 'AAAA' };
const cfg = (ai) => ({ ai: Object.assign({ order: [] }, ai) });
// a fetch that answers by host, and remembers what was sent
function fakeFetch(answers) {
  const sent = [];
  const f = async (url, o) => {
    const host = new URL(url).host, body = JSON.parse(o.body);
    sent.push({ host, url, body, headers: o.headers });
    const a = answers[host];
    if (!a) throw new Error('fetch failed');
    return { ok: a.status ? a.status < 300 : true, status: a.status || 200, json: async () => a.json };
  };
  f.sent = sent;
  return f;
}

test('plan: his order, each by the call it can take; a picture leaves out the text-only ones', () => {
  const c = cfg({ geminiKey: 'g', openrouterKey: 'o', groqKey: 'q' });
  const order = ['groq', 'gemini', 'openrouter'];
  assert.deepStrictEqual(plan(c, { lane: 'cloud', order, image: null }).map((s) => s.id), ['groq', 'gemini', 'openrouter']);
  assert.deepStrictEqual(plan(c, { lane: 'cloud', order, image: IMG }).map((s) => s.id), ['gemini', 'openrouter']);
});

test('plan: Claude straight to the API with a key, else through Claude Code; ChatGPT on his plan is skipped', () => {
  assert.strictEqual(plan(cfg({ anthropicKey: 'k' }), { order: ['claude'] })[0].how, 'anthropic');
  assert.strictEqual(plan(cfg({}), { order: ['claude'] })[0].how, 'claude-cli');
  assert.deepStrictEqual(plan(cfg({ openaiVia: 'chatgpt', openaiKey: 'x' }), { order: ['openai'] }), []);
});

test('plan: Lupa lane asks only Lupa', () => {
  assert.deepStrictEqual(plan(cfg({ geminiKey: 'g' }), { lane: 'local', order: ['gemini'], local: { url: 'http://lupa:11434', model: 'holo' } }), [{ id: 'local', how: 'ollama' }]);
  assert.deepStrictEqual(plan(cfg({}), { lane: 'local', order: ['gemini'], local: null }), []);
});

test('the picture and question reach Gemini; the answer comes back with who gave it', async () => {
  const f = fakeFetch({ 'generativelanguage.googleapis.com': { json: { candidates: [{ content: { parts: [{ text: 'It is a null pointer.' }] } }] } } });
  const r = await ask(cfg({ geminiKey: 'g' }), { question: 'what is this error?', image: IMG, lane: 'cloud' }, { fetch: f, order: ['gemini'] });
  assert.deepStrictEqual(r, { text: 'It is a null pointer.', via: 'Gemini' });
  const parts = f.sent[0].body.contents[0].parts;
  assert.deepStrictEqual(parts[0], { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
  assert.match(parts[1].text, /what is this error\?/);
});

test('a failing AI hands over to the next in his order', async () => {
  const f = fakeFetch({
    'generativelanguage.googleapis.com': { status: 429, json: { error: { message: 'quota' } } },
    'openrouter.ai': { json: { choices: [{ message: { content: 'Click Save.' } }] } },
  });
  const r = await ask(cfg({ geminiKey: 'g', openrouterKey: 'o' }), { question: 'next?', image: IMG, lane: 'cloud' }, { fetch: f, order: ['gemini', 'openrouter'] });
  assert.strictEqual(r.text, 'Click Save.');
  assert.strictEqual(r.via, 'OpenRouter');
  // OpenRouter only through providers that don't collect what's sent, picture included
  const body = f.sent[1].body;
  assert.strictEqual(body.provider.data_collection, 'deny');
  assert.strictEqual(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('every AI failing says why, per AI', async () => {
  const f = fakeFetch({ 'generativelanguage.googleapis.com': { status: 403, json: { error: { message: 'API key not valid' } } } });
  const r = await ask(cfg({ geminiKey: 'g' }), { question: 'x', image: null, lane: 'cloud' }, { fetch: f, order: ['gemini'] });
  assert.match(r.why, /Gemini: API key not valid/);
});

test('every AI failing also names the ones not asked: signed out, or text-only with a picture', async () => {
  const f = fakeFetch({ 'generativelanguage.googleapis.com': { status: 503, json: { error: { message: 'high demand' } } } });
  const r = await ask(cfg({ geminiKey: 'g', groqKey: 'q' }), { question: 'x', image: IMG, lane: 'cloud' }, { fetch: f, order: ['gemini', 'groq'], notReady: ['claude'] });
  assert.match(r.why, /Gemini: high demand/);
  assert.match(r.why, /Claude: Claude Code isn’t signed in/);
  assert.match(r.why, /Groq: can’t read a screenshot/);
});

test('Lupa gets the picture in Ollama’s images field', async () => {
  const f = fakeFetch({ 'lupa:11434': { json: { message: { content: 'A login form.' } } } });
  const r = await ask(cfg({}), { question: 'what is this?', image: IMG, lane: 'local' }, { fetch: f, order: [], local: { url: 'http://lupa:11434', model: 'holo' } });
  assert.deepStrictEqual(r, { text: 'A login form.', via: 'Lupa' });
  assert.deepStrictEqual(f.sent[0].body.messages[0].images, ['AAAA']);
  assert.strictEqual(f.sent[0].body.model, 'holo');
});

test('Claude Code without a key: the runner gets the text and the picture', async () => {
  let got = null;
  const r = await ask(cfg({}), { question: 'q', image: IMG, lane: 'cloud' }, { fetch: fakeFetch({}), order: ['claude'], claudeCli: async (text, image) => { got = { text, image }; return 'Done.'; } });
  assert.strictEqual(r.text, 'Done.');
  assert.strictEqual(got.image, IMG);
});

test('nothing set up: says what to do, and asks no one', async () => {
  const f = fakeFetch({});
  const r = await ask(cfg({ groqKey: 'q' }), { question: 'x', image: IMG, lane: 'cloud' }, { fetch: f, order: ['groq'] });
  assert.match(r.why, /can read a screenshot/);
  assert.strictEqual(f.sent.length, 0);
});

test('the chat so far goes along as text', () => {
  const t = promptText('and then?', [{ q: 'what is this', a: 'a form' }]);
  assert.match(t, /He asked: what is this\nYou answered: a form/);
  assert.match(t, /## His question\nand then\?$/);
  assert.match(promptText('', []), /What's on my screen/);
});
