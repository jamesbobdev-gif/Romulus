const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const le = require('../renderer/js/link-email');
const buy = require('../main/buy-emails');

test('an email address is checked the way the database checks it', () => {
  assert.ok(le.linkEmailValid('someone@example.com'));
  assert.ok(le.linkEmailValid('  A.B+tag@mail.example.co.uk '));
  for (const bad of ['', 'nobody', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b.c', 'x<y>@z.com', 'a@b.com,c@d.com', 'x'.repeat(250) + '@b.com'])
    assert.ok(!le.linkEmailValid(bad), bad);
  // the same pattern as link_email_start in the migration, so a yes here is a yes there
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261118_link_email.sql'), 'utf8');
  assert.ok(sql.includes("'^[^@\\s<>\",;]+@[^@\\s<>\",;]+\\.[a-z]{2,}$'"));
});

test('server refusals read as plain words, and a code is six digits however it is typed', () => {
  assert.match(le.linkEmailWhy('wrong', 'confirm'), /isn’t right/);
  assert.match(le.linkEmailWhy('too_many', 'confirm'), /new code/);
  assert.match(le.linkEmailWhy('too_many', 'start'), /tomorrow/);
  assert.match(le.linkEmailWhy('not_ready', 'start'), /can’t email/);
  assert.match(le.linkEmailWhy('something new', 'send'), /didn’t work/);
  assert.strictEqual(le.linkEmailCodeClean(' 123 456 '), '123456');
  assert.strictEqual(le.linkEmailCodeClean('1234567'), '123456');
});

test('a pick sends only the link card, never an address of its own choosing', () => {
  const body = le.linkEmailSendBody('tk_lookup', { label: 'Desk lamp', url: 'https://shop.example/lamp', price: '$20', kind: 'weird', to: 'someone@else.com', notes: 'x' });
  assert.deepStrictEqual(body, { action: 'send', account: 'tk_lookup', kind: 'buy', label: 'Desk lamp', url: 'https://shop.example/lamp', price: '$20', rating: null, image: null });
  assert.strictEqual(le.linkEmailSendBody('k', { kind: 'print', label: 'a', url: 'https://x.y' }).kind, 'print');
});

test('the desktop leaves alone a pick the app already sent to its confirmed address', async () => {
  const posts = [];
  const realFetch = global.fetch;
  global.fetch = async (u, o) => { posts.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  let cfg = { buyEmailTo: 'me@example.com', buyEmailUrl: 'https://fn.example/buy-email?token=t' };
  buy.init({ readConfig: () => cfg, writeConfig: (c) => { cfg = c; }, agentLog: () => {} });
  try {
    await buy.processBuyEmails(JSON.stringify({ tasks: [
      { id: 'a', ws: 'agent', buyEmail: { label: 'Sent by the app', url: 'https://x.example/a', at: 1, via: 'hosted' } },
      { id: 'b', ws: 'agent', buyEmail: { label: 'Older path', url: 'https://x.example/b', at: 2 } },
    ] }));
  } finally { global.fetch = realFetch; }
  assert.deepStrictEqual(posts.map((p) => p.label), ['Older path']);
});

test('only the service role can reach the address table and its functions', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261118_link_email.sql'), 'utf8');
  assert.match(sql, /alter table public\.link_email enable row level security/);
  assert.match(sql, /alter table public\.link_email_daily enable row level security/);
  assert.match(sql, /references public\.sync_accounts\(account\) on delete cascade/); // deleting the account takes it
  assert.doesNotMatch(sql, /to (anon|authenticated)/);
  assert.doesNotMatch(sql, /create policy/);
});
