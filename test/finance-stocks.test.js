const test = require('node:test');
const assert = require('node:assert');
const { cleanHoldings, holdingsOf, fetchQuotes, readChart, portfolio, portfolioLine } = require('../main/finance-stocks');

const chart = (price, prev, t, ts, closes) => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: t },
  timestamp: ts, indicators: { quote: [{ close: closes }] } }], error: null } });

test('holdings from SimpleFIN, the same symbol added up across accounts', () => {
  const a = cleanHoldings([{ symbol: 'aapl', description: 'Apple Inc', shares: '10', market_value: '1800', cost_basis: '1500' }, { symbol: 'bad symbol!', description: 'Cash', shares: '0', market_value: '50' }]);
  assert.deepStrictEqual(a.map((h) => h.symbol), ['AAPL', '']);
  const held = holdingsOf([{ holdings: a }, { holdings: cleanHoldings([{ symbol: 'AAPL', shares: 5, market_value: 900 }]) }]);
  const aapl = held.find((h) => h.symbol === 'AAPL');
  assert.deepStrictEqual([aapl.shares, aapl.value, aapl.costKnown], [15, 2700, false]);
});

test('a Yahoo chart: price, change from yesterday’s close, the day’s prices', () => {
  const q = readChart(chart(110, 100, 1792000000, [1792000000, 1792000300, 1792000600], [105, null, 110]));
  assert.deepStrictEqual([q.c, q.d, q.dp, q.t], [110, 10, 10, 1792000000]);
  assert.deepStrictEqual(q.series, [[1792000000000, 105], [1792000600000, 110]], 'a missing price is skipped');
  assert.strictEqual(readChart({ chart: { result: null, error: { code: 'Not Found' } } }), null);
});

test('only symbols go to Yahoo; BRK.B is asked as BRK-B', async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return url.includes('ZZZZ') ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => chart(190, 188, 1792000000, [], []) }; };
  const r = await fetchQuotes(['AAPL', 'BRK.B', 'ZZZZ', 'not ok'], fetch, '1d');
  assert.deepStrictEqual(Object.keys(r.quotes).sort(), ['AAPL', 'BRK.B']);
  assert.strictEqual(calls.length, 3, 'a malformed symbol is never sent');
  assert.ok(calls.some((u) => u.includes('/BRK-B?range=1d&interval=5m')));
  assert.ok((await fetchQuotes(['AAPL'], fetch, '6mo')) && calls[calls.length - 1].includes('range=6mo&interval=1d'));
  assert.ok((await fetchQuotes(['AAPL'], fetch, '1y')) && calls[calls.length - 1].includes('range=1y&interval=1d'), 'a year of closes for the 3 month / 6 month / 1 year chart');
  await assert.rejects(fetchQuotes(['AAPL'], async () => { throw new Error('offline'); }, '1d'), /online/);
});

test('live value, today’s change and the gain since bought', () => {
  const p = portfolio([{ symbol: 'AAPL', name: 'Apple', shares: 10, value: 1800, cost: 1500, costKnown: true }, { symbol: '', name: 'Cash', shares: 0, value: 50, cost: 0, costKnown: false }],
    { AAPL: { c: 190, d: 2, dp: 1.06, t: 1792000000, series: [] } });
  assert.deepStrictEqual([p.total, p.change, p.gain], [1950, 20, 400]);
  assert.deepStrictEqual(p.rows.map((r) => r.live), [true, false]);
  assert.strictEqual(p.at, 1792000000000);
});

test('the portfolio line: each stock at its latest price by then, cash flat', () => {
  const held = [{ symbol: 'A', shares: 2, value: 0 }, { symbol: 'B', shares: 1, value: 0 }, { symbol: '', shares: 0, value: 50 }];
  const line = portfolioLine(held, { A: { series: [[1000, 10], [3000, 12]] }, B: { series: [[2000, 100]] } });
  assert.deepStrictEqual(line, [[1000, 170], [2000, 170], [3000, 174]]);
});
