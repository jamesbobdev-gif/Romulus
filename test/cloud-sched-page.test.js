const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const c = require('../renderer/js/cloud-agent.js');

/* The page side of scheduled runs (renderer/js/cloud-agent.js cloudSchedTick) against a stand-in for the
   cloud-agent function: the page globals it uses are stubbed here, the sealing is the real thing. */
async function load(tasks) {
  const server = await c.cloudAgKeyPair(false);
  const srv = { rows: {}, results: [], calls: [], refuse: null };
  const timers = [];
  const fetchFake = async (url, init) => {
    const b = JSON.parse(init.body); srv.calls.push(b.action);
    let out = {};
    if (b.action === 'status') out = { enabled: true, schedPub: server.pub };
    else if (b.action === 'schedule') { if (srv.refuse) out = { ok: false, why: srv.refuse }; else { srv.rows[b.task] = b; out = { ok: true, next: new Date(b.next).toISOString() }; } }
    else if (b.action === 'unschedule') { delete srv.rows[b.task]; out = { dropped: 1 }; }
    else if (b.action === 'results') { out = { results: srv.results.splice(0), kept: Object.keys(srv.rows).map((task) => ({ task, next: srv.rows[task].next, paused: false })) }; }
    return { ok: true, json: async () => out };
  };
  const ctx = {
    console, TextEncoder, TextDecoder, Intl, Date, JSON, Math, Object, Array, String, Number, Promise, Uint8Array, Buffer, require,
    crypto: require('crypto').webcrypto, fetch: fetchFake,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {}, setInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { hidden: false, readyState: 'complete', addEventListener() {}, querySelector: () => null },
    state: { tasks, activeTab: 'agent' }, taskWs: (t) => t.ws,
    syncState: { cfg: { agent: { url: 'https://romulus.test', key: 'k', syncKey: 'tk_abcdefghijklmnopqrstuvwxyz' } } },
    validProfile: (p) => !!(p && p.url && p.key && p.syncKey), hostedIs: () => true,
    syncRowKey: async (p) => p.syncKey, syncHeaders: () => ({ 'Content-Type': 'application/json' }), syncPullRow: async () => null,
    agentSay(t, who, text, extra) { t.history = t.history || []; t.history.push(Object.assign({ who, text, at: Date.now() }, extra || {})); },
    repeatText: () => 'Every day at 8:00am', nextRepeatAt: () => Date.now() + 86400000,
    liveText: {}, livePlan: {}, liveHeard: {}, fillPlan() {}, keepLastOrder() {}, appendPrefs() {},
    touched: 0, touch() { ctx.touched++; }, render() {}, voiceToast() {}, $: () => null,
  };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of ['cart-keep.js', 'agent-results.js', 'cloud-agent.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js', f), 'utf8'), ctx);
  const tick = timers.filter((t) => t.ms === 8000)[0].f; // cloudSchedTick, as the page starts it
  return { ctx, srv, server, tick };
}
const repeating = (o) => Object.assign({ id: 'r1', ws: 'agent', title: 'Find three new internships to apply to', status: 'done', done: true,
  repeat: { every: 'day', at: '08:00', day: null }, nextRun: Date.now() + 3600000, history: [] }, o);

test('nothing is switched on: the server is never asked', async () => {
  const { srv, tick } = await load([repeating()]);
  await tick();
  assert.deepStrictEqual(srv.calls, []);
});

