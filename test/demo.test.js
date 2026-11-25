const test = require('node:test');
const assert = require('node:assert');
const { demoTasks, isDemoTask } = require('../renderer/js/demo');
const { healthGoal } = require('../renderer/js/health');
const { recurStreakText } = require('../renderer/js/recur');

test('the examples are ordinary to-dos dated from today, each found again by its id', () => {
  const now = new Date(2026, 10, 30, 15).getTime();
  const list = demoTasks(now);
  assert.ok(list.length >= 5);
  assert.ok(list.every(isDemoTask));
  assert.ok(list.every((t) => t.ws === 'personal')); // never an Agent task: nothing runs because of them
  assert.strictEqual(new Set(list.map((t) => t.id)).size, list.length);
  assert.deepStrictEqual(demoTasks(now).map((t) => t.id), list.map((t) => t.id)); // asked for twice: the same ones
  assert.strictEqual(list[0].due, '2026-11-30');
  assert.strictEqual(list.find((t) => t.dueTime).due, '2026-12-01'); // tomorrow, across the month's end
  assert.strictEqual(recurStreakText(list.find((t) => t.recur).recur), '4 in a row');
  assert.ok(list.some((t) => t.subs.length && t.subs.some((s) => s.done)));
  assert.ok(list.some((t) => healthGoal(t.title))); // one shows a goal that ticks itself
  assert.ok(list.some((t) => t.done));
  assert.strictEqual(isDemoTask({ id: 'r-demo-3-2026-12-01' }), true); // the repeating example's next copy goes with them
  assert.strictEqual(isDemoTask({ id: 'r-abc-2026-12-01' }), false);
  assert.strictEqual(isDemoTask(null), false);
});
