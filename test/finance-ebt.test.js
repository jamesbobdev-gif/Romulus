const test = require('node:test');
const assert = require('node:assert');
const { ebtWallet, ebtClean } = require('../renderer/js/finance-ebt');
const { orderEbtFrom, agentOrders } = require('../renderer/js/order-match');

const at = (m, d, h) => new Date(2026, m, d, h || 12).getTime();
const NOW = at(10, 6, 15); // Nov 6

test('the EBT part of an Agent order note', () => {
  assert.deepStrictEqual(orderEbtFrom('Placed. Total $80.10 ($60.00 EBT, $20.10 Visa). EBT balance $143.20'), { ebt: 60, left: 83.2 });
  assert.deepStrictEqual(orderEbtFrom('Total $54.21, all on EBT: $54.21. EBT left: $12.00'), { ebt: 54.21, left: 12 });
  assert.deepStrictEqual(orderEbtFrom('EBT pays $41.50, fees $7.99 on Visa. $100.50 left on EBT.'), { ebt: 41.5, left: 100.5 });
  assert.deepStrictEqual(orderEbtFrom('Milk $3.98 EBT eligible, total $3.98'), {});
  assert.deepStrictEqual(orderEbtFrom('Placed it.'), {});
});

test('orders keep their EBT part through agentOrders', () => {
  const o = agentOrders([{ id: 't1', ws: 'agent', title: 'Groceries', orders: [{ at: at(10, 2), items: [{ name: 'Eggs' }], ebt: 30, ebtLeft: 70 }] }]);
  assert.strictEqual(o[0].ebt, 30);
  assert.strictEqual(o[0].ebtLeft, 70);
});

test('nothing set up: no balance, no deposit day', () => {
  const w = ebtWallet({}, [], NOW);
  assert.strictEqual(w.known, false);
  assert.strictEqual(w.nextDeposit, null);
});

test('a typed balance, minus orders after it, plus deposits since', () => {
  const ebt = { balance: 50, at: at(9, 28), day: 3, monthly: 291 };
  const orders = [
    { title: 'Before', at: at(9, 20), ebt: 99 }, // before the typed balance: already counted in it
    { title: 'Walmart', at: at(10, 4), ebt: 60 },
  ];
  const w = ebtWallet(ebt, orders, NOW);
  assert.strictEqual(w.known, true);
  assert.strictEqual(w.from, 'typed');
  assert.strictEqual(w.balance, 50 + 291 - 60);
  assert.strictEqual(w.deposits, 1);
  assert.deepStrictEqual(w.spent.map((x) => x.title), ['Walmart']); // since Nov 3
  assert.strictEqual(new Date(w.nextDeposit).getDate(), 3);
  assert.strictEqual(new Date(w.nextDeposit).getMonth(), 11);
  assert.strictEqual(w.daysToDeposit, 27);
});

test('a newer balance seen at checkout wins over the typed one', () => {
  const w = ebtWallet({ balance: 200, at: at(10, 1) }, [
    { title: 'Walmart', at: at(10, 4), ebt: 60, ebtLeft: 140 },
    { title: 'Instacart', at: at(10, 5), ebt: 25 },
  ], NOW);
  assert.strictEqual(w.from, 'checkout');
  assert.strictEqual(w.balance, 115);
});

test('a deposit day past the end of the month lands on its last day', () => {
  const w = ebtWallet({ day: 31 }, [], at(10, 6));
  assert.strictEqual(new Date(w.nextDeposit).getDate(), 30); // Nov 30
});

test('what he types is cleaned', () => {
  assert.deepStrictEqual(ebtClean({ balance: '12.345', at: 5, day: 40, monthly: -3, pin: '1234' }), { balance: 12.35, at: 5 });
  assert.deepStrictEqual(ebtClean(null), {});
});
