const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const pa = require('../renderer/js/phone-ai');
const code = require('../main/phone-ai-code');

const steps = [
  { id: 'gemini', key: 'AIzaExampleKey123', model: 'gemini-flash-latest' },
  { id: 'claude', key: 'sk-ant-example-0001', model: 'claude-sonnet-5-5' },
  { id: 'openrouter', key: 'sk-or-example-0001', model: 'openrouter/auto', zdr: true },
];

test('the code carries the keys and nothing else, and only its own codes read back', () => {
  const text = pa.phoneAiPack(steps.concat([{ id: 'evil', key: 'x'.repeat(20) }, { id: 'openai', key: 'short' }]));
  assert.ok(text.startsWith(pa.PHONE_AI_PREFIX));
  assert.deepStrictEqual(pa.phoneAiUnpack(text), steps);
  assert.strictEqual(pa.phoneAiUnpack('tasks-finance:1:abc'), null);
  assert.strictEqual(pa.phoneAiUnpack(pa.PHONE_AI_PREFIX + 'not-json'), null);
  assert.ok(text.length < 1500, 'fits a scannable QR code');
});

test('each AI is called at its own address, the same list the Android plugin allows', () => {
  const java = fs.readFileSync(path.join(__dirname, '..', 'mobile/android/app/src/main/java/com/jartro/tasks/AiKeysPlugin.java'), 'utf8');
  const img = { mime: 'image/jpeg', b64: 'AAAA' };
  for (const id of ['claude', 'gemini', 'openai', 'openrouter']) {
    const q = pa.phoneAiRequest({ id, key: 'k-0000000000', model: '' }, 'hi', img);
    const host = new URL(q.url).host;
    assert.ok(pa.PHONE_AI_HOSTS.includes(host), id);
    assert.ok(java.includes('"' + host + '"'), host + ' in AiKeysPlugin.java');
    assert.match(q.body, /AAAA/);
  }
  assert.match(pa.phoneAiRequest({ id: 'openrouter', key: 'k', zdr: true }, 'hi', null).body, /"zdr":true/);
});

test('ask tries each in order until one answers', async () => {
  const seen = [];
  const post = async (url) => {
    seen.push(new URL(url).host);
    if (url.includes('googleapis')) return { status: 429, body: JSON.stringify({ error: { message: 'quota' } }) };
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"items":[]}' }] }) };
  };
  const r = await pa.phoneAiAsk(steps, 'q', null, post);
  assert.deepStrictEqual(r, { text: '{"items":[]}', via: 'Claude' });
  assert.deepStrictEqual(seen, ['generativelanguage.googleapis.com', 'api.anthropic.com']);
  const none = await pa.phoneAiAsk([steps[0]], 'q', null, post);
  assert.match(none.why, /Gemini: quota/);
  assert.match((await pa.phoneAiAsk([], 'q', null, post)).why, /No AI keys/);
});

test('the computer offers only keys the phone can use, in his order', () => {
  const cfg = { ai: { order: [{ id: 'openrouter', on: true }, { id: 'claude', on: true }, { id: 'gemini', on: true }], openrouterKey: 'sk-or-example-0001', geminiKey: 'AIzaExampleKey123' } };
  const cs = code.choices(cfg);
  assert.deepStrictEqual(cs.slice(0, 3).map((c) => [c.id, c.can]), [['openrouter', true], ['claude', false], ['gemini', true]]);
  assert.match(cs[1].why, /Anthropic API key/);
  assert.strictEqual(cs.find((c) => c.id === 'openai').can, false);
});
