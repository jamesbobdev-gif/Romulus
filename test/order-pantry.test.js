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
