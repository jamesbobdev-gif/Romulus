const test = require('node:test');
const assert = require('node:assert');
const helpers = require('../agent/helpers');

test('isYes: a yes that stands, not one taken back', () => {
  for (const t of ['yes', 'Yes please', 'yep', 'Y', 'ok', 'OK!', 'sure', 'ok go ahead', 'okay, order it', 'sure, go ahead', 'yes, place it', 'go ahead and submit it', 'Order it.', 'yes, post it: Anyone free Friday?',
    'yes, but first replace what you typed with exactly this text, then post it:\n\nHi all']) assert.ok(helpers.isYes(t), t);
  for (const t of ['yes, but don\'t order yet', 'yes but wait', 'yesterday was fine', 'no', 'not yet', 'yes, hold on', 'sure, but check the total first',
    'yes to the second one? actually stop', 'Yes. Never mind, cancel it', '', null,
    // a question, or an ok that leads into something other than a go-ahead, is not a yes
    'ok but what did you put for the salary question?', 'okay, show me the cart first', 'sure, which one do you recommend?', 'ok, Walmart', 'y tho?', 'yes?', 'sure thing, what was the total']) assert.ok(!helpers.isYes(t), String(t));
});

test('isYesTo: on a cancel ask, "yes, cancel it" is a yes; on any other ask those words still hold', () => {
  const ask = 'Ready to cancel Netflix: the plan ends Nov 30, nothing is refunded. Reply **yes** to cancel.';
  for (const t of ['yes', 'yes, cancel it', 'Yes, cancel the subscription', 'ok cancel', 'sure, go ahead and cancel it', 'yep, stop my plan', 'yes please cancel the netflix subscription', 'ok, end it.'])
    assert.ok(helpers.isYesTo(t, ask), t);
  for (const t of ['yes, but cancel that', 'Yes. Never mind, cancel it', 'cancel it', 'yes, cancel it and the other one', 'no, keep it', 'stop', 'yes, cancel it?', '', null])
    assert.ok(!helpers.isYesTo(t, ask), String(t));
  const order = 'The cart is ready: 12 items, $84.10, delivery 5–7pm. Reply **yes** to place the order.';
  assert.ok(helpers.isYesTo('yes', order));
  assert.ok(!helpers.isYesTo('yes, cancel it', order), 'on an order ask, cancel is a hold');
});

test('isPublicUrl: the web, not this computer or its network', () => {
  for (const u of ['https://www.walmart.com/checkout', 'http://example.org/', 'https://8.8.8.8/x', 'https://[2606:4700::1111]/'])
    assert.ok(helpers.isPublicUrl(u), u);
  for (const u of ['http://localhost:9334/json/list', 'http://127.0.0.1:11434/api/tags', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://[::1]:8790/', 'http://[fd00::1]/', 'http://lupa/', 'http://hub.local/',
    'file:///C:/x', 'javascript:alert(1)', 'ftp://example.org/', 'not a url', ''])
    assert.ok(!helpers.isPublicUrl(u), u);
});

test('fetchPublic: a name that resolves to this computer or the LAN is refused before the fetch, each hop', async () => {
  helpers._net.setLookup(async (h) => {
    const m = /^(\d+)-(\d+)-(\d+)-(\d+)\.nip\.example$/.exec(h);
    if (m) return [{ address: m.slice(1, 5).join('.'), family: 4 }];
    if (h === 'gone.example') throw new Error('ENOTFOUND');
    return [{ address: '93.184.216.34', family: 4 }];
  });
  assert.strictEqual(await helpers.resolvesPrivate('http://127-0-0-1.nip.example:9222/json'), true);
  assert.strictEqual(await helpers.resolvesPrivate('https://example.com/'), false);
  assert.strictEqual(await helpers.resolvesPrivate('https://gone.example/'), false);
  assert.strictEqual(await helpers.resolvesPrivate('http://127.0.0.1/'), false); // an address: isPublicUrl's job
  const realFetch = global.fetch;
  const hits = [];
  global.fetch = async (u) => { hits.push(u); return u.includes('redir') ? { status: 302, headers: { get: () => 'http://192-168-1-1.nip.example/admin' }, body: { cancel: async () => {} } } : { status: 200 }; };
  try {
    await assert.rejects(helpers.fetchPublic('http://10-0-0-5.nip.example/'), /not a public web address/);
    await assert.rejects(helpers.fetchPublic('https://ok.example/redir'), /redirected somewhere private/);
    assert.strictEqual((await helpers.fetchPublic('https://ok.example/page')).status, 200);
    assert.deepStrictEqual(hits, ['https://ok.example/redir', 'https://ok.example/page']); // the private ones were never fetched
  } finally { global.fetch = realFetch; }
});

