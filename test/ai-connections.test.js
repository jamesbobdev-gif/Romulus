const test = require('node:test');
const assert = require('node:assert');
const { runOrder, homeCloud, outOfUsage } = require('../agent/ai-connections');

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

test('a task stays on the AI that answered it last', () => {
  assert.strictEqual(homeCloud({ history: [] }), null);
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', text: 'x' }] }), 'claude');
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', text: 'x' }, { who: 'claude', via: 'gemini', text: 'y' }] }), 'gemini');
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', via: 'openrouter', text: 'y' }] }), 'openrouter');
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', lane: 'local', text: 'y' }] }), null);
});

test('Save Claude for last: Claude having answered doesn’t keep a task on Claude, his pick does', () => {
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', text: 'x' }] }, true), null);
  assert.strictEqual(homeCloud({ history: [{ who: 'claude', via: 'gemini', text: 'y' }] }, true), 'gemini');
  assert.strictEqual(homeCloud({ cloud: 'claude', history: [{ who: 'claude', text: 'x' }] }, true), 'claude');
});

test('his pick on the pill beats whoever answered last, Claude included', () => {
  assert.strictEqual(homeCloud({ cloud: 'openai', history: [{ who: 'claude', via: 'gemini' }] }), 'openai');
  assert.strictEqual(homeCloud({ cloud: 'claude', history: [{ who: 'claude', via: 'gemini' }] }), 'claude');
});

test('only running out of usage moves a task on', () => {
  assert.strictEqual(outOfUsage({ limit: true }), true);
  assert.strictEqual(outOfUsage({ resetAt: 123 }), true);
  assert.strictEqual(outOfUsage({ auth: true }), false);
  assert.strictEqual(outOfUsage({ why: 'no usable answer' }), false);
});
