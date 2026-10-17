const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const finance = require('../main/finance');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
const ACCESS = 'https://user:pass@beta-bridge.simplefin.org/simplefin';
const calls = [];
finance.init({ userData: () => dir, agentLog: () => {}, sendToRenderer: () => {},
  fetch: async (url, opts) => {
    calls.push({ url, opts });
    if (opts.method === 'POST') return { ok: true, status: 200, text: async () => ACCESS };
    return { ok: true, status: 200, json: async () => ({ errlist: [], connections: [{ conn_id: 'c1', name: 'Bank' }],
      accounts: [{ id: 'a1', name: 'Checking', conn_id: 'c1', currency: 'USD', balance: '12.50', 'balance-date': 1,
        transactions: [{ id: 't1', posted: Math.floor(Date.now() / 1000), amount: '-3.00', description: 'Coffee' }] }] }) };
  } });
const h = finance.handlers;
const token = Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/abc123').toString('base64');

test('only simplefin.org tokens are accepted', () => {
  assert.strictEqual(finance.claimUrlFromToken(Buffer.from('https://evil.example/claim/x').toString('base64')), null);
  assert.ok(finance.claimUrlFromToken(token));
});

test('setup, lock, wrong and right passphrase', async () => {
  const r = await h['finance:setup'](null, token, 'correct horse battery');
  assert.strictEqual(r.ok, true);
  const get = calls.find((c) => c.opts.headers && c.opts.headers.Authorization);
  assert.ok(!get.url.includes('pass@'), 'credentials go in the header, not the URL');
  assert.strictEqual(h['finance:data']().accounts[0].balance, 12.5);
  const raw = fs.readFileSync(path.join(dir, 'finance.vault'), 'utf8');
  assert.ok(!raw.includes('Coffee') && !raw.includes('pass@'), 'vault is encrypted');
  h['finance:lock']();
  assert.strictEqual(h['finance:data']().locked, true);
  assert.strictEqual((await h['finance:unlock'](null, 'wrong passphrase!')).ok, false);
  assert.strictEqual((await h['finance:unlock'](null, 'correct horse battery')).ok, true);
  assert.strictEqual(h['finance:data']().accounts[0].transactions[0].description, 'Coffee');
  h['finance:forget']();
  assert.strictEqual(fs.existsSync(path.join(dir, 'finance.vault')), false);
});
