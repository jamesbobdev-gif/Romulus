const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const learn = require('../agent/route-learn');
const routing = require('../agent/routing');

const fresh = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')); learn.init(dir); learn._reset(); return dir; };
const save = (tasks) => JSON.stringify({ tasks });

test('tasks get a type from their words', () => {
  assert.strictEqual(learn.typeOf({ title: 'I need to order food for this week' }), 'groceries');
  assert.strictEqual(learn.typeOf({ title: 'buy a desk lamp' }), 'shopping');
  assert.strictEqual(learn.typeOf({ title: 'reply to the landlord email' }), 'email');
  assert.strictEqual(learn.typeOf({ title: 'draft a cover letter' }), 'writing');
  assert.strictEqual(learn.typeOf({ title: 'hmm' }), 'other');
  assert.strictEqual(learn.typeOf({ title: 'buy a lamp', taskType: 'groceries' }), 'groceries'); // a stamped type sticks
});

test('a fresh type starts at 50% and moves with each outcome, counted once', () => {
  fresh();
  assert.deepStrictEqual(learn.chance('groceries', 'claude'), { p: 0.5, n: 0 });
  const done = { id: 'a', ws: 'agent', title: 'order food', routedLane: 'claude', lane: 'claude', status: 'done' };
  learn.learn(save([done]));
  learn.learn(save([done])); // saved again: not counted twice
  assert.deepStrictEqual(learn.chance('groceries', 'claude'), { p: 2 / 3, n: 1 });
});

test('switching a task off its lane counts against that lane and for the one that finishes it', () => {
  fresh();
  learn.learn(save([{ id: 'b', ws: 'agent', title: 'order food', routedLane: 'local', lane: 'claude', done: true }]));
  assert.strictEqual(learn.chance('groceries', 'local').n, 1);
  assert.ok(learn.chance('groceries', 'local').p < 0.5);
  assert.ok(learn.chance('groceries', 'claude').p > 0.5);
});

test('once a type has a clear record, auto routing follows it', () => {
  fresh();
  routing.useRouting({ v: 2, rules: [], default: 'auto' });
  // without history, "order food" goes to the cloud on its words
  assert.strictEqual(routing.routeTask({ title: 'I need to order food for this week' }).lane, 'claude');
  // the local model has done groceries well three times, Claude was switched off twice
  const tasks = [1, 2, 3].map((i) => ({ id: 'l' + i, ws: 'agent', title: 'groceries ' + i, routedLane: 'local', lane: 'local', done: true }))
    .concat([1, 2].map((i) => ({ id: 'c' + i, ws: 'agent', title: 'food ' + i, routedLane: 'claude', lane: 'local', status: 'queued' })));
  learn.learn(save(tasks));
  const r = routing.routeTask({ title: 'I need to order food for this week' });
  assert.strictEqual(r.lane, 'local');
  assert.match(r.reason, /groceries goes best on the local model/);
  assert.match(routing.routeInfo({ title: 'order food' }, 'local').note, /^groceries: local model \d+% \(from 3\)$/);
});

test('an old "ask me" default still sends every task somewhere', () => {
  fresh();
  routing.useRouting({ v: 2, rules: [], default: 'ask' });
  assert.ok(['claude', 'local'].includes(routing.routeTask({ title: 'something nobody has a rule for' }).lane));
});

test('stats survive a restart', () => {
  const dir = fresh();
  learn.learn(save([{ id: 'z', ws: 'agent', title: 'buy socks', routedLane: 'claude', lane: 'claude', done: true }]));
  learn.init(dir); // reload from disk
  assert.strictEqual(learn.chance('shopping', 'claude').n, 1);
});
