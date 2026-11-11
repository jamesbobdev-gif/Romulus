const test = require('node:test');
const assert = require('node:assert');
const k = require('../renderer/js/kitchen');

let n = 0;
const id = () => 'id' + (++n);
const kitchen = (items, recipes) => k.normKitchen({
  items: items.map((i) => Object.assign({ id: id() }, k.parseIngredient(i))),
  recipes: recipes.map((r) => ({ id: r.id || id(), name: r.name, ingredients: r.ings, liked: r.liked, planned: r.planned, made: r.made })),
});

test('ingredient lines become name, amount and unit', () => {
  assert.deepStrictEqual(k.parseIngredient('2 cups rice'), { name: 'rice', qty: 2, unit: 'cup' });
  assert.deepStrictEqual(k.parseIngredient('1 1/2 lb ground beef'), { name: 'ground beef', qty: 1.5, unit: 'lb' });
  assert.deepStrictEqual(k.parseIngredient('3 eggs'), { name: 'eggs', qty: 3, unit: '' });
  assert.deepStrictEqual(k.parseIngredient('1 onion, diced'), { name: 'onion', qty: 1, unit: '' });
  assert.deepStrictEqual(k.parseIngredient('- ½ cup milk'), { name: 'milk', qty: 0.5, unit: 'cup' });
  assert.deepStrictEqual(k.parseIngredient('1 dozen eggs'), { name: 'eggs', qty: 12, unit: '' });
  assert.deepStrictEqual(k.parseIngredient('2 cans of black beans'), { name: 'black beans', qty: 2, unit: 'can' });
  assert.deepStrictEqual(k.parseIngredient('salt'), { name: 'salt', qty: null, unit: '' });
  assert.strictEqual(k.parseIngredient('   '), null);
});

test('the same food under different names, but not a different food', () => {
  assert.ok(k.sameFood('Large Eggs', 'egg'));
  assert.ok(k.sameFood('tomatoes', 'Tomato'));
  assert.ok(k.sameFood('ground beef', 'beef'));
  assert.ok(!k.sameFood('rice vinegar', 'rice'));
  assert.ok(!k.sameFood('milk', 'milk chocolate'));
});

test('units convert within weight or volume only', () => {
  assert.strictEqual(Math.round(k.kConvert(1, 'lb', 'oz')), 16);
  assert.strictEqual(Math.round(k.kConvert(1, 'cup', 'tbsp')), 16);
  assert.strictEqual(k.kConvert(1, 'can', 'cup'), null);
  assert.strictEqual(k.kConvert(2, 'lb', 'cup'), null);
});

test('meals he can make now come first, liked before the rest', () => {
  const kt = kitchen(['2 lb ground beef', '1 can kidney beans', 'onion', 'tortillas'], [
    { name: 'Tacos', ings: ['1 lb ground beef', 'tortillas', '1 cup cheese'], liked: true },
    { name: 'Chili', ings: ['1 lb ground beef', '1 can kidney beans', '1 onion', 'salt'] },
    { name: 'Burgers', ings: ['1 lb ground beef', 'onion'], liked: true },
  ]);
  const s = k.suggestMeals(kt);
  assert.deepStrictEqual(s.map((x) => x.recipe.name), ['Burgers', 'Chili', 'Tacos']);
  assert.deepStrictEqual(s[2].missing, [{ name: 'cheese', need: 1, unit: 'cup' }]);
  // not enough of something counts as short by the difference
  const short = kitchen(['8 oz ground beef'], [{ name: 'Burgers', ings: ['1 lb ground beef'] }]);
  assert.deepStrictEqual(k.suggestMeals(short)[0].missing, [{ name: 'ground beef', need: 0.5, unit: 'lb' }]);
});

test('making a meal takes what it used out of the pantry', () => {
  const kt = kitchen(['2 lb ground beef', '1 can kidney beans', 'onion'], [
    { id: 'chili', name: 'Chili', ings: ['1 lb ground beef', '1 can kidney beans', '1 onion', 'salt', '1 tsp cumin'], planned: true },
  ]);
  const r = k.cookRecipe(kt, 'chili', new Date('2026-11-08T18:00:00').getTime());
  assert.deepStrictEqual(r, { used: ['ground beef'], ranOut: ['kidney beans'], unsure: ['onion'], missing: ['cumin'] });
  assert.strictEqual(kt.items.find((i) => i.name === 'ground beef').qty, 1);
  assert.ok(!kt.items.some((i) => i.name === 'kidney beans'));
  assert.strictEqual(kt.tombstones.length, 1);
  const chili = kt.recipes[0];
  assert.deepStrictEqual(chili.made, ['2026-11-08']);
  assert.strictEqual(chili.planned, false);
  // a different unit of the same kind still subtracts
  const oz = kitchen(['2 lb ground beef'], [{ id: 'b', name: 'Burgers', ings: ['8 oz ground beef'] }]);
  k.cookRecipe(oz, 'b');
  assert.strictEqual(oz.items[0].qty, 1.5);
});

