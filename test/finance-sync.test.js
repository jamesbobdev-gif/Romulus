const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Y = require('../renderer/js/finance-sync');
const finance = require('../main/finance');

const NOW = Date.UTC(2026, 10, 28);
const sec = (daysAgo) => Math.floor(NOW / 1000) - daysAgo * 86400;
const tx = (id, daysAgo, more) => Object.assign({ id, posted: sec(daysAgo), amount: -1, description: id, pending: false }, more);
const acct = (id, balance, txs) => ({ id, name: id, org: 'Bank', currency: 'USD', balance, transactions: txs, holdings: [] });
const state = (o) => Object.assign({ v: 1, fetchedAt: 0, accounts: [], errors: [], kinds: {}, kindsAt: {}, ebt: {}, ebtAt: 0, receipts: [] }, o);
const ids = (s, i) => s.accounts[i || 0].transactions.map((t) => t.id);

test('the later download decides balances; the other copy adds the history it alone has', () => {
  const old = state({ fetchedAt: 1000, accounts: [acct('a', 10, [tx('t3', 5), tx('t1', 200), tx('p1', 0, { pending: true, posted: 0 })]), acct('gone', 1, [tx('g', 3)])] });
  const fresh = state({ fetchedAt: 2000, accounts: [acct('a', 25, [tx('t4', 1), tx('t3', 5)])] });
  const m = Y.merge(old, fresh, NOW);
  assert.strictEqual(m.fetchedAt, 2000);
  assert.strictEqual(m.accounts.length, 1, 'an account the later download no longer has is dropped, as a refresh does');
  assert.strictEqual(m.accounts[0].balance, 25);
  assert.deepStrictEqual(ids(m), ['t4', 't3', 't1'], 'history kept, newest first, the old pending one gone');
  assert.strictEqual(Y.canon(Y.merge(fresh, old, NOW)), Y.canon(m), 'the same whichever device merges');
  assert.strictEqual(Y.canon(Y.merge(m, old, NOW)), Y.canon(m), 'and merging again changes nothing');
});

test('history older than 400 days is let go, and a download with no accounts never empties the rest', () => {
  const a = state({ fetchedAt: 1000, accounts: [acct('a', 10, [tx('t1', 30), tx('ancient', 500)])] });
  const b = state({ fetchedAt: 2000, accounts: [acct('a', 11, [tx('t2', 1)])] });
  assert.deepStrictEqual(ids(Y.merge(a, b, NOW)), ['t2', 't1']);
  const empty = state({ fetchedAt: 3000, accounts: [] });
  const m = Y.merge(a, empty, NOW);
  assert.strictEqual(m.accounts.length, 1);
  assert.strictEqual(m.fetchedAt, 3000);
});

test('marks: the later change wins payee by payee, taking one off included; untimed ones add up', () => {
  const a = state({ kinds: { rent: 'fixed', gym: 'fixed', old: 'skip' }, kindsAt: { rent: 100, gym: 300 } });
  const b = state({ kinds: { rent: 'variable', other: 'income' }, kindsAt: { rent: 200, gym: 400 } }); // gym taken off at 400
  const m = Y.merge(a, b, NOW);
  assert.deepStrictEqual(m.kinds, { rent: 'variable', old: 'skip', other: 'income' });
  assert.deepStrictEqual(m.kindsAt, { rent: 200, gym: 400 });
  assert.strictEqual(Y.canon(Y.merge(b, a, NOW)), Y.canon(m));
});

test('EBT settings: the later save wins; purchases from email are added together', () => {
  const a = state({ ebt: { balance: 50, at: 5, day: 3 }, ebtAt: 10, receipts: [{ id: 'r1', at: NOW - 1000 }, { id: 'stale', at: NOW - 500 * 86400000 }] });
  const b = state({ ebt: { balance: 20, at: 9 }, ebtAt: 20, receipts: [{ id: 'r2', at: NOW - 10 }] });
  const m = Y.merge(a, b, NOW);
  assert.deepStrictEqual(m.ebt, { balance: 20, at: 9 });
  assert.deepStrictEqual(m.receipts.map((r) => r.id), ['r2', 'r1']);
  const untimed = Y.merge(state({ ebt: { balance: 1, at: 5 } }), state({ ebt: { balance: 2, at: 7 } }), NOW);
  assert.strictEqual(untimed.ebt.balance, 2, 'from before saves were timed: the later balance');
});

test('sealed: only the key opens it, and nothing readable is in it', async () => {
  const key = crypto.randomBytes(32);
  const s = state({ fetchedAt: 5, accounts: [acct('a', 12.5, [tx('Coffee shop', 1)])], kinds: { 'shell oil': 'fixed' } });
  const box = await Y.seal(key, s);
  assert.ok(!JSON.stringify(box).includes('Coffee') && !JSON.stringify(box).includes('shell'));
  assert.strictEqual(Y.canon(await Y.read(key, box)), Y.canon(s));
  assert.strictEqual(await Y.read(crypto.randomBytes(32), box), null, 'another key');
  assert.strictEqual(await Y.read(key, Object.assign({}, box, { data: box.data.slice(0, -8) + 'AAAAAAA=' })), null, 'tampered with');
  assert.strictEqual(await Y.read(key, { v: 1, iv: 'x', data: 'A'.repeat(7 * 1024 * 1024) }), null, 'too big to be one');
});

