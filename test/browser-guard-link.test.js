/* The launcher's Link tools (agent/browser-proxy.js with TASKS_LINK_CLI): added to the browser's tool list, held
   behind his yes like the order button, the card typed only into fields the page labels as card fields, and
   never shown to the AI (last four digits only, the number blanked out of pages, no screenshots). A module of
   its own, because the launcher reads its settings once, when it loads. */
const test = require('node:test');
const assert = require('node:assert');

process.env.TASKS_LINK_CLI = 'C:\\fake\\link-cli.js'; process.env.TASKS_LINK_AUTH = ''; process.env.TASKS_LINK_TEST = '1'; process.env.TASKS_LINK_PENDING = '';
delete process.env.TASKS_BROWSER_LOCK; delete process.env.TASKS_BROWSER_HOSTS; delete process.env.TASKS_BROWSER_ACTIONS;
process.env.TASKS_BROWSER_MAIL = '';
process.env.TASKS_BROWSER_APPROVED = '1';
process.env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(['shop.example.com']);
process.env.TASKS_BROWSER_FILES = '[]';
process.env.TASKS_BROWSER_TASK = 'Buy trail shoes';
delete require.cache[require.resolve('../agent/browser-proxy')];
const proxy = require('../agent/browser-proxy');

const call = (name, args) => ({ id: 1, params: { name, arguments: args || {} } });
const checkout = 'https://shop.example.com/checkout';
// a stand-in for the launcher's copy of agent/link-wallet.js
const CARD = { number: '4000009990001984', cvc: '987', brand: 'visa', last4: '1984', expMonth: 6, expYear: 2029,
  billing: { name: 'Jenny Rosen', line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94015', country: 'US' } };
const shown = { brand: 'visa', last4: '1984', expMonth: 6, expYear: 2029, expiry: '06/29', billing: CARD.billing };
let state = 'pending', haveCard = false;
const asked = [];
const answer = (merchant) => state === 'approved' ? { ok: true, id: 'lsrq_1', status: 'approved', amount: 13100, currency: 'usd', merchant, card: shown }
  : { ok: true, id: 'lsrq_1', status: state, amount: 13100, currency: 'usd', merchant, approvalUrl: 'https://app.link.com/activity/approve/lsrq_1' };
proxy._link.setWallet({
  request: async (a) => { asked.push(a); return answer(a.merchantName); },
  wait: async () => answer('Example Store'),
  cancel: async () => ({ ok: true }),
  card: () => (haveCard ? CARD : null), shown: () => shown, secrets: () => (haveCard ? [{ number: CARD.number, cvc: CARD.cvc }] : []), current: () => null,
});
const filled = [];
proxy._link.setFill(async (fields) => { filled.push(...fields); return { result: { content: [{ type: 'text', text: 'ok' }] } }; });
proxy._link.setType(async () => ({ result: { isError: true } }));

test('the browser’s tool list gets Link’s tools once his wallet is on; other answers pass as they are', () => {
  proxy._link.listIds.add(7);
  const line = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'browser_click', inputSchema: {} }] } }) + '\n';
  const out = JSON.parse(proxy.withLinkTools(line));
  assert.deepStrictEqual(out.result.tools.map((t) => t.name), ['browser_click', 'link_pay_request', 'link_wait', 'link_enter_card', 'link_cancel']);
  assert.ok(out.result.tools.slice(1).every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description));
  assert.strictEqual(proxy._link.listIds.size, 0);
  const other = JSON.stringify({ jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: 'tools' }] } }) + '\n';
  assert.strictEqual(proxy.withLinkTools(other), other);
  assert.strictEqual(proxy.withLinkTools(line), line); // its id is no longer waiting
});

test('Link pays only after his yes, and only on the store he said yes to', () => {
  const pay = { merchant_name: 'Example Store', merchant_url: checkout, total: '$131.00' };
  assert.match(proxy.linkRefusal('link_pay_request', pay, 'https://www.amazon.com/gp/buy/spc'), /Not without a yes[\s\S]*His yes was about shop\.example\.com, not this page/);
  assert.match(proxy.linkRefusal('link_pay_request', pay, null), /Not without a yes/);
  assert.match(proxy.linkRefusal('link_enter_card', { number_ref: 'e1' }, 'https://other.example.net/pay'), /Not without a yes/);
  assert.match(proxy.linkRefusal('link_pay_request', Object.assign({}, pay, { merchant_url: 'https://other.example.net/pay' }), checkout), /His yes was about shop\.example\.com, not https:\/\/other\.example\.net\/pay/);
  assert.strictEqual(proxy.linkRefusal('link_pay_request', pay, checkout), null);
  assert.strictEqual(proxy.linkRefusal('link_wait', {}, checkout), null);
  assert.strictEqual(proxy.linkRefusal('link_cancel', {}, 'https://other.example.net/pay'), null); // withdrawing is always fine
  assert.strictEqual(proxy.linkRefusal('browser_click', {}, checkout), null);
});

