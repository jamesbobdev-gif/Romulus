const test = require('node:test');
const assert = require('node:assert');
const { runOrder } = require('../agent/ai-connections');

const order = ['claude', 'gemini', 'openrouter'];
const ready = () => true;

test('a web run asks his whole order, in order', () => {
  assert.deepStrictEqual(runOrder({ order, ready }), ['claude', 'gemini', 'openrouter']);
});

test('an inbox run asks Claude only', () => {
  assert.deepStrictEqual(runOrder({ order, mailRun: true, ready }), ['claude']);
  assert.deepStrictEqual(runOrder({ order: ['gemini'], mailRun: true, ready }), []);
});

test('a pinned task asks its AI first, then the rest of his order', () => {
  assert.deepStrictEqual(runOrder({ order, pinned: 'gemini', ready }), ['gemini', 'claude', 'openrouter']);
  // pinned to one that's switched off in the order: still first
  assert.deepStrictEqual(runOrder({ order, pinned: 'openai', ready }), ['openai', 'claude', 'gemini', 'openrouter']);
});

test('a pinned AI that isn’t set up is skipped, the others still try', () => {
  assert.deepStrictEqual(runOrder({ order, pinned: 'openai', ready: (id) => id !== 'openai' }), ['claude', 'gemini', 'openrouter']);
  assert.deepStrictEqual(runOrder({ order: [], pinned: 'openai', ready: () => false }), []);
});
