const test = require('node:test');
const assert = require('node:assert');
const { costKey, costGuess, costsOf } = require('../renderer/js/finance-costs');

const NOW = new Date(2026, 9, 18, 12).getTime();
const on = (y, m, d) => Math.floor(new Date(y, m, d, 12).getTime() / 1000);
let n = 0;
const tx = (desc, amount, posted, extra) => Object.assign({ id: 't' + (n++), description: desc, amount, posted }, extra || {});

test('one payee, whatever number the bank adds', () => {
  assert.strictEqual(costKey({ description: 'NETFLIX.COM 866-579 CA' }), costKey({ description: 'NETFLIX.COM 123' }));
});

test('a bill that comes back every month for about the same is fixed', () => {
  const g = [tx('Comcast Cable', -80, on(2026, 8, 3)), tx('Comcast Cable', -82, on(2026, 9, 3))];
  assert.strictEqual(costGuess('x', [tx('Joe gym', -30, on(2026, 8, 1)), tx('Joe gym', -30, on(2026, 9, 1))]), 'fixed');
  assert.strictEqual(costGuess('x', g), 'fixed');
  assert.strictEqual(costGuess('x', [tx('Corner Deli', -8, on(2026, 8, 1)), tx('Corner Deli', -15, on(2026, 9, 1))]), 'variable');
  assert.strictEqual(costGuess('x', [tx('Corner Deli', -8, on(2026, 9, 1)), tx('Corner Deli', -8, on(2026, 9, 5)), tx('Corner Deli', -8, on(2026, 8, 5)), tx('Corner Deli', -8, on(2026, 8, 9))]), 'variable', 'several times a month');
  assert.strictEqual(costGuess('x', [tx('Netflix', -15.49, on(2026, 9, 1))]), 'fixed', 'a known bill, first time seen');
  assert.strictEqual(costGuess('x', [tx('Payment Thank You - Web', -300, on(2026, 9, 1))]), 'skip');
});

test('the charts: monthly bills, and the rest month by month', () => {
  const txs = [
    tx('Netflix', -15.49, on(2026, 8, 2)), tx('Netflix', -15.49, on(2026, 9, 2)),
    tx('Rent Co Property', -1200, on(2026, 8, 1)), tx('Rent Co Property', -1200, on(2026, 9, 1)),
    tx('Old Gym', -40, on(2026, 4, 1)), tx('Old Gym', -40, on(2026, 5, 1)), // stopped in June
    tx('Corner Deli', -12, on(2026, 8, 20)), tx('Shell Oil', -40, on(2026, 9, 5)),
    tx('Paycheck', 2000, on(2026, 9, 1)), tx('Transfer to Savings', -500, on(2026, 9, 2)),
    tx('Pending deli', -5, 0, { pending: true }),
  ];
  const c = costsOf(txs, {}, NOW);
  assert.deepStrictEqual(c.fixed.map((f) => f.monthly), [1200, 15.49]);
  assert.strictEqual(Math.round(c.fixedTotal * 100), 121549);
  assert.strictEqual(c.months.length, 6);
  assert.deepStrictEqual(c.months.slice(-2).map((m) => m.total), [12, 40]);
  assert.strictEqual(c.months[5].partial, true);
  assert.strictEqual(c.kindOf(txs[8]), null, 'money in');
  assert.strictEqual(c.kindOf(txs[9]), 'skip');
});

test('his correction wins', () => {
  const txs = [tx('Shell Oil', -40, on(2026, 9, 5)), tx('Netflix', -15.49, on(2026, 9, 2))];
  const c = costsOf(txs, { 'shell oil': 'fixed', netflix: 'variable' }, NOW);
  assert.deepStrictEqual(c.fixed.map((f) => f.name), ['Shell Oil']);
  assert.strictEqual(c.months[5].total, 15.49);
});
