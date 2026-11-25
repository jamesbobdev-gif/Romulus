const test = require('node:test');
const assert = require('node:assert');
const { schoolDeadline, pastSaving, schoolExpired, schoolExpiredIds } = require('../renderer/js/school-overdue');

// November 2026: the 2nd is a Monday
const at = (d, h = 9, mi = 0) => new Date(2026, 10, d, h, mi);
const task = (o) => Object.assign({ id: 'ics-1', ws: 'school', done: false, due: '2026-11-02', dueTime: null }, o);

test('the deadline is the end of the due day, or its time; what the feed said wins', () => {
  assert.deepStrictEqual(schoolDeadline(task()), at(2, 23, 59));
  assert.deepStrictEqual(schoolDeadline(task({ dueTime: '10:00' })), at(2, 10));
  assert.deepStrictEqual(schoolDeadline(task({ due: '2026-11-05', dueTime: '08:00' }), '2026-11-02 '), at(2, 23, 59));
  assert.deepStrictEqual(schoolDeadline(task({ due: '2026-11-05' }), '2026-11-02 23:30'), at(2, 23, 30));
  assert.deepStrictEqual(schoolDeadline(null, '2026-11-02 23:30'), at(2, 23, 30));
  assert.strictEqual(schoolDeadline(task({ due: null })), null);
  assert.strictEqual(pastSaving(null, at(9)), false);
});

test('due Monday: still there Tuesday and Wednesday, gone from Thursday', () => {
  assert.strictEqual(schoolExpired(task(), at(3)), false);
  assert.strictEqual(schoolExpired(task(), at(4, 23, 58)), false);
  assert.strictEqual(schoolExpired(task(), at(5, 0, 1)), true);
  assert.strictEqual(schoolExpired(task(), at(20)), true);
});

test('a timed deadline counts from its time', () => {
  const t = task({ dueTime: '10:00' });
  assert.strictEqual(schoolExpired(t, at(4, 9, 59)), false);
  assert.strictEqual(schoolExpired(t, at(4, 10, 1)), true);
});

test('snoozed to today: the day the school set still counts; one added by hand counts from its own date', () => {
  const t = task({ due: '2026-11-05' });
  assert.strictEqual(schoolExpired(t, at(5), '2026-11-02 '), true);
  assert.strictEqual(schoolExpired(t, at(5), '2026-11-02 23:30'), true);
  assert.strictEqual(schoolExpired(t, at(5)), false);
});

test('a deadline the school moved later is the one that counts', () => {
  assert.strictEqual(schoolExpired(task(), at(5), '2026-11-09 '), false);
});

test('done, undated, repeating and other lists\' tasks stay', () => {
  assert.strictEqual(schoolExpired(task({ done: true }), at(20)), false);
  assert.strictEqual(schoolExpired(task({ due: null }), at(20)), false);
  assert.strictEqual(schoolExpired(task({ recur: { every: 'week' } }), at(20)), false);
  assert.strictEqual(schoolExpired(task({ ws: 'personal' }), at(20)), false);
  assert.strictEqual(schoolExpired(task({ ws: 'agent', fromWs: 'school' }), at(20)), false);
  assert.strictEqual(schoolExpired(null, at(20)), false);
});

test('the ids to take off, with what the feed said per id', () => {
  const tasks = [task({ id: 'ics-a' }), task({ id: 'ics-b', due: '2026-11-05' }), task({ id: 'h1', due: '2026-11-04' }), task({ id: 'h2', due: '2026-11-01' })];
  assert.deepStrictEqual(schoolExpiredIds(tasks, at(5), { 'ics-b': '2026-11-02 ' }), ['ics-a', 'ics-b', 'h2']);
  assert.deepStrictEqual(schoolExpiredIds(tasks, at(5)), ['ics-a', 'h2']);
  assert.deepStrictEqual(schoolExpiredIds([], at(5)), []);
});

test('on the page: the sweep takes expired assignments off, tombstoned, and their calendar events with them', () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const deleted = [];
  const ctx = {
    localStorage: { getItem: () => JSON.stringify({ 'ics-b': '2020-01-06 ' }) }, // the feed's word on ics-b: long gone
    setInterval() {}, touch() {},
    state: { tasks: [
      { id: 'ics-a', ws: 'school', due: '2020-01-06', dueTime: null, googleEventId: 'ev1', calRef: 'acct|cal' },
      { id: 'ics-b', ws: 'school', due: '2099-01-06', dueTime: null }, // snoozed far ahead
      { id: 'h1', ws: 'school', due: '2099-01-06', dueTime: null },
      { id: 'd', ws: 'school', due: '2020-01-06', dueTime: null, done: true },
      { id: 'p', ws: 'personal', due: '2020-01-06', dueTime: null },
    ], tombstones: [], expanded: new Set(['ics-a', 'h1']) },
  };
  ctx.window = ctx; // the page: window is the global object
  ctx.desktop = { gcalDeleteEvent: (id, ref) => deleted.push(id + '@' + ref) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/school-overdue.js'), 'utf8'), ctx);
  assert.strictEqual(ctx.sweepSchool(), 2);
  assert.deepStrictEqual(ctx.state.tasks.map((t) => t.id), ['h1', 'd', 'p']);
  assert.deepStrictEqual(ctx.state.tombstones.map((x) => x.id), ['ics-a', 'ics-b']);
  assert.ok(ctx.state.tombstones.every((x) => Math.abs(x.deletedAt - Date.now()) < 5000));
  assert.deepStrictEqual(deleted, ['ev1@acct|cal']);
  assert.deepStrictEqual([...ctx.state.expanded], ['h1']);
  assert.strictEqual(ctx.sweepSchool(), 0); // nothing left to take off
});
