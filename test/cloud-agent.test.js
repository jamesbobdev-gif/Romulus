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
