const test = require('node:test');
const assert = require('node:assert');
const { findSameAsk, sameAsk, sameWhen } = require('../renderer/js/same-ask');

const NOW = new Date(2026, 10, 8, 12, 0).getTime(); // Sunday 8 Nov 2026, noon
const DAY = 864e5;
const task = (o) => Object.assign({ id: 'x', done: false, due: null, ws: 'agent', created: NOW - DAY }, o);

test('the same ask in other words', () => {
  assert.ok(sameAsk('can i get groceries', 'Get groceries'));
  assert.ok(sameAsk('Order my groceries please', 'groceries'));
  assert.ok(sameAsk('Can you find flights to Denver?', 'Find flights to Denver'));
  assert.ok(sameAsk('#legion best laptop for school', 'best laptop for school'));
  assert.ok(sameAsk('get groceries for this week', 'Get groceries this weekend'));
});

test('different asks stay apart', () => {
  assert.ok(!sameAsk('can i get groceries', 'Cancel the grocery order delivery tomorrow window'));
  assert.ok(!sameAsk('Find flights to Denver', 'Find flights to Chicago'));
  assert.ok(!sameAsk('Call mom', 'Call the dentist'));
  assert.ok(!sameAsk('do it', 'Get groceries'), 'nothing left to compare');
});

test('an open one from this week is offered', () => {
  const old = task({ id: 'g', title: 'Get groceries', created: NOW - 3 * DAY });
  assert.strictEqual(findSameAsk([old], { title: 'can i get groceries', ws: 'agent', now: NOW }), old);
});

test('older than a week, or on another tab: a new one', () => {
  assert.strictEqual(findSameAsk([task({ title: 'Get groceries', created: NOW - 8 * DAY })], { title: 'get groceries', ws: 'agent', now: NOW }), null);
  assert.strictEqual(findSameAsk([task({ title: 'Get groceries', ws: 'personal' })], { title: 'get groceries', ws: 'agent', now: NOW }), null);
});

test('a done one counts for two days after it was done', () => {
  const recent = task({ title: 'Get groceries', done: true, doneAt: NOW - DAY, created: NOW - 5 * DAY });
  assert.strictEqual(findSameAsk([recent], { title: 'get groceries', ws: 'agent', now: NOW }), recent);
  const old = task({ title: 'Get groceries', done: true, doneAt: NOW - 3 * DAY });
  assert.strictEqual(findSameAsk([old], { title: 'get groceries', ws: 'agent', now: NOW }), null);
});

test('dates far apart are different ones', () => {
  const rent = task({ title: 'Pay rent', ws: 'personal', due: '2026-11-01' });
  assert.strictEqual(findSameAsk([rent], { title: 'pay rent', ws: 'personal', due: '2026-12-01', now: NOW }), null);
  assert.strictEqual(findSameAsk([rent], { title: 'pay rent', ws: 'personal', due: '2026-11-03', now: NOW }), rent);
});

test('the open one wins over a done one', () => {
  const done = task({ id: 'd', title: 'Get groceries', done: true, doneAt: NOW - 1000, created: NOW - 1000 });
  const open = task({ id: 'o', title: 'groceries', created: NOW - 2 * DAY });
  assert.strictEqual(findSameAsk([done, open], { title: 'can i get groceries', ws: 'agent', now: NOW }).id, 'o');
});

test('when it was asked, in words', () => {
  assert.strictEqual(sameWhen(NOW - 3600e3, NOW), 'earlier today');
  assert.strictEqual(sameWhen(NOW - DAY, NOW), 'yesterday');
  assert.match(sameWhen(NOW - 3 * DAY, NOW), /^on \w+/);
});
