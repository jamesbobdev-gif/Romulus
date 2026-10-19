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

test('the bank’s own wording is kept when the payee name hides it', () => {
  const [a] = finance.cleanAccounts({ accounts: [{ id: 'a', transactions: [
    { id: '1', posted: 1, amount: '-9', payee: 'Amazon', description: 'AMZN Mktp US*2K4', memo: 'Card 1234' },
    { id: '2', posted: 1, amount: '-3', description: 'Coffee' }] }] });
  assert.deepStrictEqual([a.transactions[0].description, a.transactions[0].bank, a.transactions[0].memo], ['Amazon', 'AMZN Mktp US*2K4', 'Card 1234']);
  assert.ok(!('bank' in a.transactions[1]) && !('memo' in a.transactions[1]));
});

test('corrections on the cost charts are kept in the vault', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  finance.init({ userData: () => d2, agentLog: () => {}, sendToRenderer: () => {}, fetch: async (url, opts) => opts.method === 'POST'
    ? { ok: true, status: 200, text: async () => ACCESS } : { ok: true, status: 200, json: async () => ({ accounts: [] }) } });
  await h['finance:setup'](null, token, 'correct horse battery');
  assert.strictEqual(h['finance:setKind'](null, 'shell oil', 'fixed').ok, true);
  assert.strictEqual(h['finance:setKind'](null, 'shell oil', 'nonsense').ok, false);
  h['finance:lock']();
  await h['finance:unlock'](null, 'correct horse battery');
  assert.deepStrictEqual(h['finance:data']().kinds, { 'shell oil': 'fixed' });
  h['finance:setKind'](null, 'shell oil', null);
  assert.deepStrictEqual(h['finance:data']().kinds, {});
  h['finance:forget']();
});

test('purchase emails are read after setup and kept in the vault, not in the clear', async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  let told;
  const done = new Promise((res) => { told = res; });
  const b64 = (s) => Buffer.from(s).toString('base64');
  finance.init({ userData: () => d3, agentLog: () => {}, sendToRenderer: (ch) => { if (ch === 'finance:updated' && !finance.handlers['finance:data']().mail.busy) told(); },
    fetch: async (url, opts) => opts.method === 'POST' ? { ok: true, status: 200, text: async () => ACCESS } : { ok: true, status: 200, json: async () => ({ accounts: [] }) },
    mail: { mailAllowed: () => true,
      gmail: async (p) => p.startsWith('messages?') ? { messages: [{ id: 'm1' }] }
        : { id: 'm1', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', body: { data: b64('Total $9.99') }, headers: [{ name: 'Subject', value: 'Your receipt' }] } },
      claudeJson: async () => JSON.stringify({ receipts: [{ email: 1, store: 'spotify', merchant: 'Spotify', total: 9.99, date: '', items: [] }] }) } });
  await h['finance:setup'](null, token, 'correct horse battery');
  await done;
  const d = h['finance:data']();
  assert.deepStrictEqual(d.receipts.map((r) => [r.store, r.total]), [['spotify', 9.99]]);
  assert.ok(!fs.readFileSync(path.join(d3, 'finance.vault'), 'utf8').includes('spotify'));
  h['finance:forget']();
});

test('purchase emails come from every Gmail account switched on, each read from its own inbox', async () => {
  const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  let told;
  const done = new Promise((res) => { told = res; });
  const b64 = (s) => Buffer.from(s).toString('base64');
  const asked = [];
  finance.init({ userData: () => d6, agentLog: () => {}, sendToRenderer: (ch) => { if (ch === 'finance:updated' && !finance.handlers['finance:data']().mail.busy) told(); },
    fetch: async (url, opts) => opts.method === 'POST' ? { ok: true, status: 200, text: async () => ACCESS } : { ok: true, status: 200, json: async () => ({ accounts: [] }) },
    mail: { receiptAccounts: () => [{ id: 'g-1', email: 'me@x.com' }, { id: 'g-2', email: 'shop@x.com' }],
      gmail: async (p, acct) => { asked.push(acct); const id = acct + '-m';
        return p.startsWith('messages?') ? { messages: [{ id }] }
          : { id, internalDate: String(Date.now()), payload: { mimeType: 'text/plain', body: { data: b64('Total $5') }, headers: [{ name: 'Subject', value: 'Receipt' }] } }; },
      claudeJson: async (m) => JSON.stringify({ receipts: [{ email: 1, store: /g-2/.test(m[1].content) ? 'target' : 'spotify', total: 5, date: '', items: [] }] }) } });
  await h['finance:setup'](null, token, 'correct horse battery');
  await done;
  assert.deepStrictEqual(h['finance:data']().receipts.map((r) => r.id).sort(), ['g-1-m', 'g-2-m']);
  assert.deepStrictEqual([...new Set(asked)], ['g-1', 'g-2']);
  h['finance:forget']();
});

