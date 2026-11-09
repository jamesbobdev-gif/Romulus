const test = require('node:test');
const assert = require('node:assert');
const { parseHours, fmtHours, hAddDays, hWeekStart, hWeekLabel } = require('../renderer/js/hours');
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects made inside the page's vm context have their own Object.prototype

test('typed hours: a decimal, a clock time, h and m words; anything else is not a time', () => {
  assert.strictEqual(parseHours('2.5'), 2.5);
  assert.strictEqual(parseHours('2:30'), 2.5);
  assert.strictEqual(parseHours('2h 30m'), 2.5);
  assert.strictEqual(parseHours('90m'), 1.5);
  assert.strictEqual(parseHours('1h'), 1);
  assert.strictEqual(parseHours(' 3 '), 3);
  assert.strictEqual(parseHours('.5'), 0.5);
  assert.strictEqual(parseHours('abc'), null);
  assert.strictEqual(parseHours(''), null);
});

test('hours read as 2h 30m, 2h, 30m', () => {
  assert.strictEqual(fmtHours(2.5), '2h 30m');
  assert.strictEqual(fmtHours(2), '2h');
  assert.strictEqual(fmtHours(0.5), '30m');
  assert.strictEqual(fmtHours(0), '0m');
  assert.strictEqual(fmtHours(1.999), '2h');
});

test('weeks start on Monday', () => {
  assert.strictEqual(hWeekStart('2026-11-04'), '2026-11-02'); // a Wednesday
  assert.strictEqual(hWeekStart('2026-11-02'), '2026-11-02'); // the Monday itself
  assert.strictEqual(hWeekStart('2026-11-08'), '2026-11-02'); // Sunday closes the week
  assert.strictEqual(hAddDays('2026-11-02', 7), '2026-11-09');
  assert.strictEqual(hAddDays('2026-01-01', -1), '2025-12-31');
});

test('the week label, seen from Wednesday Nov 4 2026', () => {
  const today = '2026-11-04';
  assert.strictEqual(hWeekLabel('2026-11-02', today), 'This week');
  assert.strictEqual(hWeekLabel('2026-10-26', today), 'Last week');
  assert.strictEqual(hWeekLabel('2026-11-09', today), 'Next week');
  assert.strictEqual(hWeekLabel('2026-10-19', today), 'Oct 19 – 25');
  assert.strictEqual(hWeekLabel('2026-09-28', today), 'Sep 28 – Oct 4');
  assert.strictEqual(hWeekLabel('2025-12-29', today), 'Dec 29 – Jan 4');
  assert.strictEqual(hWeekLabel('2025-12-22', today), 'Dec 22 – 28, 2025');
});

// the page's own scope: hours.js with the globals it leans on (core.js state and persist, sync.js stableJson)
function page() {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const ctx = { state: { hours: { entries: [], tombstones: [] }, tasks: [] }, persist() { ctx.saves++; }, saves: 0, stableJson: (v) => JSON.stringify(v) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/hours.js'), 'utf8'), ctx);
  return ctx;
}

test('on the page: turning hours in stamps what is pending through a day; undo takes the stamp back', () => {
  const ctx = page();
  ctx.state.hours = ctx.normHours({ entries: [
    { id: 'a', date: '2026-11-02', kind: 'work', hours: 4 },
    { id: 'b', date: '2026-11-03', kind: 'work', hours: 3, note: 'Front desk' },
    { id: 'c', date: '2026-11-04', kind: 'work', hours: 2 },
    { id: 'd', date: '2026-11-03', kind: 'school', hours: 1.5 },
    { id: 'x', date: 'nope', kind: 'work', hours: 1 }, // not a day: dropped
    { id: 'y', date: '2026-11-03', kind: 'work', hours: 'lots' }, // not a number: dropped
  ] });
  assert.deepStrictEqual(ctx.state.hours.entries.map((e) => e.id), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(plain(ctx.hoursSum('2026-11-02', '2026-11-08')), { school: 1.5, work: 9 });
  assert.strictEqual(ctx.hoursPending('work').length, 3);
  ctx.hoursTurnIn('work', '2026-11-03'); // the sheet he sent covered Monday and Tuesday
  assert.deepStrictEqual(ctx.hoursPending('work').map((e) => e.id), ['c']);
  assert.strictEqual(ctx.hoursPending('school').length, 1); // school hours are turned in on their own
  const stamp = ctx.hoursLastTurnIn('work');
  assert.ok(Math.abs(stamp - Date.now()) < 5000);
  ctx.hoursUndoTurnIn('work');
  assert.strictEqual(ctx.hoursPending('work').length, 3);
  assert.strictEqual(ctx.hoursLastTurnIn('work'), 0);
  ctx.hoursTurnIn('work'); // no day given: everything pending
  assert.strictEqual(ctx.hoursPending('work').length, 0);
  assert.strictEqual(ctx.saves, 3);
});

test('on the page: merging the synced copy, the newer entry wins and a tombstone beats older copies', () => {
  const ctx = page(), t = Date.now();
  ctx.state.hours = ctx.normHours({ entries: [
    { id: 'a', date: '2026-11-02', kind: 'work', hours: 4, updatedAt: t - 2000 },
    { id: 'b', date: '2026-11-03', kind: 'school', hours: 1, updatedAt: t - 2000 },
  ] });
  const r = ctx.mergeHours({ entries: [
    { id: 'a', date: '2026-11-02', kind: 'work', hours: 5, updatedAt: t - 1000 },
    { id: 'c', date: '2026-11-04', kind: 'work', hours: 2, updatedAt: t - 1000 },
  ], tombstones: [{ id: 'b', deletedAt: t - 1500 }] });
  assert.strictEqual(r.changedLocal, true);
  assert.strictEqual(r.changedRemote, false);
  const by = {}; ctx.state.hours.entries.forEach((e) => { by[e.id] = e; });
  assert.strictEqual(by.a.hours, 5);
  assert.strictEqual(by.b, undefined);
  assert.strictEqual(by.c.hours, 2);
  assert.deepStrictEqual(plain(ctx.state.hours.tombstones), [{ id: 'b', deletedAt: t - 1500 }]);
});
