const test = require('node:test');
const assert = require('node:assert');
const mailSend = require('../agent/mail-send');

const EMAIL = { to: ['Ann Lee <Ann@Example.com>'], cc: 'bob@example.org; ann@example.com', subject: 'Rent\r\nBcc: evil@x.com', body: 'Hi Ann,\r\n\r\nThe sink leaks — can someone come Friday?\n\nJames' };

test('cleanEmail: bare lower-case addresses, no duplicate cc, a one-line subject', () => {
  const e = mailSend.cleanEmail(EMAIL);
  assert.deepStrictEqual(e.to, ['ann@example.com']);
  assert.deepStrictEqual(e.cc, ['bob@example.org']);
  assert.strictEqual(e.subject, 'Rent Bcc: evil@x.com'); // the line break is gone, so no header slips in
  assert.ok(!e.body.includes('\r'));
});

test('cleanEmail refuses no recipient, bad addresses only, no body, or more than ten people', () => {
  assert.strictEqual(mailSend.cleanEmail(null), undefined);
  assert.strictEqual(mailSend.cleanEmail({ to: [], body: 'x' }), undefined);
  assert.strictEqual(mailSend.cleanEmail({ to: ['not an address', 'a@b'], body: 'x' }), undefined);
  assert.strictEqual(mailSend.cleanEmail({ to: ['a@b.com'], body: '  ' }), undefined);
  const many = Array.from({ length: 11 }, (_, i) => 'p' + i + '@x.com');
  assert.strictEqual(mailSend.cleanEmail({ to: many, body: 'x' }), undefined);
  assert.ok(mailSend.cleanEmail({ to: many.slice(0, 10), body: 'x' }));
  assert.deepStrictEqual(mailSend.addresses('a@x.com,\n"B" <b@y.co>, junk, a@x.com'), ['a@x.com', 'b@y.co']);
});

test('mime: UTF-8 subject and body survive, headers are only the ones we wrote', () => {
  const m = mailSend.mime({ from: 'me@gmail.com', to: ['a@x.com'], cc: ['b@y.com'], subject: 'Héllo — 東京', body: 'Line one\nLine two é' });
  const [head, body] = m.split('\r\n\r\n');
  const headers = head.split('\r\n');
  assert.deepStrictEqual(headers.map((h) => h.split(':')[0]), ['From', 'To', 'Cc', 'Subject', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
  const subj = /=\?UTF-8\?B\?(.*)\?=/.exec(head)[1];
  assert.strictEqual(Buffer.from(subj, 'base64').toString('utf8'), 'Héllo — 東京');
  assert.strictEqual(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Line one\r\nLine two é');
});

test('canSend: Google needs gmail.send, Microsoft Mail.Send, and a working sign-in', () => {
  const tokens = { refresh_token: 'r' };
  assert.ok(mailSend.canSend({ provider: 'google', scope: 'openid https://www.googleapis.com/auth/gmail.send', tokens }));
  assert.ok(!mailSend.canSend({ provider: 'google', scope: 'openid https://www.googleapis.com/auth/gmail.readonly', tokens }));
  assert.ok(mailSend.canSend({ provider: 'microsoft', scope: 'Calendars.ReadWrite Mail.Send', tokens }));
  assert.ok(!mailSend.canSend({ provider: 'microsoft', scope: 'Calendars.ReadWrite Mail.Send', tokens, broken: true }));
  assert.ok(!mailSend.canSend({ provider: 'ics', tokens }));
});

const fake = (status, body, seen) => async (url, opts) => { seen.url = url; seen.opts = opts; return { ok: status < 300, status, json: async () => body }; };

test('send through Gmail: users.messages.send with the raw message', async () => {
  const seen = {};
  const r = await mailSend.send({ provider: 'google', email: 'me@gmail.com' }, 'tok', EMAIL, { fetch: fake(200, { id: 'm1' }, seen) });
  assert.deepStrictEqual(r, { id: 'm1' });
  assert.strictEqual(seen.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok');
  const raw = Buffer.from(JSON.parse(seen.opts.body).raw, 'base64url').toString('utf8');
  assert.match(raw, /^From: me@gmail\.com\r\nTo: ann@example\.com\r\nCc: bob@example\.org\r\n/);
  assert.ok(!/^Bcc:/m.test(raw));
});

test('send through Outlook: Graph sendMail, kept in Sent Items', async () => {
  const seen = {};
  await mailSend.send({ provider: 'microsoft' }, 'tok', EMAIL, { fetch: fake(202, null, seen) });
  assert.strictEqual(seen.url, 'https://graph.microsoft.com/v1.0/me/sendMail');
  const b = JSON.parse(seen.opts.body);
  assert.deepStrictEqual(b.message.toRecipients, [{ emailAddress: { address: 'ann@example.com' } }]);
  assert.strictEqual(b.saveToSentItems, true);
  assert.strictEqual(b.message.body.contentType, 'Text');
});

test('send: the provider\'s refusal comes back as the error; a bad email never reaches it', async () => {
  const seen = {};
  await assert.rejects(mailSend.send({ provider: 'google' }, 't', EMAIL, { fetch: fake(403, { error: { message: 'Insufficient Permission' } }, seen) }), /Insufficient Permission/);
  const none = {};
  await assert.rejects(mailSend.send({ provider: 'google' }, 't', { to: [], body: 'x' }, { fetch: fake(200, {}, none) }));
  assert.strictEqual(none.url, undefined);
});

test('a Microsoft account from before Mail.Send refreshes without asking for it', () => {
  const calendars = require('../agent/calendars');
  assert.ok(!/Mail\.Send/.test(calendars.msRefreshScope({ scope: 'openid User.Read Calendars.ReadWrite' })));
  assert.match(calendars.msRefreshScope({ scope: 'openid https://graph.microsoft.com/Mail.Send Calendars.ReadWrite' }), /Mail\.Send/);
  assert.match(calendars.msRefreshScope({ scope: '' }), /Calendars\.ReadWrite/);
  // the Agent's mail tools: Mail.ReadWrite only once he agreed to it
  assert.ok(!/Mail\.ReadWrite/.test(calendars.msRefreshScope({ scope: 'https://graph.microsoft.com/Mail.Send' })));
  assert.match(calendars.msRefreshScope({ scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send' }), /Mail\.ReadWrite/);
});
