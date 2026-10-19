const test = require('node:test');
const assert = require('node:assert');
const { worthOf } = require('../renderer/js/finance-worth');

const NOW = new Date(2026, 9, 18, 15).getTime();
const on = (m, d) => Math.floor(new Date(2026, m, d, 12).getTime() / 1000);

test('assets, debts and net worth from today’s balances', () => {
  const w = worthOf([
    { name: 'Checking', balance: 1500, transactions: [] },
    { name: 'Savings', balance: 4000, transactions: [] },
    { name: 'Visa', balance: -600, transactions: [] },
  ], NOW);
  assert.deepStrictEqual([w.assetTotal, w.debtTotal, w.net], [5500, 600, 4900]);
  assert.deepStrictEqual(w.assets.map((a) => a.name), ['Savings', 'Checking']);
  assert.strictEqual(w.days.length, 1);
});

test('past days are worked out backwards from the transactions', () => {
  const w = worthOf([
    { name: 'Checking', balance: 1000, transactions: [{ posted: on(9, 15), amount: 2000 }, { posted: on(9, 16), amount: -500 }, { posted: 0, amount: -50, pending: true }] },
    { name: 'Visa', balance: -300, transactions: [{ posted: on(9, 17), amount: -300 }] },
  ], NOW);
  assert.strictEqual(w.days.length, 4); // Oct 15 to today
  const byDay = w.days.map((d) => [new Date(d.at).getDate(), d.assets, d.debts]);
  assert.deepStrictEqual(byDay, [[15, 1500, 0], [16, 1000, 0], [17, 1000, 300], [18, 1000, 300]]);
});

test('an overdrawn account counts as a debt only while it’s under zero', () => {
  const w = worthOf([{ name: 'Checking', balance: 200, transactions: [{ posted: on(9, 16), amount: -10 }, { posted: on(9, 17), amount: 300 }] }], NOW);
  assert.deepStrictEqual(w.days.map((d) => [d.assets, d.debts]), [[0, 100], [200, 0], [200, 0]]);
});
