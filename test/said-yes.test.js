/* His yes on a task, as the Claude lane reads it before unlocking the final click (agent/agent-browser.js saidYes):
   a yes to the step the last ask described, in words that mean it. A cancel ask (Finance's Cancel button) takes
   "yes, cancel it"; an order ask does not, since there "cancel" takes the yes back. */
const test = require('node:test');
const assert = require('node:assert');
const { saidYes } = require('../agent/agent-browser');

const task = (ask, reply) => ({ history: [{ who: 'claude', text: ask, at: 1 }, { who: 'you', text: reply, at: 2 }] });
const cancel = 'Ready to cancel Hulu: the plan ends Dec 1, nothing is refunded. Reply **yes** to cancel.';

test('a cancel ask takes a plain yes and "yes, cancel it"', () => {
  assert.ok(saidYes(task(cancel, 'yes')));
  assert.ok(saidYes(task(cancel, 'yes, cancel it')));
  assert.ok(saidYes(task(cancel, 'ok, go ahead and cancel the subscription')));
  assert.ok(saidYes({ history: [{ who: 'claude', text: cancel, at: 1 }], reply: 'ok, cancel' }), 'his unsent reply counts too');
});

test('not a yes: a hold, a question, an ask that wanted no yes, or an order ask answered with cancel', () => {
  assert.ok(!saidYes(task(cancel, 'yes, but hold on')));
  assert.ok(!saidYes(task(cancel, 'is there a fee?')));
  assert.ok(!saidYes(task('Which plan is it: Basic or Standard?', 'yes, cancel it')), 'no yes was asked for');
  assert.ok(!saidYes(task('The cart is ready. Reply **yes** to place the order.', 'yes, cancel it')));
  assert.ok(!saidYes(task(cancel, '')));
});

test('a yes to an earlier ask does not carry over to a later one', () => {
  const order = 'The cart is ready. Reply **yes** to place the order.';
  const again = 'Three replies are drafted. Reply **yes** to send them.';
  const hist = [{ who: 'claude', text: order, at: 1 }, { who: 'you', text: 'yes', at: 2 }, { who: 'claude', text: again, at: 3 }];
  assert.ok(!saidYes({ history: hist }), 'a repeat that starts with no reply');
  assert.ok(!saidYes({ history: hist, reply: null }));
  assert.ok(saidYes({ history: hist, reply: 'yes' }), 'his new reply counts');
  assert.ok(saidYes({ history: hist.concat({ who: 'you', text: 'yes', at: 4 }) }));
  assert.ok(saidYes({ history: hist.concat({ who: 'you', text: 'yes', at: 4 }, { who: 'sys', text: 'Moved to Claude', at: 5 }) }));
});
