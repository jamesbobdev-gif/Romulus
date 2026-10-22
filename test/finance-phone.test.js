const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { pairPayload } = require('../main/finance');

const ACCESS = 'https://user:pass@beta-bridge.simplefin.org/simplefin';
/* mobile/finance-phone.js against a fake FinanceVault plugin */
function load(opts) {
  const store = { setUp: false, file: null, key: crypto.randomBytes(32).toString('base64') };
  const calls = [];
  const plugin = {
    available: () => ({ ok: opts.biometrics !== false, reason: 'Add a fingerprint in your phone’s settings first.' }),
    isSetUp: () => ({ setUp: store.setUp }),
    scan: () => ({ text: opts.scanned }),
    create: () => { store.setUp = true; return { key: store.key }; },
    unlock: () => { if (opts.cancel || opts.away) { const e = new Error('Cancel'); e.code = opts.away ? 'NOT_VISIBLE' : 'CANCELLED'; throw e; } return { key: store.key }; },
    write: ({ data }) => { store.file = data; return {}; },
    read: () => ({ data: store.file }),
    forget: () => { store.setUp = false; store.file = null; return {}; },
    http: ({ url, headers }) => {
      calls.push({ url, headers });
      if (url.includes('simplefin.org')) return { status: 200, body: JSON.stringify({ accounts: [{ id: 'a1', name: 'Checking', balance: '12.50', transactions: [{ id: 't1', posted: Math.floor(Date.now() / 1000), amount: '-3', description: 'Coffee' }],
        holdings: [{ symbol: 'AAPL', shares: '2', market_value: '380' }] }] }) };
      const t = Math.floor(Date.now() / 1000);
      return { status: 200, body: JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 200, chartPreviousClose: 190, regularMarketTime: t }, timestamp: [t], indicators: { quote: [{ close: [200] }] } }] } }) };
    },
  };
  const listeners = {};
  const ctx = {
    window: {}, document: { hidden: false, addEventListener: (ev, f) => { listeners[ev] = f; } },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, clearTimeout,
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, // the 10-minute lock mustn't keep the test running
    URL, AbortSignal, console,
  };
  ctx.window.Capacitor = { isPluginAvailable: (n) => n === 'FinanceVault',
    nativePromise: async (p, m, o) => { const f = plugin[m]; if (!f) throw new Error('no ' + m); return f(o || {}); } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/finance-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../mobile/finance-phone.js'), 'utf8'), ctx);
  return { api: ctx.window.phoneFinance, store, calls, ctx, listeners };
}

test('pair from the computer’s code, then everything comes from SimpleFIN and Yahoo directly', async () => {
  const { api, store, calls } = load({ scanned: pairPayload(ACCESS, { 'shell oil': 'fixed' }) });
  assert.strictEqual((await api.financeStatus()).setUp, false);
  const r = await api.financePair();
  assert.strictEqual(r.ok, true, r.error);
  const d = await api.financeData();
  assert.strictEqual(d.accounts[0].balance, 12.5);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.kinds)), { 'shell oil': 'fixed' });
  assert.ok(!store.file.includes('Coffee') && !store.file.includes('pass@'), 'saved encrypted');
  const sf = calls.find((c) => c.url.includes('simplefin.org'));
  assert.ok(!sf.url.includes('pass@') && sf.headers.Authorization.startsWith('Basic '), 'credentials in the header');
  const s = await api.financeStocks(true);
  assert.deepStrictEqual([s.total, s.change], [400, 20]);
  assert.ok(calls.filter((c) => c.url.includes('yahoo')).every((c) => !c.url.includes('380') && !c.headers.Authorization), 'only the symbol goes to Yahoo');
});

test('locked when he leaves the app; the fingerprint opens it again; forget removes it from the phone', async () => {
  const { api, store, ctx, listeners } = load({ scanned: pairPayload(ACCESS, {}) });
  await api.financePair();
  ctx.document.hidden = true; listeners.visibilitychange();
  assert.strictEqual((await api.financeData()).locked, false, 'the scanner and fingerprint prompt hide the page for a moment: not a lock');
  await new Promise((r) => setTimeout(r, 1600));
  listeners.visibilitychange();
  assert.strictEqual((await api.financeData()).locked, true);
  ctx.document.hidden = false;
  assert.strictEqual((await api.financeUnlock()).ok, true);
  assert.strictEqual((await api.financeData()).accounts[0].name, 'Checking');
  await api.financeForget();
  assert.strictEqual((await api.financeStatus()).setUp, false);
  assert.strictEqual(store.file, null);
});

test('a code that isn’t the pairing code, no fingerprint, or a cancel: nothing is set up', async () => {
  assert.match((await load({ scanned: 'https://example.com' }).api.financePair()).error, /pairing code/);
  assert.match((await load({ scanned: 'tasks-finance:1:' + Buffer.from(JSON.stringify({ u: 'https://u:p@evil.example/x' })).toString('base64url') }).api.financePair()).error, /pairing code/);
  assert.match((await load({ scanned: pairPayload(ACCESS, {}), biometrics: false }).api.financePair()).error, /fingerprint/);
  const c = load({ scanned: pairPayload(ACCESS, {}), cancel: true });
  await c.api.financePair(); await c.api.financeLock();
  assert.strictEqual((await c.api.financeUnlock()).cancelled, true);
});

test('asked while the app is in the background: no error to show, just not unlocked', async () => {
  const c = load({ scanned: pairPayload(ACCESS, {}), away: true });
  await c.api.financePair(); await c.api.financeLock();
  const r = await c.api.financeUnlock();
  assert.deepStrictEqual([r.ok, r.notVisible, r.error], [false, true, undefined]);
});

test('the phone keeps Finance out of screenshots and screen-reading assistants while it shows', async () => {
  const { api, ctx } = load({ scanned: pairPayload(ACCESS, {}) });
  const seen = [];
  const before = ctx.window.Capacitor.nativePromise;
  ctx.window.Capacitor.nativePromise = async (p, m, o) => { if (m === 'secure') { seen.push(o.on); return {}; } return before(p, m, o); };
  await api.financeScreen(true); await api.financeScreen(false);
  assert.deepStrictEqual(seen, [true, false]);
});
