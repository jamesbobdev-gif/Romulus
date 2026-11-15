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
  assert.deepStrictEqual(pp.parse('food', 'no'), { items: [], retake: '', more: '' });
});

test('the food and shop prompts ask about the picture itself: retake when none of it reads, more when part of it', () => {
  ['food', 'shop'].forEach((mode) => {
    const q = pp.prompt(mode, []);
    assert.match(q, /items is empty and retake is one short sentence/);
    assert.match(q, /make more one short sentence saying what another picture should show/);
    assert.match(q, /"retake":"","more":""/);
  });
  assert.match(pp.prompt('food', []), /back of the package/);
  assert.match(pp.prompt('shop', []), /cut off at the bottom/);
  assert.doesNotMatch(pp.prompt('meal', []), /retake/);
});

test('retake and more come through the parse as one clean sentence each, and "none" counts as nothing', () => {
  const r = pp.parse('food', '{"items":[],"retake":"Too dark to read the labels.  Take it again with the light on.","more":"none"}');
  assert.deepStrictEqual(r, { items: [], retake: 'Too dark to read the labels. Take it again with the light on.', more: '' });
  const m = pp.parse('shop', '{"items":[{"name":"eggs"}],"retake":null,"more":"The bottom of the list is cut off."}');
  assert.deepStrictEqual(m, { items: [{ name: 'eggs', amount: '' }], retake: '', more: 'The bottom of the list is cut off.' });
  assert.strictEqual(pp.parse('food', '{"items":[],"retake":"N/A","more":"Clear."}').retake, '');
  assert.strictEqual(pp.parse('food', '{"items":[],"retake":123}').retake, '');
});

test('result: nothing read is a retake (the AI’s reason, or a plain one), part read is the list with more', () => {
  assert.deepStrictEqual(pp.result('food', { items: [], retake: 'Too blurry.', more: '' }, 'Lupa'),
    { items: [], via: 'Lupa', retake: 'Too blurry.' });
  assert.deepStrictEqual(pp.result('food', { items: [], retake: '', more: '' }, 'Claude'),
    { items: [], via: 'Claude', retake: 'Claude didn’t see any food in that picture or receipt.' });
  assert.deepStrictEqual(pp.result('shop', { items: [], retake: '', more: '' }, 'Claude'),
    { items: [], via: 'Claude', retake: 'Claude didn’t see anything to buy in that picture.' });
  const eggs = [{ name: 'eggs', amount: '12' }];
  assert.deepStrictEqual(pp.result('food', { items: eggs, retake: '', more: 'The cans at the back face away.' }, 'Lupa'),
    { items: eggs, via: 'Lupa', more: 'The cans at the back face away.' });
  assert.deepStrictEqual(pp.result('food', { items: eggs, retake: '', more: '' }, 'Lupa'), { items: eggs, via: 'Lupa', more: '' });
  // a retake beside a list it still read is a more
  assert.strictEqual(pp.result('food', { items: eggs, retake: 'Half of it is dark.', more: '' }, 'Lupa').more, 'Half of it is dark.');
  // a meal is as before: the match, or why not
  assert.deepStrictEqual(pp.result('meal', { meal: 'Fried rice', used: [{ name: 'rice', amount: '1 cup', sure: true }] }, 'Lupa'),
    { meal: 'Fried rice', used: [{ name: 'rice', amount: '1 cup', sure: true }], via: 'Lupa' });
  assert.deepStrictEqual(pp.result('meal', { meal: '', used: [] }, 'Lupa'), { why: 'Lupa couldn’t match that meal to anything in the pantry.' });
});

test('a typed meal is asked in his words, with no picture', () => {
  const q = pp.prompt('meal', [{ name: 'rice', qty: 4, unit: 'cup' }], 'chicken and rice, 2 eggs');
  assert.match(q, /in his own words: "chicken and rice, 2 eggs"/);
  assert.match(q, /he named that food/);
  assert.doesNotMatch(q, /The picture/);
  assert.match(q, /- 4 cup rice/);
  assert.match(pp.prompt('meal', []), /The picture is a meal/);
});

test('a shopping-list photo asks for things to buy and reads back like food', () => {
  const q = pp.prompt('shop', [{ name: 'rice', qty: 4, unit: 'cup' }]);
  assert.match(q, /shopping list/);
  assert.match(q, /"items"/);
  assert.doesNotMatch(q, /rice/);
  assert.deepStrictEqual(pp.parse('shop', '{"items":[{"name":"Paper towels"},{"name":"milk","amount":"1 gal"}]}'),
    { items: [{ name: 'Paper towels', amount: '' }, { name: 'milk', amount: '1 gal' }], retake: '', more: '' });
});
