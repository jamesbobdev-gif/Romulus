const test = require('node:test');
const assert = require('node:assert');
const routing = require('../agent/routing');

test('tags in the title win', () => {
  routing.useRouting(null);
  assert.deepStrictEqual(routing.routeTask({ title: 'check my bank #claude' }), { lane: 'claude', reason: 'tagged #claude' });
  assert.deepStrictEqual(routing.routeTask({ title: 'buy shoes #local' }), { lane: 'local', reason: 'tagged #local' });
});

test('private words and card numbers stay on the mini PC', () => {
  routing.useRouting(null);
  assert.deepStrictEqual(routing.routeTask({ title: 'look up my bank balance' }), { lane: 'local', reason: 'private: bank' });
  assert.strictEqual(routing.privateMatch({ title: 'pay with 4111 1111 1111 1111' }), 'a card number');
  assert.strictEqual(routing.privateMatch({ title: 'my number is 123-45-6789' }), 'a social security number');
  assert.strictEqual(routing.privateMatch({ title: 'banking app review', notes: '' }), null); // whole words only
});

test('his rules in order, then the default', () => {
  routing.useRouting(null); // default rules, default 'ask'
  assert.deepStrictEqual(routing.routeTask({ title: 'Find a desk lamp' }), { lane: 'claude', reason: 'rule: buy, find, look up, search' });
  assert.deepStrictEqual(routing.routeTask({ title: 'draft a cover letter' }), { lane: 'local', reason: 'rule: write, draft, essay' });
  assert.deepStrictEqual(routing.routeTask({ title: 'something else' }), { lane: 'ask', reason: 'no rule matched' });
  routing.useRouting({ rules: [], default: 'local' });
  assert.deepStrictEqual(routing.routeTask({ title: 'something else' }), { lane: 'local', reason: 'default' });
});

test('a conversation stays with whoever answered it', () => {
  routing.useRouting(null);
  const t = { title: 'Find a lamp', history: [{ who: 'claude', lane: 'local', text: 'here' }] };
  assert.deepStrictEqual(routing.routeTask(t), { lane: 'local', reason: 'continuing the conversation' });
});

test('rules saved before private words existed get the default list', () => {
  routing.useRouting({ rules: [] });
  assert.strictEqual(routing.getRouting().private, routing.ROUTING_DEFAULT.private);
  routing.useRouting({ nope: 1 });
  assert.strictEqual(routing.getRouting(), routing.ROUTING_DEFAULT);
});

test('laneOf keeps a lane already set', () => {
  routing.useRouting(null);
  assert.strictEqual(routing.laneOf({ title: 'look up my bank', lane: 'claude' }), 'claude');
  assert.strictEqual(routing.isClaudeLane({ title: 'Find a lamp' }), true);
});