test('trimRunLog: tool calls stay, long strings are cut, the tail is kept', () => {
  const page = 'x'.repeat(5000);
  const log = [JSON.stringify({ type: 'tool', name: 'browser_snapshot', result: page }), 'short line', 'y'.repeat(1000)].join('\n');
  const out = helpers.trimRunLog(log);
  assert.ok(out.includes('"name":"browser_snapshot"'));
  assert.ok(!out.includes('x'.repeat(401)));
  assert.ok(out.includes('[4600 more]'));
  assert.ok(out.includes('short line'));
  assert.ok(/y{400}…\[600 more\]/.test(out));
  const big = helpers.trimRunLog('a\n'.repeat(200000), { maxTotal: 1000 });
  assert.ok(big.startsWith('…[') && big.length <= 1100);
});

test('questions spread over the pool, each starting on a different AI', async () => {
  const started = [];
  const res = await helpers.askPool(['a', 'b', 'c'], { order: ['claude', 'gemini'], run: async (id, prompt) => { started.push(id); return { text: id + ':' + prompt.slice(-1) }; } });
  assert.deepStrictEqual(res.map((r) => r.via), ['claude', 'gemini', 'claude']);
  assert.strictEqual(res[1].answer, 'gemini:b');
  assert.strictEqual(started.length, 3);
});

test('a helper that fails or throws hands its question to the next', async () => {
  const res = await helpers.askPool(['q'], { order: ['claude', 'gemini', 'openrouter'], run: async (id) => {
    if (id === 'claude') return { why: 'out of usage' };
    if (id === 'gemini') throw new Error('boom');
    return { text: 'ok' };
  } });
  assert.deepStrictEqual(res, [{ question: 'q', via: 'openrouter', answer: 'ok' }]);
});

test('no answer anywhere is reported, not thrown; at most 4 questions go out', async () => {
  const res = await helpers.askPool(['1', '2', '3', '4', '5', ''], { order: ['claude'], run: async () => ({ why: 'no answer' }) });
  assert.strictEqual(res.length, 4);
  assert.match(res[0].error, /claude \(no answer\)/);
  assert.match((await helpers.askPool(['x'], { order: [], run: async () => ({ text: 'y' }) }))[0].error, /no cloud AI/);
});

test('the helper sees only the question', async () => {
  let sent;
  await helpers.askPool(['best tent under $200'], { order: ['gemini'], run: async (id, p) => { sent = p; return { text: 'x' }; } });
  assert.ok(sent.startsWith(helpers.HELPER_PROMPT));
  assert.ok(sent.endsWith('Question: best tent under $200'));
});

test('private words, card/SSN numbers and locked-profile details never leave', () => {
  const opts = { privateWords: 'bank, social security, tax', locked: '## Contact\n- Phone: 555-201-8899\n- Email: james@example.com\nWork authorization: yes' };
  assert.match(helpers.leaksPrivate('Which bank has the best savings rate?', opts), /bank/);
  assert.match(helpers.leaksPrivate('is 4111 1111 1111 1111 valid', opts), /card/);
  assert.match(helpers.leaksPrivate('lookup 123-45-6789', opts), /social security/);
  assert.match(helpers.leaksPrivate('Who owns 555-201-8899?', opts), /locked profile/);
  assert.match(helpers.leaksPrivate('Find JAMES@example.com online', opts), /locked profile/);
  assert.strictEqual(helpers.leaksPrivate('Compare the Sony WH-1000XM6 and Bose QC Ultra', opts), null);
  assert.strictEqual(helpers.leaksPrivate('Is yes a word', opts), null); // short values don't count
  assert.strictEqual(helpers.leaksPrivate('banking history of Rome', opts), null); // whole words only
});

test('show() labels who answered and flags failures', () => {
  const out = helpers.show([{ question: 'a', via: 'gemini', answer: 'line1\nline2' }, { question: 'b', error: 'no helper answered' }], { gemini: 'Gemini' });
  assert.match(out, /1\. a\n {3}Gemini says:\n {3}line1\n {3}line2/);
  assert.match(out, /2\. b\n {3}\(no helper answered\)/);
});
