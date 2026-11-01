const test = require('node:test');
const assert = require('node:assert');
const worker = require('../agent/worker');

const a = { url: 'https://w.supabase.co', key: 'k', syncKey: 'tk_agent_abc123def456ghi' };

test('isWorker reads localModel.worker', () => {
  assert.strictEqual(worker.isWorker({}), false);
  assert.strictEqual(worker.isWorker({ localModel: { url: 'x' } }), false);
  assert.strictEqual(worker.isWorker({ localModel: { worker: true } }), true);
});

test('a heartbeat counts while it is fresh, and not once three are missed', () => {
  const now = 1_000_000_000;
  const doc = worker.heartbeat({ name: 'Lupa', model: 'holo4', busy: true }, now - 60 * 1000);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['at', 'busy', 'host', 'model', 'name', 'v']);
  const w = worker.freshWorker(doc, now);
  assert.strictEqual(w.name, 'Lupa'); assert.strictEqual(w.model, 'holo4'); assert.strictEqual(w.busy, true);
  assert.strictEqual(worker.freshWorker(doc, now - 60 * 1000 + worker.FRESH_MS + 1), null);
  assert.ok(worker.freshWorker(Object.assign({}, doc, { at: now + 30 * 1000 }), now), 'a clock slightly ahead is fine');
  assert.strictEqual(worker.freshWorker(Object.assign({}, doc, { at: now + 10 * 60 * 1000 }), now), null);
  assert.strictEqual(worker.freshWorker(null, now), null);
  assert.strictEqual(worker.freshWorker({ v: 1 }, now), null);
});

test('share: the worker takes all but money questions, which it answers after a wait', () => {
  const now = 10_000_000;
  const plain = { id: 'p', updatedAt: now }, money = { id: 'm', updatedAt: now, money: true }, oldMoney = { id: 'o', updatedAt: now - worker.MONEY_WAIT_MS - 1, money: true };
  const isMoney = (t) => !!t.money, ids = (l) => l.map((t) => t.id);
  const tasks = [plain, money, oldMoney];
  assert.deepStrictEqual(ids(worker.share(tasks, { worker: true, isMoney, now })), ['p', 'o']);
  assert.deepStrictEqual(ids(worker.share(tasks, { worker: false, workerUp: true, isMoney, now })), ['m', 'o'], 'another computer keeps only money questions');
  assert.deepStrictEqual(ids(worker.share(tasks, { worker: false, workerUp: false, isMoney, now })), ['p', 'm', 'o'], 'no worker: as before');
});

test('beat writes the :worker row compare-and-swap; present reads it back once a minute', async (t) => {
  const real = global.fetch; t.after(() => { global.fetch = real; worker.forget(); });
  let stored = null, calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push([url.split('/rpc/')[1], body.p_sync_key]);
    if (url.endsWith('/sync_get')) return { ok: true, status: 200, json: async () => (stored ? [{ doc: stored.doc, updated_at: stored.at }] : []) };
    if (url.endsWith('/sync_put')) { if ((stored ? stored.at : null) !== body.p_prev) return { ok: true, status: 200, json: async () => false }; stored = { doc: body.p_doc, at: 't' + calls.length }; return { ok: true, status: 200, json: async () => true }; }
    throw new Error('unexpected ' + url);
  };
  assert.strictEqual(await worker.beat(a, { name: 'Lupa', model: 'holo4' }), true);
  assert.deepStrictEqual(calls.map((c) => c[1]), [a.syncKey + ':worker', a.syncKey + ':worker']);
  assert.strictEqual(stored.doc.name, 'Lupa');
  assert.strictEqual(await worker.beat(a, { name: 'Lupa', model: 'holo4', busy: true }), true, 'the second beat updates over the first');
  assert.strictEqual(stored.doc.busy, true);
  worker.forget();
  const w = await worker.present(a);
  assert.strictEqual(w.name, 'Lupa');
  const n = calls.length;
  assert.ok(await worker.present(a)); assert.strictEqual(calls.length, n, 'cached for a minute');
  assert.ok(worker.lastSeen());
  // the server can't be reached: the last heartbeat still counts until it goes stale
  global.fetch = async () => { throw new Error('fetch failed'); };
  assert.ok(await worker.present(a, { now: Date.now() + 61 * 1000 }));
  assert.strictEqual(await worker.present(a, { now: Date.now() + worker.FRESH_MS + 62 * 1000 }), null);
});

test('no sync set up: nothing to beat or read', async () => {
  assert.strictEqual(await worker.beat(null, {}), false);
  assert.strictEqual(await worker.present(null), null);
});
