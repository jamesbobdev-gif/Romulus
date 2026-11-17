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

test('his Food plan goes in with one meal\'s share of it', () => {
  const t = input({ pantry: [{ name: 'Eggs', qty: 12 }], plan: { kcal: 2100, protein: 160, fat: 70 } });
  assert.match(t, /## His daily Food plan \(for him alone\)\n2100 kcal, 160 g protein, 70 g fat a day\. One meal's share: about 700 kcal, 53 g protein, 23 g fat\./);
  assert.match(prompt(), /size each meal to one meal's share/);
  assert.match(prompt(), /never more of a pantry food than the pantry lists/);
  assert.doesNotMatch(input({ pantry: [], plan: {} }), /Food plan/);
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

// what AIs really send back: each of these used to come back as no meals at all
const meal = (i) => ({ name: 'Meal ' + i, why: 'about 40 g protein', ingredients: ['8 oz chicken breast', '1 cup rice'], steps: ['Cook the rice', 'Cook the chicken'] });
const six = JSON.stringify({ meals: [1, 2, 3, 4, 5, 6].map(meal) }, null, 2);

test('the answer reads through thinking notes, code fences, words with braces after it and a trailing comma', () => {
  assert.strictEqual(parse('<think>first {a plan} for this</think>\n' + six).length, 6);
  assert.strictEqual(parse('```json\n' + six + '\n```').length, 6);
  assert.strictEqual(parse(six + '\nWant more? {just ask}').length, 6);
  assert.strictEqual(parse(six.replace(/\]\s*\}\s*$/, '],\n}')).length, 6);
  assert.strictEqual(parse(six.replace('"Meal 1"', '“Meal 1”')).length, 6);
});

test('an answer cut off at its length limit keeps every whole meal before the cut', () => {
  const cut = six.slice(0, six.indexOf('"Meal 5"') + 20);
  assert.deepStrictEqual(parse(cut).map((m) => m.name), ['Meal 1', 'Meal 2', 'Meal 3', 'Meal 4']);
});

test('other shapes: a bare list, another name for the list, lines as text, ingredients as objects, numbered steps', () => {
  assert.strictEqual(parse(JSON.stringify([meal(1), meal(2)])).length, 2);
  assert.strictEqual(parse(JSON.stringify({ recipes: [meal(1)] })).length, 1);
  assert.deepStrictEqual(parse(JSON.stringify({ meals: [
    { title: 'Eggs on toast', ingredients: '2 eggs, 1 slice bread (toasted)', instructions: '1. Toast the bread. 2. Fry the eggs.' },
    { name: 'Rice bowl', ingredients: [{ amount: 1, unit: 'cup', item: 'rice' }, { quantity: '2', name: 'eggs' }], steps: ['Step 1: Cook the rice'] },
  ] })), [
    { name: 'Eggs on toast', why: '', ingredients: ['2 eggs', '1 slice bread (toasted)'], steps: ['Toast the bread.', 'Fry the eggs.'] },
    { name: 'Rice bowl', why: '', ingredients: ['1 cup rice', '2 eggs'], steps: ['Cook the rice'] },
  ]);
});

test('the computer asks for room for whole recipes, and the cloud when Lupa answers without meals', async () => {
  const kitchenAi = require('../main/kitchen-ai');
  let seen = null;
  kitchenAi.init({ dataFile: () => 'no-such-file.json', agentLog: () => {},
    readPicture: async (q, img, maxTokens, usable) => { seen = { maxTokens, usable }; return { text: six, via: 'Claude' }; } });
  const r = await kitchenAi.handlers['kitchen:ideas'](null, { pantry: [{ name: 'Rice' }] });
  assert.strictEqual(r.meals.length, 6);
  assert.ok(seen.maxTokens >= 6000);
  assert.strictEqual(seen.usable('Sorry, I can\'t help with that.'), false);
  assert.strictEqual(seen.usable(six), true);
});

const { followPrompt, followInput, parseFollow } = require('../agent/meal-ideas');

test('a follow-up carries the meal, what he asked before, his pantry and what he says now', () => {
  const t = followInput({ meal: { name: 'Egg fried rice', why: 'quick', ingredients: ['2 eggs', '1 cup rice'], steps: ['Cook rice', 'Add eggs'] },
    talk: [{ q: 'how long?', a: 'About 15 minutes.' }], said: 'add spinach', pantry: [{ name: 'Spinach' }], prefs: '' });
  assert.match(t, /## The meal\nEgg fried rice\nquick\nIngredients:\n- 2 eggs\n- 1 cup rice\nSteps:\n1\. Cook rice\n2\. Add eggs/);
  assert.match(t, /He: how long\?\nYou: About 15 minutes\./);
  assert.match(t, /- Spinach/);
  assert.match(t, /## What he says now\nadd spinach$/);
  assert.match(followPrompt(), /"meal" is null/);
});

test('a follow-up answer: a reply alone, a reply with the meal rewritten, or plain words', () => {
  assert.deepStrictEqual(parseFollow('{"reply":"About 15 minutes.","meal":null}'), { reply: 'About 15 minutes.', meal: null });
  const c = parseFollow('{"reply":"Added spinach.","meal":{"name":"Egg fried rice with spinach","why":"quick","ingredients":["2 eggs","1 cup rice","1 cup spinach"],"steps":["Cook"]}}');
  assert.strictEqual(c.reply, 'Added spinach.');
  assert.deepStrictEqual(c.meal.ingredients, ['2 eggs', '1 cup rice', '1 cup spinach']);
  assert.deepStrictEqual(parseFollow('It takes about 15 minutes.'), { reply: 'It takes about 15 minutes.', meal: null });
  assert.strictEqual(parseFollow(''), null);
});
