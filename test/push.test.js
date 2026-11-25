const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const push = require('../renderer/js/push');

const agentTask = (o) => Object.assign({ id: 't1', ws: 'agent', title: 'Book the dentist', status: 'needs-you', note: 'Tuesday 3pm or Thursday 10am?' }, o);

test('a notification carries the task, its title and what it says now, and nothing else', () => {
  const p = push.pushPayload(agentTask({ history: [{ who: 'you', text: 'secret' }], reply: 'x', options: [1], note: '**Tuesday**   3pm\nor `Thursday` 10am?' }));
  assert.deepStrictEqual(Object.keys(p).sort(), ['at', 'id', 'note', 'st', 'title', 'v']);
  assert.strictEqual(p.id, 't1');
  assert.strictEqual(p.title, 'Book the dentist');
  assert.strictEqual(p.note, 'Tuesday 3pm or Thursday 10am?');
  assert.strictEqual(p.st, 'needs-you');
  assert.strictEqual(push.pushPayload(agentTask({ status: 'done', note: null })).st, 'done');
  assert.strictEqual(push.pushPayload(agentTask({ note: null })).note, '');
  // long notes are cut so the sealed message fits in one Firebase data message (4 KB)
  assert.ok(push.pushPayload(agentTask({ title: 'x'.repeat(500), note: 'y'.repeat(5000) })).note.length <= 600);
  assert.ok(push.pushPayload(agentTask({ title: 'x'.repeat(500) })).title.length <= 120);
});

test('only an answer the page put on an open Agent task sends a notification', () => {
  const u = { id: 't1', status: 'needs-you', note: 'Tuesday 3pm or Thursday 10am?' };
  assert.ok(push.pushWants(agentTask(), u));
  assert.ok(push.pushWants(agentTask({ status: 'done', note: 'Booked.' }), { status: 'done', note: 'Booked.' }));
  // a finished answer the page left waiting on him (recipes to pick, a draft to send)
  assert.ok(push.pushWants(agentTask(), { status: 'done', note: 'Tuesday 3pm or Thursday 10am?' }));
  assert.ok(!push.pushWants(null, u), 'the task is gone');
  assert.ok(!push.pushWants(agentTask({ ws: 'personal' }), u), 'not an Agent task');
  assert.ok(!push.pushWants(agentTask({ done: true }), u), 'checked off');
  assert.ok(!push.pushWants(agentTask({ parked: true }), u), 'set aside');
  assert.ok(!push.pushWants(agentTask({ status: 'queued' }), u), 'handed on or queued again');
  assert.ok(!push.pushWants(agentTask(), { handoff: 'crashed' }), 'passed to the next AI');
  assert.ok(!push.pushWants(agentTask({ note: 'an older answer' }), u), 'the page dropped this answer');
});

test('a reply from a notification goes on its task like one typed in the app', () => {
  const tasks = [agentTask(), agentTask({ id: 't2', done: true }), { id: 't3', ws: 'personal', title: 'Milk' }];
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 't1', text: 'Tuesday' }), tasks[0]);
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 't2', text: 'Tuesday' }), null, 'checked off meanwhile');
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 't3', text: 'Tuesday' }), null, 'not an Agent task');
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 'gone', text: 'Tuesday' }), null);
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 't1', text: '   ' }), null);
  assert.strictEqual(push.pushReplyTarget(tasks, { id: 7, text: 'x' }), null);

  const said = [];
  const say = (t, who, text) => said.push([t.id, who, text]);
  const t = agentTask({ askSeen: 'abc', parked: true });
  push.pushReplyOnto(t, 'Tuesday', say);
  assert.strictEqual(t.reply, 'Tuesday');
  assert.strictEqual(t.status, 'queued');
  assert.ok(!('askSeen' in t) && !('parked' in t));
  assert.deepStrictEqual(said, [['t1', 'you', 'Tuesday']]);
  // while it is working, the reply stacks and the run carries on
  const w = agentTask({ status: 'working', reply: 'first' });
  push.pushReplyOnto(w, 'second', say);
  assert.strictEqual(w.reply, 'first\nsecond');
  assert.strictEqual(w.status, 'working');
});

