const test = require('node:test');
const assert = require('node:assert');
const tr = require('../agent/triggers');

const now = new Date(2026, 9, 28, 9, 0).getTime(); // Wed Oct 28 2026, 09:00
const task = (id, trigger, extra) => Object.assign({ id, ws: 'agent', done: false, status: 'done', title: 'Task ' + id, trigger }, extra);

test('words keeps what matters and drops the filler', () => {
  assert.deepStrictEqual(tr.words('when an email from Acmebank about my statement arrives'), ['acmebank', 'statement']);
  assert.deepStrictEqual(tr.words('a reply from Mrs. O’Neil'), ['reply', 'mrs', 'oneil']);
  assert.ok(tr.enough(['acmebank', 'statement'], 'Acmebank: Your statement is ready'));
  assert.ok(tr.enough(['acmebank', 'statement'], 'Your Acmebank account')); // half is enough
  assert.ok(!tr.enough(['acmebank', 'statement'], 'Chase: new offer'));
  assert.ok(tr.enough(['dentist', 'appointments'], 'Dentist appointment')); // plural / singular
});

test('clean: a usable trigger or nothing', () => {
  assert.deepStrictEqual(tr.clean({ kind: 'mail', what: '  Acmebank   statement ', since: '5' }), { kind: 'mail', what: 'Acmebank statement', since: 5 });
  assert.deepStrictEqual(tr.clean({ kind: 'calendar', what: 'dentist', before: '48' }), { kind: 'calendar', what: 'dentist', since: 0, before: 48 });
  assert.strictEqual(tr.clean({ kind: 'calendar', what: 'x', before: 99999 }).before, 24 * 14);
  assert.strictEqual(tr.clean({ kind: 'mail', what: '' }), null);
  assert.strictEqual(tr.clean({ kind: 'repeat', what: 'x' }), null);
  assert.strictEqual(tr.clean({ kind: 'page', what: 'under $40', url: 'http://localhost:3000/x' }), null);
  assert.strictEqual(tr.clean({ kind: 'page', what: 'under $40', url: 'https://www.amazon.com/dp/B0' }).url, 'https://www.amazon.com/dp/B0');
});

test('safeUrl: public http(s) only', () => {
  assert.ok(tr.safeUrl('https://example.com/a?b=1'));
  for (const bad of ['ftp://example.com', 'https://user:pw@example.com', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://192.168.1.5/',
    'https://172.20.0.1/', 'https://100.100.1.1/', 'https://lupa/', 'https://lupa.local/', 'https://[::1]/', 'https://[fd00::1]/', 'not a url']) {
    assert.strictEqual(tr.safeUrl(bad), null, bad);
  }
});

test('armed: an agent task with a trigger and nothing going on it', () => {
  assert.ok(tr.armed(task('a', { kind: 'mail', what: 'x' })));
  assert.ok(!tr.armed(task('a', { kind: 'mail', what: 'x' }, { status: 'queued' })));
  assert.ok(!tr.armed(task('a', { kind: 'mail', what: 'x' }, { status: 'needs-you' })));
  assert.ok(!tr.armed(task('a', { kind: 'mail', what: 'x' }, { done: true })));
  assert.ok(!tr.armed(task('a', null)));
  assert.ok(!tr.armed(Object.assign(task('a', { kind: 'mail', what: 'x' }), { ws: 'personal' })));
});

test('mail: candidates by words and age, then the model picks, and only allowed pairs count', () => {
  const t1 = task('t1', { kind: 'mail', what: 'Acmebank statement', since: now - 1000 });
  const t2 = task('t2', { kind: 'mail', what: 'reply from the landlord' });
  const mails = [
    { id: 'm1', threadId: 'th1', from: 'Acmebank <alerts@acmebank.example>', subject: 'Your statement is ready', text: 'View your October statement', date: now },
    { id: 'm2', from: 'Chase', subject: 'New offer', text: 'nothing', date: now },
    { id: 'm3', from: 'Acmebank', subject: 'Statement', text: 'old', date: now - 5000 }, // before the trigger was set
    { id: 'm4', from: 'Bob Landlord', subject: 'Re: heater', text: 'reply below', date: now },
  ];
  const pairs = tr.mailCandidates([t1, t2], mails, now);
  assert.deepStrictEqual(pairs.map((p) => p.task.id + '/' + p.mail.id), ['t1/m1', 't2/m4']);
  const input = tr.mailInput(pairs);
  assert.match(input, /1\. when an email arrives: Acmebank statement/);
  assert.match(input, /### Email 2\nFrom: Bob Landlord/);
  const out = tr.cleanMail({ matches: [{ email: 1, trigger: 1, why: 'statement notice' }, { email: 1, trigger: 2, why: 'wrong pair' }, { email: 9, trigger: 1, why: 'x' }] }, pairs);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 't1');
  assert.strictEqual(out[0].key, 'mail:m1');
  assert.match(out[0].what, /Acmebank.*statement is ready.*statement notice/);
  assert.strictEqual(out[0].link, 'https://mail.google.com/mail/u/0/#all/th1');
  assert.deepStrictEqual(tr.cleanMail(null, pairs), []);
});

