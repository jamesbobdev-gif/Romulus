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
  assert.deepStrictEqual([r.used, r.ranOut, r.unsure, r.missing], [['ground beef'], ['kidney beans'], ['onion'], ['cumin']]);
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

test('a meal photo takes the sure foods out and leaves the guesses to ask about', () => {
  const kk = kitchen(['2 lb chicken breast', '4 cups rice', 'soy sauce', '6 eggs'], []);
  const r = k.usePantry(kk, [
    { name: 'chicken breast', qty: 8, unit: 'oz', sure: true },
    { name: 'rice', qty: 1, unit: 'cup', sure: true },
    { name: 'soy sauce', qty: 1, unit: 'tbsp', sure: true }, // no amount in the pantry: ask
    { name: 'eggs', qty: 2, unit: '', sure: false }, // a guess: ask, don't take out
    { name: 'broccoli', qty: 1, unit: 'cup', sure: true }, // not in the pantry
  ], 1000);
  assert.deepStrictEqual(r.used.sort(), ['chicken breast', 'rice']);
  assert.deepStrictEqual(r.unsure.sort(), ['eggs', 'soy sauce']);
  assert.deepStrictEqual(r.missing, ['broccoli']);
  const find = (n) => kk.items.find((i) => i.name === n);
  assert.strictEqual(find('chicken breast').qty, 1.5);
  assert.strictEqual(find('rice').qty, 3);
  assert.strictEqual(find('eggs').qty, 6);
});

test('the to-do asks about the guesses, and a checked one takes that food out', () => {
  const kk = kitchen(['soy sauce', '6 eggs', '1 onion'], []);
  const todo = k.pantryAskTodo(kk, ['soy sauce', 'eggs', 'not there'], 'Fried rice', id);
  assert.match(todo.title, /Fried rice/);
  assert.deepStrictEqual(todo.subs.map((s) => s.title), ['Soy sauce is used up', 'Eggs is used up']);
  assert.strictEqual(k.pantryAskTodo(kk, ['not there'], 'x', id), null);
  assert.deepStrictEqual(k.pantryAnswers(kk, [todo], 5), []); // nothing checked yet
  todo.subs[0].done = true;
  const gone = k.pantryAnswers(kk, [todo, { id: 'other', subs: [{ id: 'plain', done: true }] }], 5);
  assert.deepStrictEqual(gone.map((g) => g.name), ['soy sauce']);
  assert.deepStrictEqual(kk.items.map((i) => i.name).sort(), ['eggs', 'onion']);
  assert.ok(kk.tombstones.some((t) => t.id === gone[0].id));
  assert.deepStrictEqual(k.pantryAnswers(kk, [todo], 6), []); // once only
});

test('cooking a recipe still takes its ingredients out', () => {
  const kk = kitchen(['2 lb ground beef', 'onion'], [{ id: 'r1', name: 'Chili', ings: [k.parseIngredient('1 lb ground beef'), k.parseIngredient('1 onion')] }]);
  const r = k.cookRecipe(kk, 'r1', 1000);
  assert.deepStrictEqual(r.used, ['ground beef']);
  assert.deepStrictEqual(r.unsure, ['onion']);
  assert.strictEqual(kk.recipes[0].made.length, 1);
});

test('a phone photo ask syncs, moves only forward, and is read by one other computer', () => {
  const ask = { id: 'a1', mode: 'meal', url: 'https://x.supabase.co/storage/v1/object/public/agent-attachments/tk_agent_att_ab/p.jpg', from: 'phone', at: 100, updatedAt: 100, state: 'waiting' };
  const phone = k.normKitchen({ items: [], asks: [ask, { id: 'bad', mode: 'meal', url: 'http://evil' }] });
  assert.deepStrictEqual(phone.asks.map((a) => a.id), ['a1']);
  assert.strictEqual(k.askToServe(phone, 'phone', 200), null); // not its own
  const pc = k.normKitchen({ items: [], asks: [ask] });
  const mine = k.askToServe(pc, 'pc', 200);
  assert.strictEqual(mine.id, 'a1');
  Object.assign(mine, { state: 'reading', reader: 'PC', readAt: 200, updatedAt: 200 });
  assert.strictEqual(k.askToServe(pc, 'lupa', 300), null); // taken a moment ago
  assert.ok(k.askToServe(pc, 'lupa', 200 + 6 * 60000)); // the reader went quiet
  // done on the computer, applied on the phone: a later "done" from a second reader can't undo the applied
  const done = k.mergeKitchenDocs(pc, { items: [], asks: [Object.assign({}, ask, { state: 'done', updatedAt: 400, result: { meal: 'x', used: [] } })] }, 500).merged;
  assert.strictEqual(done.asks[0].state, 'done');
  const applied = k.mergeKitchenDocs({ items: [], asks: [Object.assign({}, ask, { state: 'applied', updatedAt: 450 })] }, { items: [], asks: [Object.assign({}, ask, { state: 'done', updatedAt: 900 })] }, 1000);
  assert.strictEqual(applied.merged.asks[0].state, 'applied');
  assert.ok(applied.changedRemote);
  // a day after it was applied it leaves the doc, and stays gone after a merge
  const kk = applied.merged;
  assert.strictEqual(k.pruneAsks(kk, 450 + 2 * 864e5), 1);
  assert.deepStrictEqual(k.mergeKitchenDocs(kk, { items: [], asks: [ask] }, 450 + 2 * 864e5).merged.asks, []);
});

