const test = require('node:test');
const assert = require('node:assert');
const { billsOf, billTitle } = require('../renderer/js/finance-bills');

const on = (y, m, d) => Math.floor(new Date(y, m, d, 12).getTime() / 1000);
const at = (y, m, d) => new Date(y, m, d, 12).getTime();
let n = 0;
const tx = (desc, amount, posted) => ({ id: 't' + (n++), description: desc, amount, posted });
// a card paid on the 28th: Aug and Sep paid, and interest charged in Sep
const card = (extra) => ({ id: 'c1', org: 'Chase', name: 'Freedom', balance: -640, transactions: [
  tx('Payment Thank You', 200, on(2026, 7, 27)), tx('Payment Thank You', 150, on(2026, 8, 28)),
  tx('INTEREST CHARGE ON PURCHASES', -11.2, on(2026, 8, 25)), tx('Target', -40, on(2026, 9, 3))].concat(extra || []) });

test('a card: due on the day he usually pays it, interest when it charged some', () => {
  const [b] = billsOf([card()], {}, at(2026, 9, 20));
  assert.deepStrictEqual([b.name, b.due, b.paidThrough, b.interest, b.kind], ['Chase Freedom', '2026-10-28', '2026-09-28', true, 'card']);
  assert.strictEqual(billTitle(b), 'Pay Chase Freedom — accrues interest');
});

test('paid this month: next month is the one due', () => {
  const [b] = billsOf([card([tx('Payment Thank You', 300, on(2026, 9, 22))])], {}, at(2026, 9, 25));
  assert.deepStrictEqual([b.due, b.paidThrough], ['2026-11-28', '2026-10-28']);
});

test('a pending payment counts as paid', () => {
  const [b] = billsOf([card([{ id: 'p', description: 'Payment', amount: 300, posted: 0, pending: true }])], {}, Date.now());
  assert.ok(b.due > new Date().toISOString().slice(0, 10));
});

test('not paid by the due day: still that one, overdue', () => {
  const [b] = billsOf([card()], {}, at(2026, 9, 30));
  assert.strictEqual(b.due, '2026-10-28');
});

test('no interest charged lately: just a bill; nothing owed: no bill', () => {
  const quiet = { id: 'c2', org: 'Citi', name: 'Citi Double Cash', balance: -90, transactions: [tx('Payment', 50, on(2026, 8, 10))] };
  const [b] = billsOf([quiet], {}, at(2026, 9, 1));
  assert.deepStrictEqual([b.name, b.interest, b.due], ['Citi Double Cash', false, '2026-10-10']);
  assert.deepStrictEqual(billsOf([Object.assign({}, quiet, { balance: 0 })], {}, at(2026, 9, 1)), []);
});

test('a loan always accrues interest', () => {
  const loan = { id: 'l1', org: 'Nelnet', name: 'Student Loan', balance: -12000, transactions: [tx('Payment', 180, on(2026, 8, 15))] };
  const [b] = billsOf([loan], {}, at(2026, 9, 1));
  assert.deepStrictEqual([b.kind, b.interest], ['loan', true]);
});

test('monthly bills from checking, not the subscriptions that charge themselves', () => {
  const checking = { id: 'k', name: 'Checking', balance: 900, transactions: [
    tx('GEICO AUTO 800-123', -120, on(2026, 7, 5)), tx('GEICO AUTO 800-123', -120, on(2026, 8, 5)), tx('GEICO AUTO 800-123', -120, on(2026, 9, 5)),
    tx('NETFLIX.COM 866', -15.49, on(2026, 8, 9)), tx('NETFLIX.COM 866', -15.49, on(2026, 9, 9))] };
  const bills = billsOf([checking], {}, at(2026, 9, 20));
  assert.deepStrictEqual(bills.map((b) => [b.name, b.due, b.interest]), [['Geico Auto', '2026-11-05', false]]);
});

test('only names, dates and the flag come out: never amounts', () => {
  const [b] = billsOf([card()], {}, at(2026, 9, 20));
  assert.deepStrictEqual(Object.keys(b).sort(), ['day', 'due', 'interest', 'key', 'kind', 'name', 'paidThrough']);
});
