const test = require('node:test');
const assert = require('node:assert');
const { itemDue, groceryBrief, groceryChanges, groceryListFor, isFoodTask, foodBrief } = require('../agent/grocery');

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

test('a grocery run gets his macro plan per day, with the days left; none once it ran out or when nothing is set', () => {
  const { macroBrief } = require('../agent/grocery');
  const now = day('2026-11-07');
  const b = macroBrief(JSON.stringify({ kcal: 2100, protein: 160, carbs: '200', fat: 0, span: 'week', from: '2026-11-05', until: '2026-11-11', at: 5 }), now);
  assert.deepStrictEqual(b.perDay, { kcal: 2100, protein: 160, carbs: 200 });
  assert.strictEqual(b.until, '2026-11-11');
  assert.strictEqual(b.daysLeft, 5);
  assert.strictEqual(b.today, '2026-11-07');
  const open = macroBrief(JSON.stringify({ protein: 150, span: 'open' }), now);
  assert.deepStrictEqual(open.perDay, { protein: 150 });
  assert.strictEqual(open.until, undefined);
  assert.strictEqual(macroBrief(JSON.stringify({ protein: 150, until: '2026-11-06' }), now), undefined); // ended yesterday
  assert.strictEqual(macroBrief(JSON.stringify({ span: 'week', until: '2026-11-20' }), now), undefined); // no numbers
  assert.strictEqual(macroBrief('', now), undefined);
  assert.strictEqual(macroBrief('not json', now), undefined);
});

test('a meal plan’s macros: per-day numbers and how long, nothing without numbers', () => {
  const { macroChanges } = require('../agent/grocery');
  assert.deepStrictEqual(macroChanges({ kcal: '2100', protein: 160.2, carbs: 0, fat: 65, span: 'month' }), { kcal: 2100, protein: 160, fat: 65, span: 'month' });
  assert.deepStrictEqual(macroChanges({ protein: 150, span: 'forever' }), { protein: 150, span: 'week' });
  assert.strictEqual(macroChanges({ span: 'week' }), undefined);
  assert.strictEqual(macroChanges([2100]), undefined);
  assert.strictEqual(macroChanges(null), undefined);
});

test('the meal-plan skill matches meal planning, not everyday tasks', () => {
  const { loadSkills } = require('../agent/task-context');
  const s = loadSkills().find((x) => x.name === 'meal-plan');
  assert.ok(s && s.match && !s.browser);
  for (const t of ['help me plan my meals for the week', 'meal plan', 'I want to lose weight', 'meal prep for 2 weeks', 'set my macros', 'eat more protein'])
    assert.ok(s.match.test(t), t);
  for (const t of ['cut the grass', 'book a haircut', 'order groceries', 'plan the trip to Denver', 'what time is the game'])
    assert.ok(!s.match.test(t), t);
});

test('a food task that is not an order sees his usual groceries, pantry and recipes, liked first', () => {
  const tasks = [{ ws: 'agent', created: 1, list: ['Old'] }, { ws: 'agent', created: 2, list: ['Eggs', { name: 'Kiwis', every: 2 }] }];
  const kitchen = { items: [{ name: 'Chicken breast', qty: 2, unit: 'lb' }, { name: 'Salt', qty: null, unit: '' }],
    recipes: [{ name: 'Salad', ingredients: [{ name: 'spinach' }], liked: false, made: [] },
      { name: 'Turkey bowl', ingredients: [{ name: 'ground turkey' }, { name: 'sweet potato' }], liked: true, made: ['2026-11-01', '2026-11-05'] }] };
  const t = { ws: 'agent', title: 'I want eat 1 gram of protein for every pound of weight' };
  assert.strictEqual(isFoodTask(t), true);
  assert.deepStrictEqual(foodBrief(t, tasks, kitchen), {
    usualGroceries: ['Eggs', 'Kiwis'],
    pantry: [{ name: 'Chicken breast', amount: '2 lb' }, { name: 'Salt', amount: undefined }],
    recipes: [{ name: 'Turkey bowl', liked: true, timesMade: 2, ingredients: ['ground turkey', 'sweet potato'] },
      { name: 'Salad', liked: undefined, timesMade: undefined, ingredients: ['spinach'] }],
  });
});

test('no food brief for other tasks, or when he has nothing saved; an order keeps its list as groceryList', () => {
  assert.strictEqual(foodBrief({ ws: 'agent', title: 'Find a flight to Denver' }, [{ ws: 'agent', list: ['Eggs'] }], {}), undefined);
  assert.strictEqual(foodBrief({ ws: 'agent', title: 'Plan my meals' }, [], {}), undefined);
  const order = foodBrief({ ws: 'agent', title: 'Order groceries' }, [{ ws: 'agent', list: ['Eggs'] }], { items: [{ name: 'Rice' }] });
  assert.deepStrictEqual(order, { usualGroceries: undefined, pantry: [{ name: 'Rice', amount: undefined }], recipes: undefined });
});
