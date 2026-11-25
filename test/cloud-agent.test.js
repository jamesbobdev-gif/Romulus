const test = require('node:test');
const assert = require('node:assert');
const c = require('../renderer/js/cloud-agent.js');

const task = (o) => Object.assign({ id: 't1', title: 'Find a quiet cafe near the library open Sunday', status: 'queued', history: [] }, o);

test('an ordinary research task may go', () => {
  assert.strictEqual(c.cloudAgWhyNot(task()), '');
});

test('private things never go', () => {
  assert.match(c.cloudAgWhyNot(task({ title: 'Check my bank account fees' })), /private words/);
  assert.match(c.cloudAgWhyNot(task({ title: 'pay with 4111 1111 1111 1111' })), /card number/);
  assert.match(c.cloudAgWhyNot(task({ title: 'form needs 123-45-6789' })), /ID number/);
  assert.match(c.cloudAgWhyNot(task({ title: 'how much did I spend on gas' })), /own money/);
  assert.match(c.cloudAgWhyNot(task({ title: 'sort my inbox' })), /email/);
  assert.match(c.cloudAgWhyNot(task({ financeSeen: true })), /finances/);
  assert.match(c.cloudAgWhyNot(task({ lane: 'local' })), /own model/);
  assert.match(c.cloudAgWhyNot(task({ cart: [{ name: 'milk' }] })), /store accounts/);
  assert.match(c.cloudAgWhyNot(task({ replyImages: ['https://x/y.jpg'] })), /photos/);
});

test('private words come from their own list, and only their words count', () => {
  assert.match(c.cloudAgWhyNot(task({ title: 'plan the surprise party' }), 'surprise'), /surprise/);
  // an AI's answer that mentions "bank" doesn't make the task private
  assert.strictEqual(c.cloudAgWhyNot(task({ history: [{ who: 'claude', text: 'The bank across the street has a cafe' }] })), '');
  assert.match(c.cloudAgWhyNot(task({ history: [{ who: 'you', text: 'near my doctor please' }] })), /doctor/);
});

test('the request carries only the task and the conversation', () => {
  const r = c.cloudAgTask(task({ notes: 'no chains', reply: 'cheaper ones?', shot: 'https://x', cloud: 'gemini',
    history: [{ who: 'you', text: 'hi', at: 1 }, { who: 'sys', text: 'Routed' }, { who: 'claude', text: 'Here are three', options: ['a'] }] }));
  assert.deepStrictEqual(Object.keys(r).sort(), ['history', 'notes', 'reply', 'title']);
  assert.deepStrictEqual(r.history, [{ who: 'you', text: 'hi' }, { who: 'assistant', text: 'Here are three' }]);
});

test('it waits for computers first, longer when a mini PC is on', () => {
  const now = 1e9;
  assert.strictEqual(c.cloudAgDue(task({ updatedAt: now - 10e3 }), now, false), false);
  assert.strictEqual(c.cloudAgDue(task({ updatedAt: now - c.CLOUD_AG_WAIT_MS }), now, false), true);
  assert.strictEqual(c.cloudAgDue(task({ updatedAt: now - c.CLOUD_AG_WAIT_MS }), now, true), false);
  assert.strictEqual(c.cloudAgDue(task({ updatedAt: now - c.CLOUD_AG_WORKER_WAIT_MS }), now, true), true);
  assert.strictEqual(c.cloudAgDue(task({ status: 'working', updatedAt: 0 }), now, false), false);
  assert.strictEqual(c.cloudAgDue(task({ updatedAt: 0, waitUntil: now + 1000 }), now, false), false);
});

test('a failed try is not repeated until they reply', () => {
  assert.strictEqual(c.cloudAgTriedThisRound(task({ cloudTried: 0 })), true);
  assert.strictEqual(c.cloudAgTriedThisRound(task({ cloudTried: 0, history: [{ who: 'you', text: 'try again' }] })), false);
  assert.strictEqual(c.cloudAgTriedThisRound(task()), false);
});

test('only the device with the private key opens the answer', async () => {
  const mine = await c.cloudAgKeyPair();
  assert.strictEqual(mine.pub.d, undefined, 'the public half carries no private part');
  const sealed = await c.cloudAgSeal(mine.pub, { status: 'done', note: 'Two cafes fit.', options: [] });
  assert.ok(!JSON.stringify(sealed).includes('Two cafes'));
  assert.deepStrictEqual(await c.cloudAgOpen(mine.priv, sealed), { status: 'done', note: 'Two cafes fit.', options: [] });
  const other = await c.cloudAgKeyPair();
  await assert.rejects(c.cloudAgOpen(other.priv, sealed));
});