test('stock prices come from Yahoo for the holdings SimpleFIN sent', async () => {
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  const asked = [];
  finance.init({ userData: () => d4, agentLog: () => {}, sendToRenderer: () => {},
    fetch: async (url, opts) => {
      if (opts.method === 'POST') return { ok: true, status: 200, text: async () => ACCESS };
      if (url.startsWith('https://query1.finance.yahoo.com/')) {
        asked.push(url);
        const t = Math.floor(Date.now() / 1000);
        return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 200, chartPreviousClose: 199, regularMarketTime: t },
          timestamp: [t - 600, t], indicators: { quote: [{ close: [198, 200] }] } }] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'b1', name: 'Brokerage', balance: '2000', transactions: [],
        holdings: [{ id: 'h1', symbol: 'AAPL', shares: '10', market_value: '1900', cost_basis: '1500' }] }] }) };
    } });
  await h['finance:setup'](null, token, 'correct horse battery');
  const s = await h['finance:stocks'](null, true);
  assert.deepStrictEqual([s.total, s.change, s.gain], [2000, 10, 500]);
  assert.deepStrictEqual(s.today.map((p) => p[1]), [1980, 2000]);
  assert.ok(asked.every((u) => !/1500|1900|Brokerage/.test(u)), 'only the symbol goes to Yahoo');
  h['finance:forget']();
});

test('Windows Hello: kept after a passphrase unlock, opens Finance after Hello says yes, never stored in the clear', async () => {
  const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  let answer = 'Verified';
  const sealed = (s) => 'enc:v1:' + Buffer.from(s).toString('hex');
  const opened = (s) => (String(s).startsWith('enc:v1:') ? Buffer.from(s.slice(7), 'hex').toString() : s);
  const base = { userData: () => d5, agentLog: () => {}, sendToRenderer: () => {},
    fetch: async (url, opts) => opts.method === 'POST' ? { ok: true, status: 200, text: async () => ACCESS } : { ok: true, status: 200, json: async () => ({ accounts: [] }) },
    hello: { available: async () => true, verify: async () => answer } };
  finance.init(Object.assign({}, base, { seal: sealed, unseal: opened }));
  await h['finance:setup'](null, token, 'correct horse battery');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(h['finance:status']().hello, true);
  const kept = fs.readFileSync(path.join(d5, 'finance.hello'), 'utf8');
  assert.ok(kept.includes('enc:v1:'));
  h['finance:lock']();
  answer = 'Canceled';
  const no = await h['finance:helloUnlock']();
  assert.deepStrictEqual([no.ok, no.cancelled], [false, true]);
  assert.strictEqual(h['finance:data']().locked, true);
  answer = 'Verified';
  assert.strictEqual((await h['finance:helloUnlock']()).ok, true);
  assert.strictEqual(h['finance:data']().locked, false);
  // off: the sealed copy goes; the passphrase still opens it and doesn't bring Hello back
  assert.strictEqual((await h['finance:setHello'](null, false)).hello, false);
  h['finance:lock']();
  assert.strictEqual((await h['finance:unlock'](null, 'correct horse battery')).ok, true);
  assert.strictEqual(h['finance:status']().hello, false);
  h['finance:forget']();
  // Windows can't encrypt (seal hands it back as is): Hello is never set up
  const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-fin-'));
  finance.init(Object.assign({}, base, { userData: () => d6, seal: (s) => s, unseal: (s) => s }));
  await h['finance:setup'](null, token, 'correct horse battery');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(fs.existsSync(path.join(d6, 'finance.hello')), false);
  h['finance:forget']();
});
