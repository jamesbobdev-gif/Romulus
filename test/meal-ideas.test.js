const test = require('node:test');
const assert = require('node:assert');
const { prompt, input, parse } = require('../agent/meal-ideas');

test('the ask carries his pantry, aim, preferences, liked recipes and usual groceries', () => {
  const t = input({ pantry: [{ name: 'Chicken breast', qty: 2, unit: 'lb' }, { name: 'Spinach' }],
    recipes: [{ name: 'Salad' }, { name: 'Turkey bowl', liked: true }], usual: ['Eggs', 'Kiwis'],
    prefs: '## Groceries\n- Allergies or foods you avoid: Gluten', aim: 'high protein' });
  assert.match(t, /What he wants this time\nhigh protein/);
  assert.match(t, /- 2 lb Chicken breast\n- Spinach/);
  assert.match(t, /- Turkey bowl \(likes it\)\n- Salad/);
  assert.match(t, /What he usually buys\nEggs, Kiwis/);
  assert.match(t, /foods you avoid: Gluten/);
  assert.match(prompt(), /never use a food he avoids/);
});

test('no preferences or recipes still makes a usable ask', () => {
  const t = input({ pantry: [], recipes: [], usual: [], prefs: '', aim: '' });
  assert.match(t, /His preferences\n\(none saved\)/);
  assert.match(t, /His pantry \(what he has now\)\n\(empty\)/);
  assert.doesNotMatch(t, /What he wants|Recipes he has|usually buys/);
});

test('the answer: meals with ingredients only, no repeats, no emoji, text around the JSON ignored', () => {
  const text = 'Here you go:\n{"meals":[{"name":"Chicken and spinach skillet \u{1F525}","why":"about 50 g protein",' +
    '"ingredients":["8 oz chicken breast","2 cups spinach"],"steps":["Cook the chicken","Add spinach"]},' +
    '{"name":"chicken and spinach skillet","ingredients":["x"]},{"name":"No ingredients","ingredients":[]},"junk"]}\nEnjoy';
  assert.deepStrictEqual(parse(text), [{ name: 'Chicken and spinach skillet', why: 'about 50 g protein',
    ingredients: ['8 oz chicken breast', '2 cups spinach'], steps: ['Cook the chicken', 'Add spinach'] }]);
  assert.deepStrictEqual(parse('no json here'), []);
  assert.deepStrictEqual(parse('{"meals":"nope"}'), []);
});
