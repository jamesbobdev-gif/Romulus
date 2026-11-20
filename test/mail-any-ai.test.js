const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { askJson, pickJson } = require('../agent/ai-json');
const mailMcp = require('../agent/mail-mcp');
const providers = require('../agent/providers');

const messages = [{ role: 'system', content: 'find dates' }, { role: 'user', content: 'Email 1: exam on Friday' }];
const schema = { type: 'object', properties: { events: { type: 'array' } }, required: ['events'] };
const reply = (j) => ({ ok: true, status: 200, json: async () => j });

test('mail JSON goes to the first AI in his order, not to Claude', async () => {
  const cfg = { ai: { geminiKey: 'g', openrouterKey: 'o' } };
  const urls = [];
  const fetch = async (url) => { urls.push(url); return reply({ candidates: [{ content: { parts: [{ text: '```json\n{"events":[]}\n```' }] } }] }); };
  const out = await askJson(cfg, messages, schema, { fetch, order: ['gemini', 'claude'], claudeJson: async () => { throw new Error('Claude was asked'); } });
  assert.deepStrictEqual(JSON.parse(out), { events: [] });
  assert.strictEqual(urls.length, 1);
  assert.match(urls[0], /generativelanguage/);
});

test('an AI that fails hands the mail to the next one in the order', async () => {
  const cfg = { ai: { geminiKey: 'g', openrouterKey: 'o' } };
  const fetch = async (url) => /generativelanguage/.test(url) ? { ok: false, status: 503, json: async () => ({ error: { message: 'busy' } }) }
    : reply({ choices: [{ message: { content: '{"events":[{"title":"x"}]}' } }] });
  const out = await askJson(cfg, messages, schema, { fetch, order: ['gemini', 'openrouter'] });
  assert.strictEqual(JSON.parse(out).events[0].title, 'x');
});

test('Claude on his sign-in is asked only when it is its turn', async () => {
  let asked = 0;
  const out = await askJson({}, messages, schema, { fetch: async () => { throw new Error('no'); }, order: ['claude'], claudeJson: async () => { asked++; return '{"events":[]}'; } });
  assert.strictEqual(asked, 1);
  assert.strictEqual(out, '{"events":[]}');
});

test('no AI connected: says so', async () => {
  await assert.rejects(askJson({}, messages, schema, { fetch, order: [] }), /no AI is connected/);
});

test('pickJson finds the object in a chatty answer', () => {
  assert.deepStrictEqual(pickJson('Sure! {"a":1} hope that helps'), { a: 1 });
  assert.strictEqual(pickJson('no json here'), null);
});

