const test = require('node:test');
const assert = require('node:assert');
const routing = require('../agent/routing');
routing.init({ readConfig: () => ({}), dataFile: () => '', sendToRenderer() {}, finance: {} });

test('questions about his money go to Lupa; shopping doesn’t count', () => {
  for (const q of ['How much did I spend on gas last month?', 'what are my bills', 'whats my bank balance', 'show my income statement', 'what did I buy at Target'])
    assert.strictEqual(routing.routeTask({ title: q }).lane, 'local', q);
  for (const q of ['Find me a blender, budget $50', 'Compare costs of flights to NYC', 'Buy paper towels on Amazon', 'how much do I weigh'])
    assert.strictEqual(routing.moneyQuestion({ title: q }), false, q);
});

test('a task Lupa read Finance for never goes to a cloud AI, even tagged #claude or switched by hand', () => {
  const t = { title: 'how much did I spend on gas #claude', lane: 'claude', financeSeen: true };
  assert.strictEqual(routing.routeTask(t).lane, 'local');
  assert.strictEqual(routing.isClaudeLane(t), false);
  assert.strictEqual(routing.privateMatch({ title: 'anything', financeSeen: true }), 'his finances');
});