test('asking Link: waiting, then approved; the AI hears the last four digits, never the number or the code', async () => {
  let r = await proxy.linkCall(call('link_pay_request', { merchant_name: 'Example Store', merchant_url: checkout, total: '$131.00', items: [{ name: 'Trail shoes', qty: 1 }] }), checkout);
  assert.strictEqual(r.isError, false);
  assert.match(r.text, /Waiting for his approval in the Link app: \$131\.00 at Example Store/); assert.match(r.text, /approve\/lsrq_1/); assert.match(r.text, /link_wait/);
  assert.strictEqual(asked[0].merchantName, 'Example Store'); assert.strictEqual(asked[0].total, '$131.00'); assert.strictEqual(asked[0].items[0].name, 'Trail shoes');
  r = await proxy.linkCall(call('link_wait', { seconds: 30 }), checkout);
  assert.match(r.text, /Waiting/);
  state = 'approved';
  r = await proxy.linkCall(call('link_wait', {}), checkout);
  assert.strictEqual(r.isError, false);
  assert.match(r.text, /Approved in Link: a one-time visa card ending 1984 \(expires 06\/29\) for \$131\.00 at Example Store/);
  assert.match(r.text, /Jenny Rosen, 123 Main St, San Francisco, CA, 94015, US/); assert.match(r.text, /link_enter_card/);
  assert.doesNotMatch(r.text, /4000009990001984/); assert.doesNotMatch(r.text, /987/);
  state = 'denied';
  r = await proxy.linkCall(call('link_wait', {}), checkout); assert.match(r.text, /He declined/);
  state = 'approved';
  // a refusal comes back the same way, as an error
  r = await proxy.linkCall(call('link_pay_request', { merchant_name: 'Example Store', merchant_url: checkout, total: '$131.00' }), 'https://www.amazon.com/checkout');
  assert.ok(r.isError); assert.match(r.text, /Not without a yes/);
  assert.strictEqual(asked.length, 1);
});

test('the card goes only into fields the page labels as card fields, and the AI is told the last four digits', async () => {
  haveCard = false;
  let r = await proxy.linkCall(call('link_enter_card', { number_ref: 'e1' }), checkout);
  assert.ok(r.isError); assert.match(r.text, /No card to enter yet/);
  haveCard = true;
  proxy.learnRefs(['- textbox "Card number" [ref=e1]', '- textbox "MM / YY" [ref=e2]', '- textbox "CVC" [ref=e3]', '- textbox "Phone number" [ref=e4]',
    '- textbox "ZIP code" [ref=e5]', '- textbox "Gift card number" [ref=e6]', '- textbox "Name on card" [ref=e7]'].join('\n'));
  r = await proxy.linkCall(call('link_enter_card', { number_ref: 'e9' }), checkout);
  assert.ok(r.isError); assert.match(r.text, /don’t know the field e9/);
  r = await proxy.linkCall(call('link_enter_card', { number_ref: 'e4' }), checkout);
  assert.ok(r.isError); assert.match(r.text, /"textbox Phone number" \(e4\) doesn’t look like the card number field/);
  assert.ok((await proxy.linkCall(call('link_enter_card', { number_ref: 'e6' }), checkout)).isError); // a gift card's number box
  assert.ok((await proxy.linkCall(call('link_enter_card', { number_ref: 'e7', cvc_ref: 'e3' }), checkout)).isError); // the name box
  r = await proxy.linkCall(call('link_enter_card', { number_ref: 'e1', cvc_ref: 'e5' }), checkout);
  assert.ok(r.isError); assert.match(r.text, /doesn’t look like the security code/);
  assert.ok((await proxy.linkCall(call('link_enter_card', { expiry_ref: 'e2' }), checkout)).isError);
  assert.deepStrictEqual(filled, []); // nothing typed anywhere so far
  assert.strictEqual(proxy._link.cardOnPage(), false);
  r = await proxy.linkCall(call('link_enter_card', { number_ref: 'e1', expiry_ref: 'e2', cvc_ref: 'e3' }), checkout);
  assert.strictEqual(r.isError, false);
  assert.match(r.text, /Entered his Link card \(visa ending 1984, expires 06\/29\) into the card number, the expiry date \(MM\/YY\), the security code \(CVC\)/);
  assert.doesNotMatch(r.text, /4000009990001984/); assert.doesNotMatch(r.text, /987/);
  assert.deepStrictEqual(filled.map((f) => [f.ref, f.value, f.type]), [['e1', '4000009990001984', 'textbox'], ['e2', '06/29', 'textbox'], ['e3', '987', 'textbox']]);
  assert.strictEqual(proxy._link.cardOnPage(), true);
  assert.match(proxy.screenshotRefusal(call('browser_take_screenshot', {})), /No screenshots/);
  assert.strictEqual(proxy.screenshotRefusal(call('browser_snapshot', {})), null);
});

test('what Playwright sends back has the number blanked out, spaced or not, and the code next to its label', () => {
  const page = JSON.stringify({ id: 3, result: { content: [{ type: 'text', text: '- textbox "Card number": 4000 0099 9000 1984\n- textbox "CVC": 987\n- text: Subtotal $987.00\n- link "4000009990001984"' }] } }) + '\n';
  const out = proxy.blank(page);
  assert.doesNotMatch(out, /4000 ?0099 ?9000 ?1984/);
  assert.strictEqual((out.match(/•••• •••• •••• 1984/g) || []).length, 2);
  assert.match(out, /CVC\\": •••/);
  assert.match(out, /\$987\.00/); // a price that happens to be the code's digits stays
  assert.strictEqual(proxy.blank('nothing here'), 'nothing here');
});
