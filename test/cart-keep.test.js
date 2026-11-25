const test = require('node:test');
const assert = require('node:assert');
const { orderYesReply, cartOutcome } = require('../renderer/js/cart-keep');

const cart = [{ name: 'Eggs', food: true }];
const ask = 'Total $126.49 at Giant Eagle. Reply **yes** to place this order.';

test('orderYesReply: a plain go-ahead only', () => {
  ['yes', 'Yes!', 'ok place it', 'go ahead', 'yep'].forEach((s) => assert.ok(orderYesReply(s), s));
  ['yes?', 'yes but swap the milk', 'add more protein', 'not yet', '', 'what about bananas'].forEach((s) => assert.ok(!orderYesReply(s), s));
});

test('a follow-up answer with no cart keeps the cart and is not an order', () => {
  const r = cartOutcome({ cart }, { status: 'done', cart: null }, ask, 'how do I close the protein gap');
  assert.deepStrictEqual(r, { placed: false, cart: 'keep' });
  // another AI finishing without a cart, with no yes asked for
  assert.deepStrictEqual(cartOutcome({ cart }, { status: 'done' }, 'Here are some ideas.', 'yes'), { placed: false, cart: 'keep' });
});

test('finished right after his yes to the order: placed, cart cleared', () => {
  assert.deepStrictEqual(cartOutcome({ cart }, { status: 'done', cart: null }, ask, 'yes'), { placed: true, cart: 'clear' });
});

test('marked what was bought: placed', () => {
  assert.deepStrictEqual(cartOutcome({ cart }, { status: 'done', list: { bought: ['Eggs'] } }, '', ''), { placed: true, cart: 'clear' });
});

test('a new cart replaces the old one', () => {
  assert.deepStrictEqual(cartOutcome({ cart }, { status: 'needs-you', cart: [{ name: 'Tuna' }] }, ask, 'add tuna'), { placed: false, cart: 'new' });
  assert.deepStrictEqual(cartOutcome({}, { status: 'needs-you', cart: [{ name: 'Tuna' }] }, '', 'get tuna'), { placed: false, cart: 'new' });
});

test('no cart before, none after: nothing to keep', () => {
  assert.deepStrictEqual(cartOutcome({}, { status: 'done' }, ask, 'yes'), { placed: false, cart: 'keep' });
});
