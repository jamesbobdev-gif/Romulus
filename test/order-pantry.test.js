const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sameFood } = require('../renderer/js/kitchen.js');

/* a placed store order puts its food into the Kitchen pantry (renderer/js/grocery-list.js keepLastOrder) */
function load() {
  const stocked = [];
  const ctx = {
    window: {}, document: { readyState: 'complete', addEventListener() {} }, setTimeout() {}, setInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, state: { tasks: [] }, taskWs: (t) => t.ws, sameFood,
    kitchenBought(names) { stocked.push(...(names || [])); },
  };
  vm.createContext(ctx);
  for (const f of ['order-match.js', 'grocery-list.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js', f), 'utf8'), ctx);
  return { ctx, stocked };
}

test('an Amazon order puts only what the Agent marked food into the pantry', () => {
  const { ctx, stocked } = load();
  const t = { ws: 'agent', title: 'Buy protein powder and a phone charger', cart: [
    { name: 'Optimum Nutrition Whey, 5 lb', price: '$60', url: 'https://www.amazon.com/dp/1', food: true },
    { name: 'Anker USB-C Charger', price: '$20', url: 'https://www.amazon.com/dp/2', food: false },
  ] };
  ctx.keepLastOrder(t, 'Total $80');
  assert.deepStrictEqual(names(stocked), ['Optimum Nutrition Whey, 5 lb']);
  assert.strictEqual(t.orders.length, 1);
});

const names = (s) => s.map((x) => (typeof x === 'string' ? x : x.name));

test('a grocery order puts all of it in with sizes and pictures; his list names it stands for are left to it', () => {
  const { ctx, stocked } = load();
  const t = { ws: 'agent', title: 'Groceries', cart: [
    { name: 'Great Value Large White Eggs, 18 ct', url: 'https://www.walmart.com/ip/1', image: 'https://i5.walmartimages.com/eggs.jpg' },
    { name: 'Great Value Long Grain Rice, 20 lb', qty: 2, url: 'https://www.walmart.com/ip/2' },
    { name: 'Bananas', qty: 3, url: 'https://www.walmart.com/ip/3' },
    { name: 'Milk', url: 'https://www.walmart.com/ip/5', image: 'http://not-https.example/milk.jpg' },
    { name: 'Hummus', url: 'https://www.walmart.com/ip/4', suggested: true },
  ], cartOff: ['Hummus'] };
  const covered = ctx.keepLastOrder(t, '', ['Eggs', 'Paper towels']);
  assert.deepStrictEqual(names(stocked), ['Great Value Large White Eggs, 18 ct', 'Great Value Long Grain Rice, 20 lb', 'Great Value Long Grain Rice, 20 lb', 'Bananas, 3 ct', 'Milk, 1 ct']);
  assert.strictEqual(stocked[0].image, 'https://i5.walmartimages.com/eggs.jpg');
  assert.strictEqual(stocked[4].image, undefined); // only https pictures
  assert.deepStrictEqual([...covered], ['Eggs']); // applyListUpdate still stocks "Paper towels" by name
});

test('applyListUpdate leaves out what the order already stocked', () => {
  const { ctx, stocked } = load();
  ctx.applyListUpdate({ ws: 'agent', title: 'Groceries', list: [{ name: 'Eggs' }, { name: 'Salt' }] }, { bought: ['Eggs', 'Salt'] }, ['Eggs']);
  assert.deepStrictEqual(names(stocked), ['Salt']);
});

test('an unmarked order from a store that sells more than food stays out of the pantry', () => {
  const { ctx, stocked } = load();
  ctx.keepLastOrder({ ws: 'agent', title: 'Buy a lamp', cart: [{ name: 'Desk lamp', url: 'https://www.target.com/p/1' }] });
  assert.deepStrictEqual(stocked, []);
});

