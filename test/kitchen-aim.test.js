const test = require('node:test');
const assert = require('node:assert');
const { kAimSuggest, kAimRemember } = require('../renderer/js/kitchen-aim');

const texts = (list) => list.map((s) => s.text);

test('an empty box shows his recent aims first, then common ones, at most 8', () => {
  const out = kAimSuggest('', { recent: ['Spicy', 'Low carb'], pantry: ['Eggs'] });
  assert.deepStrictEqual(out.slice(0, 2), [{ text: 'Spicy', kind: 'recent' }, { text: 'Low carb', kind: 'recent' }]);
  assert.strictEqual(out.length, 8);
  assert.ok(!texts(out).some((t) => /Something with/.test(t)), 'pantry foods wait until he types');
  assert.strictEqual(texts(out).filter((t) => t === 'Low carb').length, 1, 'no repeats');
});

test('a Food plan sizes the protein and calorie aims to one meal', () => {
  const out = texts(kAimSuggest('', { plan: { kcal: 2100, protein: 160 } }));
  assert.ok(out.includes('High protein, about 53 g'));
  assert.ok(out.includes('Under 700 calories'));
  assert.ok(texts(kAimSuggest('', {})).includes('Under 600 calories'));
});

test('typing narrows them: starts-with first, every word has to match, pantry foods join in', () => {
  const ctx = { recent: ['Big dinner'], pantry: ['Chicken breast', 'Brown rice'] };
  assert.deepStrictEqual(texts(kAimSuggest('din', ctx)), ['Dinner', 'Big dinner']);
  assert.deepStrictEqual(texts(kAimSuggest('chick', ctx)), ['Something with chicken breast']);
  assert.deepStrictEqual(texts(kAimSuggest('with rice', ctx)), ['Something with brown rice']);
  assert.deepStrictEqual(kAimSuggest('dinner', ctx).map((s) => s.text), ['Big dinner'], 'what he typed exactly is not suggested back');
  assert.deepStrictEqual(kAimSuggest('zzz', ctx), []);
  assert.ok(!texts(kAimSuggest('d', ctx)).includes('Under 600 calories'), 'matches word starts, not the middle of a word');
  assert.ok(texts(kAimSuggest('d', ctx)).includes('One pan, few dishes'));
});

test('recent aims: newest first, no repeats in any case, at most 10', () => {
  assert.deepStrictEqual(kAimRemember(['Quick', 'Low carb'], ' low  carb '), ['low carb', 'Quick']);
  assert.deepStrictEqual(kAimRemember(['a'], ''), ['a']);
  const many = Array.from({ length: 12 }, (_, i) => 'aim ' + i);
  assert.strictEqual(kAimRemember(many, 'new').length, 10);
});