test('kPantryLines: the Add box takes one food per comma, as its hint shows', () => {
  const k = require('../renderer/js/kitchen.js');
  const got = k.kPantryLines('2.39 lb tomatoes, 12 kiwis, 2 bag avocados, 10.2 lb bananas, salmon, orange peppers, 4.29 lb chicken breast, 1 pack chicken breast, 2 ground turkey, 10.11 lb yams, spring mix, hummus, russet potatoes, raspberries, baby spinach');
  assert.strictEqual(got.length, 15);
  assert.deepStrictEqual(got[0], { name: 'tomatoes', qty: 2.39, unit: 'lb' });
  assert.deepStrictEqual(got[1], { name: 'kiwis', qty: 12, unit: '' });
  assert.strictEqual(got[14].name, 'baby spinach');
  assert.deepStrictEqual(k.kPantryLines('2 lb chicken, eggs, 1 bag rice').map((i) => i.name), ['chicken', 'eggs', 'rice']);
  assert.deepStrictEqual(k.kPantryLines('eggs\nmilk; bread').map((i) => i.name), ['eggs', 'milk', 'bread']);
  assert.deepStrictEqual(k.kPantryLines(' , ,'), []);
});

test('a phone can send a typed meal to a computer with no picture', () => {
  const k = require('../renderer/js/kitchen');
  const r = k.normKitchen({ items: [], asks: [
    { id: 's1', mode: 'meal', said: '  chicken and rice ', from: 'phone', at: 1, updatedAt: 1 },
    { id: 's2', mode: 'food', said: 'eggs', from: 'phone', at: 1, updatedAt: 1 },
  ] });
  assert.deepStrictEqual(r.asks.map((a) => [a.id, a.said, a.url]), [['s1', 'chicken and rice', '']]);
});

test('Made it can be undone: the food comes back and the recipe is not marked made', () => {
  const kt = kitchen(['2 lb ground beef', '1 can kidney beans', 'onion', '6 eggs'], [
    { id: 'chili', name: 'Chili', ings: ['1 lb ground beef', '1 can kidney beans', '1 onion'], planned: true },
  ]);
  const r = k.cookRecipe(kt, 'chili', 1000);
  assert.deepStrictEqual(r.before.items.map((i) => i.name).sort(), ['ground beef', 'kidney beans']); // only what it changed
  kt.items.find((i) => i.name === 'eggs').qty = 4; // he ate two eggs in between: that stays
  k.uncookRecipe(kt, r.before, 2000);
  assert.strictEqual(kt.items.find((i) => i.name === 'ground beef').qty, 2);
  assert.strictEqual(kt.items.find((i) => i.name === 'kidney beans').qty, 1);
  assert.strictEqual(kt.items.find((i) => i.name === 'eggs').qty, 4);
  assert.deepStrictEqual([kt.recipes[0].made, kt.recipes[0].planned], [[], true]);
  // the beans were deleted at 1000 and put back at 2000: a sync keeps them
  const m = k.mergeKitchenDocs(kt, { items: [], recipes: [] }, 3000).merged;
  assert.ok(m.items.some((i) => i.name === 'kidney beans'));
});

