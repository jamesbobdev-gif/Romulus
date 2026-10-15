const test = require('node:test');
const assert = require('node:assert');
const { nextRecurDue, recurCopyId } = require('../renderer/js/recur');

test('ticked off on the day: the next one is one step on', () => {
  assert.strictEqual(nextRecurDue({ every: 'day' }, '2026-10-15', '2026-10-15'), '2026-10-16');
  assert.strictEqual(nextRecurDue({ every: 'week' }, '2026-10-15', '2026-10-15'), '2026-10-22');
  assert.strictEqual(nextRecurDue({ every: '2week' }, '2026-10-15', '2026-10-15'), '2026-10-29');
  assert.strictEqual(nextRecurDue({ every: 'year' }, '2026-10-15', '2026-10-15'), '2027-10-15');
});

test('ticked off early: counts from the due date, not today', () => {
  assert.strictEqual(nextRecurDue({ every: 'week' }, '2026-10-17', '2026-10-15'), '2026-10-24');
});

test('ticked off late: skips the dates already past, so it is never overdue on arrival', () => {
  assert.strictEqual(nextRecurDue({ every: 'day' }, '2026-10-01', '2026-10-15'), '2026-10-16');
  assert.strictEqual(nextRecurDue({ every: 'week' }, '2026-10-05', '2026-10-15'), '2026-10-19'); // stays on Mondays
});

test('weekdays skip the weekend', () => {
  assert.strictEqual(nextRecurDue({ every: 'weekday' }, '2026-10-16', '2026-10-16'), '2026-10-19'); // Fri → Mon
  assert.strictEqual(nextRecurDue({ every: 'weekday' }, '2026-10-17', '2026-10-17'), '2026-10-19'); // Sat → Mon
});

test('monthly keeps its day, using the last day of short months', () => {
  const r = { every: 'month', dom: 31 };
  assert.strictEqual(nextRecurDue(r, '2027-01-31', '2027-01-31'), '2027-02-28');
  assert.strictEqual(nextRecurDue(r, '2027-02-28', '2027-02-28'), '2027-03-31');
  assert.strictEqual(nextRecurDue({ every: 'month' }, '2026-10-15', '2026-10-15'), '2026-11-15');
  assert.strictEqual(nextRecurDue({ every: 'month', dom: 15 }, '2026-12-15', '2026-12-15'), '2027-01-15');
  assert.strictEqual(nextRecurDue({ every: 'year', dom: 29 }, '2028-02-29', '2028-02-29'), '2029-02-28');
});

test('undated counts from today; an unknown rule gives nothing', () => {
  assert.strictEqual(nextRecurDue({ every: 'day' }, null, '2026-10-15'), '2026-10-16');
  assert.strictEqual(nextRecurDue({ every: 'hourly' }, '2026-10-15', '2026-10-15'), null);
  assert.strictEqual(nextRecurDue(null, '2026-10-15', '2026-10-15'), null);
});

test('the copy id is the same on every device', () => {
  assert.strictEqual(recurCopyId({ every: 'day', series: 'abc' }, 'xyz', '2026-10-16'), 'r-abc-2026-10-16');
  assert.strictEqual(recurCopyId({ every: 'day' }, 'xyz', '2026-10-16'), 'r-xyz-2026-10-16');
});