test('calendar: fires once per event when its window opens', () => {
  const t = task('c1', { kind: 'calendar', what: 'dentist', before: 24 });
  const events = [
    { id: 'e1', start: new Date(now + 30 * 3600 * 1000).toISOString(), title: 'Dentist – cleaning', where: 'Main St' }, // too far yet
    { id: 'e2', start: new Date(now + 20 * 3600 * 1000).toISOString(), title: 'Dentist checkup' },
    { id: 'e3', start: new Date(now + 2 * 3600 * 1000).toISOString(), title: 'Team meeting' },
    { id: 'e4', start: new Date(now - 3 * 3600 * 1000).toISOString(), title: 'Dentist (earlier)' }, // over
  ];
  const hit = tr.calendarHits([t], events, { now });
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].id, 'c1');
  assert.match(hit[0].what, /Dentist checkup/);
  const key = hit[0].key;
  assert.deepStrictEqual(tr.calendarHits([t], events, { now, fired: { c1: [key] } }), []);
  assert.strictEqual(tr.calendarHits([t], events, { now: now + 8 * 3600 * 1000, fired: { c1: [key] } })[0].what.includes('cleaning'), true);
  assert.strictEqual(tr.calendarSpanMs([t]), 49 * 3600 * 1000);
  assert.strictEqual(tr.calendarSpanMs([task('x', { kind: 'mail', what: 'y' })]), 0);
});

test('page: due every 6 hours, text stripped, only a clear yes fires', () => {
  const t = task('p1', { kind: 'page', url: 'https://shop.example.com/item', what: 'the price is under $40' });
  assert.ok(tr.pageDue(t, {}, now));
  assert.ok(!tr.pageDue(t, { p1: now - 60 * 60 * 1000 }, now));
  assert.ok(tr.pageDue(t, { p1: now - 7 * 60 * 60 * 1000 }, now));
  const text = tr.stripHtml('<html><head><style>p{}</style><script>x()</script></head><body><h1>Widget</h1><p>Price: <s>$49</s> <b>$39.99</b></p><div>In&nbsp;Stock</div></body></html>');
  assert.strictEqual(text, 'Widget\nPrice: $49 $39.99\nIn Stock');
  assert.match(tr.pageInput(tr.clean(t.trigger), text), /Condition: the price is under \$40/);
  const hit = tr.cleanPage({ yes: true, evidence: '$39.99 — In Stock' }, t);
  assert.strictEqual(hit.id, 'p1');
  assert.match(hit.what, /shop\.example\.com\/item — the price is under \$40 \(\$39\.99/);
  assert.strictEqual(tr.cleanPage({ yes: false, evidence: '$49' }, t), null);
  assert.strictEqual(tr.cleanPage({ yes: 'true' }, t), null);
});

test('describe reads like the panel', () => {
  assert.strictEqual(tr.describe({ kind: 'mail', what: 'Acmebank statement' }), 'when an email arrives: Acmebank statement');
  assert.strictEqual(tr.describe({ kind: 'calendar', what: 'dentist', before: 24 }), '24 h before a calendar event: dentist');
  assert.strictEqual(tr.describe({ kind: 'calendar', what: 'dentist', before: 0 }), 'at a calendar event: dentist');
  assert.strictEqual(tr.describe({ kind: 'page', url: 'https://www.shop.com/x', what: 'in stock' }), 'when shop.com/x says: in stock');
  assert.strictEqual(tr.describe(null), '');
});
