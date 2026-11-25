/* His Link wallet (agent/link-wallet.js): money as a checkout shows it, the tool's JSON output, what he reads
   when approving, his sign-in file, what the AI is told, and the launcher's side (spend requests, the card
   held in memory) against a stand-in for Link's command-line tool. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const link = require('../agent/link-wallet');

test('money as a checkout shows it → cents', () => {
  assert.strictEqual(link.cents('$131.00'), 13100);
  assert.strictEqual(link.cents('1,234.50'), 123450);
  assert.strictEqual(link.cents('USD 12'), 1200);
  assert.strictEqual(link.cents(131), 13100);
  assert.strictEqual(link.cents('free'), null);
  assert.strictEqual(link.cents('$0.00'), null);
  assert.strictEqual(link.cents('-5'), null);
  assert.strictEqual(link.cents(''), null);
  assert.strictEqual(link.money(13100), '$131.00');
  assert.strictEqual(link.money(500, 'cad'), 'CAD 5.00');
  assert.strictEqual(link.hostOf('https://Shop.Example.com/checkout?x=1'), 'shop.example.com');
  assert.strictEqual(link.hostOf('shop.example.com'), '');
});

test('the tool’s --format json output: a list (the last entry answers), an error object, or nothing', () => {
  assert.deepStrictEqual(link.parseOutput('[\n {"authenticated": false},\n {"authenticated": true}\n]\n'), { authenticated: true });
  assert.deepStrictEqual(link.parseOutput('notice first\n{"code":"NOT_AUTHENTICATED","message":"Not authenticated."}\ntrailing'), { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' });
  assert.strictEqual(link.parseOutput(''), null);
  assert.strictEqual(link.parseOutput('plain words'), null);
  assert.strictEqual(link.parseOutput('[]'), null);
});

test('what he reads when approving: the store, the items, the total, at least 100 characters', () => {
  const s = link.contextFor({ merchantName: 'Example Store', merchantUrl: 'https://example.com/checkout', amount: 13100, currency: 'usd', task: 'Buy trail shoes', why: 'his picks',
    items: [{ name: 'Trail shoes', qty: 1, price: '$120.00' }, { name: 'Socks', qty: 2 }] });
  assert.ok(s.length >= 100);
  assert.match(s, /Example Store/); assert.match(s, /Trail shoes \(\$120\.00\)/); assert.match(s, /2 x Socks/); assert.match(s, /\$131\.00/); assert.match(s, /Buy trail shoes/);
  assert.ok(link.contextFor({ merchantName: 'X', merchantUrl: 'https://x.io', items: [], amount: 100, task: '' }).length >= 100);
  // the tool's key:value lists split on commas and colons, so an item's name loses them; the line's price over the count is the unit price
  assert.strictEqual(link.lineItem({ name: 'Shoes, red: size 10', qty: 2, price: '$100.00' }), 'name:Shoes red size 10,quantity:2,unit_amount:5000');
  assert.strictEqual(link.lineItem({ name: 'Socks' }), 'name:Socks,quantity:1');
  assert.deepStrictEqual(link.totalsFor({ amount: 13100, subtotal: '$120.00', shipping: '$11.00', tax: '' }),
    ['type:subtotal,display_text:Subtotal,amount:12000', 'type:shipping,display_text:Shipping,amount:1100', 'type:total,display_text:Total,amount:13100']);
});

test('Link’s sign-in file: connected, a sign-in still waiting, or neither', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-auth-')), 'auth.json');
  assert.deepStrictEqual(link.readAuth(f), { connected: false, pending: null });
  fs.writeFileSync(f, JSON.stringify({ auth: null, pendingDeviceAuth: { verification_url: 'https://login.link.com/device?x=1', phrase: 'ABCD-EFGH', expires_at: 2e12 } }));
  assert.deepStrictEqual(link.readAuth(f, 1e12), { connected: false, pending: { url: 'https://login.link.com/device?x=1', phrase: 'ABCD-EFGH', expiresAt: 2e12 } });
  assert.deepStrictEqual(link.readAuth(f, 3e12), { connected: false, pending: null }); // it ran out
  fs.writeFileSync(f, JSON.stringify({ auth: { access_token: 'liwltoken_x', scope: 'payment_methods.agentic userinfo:read' }, pendingDeviceAuth: null }));
  assert.deepStrictEqual(link.readAuth(f), { connected: true, scope: 'payment_methods.agentic userinfo:read', pending: null });
});

test('what the AI is told about the wallet', () => {
  const p = link.promptPart({ test: true, limits: { per_transaction: { limit: 50000 }, daily: { remaining: 12345 } },
    address: { name: 'Jenny Rosen', line_1: '123 Main St', locality: 'San Francisco', administrative_area: 'CA', postal_code: '94015', country_code: 'US' } });
  assert.match(p, /## His Link wallet/); assert.match(p, /TEST MODE/); assert.match(p, /Up to \$500\.00 per purchase, \$123\.45 left today/);
  assert.match(p, /Jenny Rosen, 123 Main St, San Francisco, CA, 94015, US/);
  const q = link.promptPart({ test: false, limits: null, address: null });
  assert.doesNotMatch(q, /TEST MODE/); assert.doesNotMatch(q, /Up to/); assert.doesNotMatch(q, /shipping address/);
});

/* A stand-in for Link's tool: answers like the real one (a JSON list on stdout), keeps its requests in a state
   file the test can change (he approves in the Link app), and logs every call's arguments. */
