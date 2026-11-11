const test = require('node:test');
const assert = require('node:assert');
const { orderTotalFrom, orderStore, agentOrders, matchOrders } = require('../renderer/js/order-match');

const DAY = 86400000;
const AT = Date.UTC(2026, 9, 10);
const sec = (ms) => Math.floor(ms / 1000);

test('the total comes from what the Agent said', () => {
  assert.strictEqual(orderTotalFrom('Arrives Tue. Total with tax and shipping: $1,054.21, Visa ending 1234. Reply yes'), 1054.21);
  assert.strictEqual(orderTotalFrom('Order 112-33 placed, total $23.10'), 23.1);
  assert.strictEqual(orderTotalFrom('about $41 with delivery'), 41);
  assert.strictEqual(orderTotalFrom('Placed it.'), undefined);
});

test('the store comes from the item links, else the title', () => {
  assert.strictEqual(orderStore([{ url: 'https://www.amazon.com/dp/B0ABC' }], 'Water bottle'), 'amazon');
  assert.strictEqual(orderStore([{ url: 'https://www.walmart.com/ip/123' }], 'Groceries'), 'walmart');
  assert.strictEqual(orderStore([{ name: 'Eggs' }], 'Instacart order'), 'instacart');
  assert.strictEqual(orderStore([{ url: 'https://www.bestbuy.com/site/x' }], ''), 'bestbuy');
});

const tasks = [
  { id: 'a', ws: 'agent', title: 'Find me a water bottle', orders: [{ at: AT, total: 24.99, store: 'amazon', items: [{ name: 'Owala bottle', price: '$24.99' }] }] },
  { id: 'g', ws: 'agent', title: 'Groceries', lastOrder: { at: AT + DAY, items: [{ name: 'Eggs', price: '$3.12', url: 'https://www.walmart.com/ip/1' }, { name: 'Milk', price: '$2.50', url: 'https://www.walmart.com/ip/2' }] } },
  { id: 'p', title: 'Personal', orders: [{ at: AT, total: 5, items: [{ name: 'x' }] }] },
];

test('orders come from Agent tasks only, old lastOrder included', () => {
  const o = agentOrders(tasks);
  assert.deepStrictEqual(o.map((x) => x.task), ['g', 'a']);
  assert.strictEqual(o[0].store, 'walmart');
});

test('a charge matches the order it paid for', () => {
  const txs = [
    { id: 't1', posted: sec(AT + 3 * DAY), amount: -25.4, description: 'Amazon', bank: 'AMZN Mktp US*2K4' }, // shipped later, a little tax
    { id: 't2', posted: sec(AT + DAY), amount: -6.1, description: 'WAL-MART #1234' },
    { id: 't3', posted: sec(AT + 2 * DAY), amount: -24.99, description: 'Target' }, // wrong store
    { id: 't4', posted: sec(AT + 30 * DAY), amount: -24.99, description: 'Amazon' }, // too late
  ];
  const m = matchOrders(txs, agentOrders(tasks), AT + 40 * DAY);
  assert.strictEqual(m.t1.order.task, 'a');
  assert.strictEqual(m.t1.sure, true);
  assert.strictEqual(m.t2.order.task, 'g');
  assert.ok(!m.t3 && !m.t4);
});

test('one order, one charge; a smaller charge from the store is only a maybe', () => {
  const txs = [
    { id: 'x1', posted: sec(AT + DAY), amount: -10, description: 'Amazon.com' },
    { id: 'x2', posted: sec(AT + 2 * DAY), amount: -24.99, description: 'Amazon.com' },
    { id: 'x3', posted: sec(AT + DAY), amount: 24.99, description: 'Amazon refund' },
  ];
  const m = matchOrders(txs, agentOrders(tasks), AT + 5 * DAY);
  assert.strictEqual(m.x2.sure, true);
  assert.ok(!m.x1, 'the order already has its charge');
  assert.ok(!m.x3, 'money in is not a purchase');
  const alone = matchOrders([txs[0]], agentOrders(tasks), AT + 5 * DAY);
  assert.strictEqual(alone.x1.sure, false);
});

test('a food store charge no order explains starts one look at that store', () => {
  const { storesToCheck } = require('../renderer/js/order-match');
  const now = AT + 10 * DAY;
  const txs = [
    { id: 'i1', amount: -41.5, posted: sec(now - DAY), description: 'INSTACART*ALDI' },
    { id: 'i2', amount: -12, posted: 0, description: 'Instacart' }, // pending: same store, one look
    { id: 'w1', amount: -20, posted: sec(now - 2 * DAY), description: 'WAL-MART #123' },
    { id: 'a1', amount: -30, posted: sec(now - DAY), description: 'AMAZON MKTPLACE' }, // not a food store
    { id: 'k1', amount: -15, posted: sec(now - 6 * DAY), description: 'KROGER' }, // too old
    { id: 't1', amount: 25, posted: sec(now - DAY), description: 'TARGET REFUND' }, // money in
  ];
  assert.deepStrictEqual(storesToCheck(txs, { w1: { sure: true } }, [], now), ['instacart']);
  assert.deepStrictEqual(storesToCheck(txs, {}, [], now), ['instacart', 'walmart']);
  // a look already going, or one since the charge, or one in the last 2 days: none again
  const open = [{ ws: 'agent', orderLook: 'instacart', created: now - 3 * DAY, done: false }];
  assert.deepStrictEqual(storesToCheck(txs, { w1: {} }, open, now), []);
  const after = [{ ws: 'agent', orderLook: 'instacart', created: now - 12 * 3600000, done: true }];
  assert.deepStrictEqual(storesToCheck(txs.slice(0, 1), {}, after, now), []);
  const before = [{ ws: 'agent', orderLook: 'instacart', created: now - 3 * DAY, done: true }];
  assert.deepStrictEqual(storesToCheck(txs.slice(0, 1), {}, before, now), ['instacart']);
});
