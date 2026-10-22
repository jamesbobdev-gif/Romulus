const test = require('node:test');
const assert = require('node:assert');
const { itemDue, groceryBrief, groceryChanges, groceryListFor } = require('../agent/grocery');

const day = (s) => new Date(s + 'T12:00:00').getTime();

test('an item is due when he ran out, it was never bought, or its weeks are up', () => {
  assert.strictEqual(itemDue({ every: 1, last: null, out: false }, day('2026-10-16')), true);
  assert.strictEqual(itemDue({ every: 4, last: '2026-10-14', out: true }, day('2026-10-16')), true);
  assert.strictEqual(itemDue({ every: 1, last: '2026-10-09', out: false }, day('2026-10-16')), true);
  assert.strictEqual(itemDue({ every: 1, last: '2026-10-14', out: false }, day('2026-10-16')), false);
  assert.strictEqual(itemDue({ every: 4, last: '2026-10-02', out: false }, day('2026-10-16')), false);
});

test('the run sees each item with how often and whether it is due; plain old lines still work', () => {
  const b = groceryBrief(['Eggs', { name: 'Rice, 20 lb', every: 4, last: '2026-10-02' }, { name: ' ' }], day('2026-10-16'));
  assert.deepStrictEqual(b, [
    { name: 'Eggs', every: 'weekly', lastBought: undefined, ranOut: undefined, due: true },
    { name: 'Rice, 20 lb', every: 'every 4 weeks', lastBought: '2026-10-02', ranOut: undefined, due: false },
  ]);
  assert.strictEqual(groceryBrief([]), undefined);
  assert.strictEqual(groceryBrief(null), undefined);
});

test('the answer can only add, mark bought or remove, never replace the list', () => {
  assert.deepStrictEqual(groceryChanges({ add: [{ name: 'Milk, 2%', every: 99 }, 'Bread'], bought: ['Eggs'], remove: [] }),
    { add: [{ name: 'Milk, 2%', every: 52 }, { name: 'Bread', every: 1 }], bought: ['Eggs'], remove: [] });
  assert.strictEqual(groceryChanges(['Eggs', 'Milk']), undefined); // a whole list: ignored
  assert.strictEqual(groceryChanges({ add: [], bought: [] }), undefined);
  assert.strictEqual(groceryChanges(null), undefined);
});

test('a new grocery task with no list uses the list on the newest grocery task that has one', () => {
  const old = { ws: 'agent', title: 'Groceries', created: 1, list: [{ name: 'Eggs' }] };
  const newer = { ws: 'agent', title: 'Groceries', created: 2, done: true, list: [{ name: 'Milk' }] };
  const ask = { ws: 'agent', title: 'can I get groceries with my EBT', created: 3 };
  assert.deepStrictEqual(groceryListFor(ask, [old, newer, ask]), [{ name: 'Milk' }]);
  assert.deepStrictEqual(groceryListFor(old, [old, newer, ask]), [{ name: 'Eggs' }]); // its own list first
  assert.strictEqual(groceryListFor({ ws: 'agent', title: 'Book a flight', created: 4 }, [old]), undefined);
  assert.strictEqual(groceryListFor({ ws: 'personal', title: 'groceries', created: 4 }, [old]), undefined);
});

test('an Amazon order is not his last grocery order', () => {
  const { lastOrderFor } = require('../agent/grocery');
  const last = lastOrderFor([
    { ws: 'agent', title: 'Find me a water bottle', lastOrder: { at: 2, items: [{ name: 'Owala bottle' }] } },
    { ws: 'agent', title: 'Groceries', lastOrder: { at: 1, items: [{ name: 'Eggs' }] } }]);
  assert.equal(last.items[0].name, 'Eggs');
});