const FAKE = `
const fs = require('fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_LINK_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LINK_LOG, JSON.stringify(a) + '\\n');
const save = () => fs.writeFileSync(process.env.FAKE_LINK_STATE, JSON.stringify(st));
const out = (v) => process.stdout.write(JSON.stringify([v], null, 2) + '\\n');
const fail = (code, message) => { process.stdout.write(JSON.stringify({ code, message })); process.exit(1); };
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const url = (id) => 'https://app.link.com/activity/approve/' + id;
if (!process.env.LINK_AUTH_FILE) fail('NOT_AUTHENTICATED', 'Not authenticated. Run "link-cli auth login" first.');
if (a[0] === 'spend-request' && a[1] === 'create') {
  const id = 'lsrq_' + (st.next++);
  st.requests[id] = { status: 'pending_approval', amount: Number(opt('--amount')), currency: opt('--currency'), merchant_name: opt('--merchant-name'), merchant_url: opt('--merchant-url'), test: a.includes('--test') };
  save(); out(Object.assign({ id, approval_url: url(id) }, st.requests[id]));
} else if (a[0] === 'spend-request' && a[1] === 'retrieve') {
  const r = st.requests[a[2]]; if (!r) fail('NOT_FOUND', 'no such request');
  const v = Object.assign({ id: a[2], approval_url: url(a[2]) }, r);
  if (a.includes('--include') && r.status === 'approved') v.card = { brand: 'visa', number: '4000009990001984', cvc: '987', exp_month: 6, exp_year: 2029, valid_until: '2026-12-01T00:00:00Z',
    billing_address: { name: 'Jenny Rosen', line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94015', country: 'US' } };
  out(v);
} else if (a[0] === 'spend-request' && a[1] === 'update') { st.requests[a[2]].amount = Number(opt('--amount')); save(); out({ id: a[2], status: st.requests[a[2]].status }); }
else if (a[0] === 'spend-request' && a[1] === 'request-approval') { st.requests[a[2]].status = 'pending_approval'; save(); out({ id: a[2], status: 'pending_approval', approval_url: url(a[2]) }); }
else if (a[0] === 'spend-request' && a[1] === 'cancel') { st.requests[a[2]].status = 'canceled'; save(); out({ id: a[2], status: 'canceled' }); }
else if (a[0] === 'user-info') out({ email: 'jenny@example.com', agent_wallet_spend_limits: { per_transaction: { limit: 50000, used: 0, remaining: 50000 } } });
else if (a[0] === 'shipping-address') out([{ id: 'sa_1', is_default: true, address: { name: 'Jenny Rosen', line_1: '123 Main St', locality: 'San Francisco', administrative_area: 'CA', postal_code: '94015', country_code: 'US' } }]);
else if (a[0] === 'auth' && a[1] === 'status') out({ authenticated: true });
else fail('UNKNOWN', 'unknown command ' + a.join(' '));
`;
function fakeCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-wallet-'));
  const cli = path.join(dir, 'fake-link-cli.js'); fs.writeFileSync(cli, FAKE);
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, JSON.stringify({ next: 1, requests: {} })); fs.writeFileSync(log, '');
  process.env.FAKE_LINK_STATE = state; process.env.FAKE_LINK_LOG = log;
  const read = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  return { cli, read, write: (fn) => { const s = read(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); },
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    pending: path.join(dir, 'pending.json'), auth: path.join(dir, 'auth.json') };
}
const shop = { merchantName: 'Example Store', merchantUrl: 'https://shop.example.com/checkout', total: '$131.00', waitMs: 1 };
const walletFor = (f, extra) => link.wallet(Object.assign({ node: process.execPath, cli: f.cli, auth: f.auth, test: false, pending: f.pending, task: 'Buy trail shoes' }, extra));

