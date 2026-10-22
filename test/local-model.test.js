const test = require('node:test');
const assert = require('node:assert');
const { mergeLocalModel, OLLAMA_DEFAULT } = require('../agent/local-lane');

test('a bare host becomes an http address; the default is this computer’s Ollama', () => {
  assert.strictEqual(OLLAMA_DEFAULT, 'http://localhost:11434');
  assert.deepStrictEqual(mergeLocalModel({}, { url: 'localhost:11434/', model: 'qwen3:8b' }), { url: 'http://localhost:11434', model: 'qwen3:8b' });
  assert.deepStrictEqual(mergeLocalModel({}, { url: '', model: 'm' }), { url: OLLAMA_DEFAULT, model: 'm' });
  assert.deepStrictEqual(mergeLocalModel({}, { url: 'http://192.168.1.50:11434', model: 'm' }), { url: 'http://192.168.1.50:11434', model: 'm' });
});

test('the rest of localModel (the browser’s ssh host) survives a save; turning off keeps the address', () => {
  const cfg = { localModel: { url: 'http://old:11434', model: 'old', browser: { ssh: 'lupa' } } };
  const l = mergeLocalModel(cfg, { url: 'http://new:11434', model: 'new' });
  assert.deepStrictEqual(l, { url: 'http://new:11434', model: 'new', browser: { ssh: 'lupa' } });
  const off = mergeLocalModel({ localModel: l }, { enabled: false });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.url, 'http://new:11434');
  // a later save turns it back on
  assert.strictEqual(mergeLocalModel({ localModel: off }, { url: off.url, model: 'new' }).enabled, undefined);
});

test('a bad address or no model is refused', () => {
  assert.throws(() => mergeLocalModel({}, { url: 'file:///etc', model: 'm' }), /address/);
  assert.throws(() => mergeLocalModel({}, { url: 'http://a b', model: 'm' }), /address/);
  assert.throws(() => mergeLocalModel({}, { url: 'localhost', model: '' }), /model/);
});
