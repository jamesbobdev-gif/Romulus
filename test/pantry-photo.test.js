const test = require('node:test');
const assert = require('node:assert');
const pp = require('../renderer/js/pantry-photo');

test('the meal prompt lists the pantry, the food prompt does not need it', () => {
  const q = pp.prompt('meal', [{ name: 'rice', qty: 4, unit: 'cup' }, { name: 'eggs', qty: null }]);
  assert.match(q, /- 4 cup rice/);
  assert.match(q, /- eggs/);
  assert.match(q, /"used"/);
  assert.match(pp.prompt('food', []), /"items"/);
});

test('the food prompt reads receipts too, and uses pantry names when there are some', () => {
  const empty = pp.prompt('food', []);
  assert.match(empty, /receipt/);
  assert.match(empty, /Leave out prices/);
  assert.doesNotMatch(empty, /His pantry/);
  const q = pp.prompt('food', [{ name: 'whole milk', qty: 1, unit: 'gal' }]);
  assert.match(q, /use that exact name/);
  assert.match(q, /## His pantry\n- 1 gal whole milk/);
});

test('a food answer becomes clean names and amounts, no repeats', () => {
  const r = pp.parse('food', 'Here you go: {"items":[{"name":"Eggs","amount":"12"},{"name":"eggs"},{"name":"  black beans ","amount":"3 cans"},{"name":""},"milk"]}');
  assert.deepStrictEqual(r.items, [{ name: 'Eggs', amount: '12' }, { name: 'black beans', amount: '3 cans' }, { name: 'milk', amount: '' }]);
});

test('a meal answer keeps sure, and an unusable answer is empty', () => {
  const r = pp.parse('meal', '{"meal":"Fried rice","used":[{"name":"rice","amount":"1 cup","sure":true},{"name":"soy sauce","amount":"1 tbsp","sure":false},{"name":"eggs","amount":"2"}]}');
  assert.strictEqual(r.meal, 'Fried rice');
  assert.deepStrictEqual(r.used.map((u) => u.sure), [true, false, true]);
  assert.deepStrictEqual(pp.parse('meal', 'sorry, I can\'t see that'), { meal: '', used: [] });
  assert.deepStrictEqual(pp.parse('food', 'no'), { items: [] });
});