test('lines of their notes with private things are left out, headings stay', () => {
  const notes = '## About him\n- Lives near the library\n- Doctor appointments on Fridays\n- Card 4111 1111 1111 1111\n## Shopping\n- Likes oat milk';
  assert.strictEqual(c.cloudAgPrefs(notes), '## About him\n- Lives near the library\n## Shopping\n- Likes oat milk');
  assert.strictEqual(c.cloudAgPrefs('- plan the surprise party', 'surprise'), '');
  assert.strictEqual(c.cloudAgPrivateIn('my SSN is 123-45-6789'), 'it mentions “ssn”, one of your private words');
});

test('the account goes as the same hash the server makes, never the key', async () => {
  const crypto = require('crypto');
  const want = 'tk_acct_' + crypto.createHash('sha256').update('abc123XYZ_secret-part').digest('hex');
  assert.strictEqual(await c.cloudAgAccount('tk_agent_abc123XYZ_secret-part'), want);
  assert.strictEqual(await c.cloudAgAccount('tk_abc123XYZ_secret-part:prefs'), want, 'same account for every list and side row');
  assert.ok(!(await c.cloudAgAccount('tk_agent_abc123XYZ_secret-part')).includes('secret'));
});

test('a locked key pair opens answers but its private half cannot be exported', async () => {
  const k = await c.cloudAgKeyPair(true);
  const sealed = await c.cloudAgSeal(k.pub, { status: 'done', note: 'ok' });
  assert.deepStrictEqual(await c.cloudAgOpen(k.priv, sealed), { status: 'done', note: 'ok' });
  await assert.rejects(require('crypto').webcrypto.subtle.exportKey('jwk', k.priv));
});

test('the answer becomes a normal Agent result', () => {
  const r = c.cloudAgResult('t1', { status: 'done', note: 'Here.', options: [{ label: 'Cafe', url: 'https://cafe.example' }, { label: 'Bad', url: 'javascript:alert(1)' }, { url: 'https://x' }] });
  assert.strictEqual(r.status, 'done'); assert.strictEqual(r.lane, 'claude'); assert.strictEqual(r.model, 'Romulus cloud');
  assert.deepStrictEqual(r.options.map((o) => o.url), ['https://cafe.example', undefined]);
  assert.strictEqual(c.cloudAgResult('t1', { status: 'odd', note: 'Hm' }).status, 'needs-you');
  assert.strictEqual(c.cloudAgResult('t1', { note: '  ' }), null);
});

test('every refusal reads as plain words', () => {
  for (const why of ['limit', 'spend', 'server', 'ip', 'off', 'no_account', 'new_account', 'other']) assert.match(c.cloudAgWhyText(why, { limit: 20 }), /computer/);
  assert.match(c.cloudAgWhyText('busy'), /starts when one of them finishes/);
  assert.match(c.cloudAgWhyText('limit', { limit: 20 }), /20 Romulus cloud tasks/);
});

/* ── scheduled runs: a repeating task kept on the server for when every device is off ── */
const rep = (o) => task(Object.assign({ repeat: { every: 'day', at: '08:00', day: null }, nextRun: 1800000000000, done: true, status: 'done' }, o));

test('only a repeating task that could go to the cloud anyway can be scheduled there', () => {
  assert.strictEqual(c.cloudSchedWhyNot(rep()), ''); // finished between rounds is fine
  assert.match(c.cloudSchedWhyNot(task()), /doesn’t repeat/);
  assert.match(c.cloudSchedWhyNot(rep({ title: 'check my bank account fees' })), /private words/);
  assert.match(c.cloudSchedWhyNot(rep({ lane: 'local' })), /own model/);
  assert.match(c.cloudSchedWhyNot(rep({ title: 'sort my inbox' })), /email/);
});