test('a round: nothing to do when both match, a push when the row is behind', () => {
  const vault = { accessUrl: 'x', cache: { fetchedAt: 9, accounts: [acct('a', 1, [tx('t1', 1)])], errors: [] }, kinds: { rent: 'fixed' } };
  const first = Y.step(vault, null, NOW);
  assert.deepStrictEqual([first.changed, first.push], [false, true], 'an empty row gets this device’s copy');
  const again = Y.step(vault, JSON.parse(JSON.stringify(first.state)), NOW);
  assert.deepStrictEqual([again.changed, again.push], [false, false]);
  const theirs = Y.merge(first.state, state({ fetchedAt: 3, accounts: [acct('a', 0, [tx('old', 120)])], kinds: { gym: 'fixed' } }), NOW);
  const took = Y.step(vault, theirs, NOW);
  assert.deepStrictEqual([took.changed, took.push], [true, false]);
  assert.deepStrictEqual(vault.cache.accounts[0].transactions.map((t) => t.id), ['t1', 'old']);
  assert.deepStrictEqual(vault.kinds, { rent: 'fixed', gym: 'fixed' });
  assert.strictEqual(vault.accessUrl, 'x', 'the link is never part of it');
});

/* two computers (two data folders, one at a time) and the row between them */
const ACCESS = 'https://user:pass@beta-bridge.simplefin.org/simplefin';
const token = Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/abc123').toString('base64');
const h = finance.handlers;
function computer(txs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-finsync-'));
  return () => finance.init({ userData: () => dir, agentLog: () => {}, sendToRenderer: () => {},
    fetch: async (url, opts) => (opts.method === 'POST' ? { ok: true, status: 200, text: async () => ACCESS }
      : { ok: true, status: 200, json: async () => ({ accounts: [{ id: 'a1', name: 'Checking', balance: '12.50', transactions: txs }] }) }) });
}
const nowSec = () => Math.floor(Date.now() / 1000);

test('two computers under one passphrase end up with the same history, marks and EBT balance', async () => {
  const useA = computer([{ id: 'old', posted: nowSec() - 80 * 86400, amount: '-9', description: 'Hardware store' }]);
  const useB = computer([{ id: 'new', posted: nowSec() - 60, amount: '-3', description: 'Coffee' }]);
  useA();
  assert.strictEqual((await h['finance:setup'](null, token, 'correct horse battery')).ok, true);
  await h['finance:setKind'](null, 'hardware store', 'fixed');
  await h['finance:setEbt'](null, { balance: 40, at: Date.now(), day: 5 });
  assert.strictEqual((await h['finance:sync'](null, { v: 1 }, null)).needKey, true, 'no box in the row yet');
  const box = (await h['finance:shareBox']()).box;
  const up = await h['finance:sync'](null, box, null);
  assert.deepStrictEqual([up.ok, up.changed, !!up.box], [true, false, true]);
  assert.ok(!JSON.stringify(up.box).includes('Hardware'), 'sealed before it leaves');
  h['finance:lock']();
  assert.strictEqual((await h['finance:sync'](null, box, up.box)).error, 'locked');

  useB();
  assert.strictEqual((await h['finance:setupShared'](null, box, 'correct horse battery')).ok, true);
  const took = await h['finance:sync'](null, box, up.box);
  assert.deepStrictEqual([took.ok, took.changed, !!took.box], [true, true, true], 'B takes A’s history and has a newer download to give back');
  const d = h['finance:data']();
  assert.deepStrictEqual(d.accounts[0].transactions.map((t) => t.id), ['new', 'old']);
  assert.deepStrictEqual(d.kinds, { 'hardware store': 'fixed' });
  assert.strictEqual(d.ebt.balance, 40);
  const settled = await h['finance:sync'](null, box, took.box);
  assert.deepStrictEqual([settled.changed, settled.box], [false, null], 'nothing more to say');
  h['finance:lock']();

  useA();
  await h['finance:unlock'](null, 'correct horse battery');
  const back = await h['finance:sync'](null, box, took.box);
  assert.deepStrictEqual([back.changed, back.box], [true, null]);
  assert.deepStrictEqual(h['finance:data']().accounts[0].transactions.map((t) => t.id), ['new', 'old']);
  await h['finance:forget']();
});

test('a computer under its own passphrase asks for the row’s once, then keeps in step', async () => {
  const useA = computer([{ id: 'old', posted: nowSec() - 80 * 86400, amount: '-9', description: 'Hardware store' }]);
  const useC = computer([{ id: 'new', posted: nowSec() - 60, amount: '-3', description: 'Coffee' }]);
  useA();
  await h['finance:setup'](null, token, 'correct horse battery');
  const box = (await h['finance:shareBox']()).box;
  const up = await h['finance:sync'](null, box, null);
  h['finance:lock']();

  useC();
  await h['finance:setup'](null, token, 'a different passphrase');
  const mine = (await h['finance:shareBox']()).box;
  assert.notDeepStrictEqual(mine, box);
  assert.strictEqual((await h['finance:sync'](null, box, up.box)).needKey, true);
  assert.strictEqual((await h['finance:adoptShare'](null, box, 'not the passphrase')).ok, false);
  assert.strictEqual((await h['finance:adoptShare'](null, box, 'correct horse battery')).ok, true);
  assert.deepStrictEqual((await h['finance:shareBox']()).box, box, 'it shares under the row’s box from now on');
  const took = await h['finance:sync'](null, box, up.box);
  assert.strictEqual(took.changed, true);
  h['finance:lock']();
  await h['finance:unlock'](null, 'a different passphrase'); // its own passphrase still opens it, and the key was kept
  assert.strictEqual((await h['finance:sync'](null, box, took.box)).ok, true);
  assert.deepStrictEqual(h['finance:data']().accounts[0].transactions.map((t) => t.id), ['new', 'old']);
  await h['finance:forget']();
});