test('a new request waits for his approval; once approved, the card is fetched and held here, never in the answer', async () => {
  const f = fakeCli(), w = walletFor(f);
  const r = await w.request(Object.assign({}, shop, { items: [{ name: 'Trail shoes', qty: 1, price: '$120.00' }], shipping: '$11.00', why: 'his pick' }));
  assert.strictEqual(r.status, 'pending'); assert.strictEqual(r.amount, 13100); assert.strictEqual(r.merchant, 'Example Store'); assert.match(r.approvalUrl, /lsrq_1$/);
  const create = f.calls().find((c) => c[1] === 'create');
  assert.strictEqual(create[create.indexOf('--amount') + 1], '13100');
  assert.strictEqual(create[create.indexOf('--merchant-url') + 1], 'https://shop.example.com/checkout');
  assert.ok(create[create.indexOf('--context') + 1].length >= 100);
  assert.ok(create.includes('--line-item') && create.includes('--total') && create.includes('--idempotency-key') && create.includes('--format'));
  assert.ok(!create.includes('--test'));
  assert.strictEqual(JSON.parse(fs.readFileSync(f.pending, 'utf8')).id, 'lsrq_1');
  assert.strictEqual(w.card(), null);
  f.write((s) => { s.requests.lsrq_1.status = 'approved'; }); // he approved in the Link app
  const a = await w.wait(1);
  assert.strictEqual(a.status, 'approved'); assert.strictEqual(a.id, 'lsrq_1');
  assert.deepStrictEqual([a.card.brand, a.card.last4, a.card.expiry, a.card.billing.name], ['visa', '1984', '06/29', 'Jenny Rosen']);
  assert.ok(!JSON.stringify(a).includes('4000009990001984') && !JSON.stringify(a).includes('987')); // the number and the code never leave the wallet
  assert.strictEqual(w.card().number, '4000009990001984'); assert.strictEqual(w.card().cvc, '987');
  assert.deepStrictEqual(w.secrets(), [{ number: '4000009990001984', cvc: '987' }]);
  assert.strictEqual(f.calls().filter((c) => c.includes('--include')).length, 1); // fetched once
  await w.wait(1); assert.strictEqual(f.calls().filter((c) => c.includes('--include')).length, 1);

  // the next run, same store and total: the approved request is reused, nothing new is asked of him
  const w2 = walletFor(f);
  const r2 = await w2.request(shop);
  assert.strictEqual(r2.status, 'approved'); assert.strictEqual(r2.id, 'lsrq_1'); assert.strictEqual(w2.card().last4, '1984');
  assert.strictEqual(f.calls().filter((c) => c[1] === 'create').length, 1);
  // the total grew (tax showed up): the same request is raised and goes back to him
  const r3 = await w2.request(Object.assign({}, shop, { total: '$140.00' }));
  assert.strictEqual(r3.status, 'pending'); assert.strictEqual(r3.id, 'lsrq_1'); assert.strictEqual(r3.amount, 14000);
  const names = f.calls().map((c) => c[1]);
  assert.ok(names.includes('update') && names.includes('request-approval'));
  assert.strictEqual(f.read().requests.lsrq_1.amount, 14000);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.pending, 'utf8')).amount, 14000);
});