/* orders he placed himself, found in his store account by a run (stockOrdered), and the cart check that looks for them */
test('an order he placed himself goes into the pantry once, food only, and joins the task\'s orders', () => {
  const { ctx, stocked } = load();
  const t = { ws: 'agent', title: 'Groceries', cart: [{ name: 'Eggs, 12 ct' }] };
  ctx.state.tasks.push(t);
  const found = [{ store: 'Aldi (Instacart)', id: 'A-123', date: '2026-11-08', total: 41.5, items: [
    { name: 'Large Eggs, 12 ct', url: 'https://www.instacart.com/products/1', food: true },
    { name: 'Paper Towels, 6 rolls', url: 'https://www.instacart.com/products/2', food: false },
    { name: 'Bananas', qty: 3, url: 'https://www.instacart.com/products/3', food: true },
  ] }];
  const out = ctx.stockOrdered(t, found);
  assert.deepStrictEqual(names(stocked), ['Large Eggs, 12 ct', 'Bananas, 3 ct']);
  assert.deepStrictEqual(Array.from(out, (s) => s.n), [2]);
  assert.strictEqual(t.orders.length, 1);
  assert.strictEqual(t.orders[0].store, 'instacart');
  assert.strictEqual(t.orders[0].total, 41.5);
  assert.strictEqual(t.orders[0].self, true);
  // the next run sees the same order again: nothing more goes in
  assert.deepStrictEqual([...ctx.stockOrdered(t, found)], []);
  assert.strictEqual(stocked.length, 2);
  assert.strictEqual(t.orders.length, 1);
  assert.match(ctx.orderedLine(out[0]), /^Into your pantry from your Aldi \(Instacart\) order of Nov 8: 2 items$/);
});

test('an unmarked order he placed himself goes in whole from a grocery task, not from a lamp task', () => {
  const { ctx, stocked } = load();
  const items = [{ name: 'Rice, 5 lb', url: 'https://www.walmart.com/ip/1' }];
  ctx.stockOrdered({ ws: 'agent', title: 'Groceries' }, [{ store: 'Walmart', id: '1', items }]);
  assert.deepStrictEqual(names(stocked), ['Rice, 5 lb']);
  ctx.stockOrdered({ ws: 'agent', title: 'Buy a lamp' }, [{ store: 'Walmart', id: '2', items }]);
  assert.strictEqual(stocked.length, 1);
});

test('a waiting cart is looked at a day after it came and again at 3 days, then no more', () => {
  const { ctx } = load();
  const day = 864e5, at = 1e12;
  const t = { ws: 'agent', status: 'needs-you', cart: [{ name: 'Milk' }], cartAt: at };
  assert.strictEqual(ctx.cartLookDue(t, at + day / 2), false);
  assert.strictEqual(ctx.cartLookDue(t, at + day), true);
  t.cartLooks = 1;
  assert.strictEqual(ctx.cartLookDue(t, at + 2 * day), false);
  assert.strictEqual(ctx.cartLookDue(t, at + 3 * day), true);
  t.cartLooks = 2;
  assert.strictEqual(ctx.cartLookDue(t, at + 30 * day), false);
  assert.strictEqual(ctx.cartLookDue({ ...t, cartLooks: 0, status: 'queued' }, at + 3 * day), false); // already going
  assert.strictEqual(ctx.cartLookDue({ ...t, cartLooks: 0, done: true }, at + 3 * day), false);
});

test('an Instacart order he placed himself: sizes in brackets go in once per one bought, and his list names it covers are left to it', () => {
  const { ctx, stocked } = load();
  ctx.kSized = require('../renderer/js/kitchen.js').kSized;
  const t = { ws: 'agent', title: 'Groceries' };
  ctx.state.tasks.push(t);
  const out = ctx.stockOrdered(t, [{ store: 'Example Market (Instacart)', id: 'B-1', date: '2026-11-10', items: [
    { name: 'Bananas (10.2 lb)', food: true }, { name: 'Lean Ground Turkey (16 oz)', qty: 2, food: true }, { name: 'Kiwi (1 each)', qty: 12, food: true }, { name: 'Limes', qty: 3, food: true },
  ] }], ['Ground turkey', 'Bananas', 'Paper towels']);
  assert.deepStrictEqual(names(stocked), ['Bananas (10.2 lb)', 'Lean Ground Turkey (16 oz)', 'Lean Ground Turkey (16 oz)'].concat(Array(12).fill('Kiwi (1 each)'), ['Limes, 3 ct']));
  assert.deepStrictEqual([...out[0].covered], ['Ground turkey', 'Bananas']);
});