test('the shopping list adds up planned meals and takes off what he has', () => {
  const kt = kitchen(['1 lb ground beef', 'tortillas'], [
    { name: 'Tacos', ings: ['1 lb ground beef', 'tortillas', '1 cup cheese'], planned: true, liked: true },
    { name: 'Chili', ings: ['1 lb ground beef', '1 can kidney beans', 'salt'], planned: true },
    { name: 'Pancakes', ings: ['2 cups flour'] },
  ]);
  assert.deepStrictEqual(k.shoppingList(kt), [
    { name: 'cheese', qty: 1, unit: 'cup', for: ['Tacos'] },
    { name: 'ground beef', qty: 1, unit: 'lb', for: ['Tacos', 'Chili'] },
    { name: 'kidney beans', qty: 1, unit: 'can', for: ['Chili'] },
  ]);
});

test('groceries bought go into the pantry, with their size when the name has one', () => {
  const kt = kitchen(['1 lb rice'], []);
  const added = k.stockPantry(kt, ['Rice, 20 lb', 'Eggs', 'Milk, 1 gallon'], 1, id);
  assert.deepStrictEqual(added, ['rice', 'Eggs', 'Milk']);
  assert.strictEqual(kt.items.find((i) => i.name === 'rice').qty, 21);
  assert.strictEqual(kt.items.find((i) => i.name === 'Eggs').qty, null);
  assert.deepStrictEqual([kt.items.find((i) => i.name === 'Milk').qty, kt.items.find((i) => i.name === 'Milk').unit], [1, 'gal']);
});

test('"we\'re out of eggs" takes eggs out of the pantry, and an exact name keeps a looser one', () => {
  const kt = kitchen(['12 large eggs', '1 gallon milk', '1 qt almond milk', '2 lb rice'], []);
  const gone = k.pantryRanOut(kt, ['eggs', 'milk', 'cheese'], 5);
  assert.deepStrictEqual(gone, ['large eggs', 'milk']); // no exact "eggs", so "large eggs" goes; "milk" leaves the almond milk
  assert.deepStrictEqual(kt.items.map((i) => i.name).sort(), ['almond milk', 'rice']);
  assert.strictEqual(kt.tombstones.length, 2); // so a sync doesn't bring them back
  assert.deepStrictEqual(k.pantryRanOut(kt, ['egg noodles'], 6), []);
});

test('an ordered item brings its picture and count into the pantry, and the picture survives a sync', () => {
  const kt = kitchen(['rice'], []);
  k.stockPantry(kt, [{ name: 'Bananas, 3 ct', image: 'https://img.example/bananas.jpg' }, { name: 'Rice, 2 lb', image: 'https://img.example/rice.jpg' }], 1, id);
  const ban = kt.items.find((i) => i.name === 'Bananas');
  assert.deepStrictEqual([ban.qty, ban.image], [3, 'https://img.example/bananas.jpg']);
  assert.strictEqual(kt.items.find((i) => i.name === 'rice').image, 'https://img.example/rice.jpg'); // fills in a picture it didn't have
  assert.strictEqual(k.normKitchen({ items: [ban] }).items[0].image, 'https://img.example/bananas.jpg');
  assert.strictEqual(k.normKitchen({ items: [{ id: 'x', name: 'x', image: 'javascript:alert(1)' }] }).items[0].image, undefined);
});

test('two devices merge: newer copy wins, a delete beats an older copy', () => {
  const a = { items: [{ id: 'e', name: 'eggs', qty: 6, updatedAt: 5 }, { id: 'm', name: 'milk', updatedAt: 1 }], recipes: [], tombstones: [] };
  const b = { items: [{ id: 'e', name: 'eggs', qty: 3, updatedAt: 9 }], recipes: [{ id: 'r', name: 'Omelet', ingredients: ['2 eggs'], updatedAt: 2 }], tombstones: [{ id: 'm', deletedAt: 4 }] };
  const r = k.mergeKitchenDocs(a, b, 10);
  assert.deepStrictEqual(r.merged.items.map((i) => [i.name, i.qty]), [['eggs', 3]]);
  assert.strictEqual(r.merged.recipes[0].ingredients[0].name, 'eggs');
  assert.ok(r.changedLocal);
  assert.ok(!k.mergeKitchenDocs(r.merged, r.merged, 10).changedRemote);
});