// the mail tools' accounts file, as the runner writes it
function mailboxes(list, final) {
  const f = path.join(os.tmpdir(), 'mail-mcp-test-accounts.json');
  fs.writeFileSync(f, JSON.stringify(list));
  process.env.MAIL_ACCOUNTS_FILE = f; process.env.MAIL_FINAL = final ? '1' : '0';
}
// a fake mail server: records each call, answers what the tool needs
function fakeFetch(answer) {
  const calls = [];
  global.fetch = async (url, o = {}) => { calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
    return reply(answer ? answer(url, o) : { id: 'x1' }); };
  return calls;
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

test('the mail tools: reading, changing, and the final ones', () => {
  const names = mailMcp.TOOLS.map((t) => t.name);
  for (const n of ['search_threads', 'get_thread', 'get_message', 'list_labels', 'create_draft', 'change_labels', 'archive', 'mark_read', 'send_message', 'reply', 'forward', 'send_draft', 'trash']) assert.ok(names.includes(n), n);
  assert.deepStrictEqual(mailMcp.FINAL_TOOLS.sort(), ['forward', 'reply', 'send_draft', 'send_message', 'trash']);
});

test('no mailbox connected: the tools say so', async () => {
  mailboxes([]);
  await assert.rejects(mailMcp.call('list_labels', {}), /No mailbox is connected/);
});

test('send and trash wait for his yes; drafts and archive do not', async () => {
  mailboxes([{ provider: 'google', email: 'me@gmail.com', token: 't', write: true, send: true }], false);
  const calls = fakeFetch();
  await assert.rejects(mailMcp.call('send_message', { to: ['a@b.co'], subject: 'Hi', body: 'Hello' }), /waits for his yes/);
  await assert.rejects(mailMcp.call('trash', { messageId: 'm1' }), /waits for his yes/);
  await assert.rejects(mailMcp.call('reply', { messageId: 'm1', body: 'ok' }), /waits for his yes/);
  assert.strictEqual(calls.length, 0); // refused before anything reached Gmail
  const d = await mailMcp.call('create_draft', { to: ['a@b.co'], subject: 'Hi', body: 'Hello' });
  assert.strictEqual(d.draftId, 'x1');
  assert.match(calls[0].url, /\/drafts$/);
  await mailMcp.call('archive', { threadId: 't1' });
  assert.match(calls[1].url, /threads\/t1\/modify$/);
  assert.deepStrictEqual(calls[1].body, { addLabelIds: [], removeLabelIds: ['INBOX'] });
});

test('with his yes, send goes through Gmail and trash never deletes for good', async () => {
  mailboxes([{ provider: 'google', email: 'me@gmail.com', token: 't', write: true, send: true }], true);
  const calls = fakeFetch();
  const r = await mailMcp.call('send_message', { to: 'Ann <ann@x.com>', subject: 'Hi', body: 'Hello' });
  assert.deepStrictEqual(r.to, ['ann@x.com']);
  assert.match(calls[0].url, /messages\/send$/);
  assert.match(Buffer.from(calls[0].body.raw, 'base64url').toString(), /To: ann@x\.com/);
  await mailMcp.call('trash', { messageId: 'm1' });
  assert.match(calls[1].url, /messages\/m1\/trash$/);
});

test('a mailbox connected before it could change mail says to connect it again', async () => {
  mailboxes([{ provider: 'google', email: 'me@gmail.com', token: 't', write: false, send: true }], true);
  fakeFetch();
  await assert.rejects(mailMcp.call('archive', { messageId: 'm1' }), /connect it again/);
});

test('Outlook: drafts, archive and send through Microsoft Graph', async () => {
  mailboxes([{ provider: 'microsoft', email: 'me@school.edu', token: 't', write: true, send: true }], true);
  const calls = fakeFetch();
  await mailMcp.call('create_draft', { to: ['a@b.co'], subject: 'Hi', body: 'Hello' });
  assert.match(calls[0].url, /graph\.microsoft\.com\/v1\.0\/me\/messages$/);
  await mailMcp.call('archive', { messageId: 'm1' });
  assert.deepStrictEqual(calls[1].body, { destinationId: 'archive' });
  await mailMcp.call('send_message', { to: ['a@b.co'], subject: 'Hi', body: 'Hello', account: 'me@school.edu' });
  assert.match(calls[2].url, /\/sendMail$/);
});

test('ids from an email cannot walk to another address', async () => {
  mailboxes([{ provider: 'google', email: 'me@gmail.com', token: 't', write: true, send: true }], true);
  fakeFetch();
  await assert.rejects(mailMcp.call('get_thread', { threadId: '../x?y' }), /isn’t a message id/);
});

test('a message comes back as plain text with its headers', () => {
  const data = Buffer.from('Hello there').toString('base64');
  const m = mailMcp.showMessage({ id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', body: { data },
    headers: [{ name: 'From', value: 'a@b.c' }, { name: 'Subject', value: 'Hi' }] } }, 100);
  assert.strictEqual(m.text, 'Hello there');
  assert.strictEqual(m.from, 'a@b.c');
  assert.strictEqual(m.subject, 'Hi');
});

test('an inbox run on Codex has web search off and the mail server in its config', () => {
  const a = providers.codexArgs('codex.js', 'out.txt', null, { name: 'mail', command: 'node', args: ['mail-mcp.js'] }, true);
  assert.ok(a.includes('web_search="disabled"'));
  assert.ok(a.some((x) => x.startsWith('mcp_servers.mail.command=')));
  assert.ok(!a.some((x) => x.startsWith('mcp_servers.browser.')));
});
