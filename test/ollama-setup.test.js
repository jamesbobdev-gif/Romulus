const test = require('node:test');
const assert = require('node:assert');
const { recommendModel, hardwareFit } = require('../agent/ollama-setup');

const GB = 1024 ** 3;
test('Set it up for me picks a model that fits the memory', () => {
  assert.strictEqual(recommendModel(8 * GB).model, 'qwen3:4b');
  assert.strictEqual(recommendModel(16 * GB).model, 'qwen3:8b');
  assert.strictEqual(recommendModel(32 * GB).model, 'qwen3:14b');
});
test('it is only offered on a computer that can run one', () => {
  assert.strictEqual(hardwareFit(4 * GB, 100 * GB).ok, false); // too little memory
  assert.strictEqual(hardwareFit(16 * GB, 3 * GB).ok, false); // too little disk for qwen3:8b
  assert.deepStrictEqual(hardwareFit(32 * GB, 100 * GB), { ok: true, why: '' });
  const slow = hardwareFit(8 * GB, 100 * GB); assert.ok(slow.ok && /slowly/.test(slow.why));
  assert.strictEqual(hardwareFit(16 * GB, null).ok, true); // disk unknown: memory decides
});