test('another store’s request is withdrawn before a new one is made; test mode is passed on; cancel forgets it', async () => {
  const f = fakeCli(), w = walletFor(f, { test: true });
  assert.strictEqual((await w.request(shop)).status, 'pending');
  const r = await w.request({ merchantName: 'Other Shop', merchantUrl: 'https://other.example.net/pay', total: '$20.00', waitMs: 1 });
  assert.strictEqual(r.status, 'pending'); assert.strictEqual(r.id, 'lsrq_2'); assert.strictEqual(r.amount, 2000);
  assert.ok(f.calls().some((c) => c[1] === 'cancel' && c[2] === 'lsrq_1'));
  assert.strictEqual(f.read().requests.lsrq_1.status, 'canceled');
  assert.ok(f.calls().filter((c) => c[1] === 'create').every((c) => c.includes('--test')));
  assert.strictEqual(JSON.parse(fs.readFileSync(f.pending, 'utf8')).id, 'lsrq_2');
  assert.deepStrictEqual(await w.cancel(), { ok: true });
  assert.ok(!fs.existsSync(f.pending));
  assert.strictEqual(f.read().requests.lsrq_2.status, 'canceled');
  assert.match((await w.cancel()).error, /no Link request/);
  assert.match((await w.wait(1)).error, /nothing is waiting/);
});

test('a declined or expired request is forgotten; bad input never reaches Link', async () => {
  const f = fakeCli(), w = walletFor(f);
  assert.match((await w.request(Object.assign({}, shop, { total: 'free' }))).error, /total must be/);
  assert.match((await w.request(Object.assign({}, shop, { merchantUrl: 'shop.example.com' }))).error, /merchant_url/);
  assert.deepStrictEqual(f.calls(), []);
  assert.strictEqual((await w.request(shop)).status, 'pending');
  f.write((s) => { s.requests.lsrq_1.status = 'denied'; });
  assert.strictEqual((await w.wait(1)).status, 'denied');
  assert.ok(!fs.existsSync(f.pending));
  assert.strictEqual((await w.request(shop)).id, 'lsrq_2'); // a fresh one
  f.write((s) => { s.requests.lsrq_2.status = 'expired'; });
  assert.strictEqual((await w.request(shop)).id, 'lsrq_3');
  f.write((s) => { s.requests.lsrq_3.status = 'requires_action'; s.requests.lsrq_3.status_details = { requires_action: { next_action: { type: 'add_payment_method', resolution: 'create_new_spend_request_after_completion', display_message: 'Add a card to your Link wallet first.', action_url: 'https://app.link.com/add' } } }; });
  const act = await w.wait(1);
  assert.strictEqual(act.status, 'action'); assert.match(act.message, /Add a card/); assert.strictEqual(act.actionUrl, 'https://app.link.com/add');
  assert.ok(!fs.existsSync(f.pending));
});

test('not signed in: Link’s own error comes back in words', async () => {
  const f = fakeCli(), w = walletFor(f, { auth: '' });
  const r = await w.request(shop);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'NOT_AUTHENTICATED'); assert.match(r.error, /Not authenticated/);
  // and a tool that isn't there at all
  const gone = link.runner({ node: process.execPath, cli: path.join(os.tmpdir(), 'no-such-link-cli.js'), auth: '' });
  assert.strictEqual((await gone(['auth', 'status'])).ok, false);
});
