/* The browser launcher's final-step guard beyond buttons (agent/browser-proxy.js buyRefusal): an address that acts when
   opened, dragging and accepting a pop-up on a checkout page, and the wider set of order buttons all wait for his yes. */
const test = require('node:test');
const assert = require('node:assert');

delete process.env.TASKS_BROWSER_LOCK; delete process.env.TASKS_BROWSER_HOSTS; delete process.env.TASKS_BROWSER_PRIVATE;
process.env.TASKS_BROWSER_MAIL = '';
process.env.TASKS_BROWSER_APPROVED = '1'; // his yes, to walmart.com
process.env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(['walmart.com']);
const proxy = require('../agent/browser-proxy');
const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
proxy.learnRefs(['- button "Finish checkout" [ref=e1]', '- button "Agree and continue" [ref=e2]', '- button "Confirm order" [ref=e3]', '- button "Place bid" [ref=e4]',
  '- button "Continue" [ref=e5]', '- button "Complete your purchase" [ref=e6]'].join('\n'));
const shop = 'https://shop.example/basket', checkout = 'https://shop.example/checkout/payment';

test('an address that acts by being opened waits for a yes on a site his yes was not about', () => {
  for (const u of ['https://news.example/unsubscribe?u=123', 'https://store.example/account/close?confirm=1', 'https://a.example/x?approve=tok',
    'https://b.example/one-click/order/55', 'https://c.example/cancel-subscription', 'https://d.example/invites/accept-invite/9'])
    assert.match(proxy.buyRefusal(call('browser_navigate', { url: u }), shop), /Not without a yes: opening/, u);
  assert.match(proxy.buyRefusal(call('browser_tabs', { action: 'new', url: 'https://news.example/unsubscribe?u=1' }), shop), /acts by itself/);
  for (const u of ['https://www.walmart.com/cart', 'https://shop.example/help/cancellation-policy', 'https://shop.example/search?q=approved+foods', 'about:blank'])
    assert.strictEqual(proxy.buyRefusal(call('browser_navigate', { url: u }), shop), null, u);
  // on the site his yes named, the same link goes through
  assert.strictEqual(proxy.buyRefusal(call('browser_navigate', { url: 'https://www.walmart.com/account/close?confirm=1' }), 'https://www.walmart.com/account'), null);
});

test('dragging and accepting a pop-up on a checkout page wait for a yes; elsewhere they are ordinary', () => {
  assert.match(proxy.buyRefusal(call('browser_drag', { startRef: 'e9', endRef: 'e10' }), checkout), /dragging here can complete the payment/);
  assert.match(proxy.buyRefusal(call('browser_handle_dialog', { accept: true }), checkout), /accepting that pop-up/);
  assert.match(proxy.buyRefusal(call('browser_handle_dialog', { accept: true }), null), /accepting that pop-up/); // the address could not be read: taken as the checkout
  assert.strictEqual(proxy.buyRefusal(call('browser_handle_dialog', { accept: false }), checkout), null); // dismissing it is fine
  assert.strictEqual(proxy.buyRefusal(call('browser_drag', { startRef: 'e9', endRef: 'e10' }), shop), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_handle_dialog', { accept: true }), shop), null);
  // with his yes, on the site it named, the same steps go
  assert.strictEqual(proxy.buyRefusal(call('browser_drag', { startRef: 'e9', endRef: 'e10' }), 'https://www.walmart.com/checkout/payment'), null);
});

test('the order button under its other names waits too; Continue does not', () => {
  for (const ref of ['e1', 'e2', 'e3', 'e4', 'e6']) assert.match(proxy.buyRefusal(call('browser_click', { target: ref }), checkout), /Not without a yes/, ref);
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e5' }), checkout), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e3' }), 'https://www.walmart.com/checkout'), null); // his yes was to walmart.com
});
