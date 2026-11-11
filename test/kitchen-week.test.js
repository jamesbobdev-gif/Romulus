const test = require('node:test');
const assert = require('node:assert');
const { kWeekCookDay, kWeekDays, kWeekSayTotal } = require('../renderer/js/kitchen-week');

test('the cook is on the coming Sunday, or today when it is Sunday', () => {
  assert.strictEqual(kWeekCookDay(new Date(2026, 10, 10, 9)).getDate(), 15); // Tue Nov 10 → Sun Nov 15
  assert.strictEqual(kWeekCookDay(new Date(2026, 10, 15, 20)).getDate(), 15); // a Sunday stays
  assert.strictEqual(kWeekCookDay(new Date(2026, 10, 15)).getDay(), 0);
});

test('it covers Monday to Sunday after the cook', () => {
  const d = kWeekDays(kWeekCookDay(new Date(2026, 10, 10)));
  assert.deepStrictEqual(d.map((x) => x.label), ['Mon Nov 16', 'Tue Nov 17', 'Wed Nov 18', 'Thu Nov 19', 'Fri Nov 20', 'Sat Nov 21', 'Sun Nov 22']);
});

test('a day against the plan', () => {
  assert.strictEqual(kWeekSayTotal({ kcal: 1850, protein: 140 }, { kcal: 2100, protein: 160, fat: 70 }), '1,850 kcal of 2,100 · 140 g protein of 160');
  assert.strictEqual(kWeekSayTotal({ protein: 40 }, null), '40 g protein');
  assert.strictEqual(kWeekSayTotal({}, null), '');
});
