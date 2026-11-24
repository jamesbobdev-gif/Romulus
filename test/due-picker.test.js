// The add box's Date button: its quick picks and what the button says (renderer/js/due-picker.js)
const test = require('node:test');
const assert = require('node:assert');
const { duePickDays, duePickLabel } = require('../renderer/js/due-picker.js');

const keys = (now) => Object.fromEntries(duePickDays(now).map((d) => [d.name, d.key]));

test('quick picks on a Thursday', () => {
  const k = keys(new Date(2026, 10, 19, 15, 0)); // Thu Nov 19
  assert.deepStrictEqual(k, { 'Today': '2026-11-19', 'Tomorrow': '2026-11-20', 'This weekend': '2026-11-21', 'Next week': '2026-11-23' });
});

test('on a Saturday the weekend pick is the next one, and on a Monday next week is the next Monday', () => {
  assert.strictEqual(keys(new Date(2026, 10, 21))['Next weekend'], '2026-11-28');
  assert.strictEqual(keys(new Date(2026, 10, 23))['Next week'], '2026-11-30');
  assert.strictEqual(keys(new Date(2026, 10, 22))['Next weekend'], '2026-11-28'); // Sunday
});

test('quick picks cross a month end', () => {
  assert.strictEqual(keys(new Date(2026, 10, 30))['Tomorrow'], '2026-12-01');
});

test('button text', () => {
  const now = new Date(2026, 10, 19, 9, 0);
  assert.strictEqual(duePickLabel('2026-11-19', now), 'Today');
  assert.strictEqual(duePickLabel('2026-11-20', now), 'Tomorrow');
  assert.strictEqual(duePickLabel('2026-11-21', now), 'Sat');
  assert.match(duePickLabel('2026-11-28', now), /Sat.*Nov.*28/);
  assert.match(duePickLabel('2026-11-17', now), /Tue.*Nov.*17/);
});