test('servings: a recipe says how many it makes, and Made it takes out what he made', () => {
  const kt = k.normKitchen({
    items: [{ id: 'r', name: 'rice', qty: 4, unit: 'cup' }, { id: 'c', name: 'chicken', qty: 3, unit: 'lb' }],
    recipes: [{ id: 'cr', name: 'Chicken and rice', servings: 4, ingredients: ['2 cups rice', '2 lb chicken'] },
      { id: 'one', name: 'Rice bowl', servings: 1, ingredients: ['1 cup rice'] }],
  });
  assert.deepStrictEqual(kt.recipes.map((r) => r.servings), [4, undefined]); // 1 is not kept
  assert.deepStrictEqual(k.suggestMeals(kt).map((s) => s.missing.length), [0, 0]);
  // eight servings is twice the recipe: one more pound of chicken than he has
  const big = k.suggestMeals(kt, { cr: 8 }).find((s) => s.recipe.id === 'cr');
  assert.deepStrictEqual(big.missing, [{ name: 'chicken', need: 1, unit: 'lb' }]);
  k.cookRecipe(kt, 'cr', 1000, 2); // half of it
  assert.deepStrictEqual(kt.items.map((i) => [i.name, i.qty]), [['rice', 3], ['chicken', 2]]);
  k.cookRecipe(kt, 'one', 2000, 3); // three bowls: the rice is gone
  assert.ok(!kt.items.some((i) => i.name === 'rice'));
});

test('where food is kept: what he picked, or a guess from the name', () => {
  assert.strictEqual(k.kPlaceOf({ name: 'Whole milk' }), 'fridge');
  assert.strictEqual(k.kPlaceOf({ name: 'Large eggs' }), 'fridge');
  assert.strictEqual(k.kPlaceOf({ name: 'Frozen peas' }), 'freezer');
  assert.strictEqual(k.kPlaceOf({ name: 'Peanut butter' }), 'cupboard');
  assert.strictEqual(k.kPlaceOf({ name: 'Chicken broth' }), 'cupboard');
  assert.strictEqual(k.kPlaceOf({ name: 'Rice' }), 'cupboard');
  assert.strictEqual(k.kPlaceOf({ name: 'Rice', where: 'freezer' }), 'freezer');
  const it = k.normKitchen({ items: [{ id: 'a', name: 'bread', where: 'freezer' }, { id: 'b', name: 'jam', where: 'garage' }] }).items;
  assert.deepStrictEqual(it.map((i) => i.where), ['freezer', undefined]);
});

test('the plus and minus beside an amount step by the size of it', () => {
  assert.strictEqual(k.kNudge(6, '', 1), 7);
  assert.strictEqual(k.kNudge(1, '', -1), 0); // the last one: none left
  assert.strictEqual(k.kNudge(2, 'lb', -1), 1.5);
  assert.strictEqual(k.kNudge(0.5, 'lb', -1), 0);
  assert.strictEqual(k.kNudge(5, 'lb', -1), 4.5);
  assert.strictEqual(k.kNudge(5, 'lb', 1), 6);
  assert.strictEqual(k.kNudge(500, 'g', -1), 450);
  assert.strictEqual(k.kNudge(2, 'can', 1), 3); // cans are counted
  assert.strictEqual(k.kNudge(null, '', 1), 1);
  assert.strictEqual(k.kNudge(null, '', -1), null);
});

test('finding: every word typed is somewhere in the name', () => {
  assert.ok(k.kMatch('Chicken and rice', 'chick ri'));
  assert.ok(k.kMatch('Chicken and rice', ''));
  assert.ok(!k.kMatch('Chicken and rice', 'beef'));
});

test('meal ideas are kept and the newer set wins a sync', () => {
  const meal = (name) => ({ name, why: 'quick', ingredients: ['2 eggs'], steps: ['Cook.'] });
  const pc = k.normKitchen({ items: [], ideas: { at: 2000, via: 'Lupa', aim: 'high protein', meals: [meal('Omelet'), { name: 'No food', ingredients: [] }] } });
  assert.deepStrictEqual(pc.ideas.meals.map((m) => m.name), ['Omelet']);
  assert.strictEqual(k.normKitchen({ items: [], ideas: { at: 1, meals: [] } }).ideas, null);
  const phone = k.normKitchen({ items: [], ideas: { at: 1000, via: 'Claude', meals: [meal('Toast')] } });
  const m = k.mergeKitchenDocs(phone, pc, 3000);
  assert.strictEqual(m.merged.ideas.meals[0].name, 'Omelet');
  assert.ok(m.changedLocal && !m.changedRemote);
  assert.strictEqual(k.mergeKitchenDocs(pc, { items: [] }, 3000).merged.ideas.via, 'Lupa'); // an older app's row has none
});