test('the switch sends a sealed copy once; a round the server ran lands on the task; switching off takes it back', async () => {
  const t = repeating({ cloudRun: { on: true } });
  const { ctx, srv, server, tick } = await load([t]);
  await tick();
  const id = await c.cloudSchedId('r1');
  assert.ok(srv.rows[id], 'the copy is on the server');
  assert.ok(!JSON.stringify(srv.rows[id]).includes('internships'), 'and nothing in it can be read');
  assert.strictEqual((await c.cloudAgOpen(server.priv, srv.rows[id].sealed)).task.title, t.title); // except by the function's key
  assert.ok(t.cloudRun.sent && t.cloudRun.priv && !srv.rows[id].pub.d);
  const sends = () => srv.calls.filter((a) => a === 'schedule').length;
  await tick();
  assert.strictEqual(sends(), 1, 'unchanged: not sent again');

  // the server ran the round while every device was off
  const ran = Date.now() - 3600000, next = Date.now() + 86400000;
  srv.results.push({ task: id, sealed: await c.cloudAgSeal(srv.rows[id].pub, { status: 'done', note: 'Three internships, with links.', options: [] }), why: null, next, ran });
  await tick();
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.done, false); // back on the list for him to read
  assert.strictEqual(t.note, 'Three internships, with links.');
  assert.strictEqual(t.nextRun, next);
  assert.ok(t.history.some((h) => h.who === 'sys' && /on Romulus cloud/.test(h.text)));
  assert.ok(t.history.some((h) => h.who === 'claude' && h.text === 'Three internships, with links.'));
  assert.strictEqual(sends(), 2, 'the copy is refreshed with the new conversation and time');

  // a round it couldn't run says why, without touching the answer
  srv.results.push({ task: id, sealed: null, why: 'limit', next, ran });
  await tick();
  assert.match(t.history[t.history.length - 1].text, /allowance is used up/);
  assert.strictEqual(t.note, 'Three internships, with links.');

  t.cloudRun.on = false;
  await tick();
  assert.strictEqual(srv.rows[id], undefined);
  assert.strictEqual(t.cloudRun, undefined);
  assert.ok(ctx.touched > 0);
});

test('a plan that doesn\'t include it: the switch goes back off and the task says why', async () => {
  const t = repeating({ cloudRun: { on: true } });
  const { srv, tick } = await load([t]);
  srv.refuse = 'plan';
  await tick();
  assert.strictEqual(t.cloudRun.on, false);
  assert.match(t.history[t.history.length - 1].text, /paid plan/);
  await tick(); // and it is not tried again by itself
  assert.strictEqual(srv.calls.filter((a) => a === 'schedule').length, 1);
});

test('a round already going on a device: the server\'s answer joins the conversation without taking the task over', async () => {
  const t = repeating({ cloudRun: { on: true }, status: 'working', done: false });
  const { srv, tick } = await load([t]);
  await tick();
  const id = await c.cloudSchedId('r1');
  srv.results.push({ task: id, sealed: await c.cloudAgSeal(srv.rows[id].pub, { status: 'done', note: 'From the server.', options: [] }), why: null, next: Date.now() + 86400000, ran: Date.now() });
  await tick();
  assert.strictEqual(t.status, 'working');
  assert.ok(t.history.some((h) => h.who === 'claude' && h.text === 'From the server.'));
});

test('a copy left on the server for a task that is gone here is taken back', async () => {
  const t = repeating({ cloudRun: { on: true, sent: 'x', at: Date.now() } });
  const { srv, tick } = await load([t]);
  srv.rows['f'.repeat(40)] = { next: 1 };
  await tick();
  assert.strictEqual(srv.rows['f'.repeat(40)], undefined);
});

test('a collected answer is saved even when the next call in the same check fails', async () => {
  const t = repeating({ cloudRun: { on: true } });
  const { ctx, srv, tick } = await load([t]);
  await tick();
  const id = await c.cloudSchedId('r1');
  srv.results.push({ task: id, sealed: await c.cloudAgSeal(srv.rows[id].pub, { status: 'done', note: 'Three internships, with links.', options: [] }), why: null, next: Date.now() + 86400000, ran: Date.now() - 3600000 });
  const real = ctx.fetch, before = ctx.touched;
  ctx.fetch = async (url, init) => { if (JSON.parse(init.body).action === 'schedule') throw new Error('offline'); return real(url, init); };
  await tick();
  assert.strictEqual(t.note, 'Three internships, with links.');
  assert.ok(ctx.touched > before, 'the answer is saved');
});
