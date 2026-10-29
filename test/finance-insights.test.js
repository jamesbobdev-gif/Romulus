const test = require('node:test');
const assert = require('node:assert');
const { debtPlan, subscriptionCheck, oddCharges, oddTitle, portfolioMix, stocksCsv } = require('../renderer/js/finance-insights');
const { fetchSectors, stocksView } = require('../renderer/js/finance-core');

const NOW = new Date(2026, 9, 28, 12).getTime();
const on = (y, m, d) => Math.floor(new Date(y, m, d, 12).getTime() / 1000);
let n = 0;
const tx = (desc, amount, posted, extra) => Object.assign({ id: 't' + (n++), description: desc, amount, posted }, extra || {});

test('debts: interest charged, the rate it works out to, the costliest first, and the payoff at his usual payment', () => {
  const card = { id: 'c', org: 'Chase', name: 'Freedom', balance: -2000, transactions: [
    tx('INTEREST CHARGE ON PURCHASES', -40, on(2026, 9, 5)), tx('INTEREST CHARGE', -38, on(2026, 8, 5)),
    tx('Payment Thank You', 200, on(2026, 9, 1)), tx('Payment Thank You', 200, on(2026, 8, 1)), tx('Payment Thank You', 200, on(2026, 7, 2))] };
  const quiet = { id: 'q', org: 'Citi', name: 'Citi Card', balance: -300, transactions: [tx('Payment', 300, on(2026, 9, 10))] };
  const p = debtPlan([quiet, card], {}, NOW);
  assert.deepStrictEqual(p.debts.map((d) => d.name), ['Chase Freedom', 'Citi Card'], 'highest rate first');
  const c = p.debts[0];
  assert.strictEqual(c.interestMonth, 40);
  assert.strictEqual(c.rate, 24); // 40 / 2000 * 12
  assert.strictEqual(c.monthlyPay, 200);
  assert.ok(c.months > 10 && c.months < 13, 'about 11 months at $200 with 2% a month');
  assert.ok(c.interestLeft > 200 && c.interestLeft < 300);
  assert.strictEqual(p.first, 'Chase Freedom');
  assert.strictEqual(p.debts[1].rate, null);
});

test('debts: a payment that doesn\'t cover the interest never pays it off', () => {
  const c = { id: 'c', name: 'Card', balance: -10000, transactions: [tx('INTEREST CHARGE', -250, on(2026, 9, 5)), tx('Payment', 150, on(2026, 9, 1))] };
  const [d] = debtPlan([c], {}, NOW).debts;
  assert.deepStrictEqual([d.months, d.interestLeft], [null, null]);
});

const months = (desc, amounts, day) => amounts.map((a, i) => tx(desc, -a, on(2026, 5 + i, day))); // June to October
test('subscriptions: price rises, ones that just started, and not the rent', () => {
  const txs = [].concat(
    months('SPOTIFY USA', [11.99, 11.99, 11.99, 11.99, 12.99], 9),
    months('RENT PAYMENT ACME', [1500, 1500, 1500, 1500, 1550], 1),
    months('NETFLIX.COM', [15.49, 15.49, 15.49, 15.49, 15.49], 15),
    [tx('NEWAPP SUBSCRIPTION', -9.99, on(2026, 9, 20)), tx('Corner Deli', -8, on(2026, 9, 21))]);
  const s = subscriptionCheck(txs, {}, NOW);
  assert.deepStrictEqual(s.subs.map((x) => x.name).sort(), ['NETFLIX.COM', 'SPOTIFY USA']);
  assert.deepStrictEqual(s.raised.map((x) => [x.name, x.from, x.to]).sort(), [['RENT PAYMENT ACME', 1500, 1550], ['SPOTIFY USA', 11.99, 12.99]]);
  assert.deepStrictEqual(s.fresh.map((x) => x.name), ['NEWAPP SUBSCRIPTION']);
});

test('subscriptions: with only a few weeks of history, nothing counts as just started', () => {
  const s = subscriptionCheck([tx('NEWAPP SUBSCRIPTION', -9.99, on(2026, 9, 20))], {}, NOW);
  assert.deepStrictEqual(s.fresh, []);
});