test('a phone can ask a computer for meal ideas, with or without something to aim for', () => {
  const r = k.normKitchen({ items: [], asks: [
    { id: 'i1', mode: 'ideas', said: ' high protein ', from: 'phone', at: 1, updatedAt: 1 },
    { id: 'i2', mode: 'ideas', from: 'phone', at: 2, updatedAt: 2 },
    { id: 'i3', mode: 'plans', said: 'x', from: 'phone', at: 3, updatedAt: 3 },
  ] });
  assert.deepStrictEqual(r.asks.map((a) => [a.id, a.said, a.url]), [['i1', 'high protein', ''], ['i2', '', '']]);
  assert.strictEqual(k.askToServe(r, 'pc', 10).id, 'i1');
});

test('things he adds himself go on the shopping list, with or without a meal planned', () => {
  const kt = kitchen(['1 gal milk'], [{ name: 'Omelet', ings: ['3 eggs'], planned: true }]);
  assert.deepStrictEqual(k.addToShop(kt, ['milk', '2 lb apples', 'eggs'], 1, id), ['milk', 'apples', 'eggs']);
  k.addToShop(kt, ['1 lb apples'], 2, id); // the same food again adds to it
  const list = k.shoppingList(kt);
  // milk is in the pantry, but he asked for it, so it stays; eggs fold into the omelet's line
  assert.deepStrictEqual(list.map((e) => [e.name, e.qty, e.unit, e.for]), [
    ['apples', 3, 'lb', []], ['eggs', 3, '', ['Omelet']], ['milk', null, '', []]]);
  assert.ok(list.every((e) => e.id));
  // it syncs: the other device sees it, and a removal wins over the older add
  const other = k.mergeKitchenDocs(k.normKitchen({}), kt, 3).merged;
  assert.strictEqual(other.extra.length, 3);
  assert.strictEqual(k.dropFromShop(kt, ['Apples, 3 lb'], 4), 1);
  const back = k.mergeKitchenDocs(other, kt, 5).merged;
  assert.deepStrictEqual(back.extra.map((e) => e.name).sort(), ['eggs', 'milk']);
});

test('a size in brackets at the end of a product name is the amount, the way Instacart writes it', () => {
  assert.deepStrictEqual(k.kSized('Bananas (10.2 lb)'), { base: 'Bananas', qty: 10.2, unit: 'lb' });
  assert.deepStrictEqual(k.kSized('Kiwi (1 each)'), { base: 'Kiwi', qty: 1, unit: '' });
  assert.deepStrictEqual(k.kSized('Pier33 Atlantic Salmon, Boneless, Skin On Portions (2 lb)'), { base: 'Pier33 Atlantic Salmon', qty: 2, unit: 'lb' });
  assert.deepStrictEqual(k.kSized('Chicken Breast, 24 oz, frozen'), { base: 'Chicken Breast', qty: 24, unit: 'oz' });
  assert.deepStrictEqual(k.kSized('Ground beef or turkey, 93% lean'), { base: 'Ground beef or turkey', qty: null, unit: '' }); // not a size
  assert.deepStrictEqual(k.kSized('Sweet Potato (Yam)'), { base: 'Sweet Potato (Yam)', qty: null, unit: '' });
  const kt = kitchen([], []);
  k.stockPantry(kt, ['Bananas (10.2 lb)', 'Lean Ground Turkey (16 oz)', 'Lean Ground Turkey (16 oz)', 'Ground beef or turkey, 93% lean'], 1, id);
  assert.deepStrictEqual(kt.items.map((i) => [i.name, i.qty, i.unit]), [['Bananas', 10.2, 'lb'], ['Lean Ground Turkey', 32, 'oz'], ['Ground beef or turkey', null, '']]);
});

test('pantry items that went in with the size in their name get it as their amount', () => {
  const kt = { items: [
    { id: 'a', name: 'Bananas (10.2 lb)', qty: null, unit: '' },
    { id: 'b', name: 'Lean Ground Turkey (16 oz)', qty: 2, unit: '' }, // two packs
    { id: 'c', name: 'Kiwi (1 each)', qty: 12, unit: '' },
    { id: 'd', name: 'Milk (whole)', qty: null, unit: '' }, // not a size: left alone
    { id: 'e', name: 'Rice (5 lb)', qty: 3, unit: 'lb' }, // he set an amount himself: left alone
  ] };
  assert.strictEqual(k.kFixSized(kt, 9), 3);
  assert.deepStrictEqual(kt.items.map((i) => [i.name, i.qty, i.unit]),
    [['Bananas', 10.2, 'lb'], ['Lean Ground Turkey', 32, 'oz'], ['Kiwi', 12, ''], ['Milk (whole)', null, ''], ['Rice (5 lb)', 3, 'lb']]);
  assert.strictEqual(k.kFixSized(kt, 10), 0); // nothing left to do the next time
});
