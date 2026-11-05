/* Pay with Link: which checkout field is which (agent/link-pay.js), the wallet's refusals, the spend request it
   sends, the card masking in the browser launcher (agent/browser-proxy.js), and Link's sign-in polling (agent/link-api.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-link-'));
const flag = path.join(tmp, 'card-filled.json');
process.env.TASKS_CARD_FLAG = flag;
const pay = require('../agent/link-pay');
const proxy = require('../agent/browser-proxy');
const link = require('../agent/link-api');

test('card fields are found by autocomplete, name, label or placeholder', () => {
  const k = pay.fieldKind;
  assert.strictEqual(k({ autocomplete: 'cc-number' }), 'number');
  assert.strictEqual(k({ autocomplete: 'section-pay cc-csc' }), 'cvc');
  assert.strictEqual(k({ autocomplete: 'cc-exp' }), 'exp');
  assert.strictEqual(k({ autocomplete: 'cc-exp-month' }), 'expMonth');
  assert.strictEqual(k({ autocomplete: 'cc-exp-year' }), 'expYear');
  assert.strictEqual(k({ autocomplete: 'billing postal-code' }), 'postal');
  assert.strictEqual(k({ name: 'cardnumber', placeholder: '1234 1234 1234 1234' }), 'number'); // Stripe Elements
  assert.strictEqual(k({ name: 'exp-date', placeholder: 'MM / YY' }), 'exp');
  assert.strictEqual(k({ name: 'cvc', placeholder: 'CVC' }), 'cvc');
  assert.strictEqual(k({ id: 'credit-card-number' }), 'number'); // Braintree
  assert.strictEqual(k({ data: 'encryptedSecurityCode' }), 'cvc'); // Adyen
  assert.strictEqual(k({ label: 'Expiration month' }), 'expMonth');
  assert.strictEqual(k({ label: 'Exp. year' }), 'expYear');
  assert.strictEqual(k({ label: 'Name on card' }), 'name');
  assert.strictEqual(k({ label: 'Security code' }), 'cvc');
});

test('fields that are not the card are left alone', () => {
  const k = pay.fieldKind;
  assert.strictEqual(k({ label: 'Gift card number' }), null);
  assert.strictEqual(k({ label: 'Promo code' }), null);
  assert.strictEqual(k({ label: 'Email' }), null);
  assert.strictEqual(k({ label: 'Enter the one-time code we texted you' }), null);
  assert.strictEqual(k({ label: 'Search' }), null);
  assert.strictEqual(k({ label: 'First name' }), null);
  assert.strictEqual(k({ autocomplete: 'shipping postal-code' }), null); // only a billing ZIP counts by autocomplete
  assert.strictEqual(k({}), null);
});

test('expiry is typed the way the field asks for it', () => {
  const e = pay.expiryText;
  assert.strictEqual(e('exp', { placeholder: 'MM / YY' }, 3, 2029), '03/29');
  assert.strictEqual(e('exp', { placeholder: 'MM/YYYY' }, 3, 2029), '03/2029');
  assert.strictEqual(e('exp', { maxLength: 4 }, 11, 2030), '1130');
  assert.strictEqual(e('expMonth', {}, 3, 2029), '03');
  assert.strictEqual(e('expYear', {}, 3, 2029), '2029');
  assert.strictEqual(e('expYear', { maxLength: 2 }, 3, 2029), '29');
  assert.strictEqual(e('expYear', { placeholder: 'YY' }, 3, 2029), '29');
});

test('no card without a yes, over the limit, or at a store the yes was not about', () => {
  const a = { page_url: 'https://shop.example.com/checkout', merchant_name: 'Example', amount_cents: 2599 };
  assert.match(pay.payRefusal(a, { approved: false }), /Not without a yes/);
  assert.strictEqual(pay.payRefusal(a, { approved: true, hosts: [], cap: 20000 }), null);
  assert.strictEqual(pay.payRefusal(a, { approved: true, hosts: ['example.com'], cap: 20000 }), null);
  assert.match(pay.payRefusal(a, { approved: true, hosts: ['walmart.com'], cap: 20000 }), /His yes was about walmart\.com/);
  assert.match(pay.payRefusal(Object.assign({}, a, { amount_cents: 25000 }), { approved: true, hosts: [], cap: 20000 }), /over his limit/);
  assert.match(pay.payRefusal(Object.assign({}, a, { amount_cents: 25.99 }), { approved: true, hosts: [], cap: 20000 }), /whole number/);
  assert.match(pay.payRefusal(Object.assign({}, a, { page_url: 'http://shop.example.com/checkout' }), { approved: true, hosts: [], cap: 20000 }), /https/);
  assert.match(pay.payRefusal(a, { approved: true, hosts: [], cap: 20000, used: true }), /fresh yes/);
  assert.strictEqual(pay.payRefusal(Object.assign({ spend_request_id: 'lsrq_1' }, a), { approved: true, hosts: [], cap: 20000, used: true }), null);
  assert.match(pay.payRefusal(a, { approved: true, hosts: [], cap: 20000, mailSeen: true }), /opened his mail/);
});

test('the spend request names the store, the amount and the items, with context Link accepts', () => {
  const b = pay.spendBody({ page_url: 'https://www.bluebottlecoffee.com/checkouts/abc', merchant_name: 'Blue Bottle', amount_cents: 2350,
    items: [{ name: 'Bella Donovan 12oz', quantity: 2, unit_cents: 1100 }, { name: '' }] }, true);
  assert.strictEqual(b.amount, 2350);
  assert.strictEqual(b.currency, 'usd');
  assert.strictEqual(b.credential_type, 'card');
  assert.strictEqual(b.merchant_url, 'https://www.bluebottlecoffee.com');
  assert.strictEqual(b.request_approval, true);
  assert.strictEqual(b.test, true);
  assert.deepStrictEqual(b.line_items, [{ name: 'Bella Donovan 12oz', quantity: 2, unit_amount: 1100 }]);
  assert.deepStrictEqual(b.totals, [{ type: 'total', display_text: 'Total', amount: 2350 }]);
  assert.ok(b.context.length >= 100 && /\$23\.50/.test(b.context) && /2 × Bella Donovan/.test(b.context));
  assert.strictEqual(pay.spendBody({ page_url: 'https://a.example/x', amount_cents: 500 }, false).test, undefined);
  assert.ok(pay.contextFor({ amount_cents: 100 }, 'a.example').length >= 100);
});

test('payment fields are masked in what the page shows the AI; any card number once a card is in', () => {
  const text = '- textbox "Card number" [ref=f1e5]: 4000 0099 9000 1984\n- textbox "CVC" [ref=f1e7]: 123\n'
    + '- textbox "Expiration date MM / YY" [ref=f1e6]: 12 / 29\n- text: Order 112-3456789-1234567 paid with 4242424242424242\n'
    + '- textbox "ZIP" [ref=f1e8]: 44101\n- textbox "Card number" [ref=f1e9]';
  const line = JSON.stringify({ result: { content: [{ type: 'text', text }] } });
  const out = (shown) => JSON.parse(proxy.maskCards(line, shown)).result.content[0].text;
  const before = out(false);
  assert.ok(!/1984|: 123\b|12 \/ 29/.test(before));
  assert.match(before, /4242424242424242/); // not a field, and no card filled yet
  assert.match(before, /44101/);
  assert.match(before, /112-3456789-1234567/);
  const after = out(true);
  assert.ok(!/4242424242424242/.test(after));
  assert.match(after, /•••• 4242/);
  assert.match(after, /112-3456789-1234567/); // order numbers fail the card checksum
  assert.ok(proxy.luhn('4242424242424242') && !proxy.luhn('4242424242424243'));
  // Link's test card fails the checksum: grouped like a card, it's masked anyway
  const grouped = JSON.stringify({ result: { content: [{ type: 'text', text: '- text: card 4000 0099 9000 1984 · order 4000009990001984' }] } });
  assert.strictEqual(JSON.parse(proxy.maskCards(grouped, true)).result.content[0].text, '- text: card •••• 1984 · order 4000009990001984');
});

test('screenshots are off while a card is in a form', () => {
  const shot = { id: 1, params: { name: 'browser_take_screenshot', arguments: {} } };
  assert.strictEqual(proxy.cardRefusal(shot, false), null);
  assert.match(proxy.cardRefusal(shot, true), /Screenshots are off/);
  assert.strictEqual(proxy.cardRefusal({ id: 1, params: { name: 'browser_snapshot', arguments: {} } }, true), null);
});

const fakeFetch = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
test('Link sign-in: waiting, approved, refused', async () => {
  assert.strictEqual(await link.pollLogin('dc', fakeFetch(400, { error: 'authorization_pending' })), null);
  assert.strictEqual(await link.pollLogin('dc', fakeFetch(400, { error: 'slow_down' })), null);
  const t = await link.pollLogin('dc', fakeFetch(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
  assert.strictEqual(t.access_token, 'a');
  assert.ok(t.expires_at > Date.now());
  await assert.rejects(link.pollLogin('dc', fakeFetch(400, { error: 'access_denied' })), /said no/);
  await assert.rejects(link.pollLogin('dc', fakeFetch(400, { error: 'expired_token' })), /expired/);
  const s = await link.startLogin('Romulus', 'pc', fakeFetch(200, { device_code: 'dc', user_code: 'apple-tree', verification_uri_complete: 'https://app.link.com/device?code=x', interval: 5, expires_in: 600 }));
  assert.deepStrictEqual(s, { deviceCode: 'dc', userCode: 'apple-tree', url: 'https://app.link.com/device?code=x', interval: 5, expiresIn: 600 });
  const r = await link.refresh('old', fakeFetch(200, { access_token: 'b', expires_in: 60 }));
  assert.strictEqual(r.refresh_token, 'old'); // kept when not rotated
});

test('a spend request is still waiting until he answers', () => {
  assert.ok(link.waiting({ status: 'pending_approval' }));
  assert.ok(link.waiting({ status: 'created' }));
  assert.ok(link.waiting({ status: 'requires_action', status_details: { requires_action: { next_action: { resolution: 'auto_resume' } } } }));
  assert.ok(!link.waiting({ status: 'requires_action', status_details: { requires_action: { next_action: { resolution: 'create_new_spend_request' } } } }));
  assert.ok(!link.waiting({ status: 'approved' }));
  assert.ok(!link.waiting({ status: 'denied' }));
  assert.deepStrictEqual(link.nextAction({ status_details: { failed: { next_action: { type: 'ssn_verification' } } } }), { type: 'ssn_verification' });
});
