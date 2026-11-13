const test = require('node:test');
const assert = require('node:assert');
const { prompt, parse, slotsOf } = require('../agent/meal-prep');

test('the ask covers only the meals he picked, one Sunday cook, and food safety', () => {
  const p = prompt(['dinner', 'lunch']);
  assert.match(p, /exactly these meals: lunch, dinner\./);
  assert.match(p, /cooks once, on Sunday, for Monday to Sunday/);
  assert.match(p, /freezer for Thursday on/);
  assert.match(p, /never more of a food than the pantry lists/);
  assert.deepStrictEqual(slotsOf([]), ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.deepStrictEqual(slotsOf(['snack', 'bogus']), ['snack']);
});

const answer = JSON.stringify({
  prep: [
    { name: 'Chicken rice bowls', portions: 5, portion: '1 container', kcal: 650, protein: 50, ingredients: ['3 lb chicken breast', '4 cups rice'], steps: ['Cook rice', 'Bake chicken'], store: 'Mon-Wed fridge, rest freezer' },
    { name: 'chicken rice bowls', ingredients: ['x'] },
    { name: 'No ingredients', ingredients: [] },
  ],
  days: [
    { day: 'Monday', meals: [{ slot: 'dinner', dish: 'Chicken rice bowls' }, { slot: 'lunch', dish: 'Turkey sandwich', kcal: 450, protein: 30 }, { slot: 'breakfast', dish: 'Eggs' }] },
    { day: 'Mon', meals: [{ slot: 'lunch', dish: 'Duplicate day' }] },
    { day: 'Funday', meals: [{ slot: 'lunch', dish: 'x' }] },
    { day: 'Tue', meals: [] },
  ],
  buy: ['2 lb chicken breast', '2 LB chicken breast', 'Rice \u{1F35A}'],
  notes: ['Label the containers'],
});

test('the answer: dishes, days in order with only his meals, totals, a clean buy list', () => {
  const w = parse('Sure!\n' + answer, ['lunch', 'dinner']);
  assert.strictEqual(w.prep.length, 1);
  assert.deepStrictEqual(w.prep[0].portions, 5);
  assert.deepStrictEqual(w.days.map((d) => d.day), ['Mon']);
  assert.deepStrictEqual(w.days[0].meals.map((m) => m.slot), ['lunch', 'dinner'], 'breakfast was not picked; lunch before dinner');
  assert.deepStrictEqual(w.days[0].total, { kcal: 1100, protein: 80 }, 'a prep dish counts its portion, a no-cook meal its own numbers');
  assert.deepStrictEqual(w.buy, ['2 lb chicken breast', 'Rice']);
  assert.deepStrictEqual(w.notes, ['Label the containers']);
});

test('a day total leaves out a number some meal is missing', () => {
  const { dayTotals } = require('../agent/meal-prep');
  const prep = [{ name: 'Bowl', kcal: 600, protein: 50, carbs: 70 }];
  assert.deepStrictEqual(dayTotals({ meals: [{ dish: 'bowl' }, { dish: 'Apple', kcal: 95, protein: 1 }] }, prep), { kcal: 695, protein: 51 });
});

test('no dish or no day is no week', () => {
  assert.strictEqual(parse('nope'), null);
  assert.strictEqual(parse(JSON.stringify({ prep: [], days: [{ day: 'Mon', meals: [{ slot: 'lunch', dish: 'x' }] }] })), null);
  assert.strictEqual(parse(JSON.stringify({ prep: [{ name: 'A', ingredients: ['1 egg'] }], days: [] })), null);
});
