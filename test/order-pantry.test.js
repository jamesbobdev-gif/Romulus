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
  assert.deepStrictEqual(stocked, ['Optimum Nutrition Whey, 5 lb']);
  assert.strictEqual(t.orders.length, 1);
});

test('a grocery order from before items were marked puts all of it in, but not what his list already bought', () => {
  const { ctx, stocked } = load();
  const t = { ws: 'agent', title: 'Groceries', cart: [
    { name: 'Great Value Large White Eggs, 18 ct', url: 'https://www.walmart.com/ip/1' },
    { name: 'Great Value Long Grain Rice, 20 lb', qty: 2, url: 'https://www.walmart.com/ip/2' },
    { name: 'Bananas', qty: 3, url: 'https://www.walmart.com/ip/3' },
    { name: 'Hummus', url: 'https://www.walmart.com/ip/4', suggested: true },
  ], cartOff: ['Hummus'] };
  ctx.keepLastOrder(t, '', ['Eggs']); // applyListUpdate stocks "Eggs" itself
  assert.deepStrictEqual(stocked, ['Great Value Long Grain Rice, 20 lb', 'Great Value Long Grain Rice, 20 lb', 'Bananas, 3 ct']);
});

test('an unmarked order from a store that sells more than food stays out of the pantry', () => {
  const { ctx, stocked } = load();
  ctx.keepLastOrder({ ws: 'agent', title: 'Buy a lamp', cart: [{ name: 'Desk lamp', url: 'https://www.target.com/p/1' }] });
  assert.deepStrictEqual(stocked, []);
});
