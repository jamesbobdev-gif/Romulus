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
  routing.useRouting({ v: 2, rules: routing.ROUTING_DEFAULT.rules, default: 'ask' });
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

test('auto picks from what the task needs', () => {
  routing.useRouting({ v: 2, rules: [], default: 'auto' });
  routing.noteSituation({ localUp: true, cloudUp: true, claudeTight: false });
  assert.strictEqual(routing.routeTask({ title: 'check my inbox for the invoice' }).lane, 'claude');
  assert.strictEqual(routing.routeTask({ title: 'cheapest flights to Denver' }).lane, 'claude');
  assert.strictEqual(routing.routeTask({ title: 'draft a thank-you note' }).lane, 'local');
  assert.strictEqual(routing.routeTask({ title: 'fill the volunteer form' }).lane, 'local');
  assert.deepStrictEqual(routing.routeTask({ title: 'something else' }), { lane: 'claude', reason: 'auto: quickest for everyday tasks' });
  routing.noteSituation({ claudeTight: true });
  assert.deepStrictEqual(routing.routeTask({ title: 'something else' }), { lane: 'local', reason: 'auto: Claude is near its limit' });
});

test('auto goes around a side that is down', () => {
  routing.useRouting({ v: 2, rules: [{ words: 'draft', lane: 'local' }], default: 'auto' });
  routing.noteSituation({ localUp: false, cloudUp: true, claudeTight: false });
  assert.strictEqual(routing.routeTask({ title: 'write an essay' }).lane, 'claude');
  assert.strictEqual(routing.routeTask({ title: 'draft a letter' }).lane, 'claude'); // his rule, but the mini PC is down
  assert.strictEqual(routing.routeTask({ title: 'my bank statement' }).lane, 'local'); // private still never leaves
  routing.noteSituation({ localUp: true, cloudUp: false });
  assert.strictEqual(routing.routeTask({ title: 'find a lamp' }).lane, 'local');
  routing.useRouting({ v: 2, rules: [{ words: 'draft', lane: 'local' }], default: 'claude' });
  routing.noteSituation({ localUp: false, cloudUp: true });
  assert.strictEqual(routing.routeTask({ title: 'draft a letter' }).lane, 'local'); // not auto: his rule stands
  routing.noteSituation({ localUp: null, cloudUp: null, claudeTight: false });
});

test('the old ask default becomes auto; a saved v2 choice stays', () => {
  routing.useRouting({ v: 1, rules: [], default: 'ask' });
  assert.strictEqual(routing.getRouting().default, 'auto');
  routing.useRouting({ v: 2, rules: [], default: 'ask' });
  assert.strictEqual(routing.getRouting().default, 'ask');
  routing.useRouting({ v: 1, rules: [], default: 'local' });
  assert.strictEqual(routing.getRouting().default, 'local');
});