test('the server knows a scheduled task by a hash, and gets a shorter copy than a live task', async () => {
  const id = await c.cloudSchedId('t1');
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.strictEqual(id, await c.cloudSchedId('t1'));
  assert.notStrictEqual(id, await c.cloudSchedId('t2'));
  const history = Array.from({ length: 12 }, (_, i) => ({ who: i % 2 ? 'claude' : 'you', text: 'x'.repeat(4000), at: i }));
  const copy = c.cloudSchedTask(rep({ history, reply: 'something typed just now', notes: 'n' }));
  assert.strictEqual(copy.history.length, 8);
  assert.strictEqual(copy.history[0].text.length, 1500);
  assert.strictEqual(copy.reply, '');
  assert.deepStrictEqual(Object.keys(copy).sort(), ['history', 'notes', 'reply', 'title']);
  assert.deepStrictEqual(c.cloudSchedRule(rep({ repeat: { every: 'week', at: '07:00', day: 0 } }), 'America/New_York'),
    { every: 'week', at: '07:00', day: 0, tz: 'America/New_York' });
});

test('a copy is sent again only when what it depends on changed, or it is getting old', () => {
  const now = 1800000000000, tz = 'America/New_York';
  const t = rep({ cloudRun: { on: true } });
  assert.deepStrictEqual(c.cloudSchedPlan([t], null, now, tz).put, [t]); // never sent
  t.cloudRun.sent = c.cloudSchedPrint(t, tz); t.cloudRun.at = now;
  assert.deepStrictEqual(c.cloudSchedPlan([t], null, now + 1000, tz), { put: [], drop: [], clear: [] });
  for (const change of [{ title: 'another title' }, { nextRun: t.nextRun + 86400000 }, { repeat: { every: 'day', at: '09:00', day: null } },
    { history: [{ who: 'you', text: 'cheaper ones please', at: 5 }] }]) {
    assert.strictEqual(c.cloudSchedPlan([Object.assign({}, t, change)], null, now + 1000, tz).put.length, 1, JSON.stringify(change));
  }
  assert.strictEqual(c.cloudSchedPlan([t], null, now + 1000, 'Europe/Paris').put.length, 1); // he moved time zone
  assert.strictEqual(c.cloudSchedPlan([t], null, now + c.CLOUD_SCHED_REFRESH_MS + 1, tz).put.length, 1); // still in use: say so
});

test('switched off, no longer repeating or turned private: the server\'s copy is taken back', () => {
  const now = 1800000000000;
  const sent = (o) => rep(Object.assign({ cloudRun: { on: true, sent: 'x', at: now } }, o));
  const off = sent({ cloudRun: { on: false, sent: 'x', at: now } });
  const noRepeat = sent({ repeat: null });
  const priv = sent({ title: 'renew my passport every year' });
  const never = rep({ cloudRun: { on: false } });
  const plan = c.cloudSchedPlan([off, noRepeat, priv, never, rep()], null, now, 'UTC');
  assert.deepStrictEqual(plan.drop, [off, noRepeat, priv]);
  assert.deepStrictEqual(plan.clear, [never]);
  assert.deepStrictEqual(plan.put, []);
});

test('a stored copy opens only with the server\'s key, and its answer only with the key on the task', async () => {
  const server = await c.cloudAgKeyPair(false), onTask = await c.cloudAgKeyPair(false), other = await c.cloudAgKeyPair(false);
  const copy = { task: c.cloudSchedTask(rep()), prefs: 'Likes quiet places' };
  const sealed = await c.cloudAgSeal(server.pub, copy);
  assert.ok(!JSON.stringify(sealed).includes('cafe'));
  assert.deepStrictEqual(await c.cloudAgOpen(server.priv, sealed), copy); // what the function does (index.ts open)
  await assert.rejects(c.cloudAgOpen(other.priv, sealed));
  const answer = await c.cloudAgSeal(onTask.pub, { status: 'done', note: 'Three cafes are open Sunday.' });
  assert.strictEqual((await c.cloudAgOpen(onTask.priv, answer)).note, 'Three cafes are open Sunday.');
  await assert.rejects(c.cloudAgOpen(server.priv, answer)); // the server can't read back what it sealed
});

test('why a round didn\'t run is said in plain words', () => {
  assert.match(c.cloudSchedWhyText('plan'), /paid plan/);
  assert.match(c.cloudSchedWhyText('limit', { limit: 20 }), /up to 20/);
  assert.match(c.cloudSchedWhyText('spend'), /allowance is used up/);
  assert.match(c.cloudSchedWhyText('Romulus cloud is busy right now.'), /busy right now/);
});
