const test = require('node:test');
const assert = require('node:assert');
const { ppSources } = require('../renderer/js/pantry-pictures');
const { sameFood } = require('../renderer/js/kitchen');

test('ppSources: pantry items without a picture get one from the order they came on', () => {
  const items = [
    { id: 'a', name: 'Large eggs' },
    { id: 'b', name: 'Whole milk' },
    { id: 'c', name: 'Rice', image: 'https://x.com/rice.jpg' }, // has one already
    { id: 'd', name: 'Onions' }, // typed in, on no order
  ];
  const tasks = [
    { orders: [{ store: 'instacart', items: [{ name: 'Large eggs, 18 ct', url: 'https://www.instacart.com/products/1' }, { name: 'Whole milk, 1 gal', url: 'https://x.com/milk-page' }] }] },
    { lastOrder: { items: [{ name: 'Large eggs, 12 ct', image: 'https://x.com/eggs.jpg' }, { name: 'Rice, 20 lb', image: 'https://x.com/r2.jpg' }] } },
    { title: 'no orders' },
  ];
  assert.deepStrictEqual(ppSources(items, tasks, sameFood), [
    { id: 'a', image: 'https://x.com/eggs.jpg' }, // a picture beats a page to fetch
    { id: 'b', url: 'https://x.com/milk-page' },
  ]);
  assert.deepStrictEqual(ppSources(items, [], sameFood), []);
  assert.deepStrictEqual(ppSources(null, null, sameFood), []);
});
