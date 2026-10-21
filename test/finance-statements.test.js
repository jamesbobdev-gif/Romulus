const test = require('node:test');
const assert = require('node:assert');
const { incomeStatement, balanceSheet } = require('../renderer/js/finance-statements');

const NOW = new Date(2026, 9, 18, 12).getTime();
const on = (m, d) => Math.floor(new Date(2026, m, d, 12).getTime() / 1000);
let n = 0;
const tx = (desc, amount, posted) => ({ id: 't' + n++, description: desc, amount, posted });

const checking = { id: 'c', name: 'Checking', org: 'Chase', balance: 2000, transactions: [
  tx('ACME PAYROLL DIRECT DEP', 3000, on(8, 1)), tx('ACME PAYROLL DIRECT DEP', 3000, on(9, 1)),
  tx('Rent Co Property', -1200, on(8, 2)), tx('Rent Co Property', -1200, on(9, 2)),
  tx('Netflix.com', -15.49, on(8, 5)), tx('Netflix.com', -15.49, on(9, 5)),
  tx('Corner Deli', -40, on(8, 10)), tx('Shell Oil 123', -60, on(9, 9)),
  tx('Amazon refund', 25, on(8, 12)), tx('Interest paid', 1.5, on(8, 30)),
  tx('Transfer from Savings', 500, on(8, 15)), tx('Payment Thank You - Web', -300, on(8, 20)),
] };
const visa = { id: 'v', name: 'Visa', org: 'Chase', balance: -640, transactions: [tx('Payment Thank You', 300, on(8, 20)), tx('Shell Oil 123', -80, on(9, 12))] };
const broker = { id: 'b', name: 'Individual', org: 'Fidelity', balance: 9000, holdings: [{ symbol: 'VOO' }], transactions: [] };

test('income statement: pay, interest, refunds against spending, transfers left out', () => {
  const s = incomeStatement([checking, visa], {}, NOW);
  assert.deepStrictEqual(s.cols.map((c) => c.partial), [false, false, false, true]);
  const sep = 2; // Jul, Aug, Sep, Oct so far
  assert.deepStrictEqual(s.income.map((r) => [r.name, r.vals[sep]]), [['Pay', 3000], ['Interest and dividends', 1.5]]);
  assert.strictEqual(s.fixedTotal[sep], 1215.49);
  assert.strictEqual(s.variableTotal[sep], 15, 'deli 40 minus the 25 refund');
  assert.strictEqual(Math.round(s.net[sep] * 100) / 100, 3001.5 - 1230.49);
  assert.strictEqual(s.incomeTotal[3], 3000);
  assert.strictEqual(s.variableTotal[3], 140, 'both Shell charges, on the card too');
  assert.ok(s.savingsRate[sep] > 0.58 && s.savingsRate[sep] < 0.6);
  assert.strictEqual(s.savingsRate[0], null, 'no income in July');
});

test('his "not spending" mark keeps money in out of income too', () => {
  const s = incomeStatement([{ id: 'x', balance: 0, transactions: [tx('Venmo from Mom', 200, on(9, 3))] }], { 'venmo from mom': 'skip' }, NOW);
  assert.deepStrictEqual(s.income, []);
});

test('balance sheet: cash, investments, what’s owed, worked back to earlier days', () => {
  const b = balanceSheet([checking, visa, broker], NOW);
  assert.deepStrictEqual(b.cols.map((c) => c.label), ['Today', '30 days ago', '90 days ago']);
  assert.deepStrictEqual([b.cashTotal[0], b.investTotal[0], b.liabilityTotal[0], b.netWorth[0]], [2000, 9000, 640, 10360]);
  // 30 days ago (Sep 18): before the Sep 20 card payment, Sep 30 interest and everything in October
  assert.strictEqual(b.cash[0].vals[1], Math.round((2000 - (3000 - 1200 - 15.49 - 60 - 300 + 1.5)) * 100) / 100);
  assert.strictEqual(b.liabilities[0].vals[1], 860, 'before the $300 payment and the Oct 12 charge');
});

test('a brokerage’s buys and sells aren’t income or spending; its dividends are income', () => {
  const brokerage = { id: 'b', name: 'Individual', org: 'Fidelity', balance: 5000, holdings: [{ symbol: 'VOO' }], transactions: [
    tx('YOU SOLD VOO', 4000, on(8, 3)), tx('YOU BOUGHT AAPL', -2000, on(8, 4)), tx('DIVIDEND RECEIVED VOO', 12.4, on(8, 20))] };
  const s = incomeStatement([brokerage], {}, NOW);
  assert.deepStrictEqual(s.income.map((r) => [r.name, r.vals[2]]), [['Interest and dividends', 12.4]]);
  assert.strictEqual(s.expenseTotal[2], 0);
});

test('every line keeps its transactions; his income / not income mark wins', () => {
  const acct = { id: 'c', name: 'Checking', balance: 0, transactions: [tx('GUSTO PAY 123', 2500, on(8, 1)), tx('Venmo from Sam', 50, on(8, 2))] };
  const s = incomeStatement([acct], {}, NOW);
  const other = s.income.find((r) => r.name === 'Other income');
  assert.deepStrictEqual(other.items.map((x) => [x.t.description, x.account, x.col]), [['GUSTO PAY 123', 'Checking', 2], ['Venmo from Sam', 'Checking', 2]]);
  const marked = incomeStatement([acct], { 'in:venmo from sam': 'skip' }, NOW);
  assert.strictEqual(marked.incomeTotal[2], 2500);
  // a transfer the rules skip can be counted after all
  const t = { id: 'c', name: 'Checking', balance: 0, transactions: [tx('Transfer from Mom', 300, on(8, 5))] };
  assert.strictEqual(incomeStatement([t], {}, NOW).incomeTotal[2], 0);
  assert.strictEqual(incomeStatement([t], { 'in:transfer from mom': 'income' }, NOW).incomeTotal[2], 300);
});

test('contribution margin: income minus variable costs, and its share of income', () => {
  const s = incomeStatement([checking, visa], {}, NOW);
  const sep = 2;
  assert.strictEqual(Math.round(s.contribution[sep] * 100) / 100, 3001.5 - 15);
  assert.strictEqual(Math.round((s.contribution[sep] - s.fixedTotal[sep]) * 100) / 100, Math.round(s.net[sep] * 100) / 100, 'margin − fixed = net income');
  assert.ok(Math.abs(s.contributionRatio[sep] - (3001.5 - 15) / 3001.5) < 1e-9);
  assert.strictEqual(s.contributionRatio[0], null, 'no income in July');
});
