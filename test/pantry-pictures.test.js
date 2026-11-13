const test = require('node:test');
const assert = require('node:assert');
const { ppSources, ppRecheck } = require('../renderer/js/pantry-pictures');
const { sameFood } = require('../renderer/js/kitchen');

test('ppSources: pantry items without a picture get one from the order they came on', () => {
  const items = [
    { id: 'a', name: 'Large eggs' },
    { id: 'b', name: 'Whole milk' },
    { id: 'c', name: 'Rice', image: 'https://x.com/rice.jpg' }, // has one already
    { id: 'd', name: 'Onions' }, // typed in, on no order: looked up by name, since he shops on Instacart
  ];
  const tasks = [
    { orders: [{ store: 'instacart', items: [{ name: 'Large eggs, 18 ct', url: 'https://www.instacart.com/products/1' }, { name: 'Whole milk, 1 gal', url: 'https://x.com/milk-page' }] }] },
    { lastOrder: { items: [{ name: 'Large eggs, 12 ct', image: 'https://x.com/eggs.jpg' }, { name: 'Rice, 20 lb', image: 'https://x.com/r2.jpg' }] } },
    { title: 'no orders' },
  ];
  assert.deepStrictEqual(ppSources(items, tasks, sameFood), [
    { id: 'a', image: 'https://x.com/eggs.jpg' }, // a picture beats a page to fetch
    { id: 'b', url: 'https://x.com/milk-page' },
    { id: 'd', find: 'Onions' },
  ]);
  assert.deepStrictEqual(ppSources(items, [], sameFood), []);
  assert.deepStrictEqual(ppSources(null, null, sameFood), []);
});

test('ppSources: with an Instacart order, what no order pictures is looked up by name; without one it keeps its letter', () => {
  const items = [{ id: 'a', name: 'Bananas' }, { id: 'b', name: 'Sweet potatoes' }, { id: 'c', name: 'Pier33 Atlantic Salmon' }];
  const order = { store: 'instacart', self: true, items: [{ name: 'Bananas (10.2 lb)' }, { name: 'Pier33 Atlantic Salmon, Boneless, Skin On Portions (2 lb)', url: 'https://x.com/salmon' }] };
  assert.deepStrictEqual(ppSources(items, [{ orders: [order] }], sameFood), [
    { id: 'a', find: 'Bananas' }, { id: 'b', find: 'Sweet potatoes' }, { id: 'c', url: 'https://x.com/salmon' },
  ]);
  assert.deepStrictEqual(ppSources(items, [{ orders: [Object.assign({}, order, { store: 'walmart' })] }], sameFood), [{ id: 'c', url: 'https://x.com/salmon' }]);
});

test('ppAmounts: an item with no amount gets the size on its newest order, times how many he got', () => {
  const { ppAmounts } = require('../renderer/js/pantry-pictures');
  const { kSized } = require('../renderer/js/kitchen');
  const items = [{ id: 'a', name: 'Pier33 Atlantic Salmon', qty: null }, { id: 'b', name: 'Lean Ground Turkey', qty: null }, { id: 'c', name: 'Eggs', qty: 6 }, { id: 'd', name: 'Onions', qty: null }];
  const tasks = [{ orders: [
    { at: 1, items: [{ name: 'Lean Ground Turkey (16 oz)' }] },
    { at: 2, items: [{ name: 'Pier33 Atlantic Salmon, Boneless, Skin On Portions (2 lb)' }, { name: 'Lean Ground Turkey (16 oz)', qty: 2 }, { name: 'Large Eggs, 12 ct' }, { name: 'Onions' }] },
  ] }];
  assert.deepStrictEqual(ppAmounts(items, tasks, sameFood, kSized), [{ id: 'a', qty: 2, unit: 'lb' }, { id: 'b', qty: 32, unit: 'oz' }]);
});

test('instacartPick: the search result closest to the name, the food itself above the brand', () => {
  const { instacartPick } = require('../agent/previews');
  const card = (file, alt) => '<a href="/products/1-x"><img srcSet="https://www.instacart.com/image-server/197x197/filters:fill(FFFFFF,true):format(jpg)/d2lnr5mha7bycj.cloudfront.net/product-image/file/large_' + file + '.jpg, https://www.instacart.com/image-server/296x296/x 1.5x" alt="' + alt + '"/></a>';
  const page = card('syrup', 'Bruce&#x27;s Yams Cut Sweet Potatoes in Syrup') + card('yam', 'Sweet Potato (Yam)') + card('turkey', 'Lean Ground Turkey Tray') + card('hummus', 'Example Brand Classic Hummus');
  const pic = (f) => 'https://www.instacart.com/image-server/394x394/filters:fill(FFFFFF,true):format(jpg)/d2lnr5mha7bycj.cloudfront.net/product-image/file/large_' + f + '.jpg';
  assert.strictEqual(instacartPick(page, 'Yams'), pic('yam')); // the plain one, not the can in syrup
  assert.strictEqual(instacartPick(page, 'Store Brand Original Hummus'), pic('hummus'));
  assert.strictEqual(instacartPick(page, 'Sweet potatoes'), pic('yam'));
  assert.strictEqual(instacartPick(page, 'Dish soap'), null);
  assert.strictEqual(instacartPick('', 'Yams'), null);
});

test('ppRecheck: pictures off his own order history are checked against the product page; his own photos are not', () => {
  const items = [
    { id: 't', name: 'Tuna', image: 'https://x.com/potatoes.jpg' }, // got the row above's picture
    { id: 'p', name: 'Potatoes', image: 'https://x.com/potatoes.jpg', picOwn: true }, // he took this one
    { id: 'r', name: 'Rice', image: 'https://x.com/rice.jpg' }, // from an order the Agent placed
    { id: 'b', name: 'Bread' },
  ];
  const tasks = [
    { orders: [{ store: 'instacart', self: true, items: [{ name: 'Potatoes, 5 lb', image: 'https://x.com/potatoes0.jpg', url: 'https://x.com/p' }, { name: 'Chunk Light Tuna, 5 oz', image: 'https://x.com/potatoes.jpg', url: 'https://x.com/tuna' }] }] },
    { orders: [{ store: 'instacart', items: [{ name: 'Rice, 20 lb', image: 'https://x.com/rice.jpg', url: 'https://x.com/rice' }] }] },
  ];
  assert.deepStrictEqual(ppRecheck(items, tasks, sameFood), [{ id: 't', url: 'https://x.com/tuna', old: 'https://x.com/potatoes.jpg' }]);
  assert.deepStrictEqual(ppRecheck(null, null, sameFood), []);
});

test('ppSources: a picture he took himself is never replaced, even one that will not load here', () => {
  const items = [{ id: 'a', name: 'Hummus', image: 'https://x.com/mine.jpg', picOwn: true }];
  const tasks = [{ orders: [{ store: 'instacart', items: [{ name: 'Hummus (17 oz)', image: 'https://x.com/h.jpg' }] }] }];
  assert.deepStrictEqual(ppSources(items, tasks, sameFood, new Set(['https://x.com/mine.jpg'])), []);
});
