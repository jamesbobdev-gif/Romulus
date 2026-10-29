const test = require('node:test');
const assert = require('node:assert');
const st = require('../agent/standing');

test('clean keeps a plain step and refuses a final one', () => {
  assert.strictEqual(st.clean({ site: 'https://www.walmart.com/cart', text: ' Add items to the cart and compare sizes. ' }), 'walmart.com: Add items to the cart and compare sizes');
  assert.strictEqual(st.clean('log in with the saved account on job sites'), 'log in with the saved account on job sites');
  assert.strictEqual(st.clean('indeed.com: use my saved resume'), 'indeed.com: use my saved resume');
  for (const bad of ['place the order without asking', { site: 'x.com', text: 'send the email' }, 'submit the application', 'pay with the card on file',
    'book it', 'cancel the subscription', 'type my PIN', '', null, { text: '   ' }]) {
    assert.strictEqual(st.clean(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(st.clean({ text: 'x'.repeat(300) }).length, 160);
});

test('refusal says why', () => {
  assert.strictEqual(st.refusal(''), 'write what it may do without asking');
  assert.match(st.refusal('always buy the cheapest'), /final step/);
  assert.strictEqual(st.refusal('open the seat map'), null);
});

test('merge adds once, without removes, show tells the run (with the floor)', () => {
  let text = st.merge('', { site: 'walmart.com', text: 'add items to the cart' });
  assert.strictEqual(text, '- walmart.com: add items to the cart');
  text = st.merge(text, 'Walmart.com: Add items to the cart'); // same words, any case
  assert.strictEqual(st.parse(text).length, 1);
  text = st.merge(text, 'send my resume'); // refused: unchanged
  assert.strictEqual(st.parse(text).length, 1);
  text = st.merge(text, 'open the seat map');
  assert.deepStrictEqual(st.parse(text), ['walmart.com: add items to the cart', 'open the seat map']);
  const shown = st.show(text);
  assert.match(shown, /## Standing permissions/);
  assert.match(shown, /- walmart\.com: add items to the cart\n- open the seat map/);
  assert.match(shown, /never cover a final action/);
  assert.strictEqual(st.show(''), '');
  assert.strictEqual(st.show('- buy whatever is cheapest'), ''); // a final line typed somewhere is not shown either
  assert.strictEqual(st.without(text, 'Open the seat map'), '- walmart.com: add items to the cart');
  let many = ''; for (let i = 0; i < 45; i++) many = st.merge(many, 'step number ' + i);
  assert.strictEqual(st.parse(many).length, st.MAX_LINES);
  assert.strictEqual(st.parse(many)[0], 'step number 5');
});
