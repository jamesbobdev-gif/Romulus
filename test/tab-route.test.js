const test = require('node:test');
const assert = require('node:assert');
const { tabRoute, trStockName } = require('../renderer/js/tab-route');

const ctx = { foods: ['Chicken', 'Rice', 'Milk'], recipes: [{ id: 'r1', name: 'Chili' }, { id: 'r2', name: 'Tacos' }] };
const route = (s, c) => tabRoute(s, c || ctx);

test('a daily health goal becomes a Health goal, worded so it ticks itself off', () => {
  assert.deepStrictEqual(route('I want to walk 10k steps a day'), { tab: 'health', kind: 'goal', goal: { kind: 'steps', target: 10000, title: 'Walk 10,000 steps' } });
  assert.deepStrictEqual(route('my goal is 8 hours of sleep every night').goal, { kind: 'sleep', target: 480, title: 'Sleep 8 hours' });
  assert.deepStrictEqual(route('run 30 min every day').goal, { kind: 'exercise', target: 30, title: 'Run 30 min' });
  assert.deepStrictEqual(route('I want to do 45 minutes of yoga daily').goal, { kind: 'exercise', target: 45, title: 'Yoga 45 min' });
  assert.deepStrictEqual(route("I'm trying to get 7.5 hours of sleep").goal.title, 'Sleep 7.5 hours');
});

test('Food plan numbers change just those numbers; a per-pound rule goes to the Agent', () => {
  assert.deepStrictEqual(route('I want 160 g of protein a day'), { tab: 'health', kind: 'plan', macros: { protein: 160, keep: true } });
  assert.deepStrictEqual(route('2,000 calories a day').macros, { kcal: 2000, keep: true });
  assert.deepStrictEqual(route('my calorie goal is 2,200').macros, { kcal: 2200, keep: true });
  assert.deepStrictEqual(route('eat 180 grams of protein and 250 g carbs daily').macros, { protein: 180, carbs: 250, keep: true });
  assert.deepStrictEqual(route('I want to eat 1 g of protein per pound'), { tab: 'health', kind: 'plan-ask' });
  assert.strictEqual(route('1 g of protein per pound', Object.assign({}, ctx, { agent: true })), null); // already an Agent task there
  assert.strictEqual(route('buy 2 lb of 80/20 beef'), null);
});

test('lifting and running goals land on the Health tab as training goals', () => {
  assert.deepStrictEqual(route('I want to bench 225 by March'), { tab: 'health', kind: 'training', title: 'Bench 225 by March' });
  assert.strictEqual(route('My goal is to run a half marathon').title, 'Run a half marathon');
  assert.strictEqual(route("I'm gonna start running 3 times a week").title, 'Start running 3 times a week');
  assert.strictEqual(route('I want to do 50 push-ups').title, 'Do 50 push-ups');
  assert.strictEqual(route('I want to lose 10 pounds').title, 'Lose 10 pounds');
});

test('what he has, used up, made, liked or plans goes to the Kitchen tab', () => {
  assert.deepStrictEqual(route('I have 2 lb of chicken and some rice'), { tab: 'kitchen', kind: 'stock', items: [{ name: 'chicken', qty: 2, unit: 'lb' }, { name: 'rice', qty: null, unit: '' }] });
  assert.deepStrictEqual(route('I just bought a dozen eggs').items, [{ name: 'eggs', qty: 12, unit: '' }]);
  assert.deepStrictEqual(route('just bought a dozen eggs').items, [{ name: 'eggs', qty: 12, unit: '' }]); // said without the "I"
  assert.strictEqual(route('picked up the kids'), null);
  assert.deepStrictEqual(route('there’s leftover soup in the fridge').items, [{ name: 'leftover soup', qty: null, unit: '' }]);
  assert.deepStrictEqual(route('add 3 cans of black beans to the pantry').items, [{ name: 'black beans', qty: 3, unit: 'can' }]);
  assert.deepStrictEqual(route('I used the last of the milk'), { tab: 'kitchen', kind: 'used', names: ['milk'] });
  assert.deepStrictEqual(route('the bread is gone').names, ['bread']);
  const made = route('I made the chili and loved it');
  assert.deepStrictEqual([made.kind, made.name, made.liked, made.recipe.id], ['made', 'Chili', true, 'r1']);
  const fresh = route('I made shrimp pasta for dinner');
  assert.deepStrictEqual([fresh.kind, fresh.name, fresh.recipe], ['made', 'Shrimp pasta', null]);
  assert.deepStrictEqual([route('the tacos were gross').kind, route('the tacos were gross').liked], ['liked', false]);
  assert.deepStrictEqual([route('I loved the chili').kind, route('I loved the chili').liked], ['liked', true]);
  assert.strictEqual(route('I want to make tacos this week').kind, 'plan');
  assert.strictEqual(trStockName({ name: 'chicken', qty: 2, unit: 'lb' }), 'Chicken, 2 lb');
  assert.strictEqual(trStockName({ name: 'eggs', qty: 12, unit: '' }), 'Eggs, 12');
});

test('everyday to-dos, questions and requests stay what they were', () => {
  for (const s of [
    'Walk 8000 steps', 'Call mom', 'I have a dentist appointment', 'I have to finish the essay', 'I have 2 hours of homework',
    'I need to train the new hire', "I'll run errands after work", 'I want to buy a bike', 'I want to watch the marathon',
    'I made a reservation for dinner', 'I had a meeting', 'I made the bed', 'I loved the movie', 'the car is gone',
    'there’s a game tonight', 'I got a new job', 'Book a 30 min meeting', 'Plan the 3 steps',
    'what can I make with chicken?', 'make me a running plan', 'how much protein should I eat',
    'can you find a 5k near me', 'I finished the essay', 'Gym #exercise 30', 'merge the PR', 'I want to merge the PR',
  ]) assert.strictEqual(route(s), null, s);
});
