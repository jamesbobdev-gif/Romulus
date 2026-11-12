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

test('he hears once when the worker goes quiet and once when it comes back; nothing before it ever ran', () => {
  const now = Date.now(), doc = (ago) => ({ v: 1, at: now - ago, name: 'Lupa Au Palatine', host: 'lupa' });
  assert.strictEqual(worker.stateNotice(null, null, now).is, 'none');
  assert.strictEqual(worker.stateNotice('none', null, now).title, null); // no worker set up: never a warning
  assert.strictEqual(worker.stateNotice('up', doc(60 * 1000), now).title, null); // still fresh
  const quiet = worker.stateNotice('up', doc(worker.FRESH_MS + 60 * 1000), now);
  assert.strictEqual(quiet.is, 'quiet');
  assert.strictEqual(quiet.title, 'Lupa Au Palatine stopped answering');
  assert.match(quiet.body, /Last heard 7 min ago/);
  assert.strictEqual(worker.stateNotice('quiet', doc(worker.FRESH_MS + 5 * 60 * 1000), now).title, null); // said once
  assert.strictEqual(worker.stateNotice('quiet', doc(30 * 1000), now).title, 'Lupa Au Palatine is back');
  assert.strictEqual(worker.stateNotice('none', doc(30 * 1000), now).title, null); // first heartbeat ever: no fanfare
});

test('the heartbeat carries the worker browser actions, trimmed, and other computers merge them in', () => {
  const lines = [
    { at: 300, task: 'Order paper towels', what: 'clicked', label: 'Place order', url: 'https://www.walmart.com/checkout/' + 'x'.repeat(400) },
    { at: 200, task: 'Apply', what: 'uploaded', files: ['resume.pdf'], url: 'https://jobs.example.com/apply' },
    { at: 0, what: 'broken' }, null];
  const doc = worker.heartbeat({ name: 'Lupa', actions: lines }, 1000);
  assert.strictEqual(doc.actions.length, 2);
  assert.ok(doc.actions[0].url.length <= 160);
  assert.deepStrictEqual(doc.actions[1].files, ['resume.pdf']);
  assert.strictEqual(worker.heartbeat({ name: 'Lupa', actions: [] }, 1000).actions, undefined);
  assert.strictEqual(worker.actionsForBeat(Array.from({ length: 50 }, (_, i) => ({ at: i + 1, what: 'clicked' }))).length, worker.ACTIONS_MAX);

  const own = [{ at: 250, what: 'opened mail', url: 'https://mail.google.com/' }];
  const merged = worker.mergeActions(own, doc);
  assert.deepStrictEqual(merged.map((l) => l.at), [300, 250, 200]);
  assert.strictEqual(merged[0].where, 'Lupa');
  assert.strictEqual(merged[1].where, undefined, 'its own lines are not marked');
  assert.strictEqual(worker.mergeActions(merged.slice(0, 1).map((l) => Object.assign({}, l, { where: undefined })), doc).length, 2, 'a line it already has is not added twice');
  assert.deepStrictEqual(worker.mergeActions(own, null), own);
});

test('a heartbeat that did not go out is tried again in seconds, and says why', async (t) => {
  assert.strictEqual(worker.nextBeatIn(true, 0), worker.BEAT_MS);
  assert.strictEqual(worker.nextBeatIn(false, 1), 15 * 1000);
  assert.strictEqual(worker.nextBeatIn(false, 2), 30 * 1000);
  assert.strictEqual(worker.nextBeatIn(false, 3), 60 * 1000);
  assert.strictEqual(worker.nextBeatIn(false, 9), worker.BEAT_MS, 'never slower than the usual pace');
  // three tries fit well inside the time his other computers wait before calling it quiet
  assert.ok(worker.nextBeatIn(false, 1) + worker.nextBeatIn(false, 2) + worker.nextBeatIn(false, 3) < worker.FRESH_MS - worker.BEAT_MS);
  const real = global.fetch; t.after(() => { global.fetch = real; worker.forget(); });
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) });
  assert.strictEqual(await worker.beat(a, { name: 'Lupa' }), false);
  assert.match(worker.lastBeatError(), /HTTP 401.*refused this computer/);
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('/sync_get') ? [] : true) });
  assert.strictEqual(await worker.beat(a, { name: 'Lupa' }), true);
  assert.strictEqual(worker.lastBeatError(), '');
});

test('lookAgain reads the row afresh but keeps what was last heard', async (t) => {
  const real = global.fetch; t.after(() => { global.fetch = real; worker.forget(); });
  const b = Object.assign({}, a, { syncKey: 'tk_agent_lookagain123456' });
  let reads = 0;
  const doc = worker.heartbeat({ name: 'Lupa' });
  global.fetch = async () => { reads++; return { ok: true, status: 200, json: async () => [{ doc, updated_at: 't1' }] }; };
  worker.forget();
  assert.ok(await worker.present(b)); assert.ok(await worker.present(b));
  assert.strictEqual(reads, 1);
  worker.lookAgain();
  assert.ok(worker.lastSeen(), 'still known meanwhile');
  global.fetch = async () => { reads++; throw new Error('fetch failed'); }; // just woke: the network isn't back yet
  assert.ok(await worker.present(b), 'a failed read keeps the last heartbeat');
  assert.strictEqual(reads, 2);
});