test('odd charges: a double charge once, $100+ from a new payee, a foreign fee; transfers and old ones left alone', () => {
  const acct = { id: 'a', name: 'Checking', balance: 500, transactions: [
    tx('Grocer', -20, on(2026, 6, 1)), // history going back
    tx('UBER TRIP', -23.5, on(2026, 9, 26)), tx('UBER TRIP', -23.5, on(2026, 9, 26)),
    tx('BEST BUY 00123', -349.99, on(2026, 9, 25)),
    tx('FOREIGN TRANSACTION FEE', -2.1, on(2026, 9, 27)),
    tx('Transfer to Savings', -500, on(2026, 9, 27)),
    tx('APPLE STORE', -999, on(2026, 8, 1))] }; // a month ago: not recent
  const odd = oddCharges([acct], {}, NOW, 7);
  assert.deepStrictEqual(odd.map((o) => o.kind).sort(), ['double', 'foreign', 'new-big']);
  const big = odd.find((o) => o.kind === 'new-big');
  assert.match(oddTitle(big), /^Check a new \$100\+ charge from BEST BUY 00123 on /);
  odd.forEach((o) => assert.doesNotMatch(oddTitle(o), /349|23\.5|2\.1/), 'no amounts in the to-do');
});

test('odd charges: a payee seen before isn\'t new; a pending charge beside its posted copy isn\'t double', () => {
  const acct = { id: 'a', name: 'Checking', balance: 500, transactions: [
    tx('Grocer', -20, on(2026, 6, 1)), tx('COSTCO', -180, on(2026, 8, 2)), tx('COSTCO', -210, on(2026, 9, 26)),
    tx('CAFE', -12, on(2026, 9, 27), { pending: true }), tx('CAFE', -12, on(2026, 9, 27))] };
  assert.deepStrictEqual(oddCharges([acct], {}, NOW, 7), []);
});

test('portfolio mix: by sector (funds as their own), holding and type, with shares of the whole', () => {
  const rows = [
    { symbol: 'AAPL', value: 600, type: 'Stock', sector: 'Technology', industry: 'Consumer Electronics' },
    { symbol: 'MSFT', value: 200, type: 'Stock', sector: 'Technology', industry: 'Software' },
    { symbol: 'VOO', value: 200, type: 'ETF', sector: null, industry: null }];
  const m = portfolioMix(rows);
  assert.strictEqual(m.total, 1000);
  assert.deepStrictEqual(m.sectors.map((x) => [x.name, x.pct]), [['Technology', 80], ['Funds (ETF)', 20]]);
  assert.deepStrictEqual(m.holdings[0], { name: 'AAPL', value: 600, pct: 60 });
  assert.deepStrictEqual(m.types.map((x) => x.name), ['Stock', 'ETF']);
});

test('sectors: only the ticker goes to Yahoo, and the answer lands on each stock row', async () => {
  const asked = [];
  const fake = async (url) => {
    asked.push(url);
    const sym = decodeURIComponent(url.split('q=')[1]);
    const quotes = sym === 'AAPL' ? [{ symbol: 'AAPL', quoteType: 'EQUITY', sectorDisp: 'Technology', industryDisp: 'Consumer Electronics' }]
      : sym === 'BRK-B' ? [{ symbol: 'BRK-B', quoteType: 'EQUITY', sector: 'Financial Services', industry: 'Insurance' }]
      : [{ symbol: 'VOO', quoteType: 'ETF' }];
    return { ok: true, json: async () => ({ quotes }) };
  };
  const s = await fetchSectors(['AAPL', 'VOO', 'BRK.B'], fake);
  assert.deepStrictEqual(s.AAPL, { type: 'Stock', sector: 'Technology', industry: 'Consumer Electronics' });
  assert.deepStrictEqual(s.VOO, { type: 'ETF', sector: null, industry: null });
  assert.strictEqual(s['BRK.B'].sector, 'Financial Services');
  asked.forEach((u) => assert.match(u, /search\?quotesCount=3&newsCount=0&q=(AAPL|VOO|BRK-B)$/));
  const v = stocksView([{ symbol: 'AAPL', shares: 1, value: 200 }], {}, null, null, null, s);
  assert.deepStrictEqual([v.rows[0].type, v.rows[0].sector], ['Stock', 'Technology']);
});

test('stocks spreadsheet: biggest first, plain numbers, commas quoted, no formulas, blanks for unknowns', () => {
  const csv = stocksCsv([
    { r: { symbol: null, name: '=HYPERLINK("x")', shares: 1, price: 5, live: false, changePct: 0, value: 5, cost: null, gain: null }, pct: null },
    { r: { symbol: 'AAPL', name: 'Apple, Inc.', type: 'Stock', sector: 'Technology', industry: null, shares: 10.5, price: 230.1234567,
      live: true, changePct: -1.2, value: 2416.3, cost: 2000, gain: 416.3 }, pct: 12.3 }], '6M', 'USD');
  assert.deepStrictEqual(csv.split('\r\n'), [
    'Symbol,Name,Type,Sector,Industry,Shares,Price (USD),Today %,6M %,Value (USD),Cost (USD),Gain (USD)',
    'AAPL,"Apple, Inc.",Stock,Technology,,10.5,230.1235,-1.2,12.3,2416.3,2000,416.3',
    ',"\'=HYPERLINK(""x"")",,,,1,5,,,5,,',
    '']);
});