test('replies are only asked for while a recent answer is waiting', () => {
  const now = Date.now();
  assert.ok(push.pushAwaits([agentTask({ updatedAt: now - 1000 })], now));
  assert.ok(push.pushAwaits([agentTask({ status: 'done' })], now));
  assert.ok(!push.pushAwaits([agentTask({ updatedAt: now - 4 * 86400000 })], now));
  assert.ok(!push.pushAwaits([agentTask({ status: 'working' }), agentTask({ done: true }), { id: 'x', ws: 'personal' }], now));
  assert.ok(!push.pushAwaits([], now));
});

test('the words are sealed with a key from the sync key, in the form the phone opens', async () => {
  const key = await push.pushKeyBytes('tk_examplesynckey0123456789');
  assert.strictEqual(key.length, 32);
  assert.deepStrictEqual(Array.from(await push.pushKeyBytes('tk_examplesynckey0123456789')), Array.from(key));
  assert.notDeepStrictEqual(Array.from(await push.pushKeyBytes('tk_anothersynckey0123456789')), Array.from(key));
  // the same derivation with Node's own HKDF
  const hk = Buffer.from(nodeCrypto.hkdfSync('sha256', Buffer.from('tk_examplesynckey0123456789'), Buffer.from(push.PUSH_SALT), Buffer.from('push'), 32));
  assert.deepStrictEqual(Array.from(hk), Array.from(key));

  const body = { v: 1, id: 't1', title: 'Book the dentist', note: 'Tuesday 3pm?', st: 'needs-you', at: 1 };
  const env = await push.pushSeal(key, body);
  assert.deepStrictEqual(Object.keys(env).sort(), ['ct', 'iv']);
  assert.ok(!JSON.stringify(env).includes('dentist'));
  assert.deepStrictEqual(await push.pushOpen(key, env), body);
  await assert.rejects(push.pushOpen(await push.pushKeyBytes('tk_anothersynckey0123456789'), env));
  // Push.java: AES/GCM/NoPadding, a 12-byte iv, the 16-byte tag at the end of ct
  const iv = Buffer.from(env.iv, 'base64'), ct = Buffer.from(env.ct, 'base64');
  assert.strictEqual(iv.length, 12);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  assert.deepStrictEqual(JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8')), body);
  // and a reply sealed the way Push.java does opens here
  const riv = nodeCrypto.randomBytes(12), c = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(key), riv);
  const rct = Buffer.concat([c.update(JSON.stringify({ id: 't1', text: 'Tuesday', at: 2 }), 'utf8'), c.final(), c.getAuthTag()]);
  assert.deepStrictEqual(await push.pushOpen(key, { iv: riv.toString('base64'), ct: rct.toString('base64') }), { id: 't1', text: 'Tuesday', at: 2 });
  // the longest notification still fits the push function's limit
  const big = await push.pushSeal(key, push.pushPayload(agentTask({ title: 'é'.repeat(500), note: 'é'.repeat(5000) })));
  assert.ok(big.ct.length <= 3400, String(big.ct.length));
});

test('the database part is in the migration and in setup.sql, and the page uses the same names', () => {
  const mig = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261125_push.sql'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, '../supabase/setup.sql'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../renderer/js/push.js'), 'utf8');
  const java = fs.readFileSync(path.join(__dirname, '../mobile/android/app/src/main/java/com/jartro/tasks/Push.java'), 'utf8');
  const fn = fs.readFileSync(path.join(__dirname, '../supabase/functions/push/index.ts'), 'utf8');
  for (const name of ['push_register', 'push_unregister', 'push_reply_put', 'push_reply_take', 'push_send_tokens', 'push_token_gone']) {
    assert.ok(mig.includes('function public.' + name + '('), name);
    assert.ok(setup.includes('function public.' + name + '('), name + ' in setup.sql');
  }
  const body = mig.slice(mig.indexOf('create table if not exists public.push_tokens'));
  assert.ok(setup.replace(/\r\n/g, '\n').includes(body.replace(/\r\n/g, '\n')), 'setup.sql carries the migration as it is');
  assert.ok(page.includes("'push_reply_take'") && page.includes("'push_register'"));
  assert.ok(java.includes('/rest/v1/rpc/push_reply_put'));
  assert.ok(fn.includes('"push_send_tokens"') && fn.includes('"push_token_gone"'));
  // only the functions a device calls are open to the app's key
  assert.ok(/grant execute on function public\.push_send_tokens\(text\), public\.push_token_gone\(text\) to service_role;/.test(mig));
});
