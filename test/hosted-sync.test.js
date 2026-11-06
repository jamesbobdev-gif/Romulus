const test = require('node:test');
const assert = require('node:assert');
// sync.js's rule for the keys made from the personal one (deriveSyncKey), which hosted-sync.js uses as a page global
global.deriveSyncKey = (k, list) => { const id = String(k || '').replace(/^tk_/, ''); return id ? 'tk_' + list + '_' + id : ''; };
const h = require('../renderer/js/hosted-sync');

test('every plain key a list or its side rows could be looked for under gets the encrypted-list marker', () => {
  const keys = h.hostedMarkerKeys('tk_abc');
  assert.deepStrictEqual(keys, [
    'tk_abc', 'tk_abc:ideas', 'tk_abc:hours', 'tk_abc:devices',
    'tk_work_abc',
    'tk_agent_abc', 'tk_agent_abc:prefs', 'tk_agent_abc:locked', 'tk_agent_abc:routing', 'tk_agent_abc:standing',
    'tk_school_abc',
  ]);
  // each one is a key the database's sync_set takes (supabase/setup.sql)
  const shape = /^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$/;
  for (const k of h.hostedMarkerKeys('tk_26dbc739-a57d-4d40-900d-984640e0415d')) assert.ok(shape.test(k), k);
});

test('the space line, and the choice once the free space is nearly used', () => {
  const MB = 1024 * 1024;
  const quiet = h.hostedPlanText({ used_bytes: 900 * 1024, quota_bytes: 5 * MB, paid_quota_bytes: 600 * MB }, true);
  assert.strictEqual(quiet.full, false);
  assert.match(quiet.line, /^Using 900 KB of 5 MB free\.$/);
  const near = h.hostedPlanText({ used_bytes: 4.6 * MB, quota_bytes: 5 * MB, paid_quota_bytes: 600 * MB }, true);
  assert.strictEqual(near.full, true);
  assert.match(near.line, /\$5 a month \(600 MB\)/);
  assert.match(near.line, /Pro at \$25 a month/);
  const refused = h.hostedPlanText({ used_bytes: 1, quota_bytes: 5 * MB, refused: 'full', paid_quota_bytes: 600 * MB }, false);
  assert.strictEqual(refused.full, true);
  assert.doesNotMatch(refused.line, /\$5/); // no payment link in this build: only the move is offered
  const paid = h.hostedPlanText({ used_bytes: 400 * MB, quota_bytes: 600 * MB, paid_until: '2026-12-09T00:00:00Z', paid_quota_bytes: 600 * MB }, true);
  assert.strictEqual(paid.full, false); // paid: no nagging
  assert.match(paid.line, /paid until/);
});

test('the Romulus server is recognised whatever the trailing slash', () => {
  global.window = { ROMULUS_PAIR: { url: 'https://x.supabase.co', key: 'sb_publishable_x' } };
  assert.ok(h.hostedIs('https://x.supabase.co/'));
  assert.ok(!h.hostedIs('https://y.supabase.co'));
  global.window = { ROMULUS_PAIR: null };
  assert.ok(!h.hostedIs('https://x.supabase.co'));
  delete global.window;
});

test('store builds never offer the $5 plan; the releases builds and computers do', () => {
  const saved = global.window;
  try {
    const h2 = { url: 'https://x.supabase.co', key: 'k', pay: 'https://buy.stripe.com/abc' };
    global.window = {};
    assert.strictEqual(h.hostedCanPay(h2), true);
    global.window = { ROMULUS_STORE: 'github' };
    assert.strictEqual(h.hostedCanPay(h2), true);
    global.window = { ROMULUS_STORE: 'play' };
    assert.strictEqual(h.hostedInStore(), true);
    assert.strictEqual(h.hostedCanPay(h2), false);
    global.window = {};
    assert.strictEqual(h.hostedCanPay({ url: 'u', key: 'k' }), false); // no Stripe link in this build
  } finally { global.window = saved; }
});

test('delete sends every key the Romulus server holds these lists under, and the agent key for its files', async () => {
  const saved = global.window;
  try {
    global.window = { ROMULUS_PAIR: { url: 'https://romulus.supabase.co/', key: 'pk' } };
    const cfg = {
      personal: { url: 'https://romulus.supabase.co', key: 'pk', syncKey: 'tk_abc', v2: true },
      work: { url: 'https://romulus.supabase.co', key: 'pk', syncKey: 'tk_work_abc', derived: true, v2: true },
      agent: { url: 'https://romulus.supabase.co', key: 'pk', syncKey: 'tk_agent_abc', derived: true, v2: true },
      school: { url: 'https://own.supabase.co', key: 'o', syncKey: 'tk_school_zzz' }, // his own project: not touched
    };
    const rowKeyOf = async (p) => p.syncKey.replace(/abc$/, 'LOOKUP') + ':prefs'; // side-row suffixes are dropped
    const body = await h.hostedDeleteBody(cfg, rowKeyOf);
    assert.deepStrictEqual(body.keys, ['tk_abc', 'tk_LOOKUP', 'tk_work_abc', 'tk_work_LOOKUP', 'tk_agent_abc', 'tk_agent_LOOKUP']);
    assert.deepStrictEqual(body.agentKeys, ['tk_agent_abc']);
  } finally { global.window = saved; }
});

test('restoring a day brings its tasks back everywhere and removes what came after, in that list only', () => {
  const now = 2000;
  const tasks = [
    { id: 'a', ws: 'personal', text: 'kept, edited since', updatedAt: 1500 },
    { id: 'b', ws: 'personal', text: 'added since', updatedAt: 1600 },
    { id: 'w', ws: 'work', text: 'another list', updatedAt: 1700 },
    { id: 'm', ws: 'work', text: 'moved to work since', updatedAt: 1800 },
  ];
  const tombs = [{ id: 'c', deletedAt: 1400 }, { id: 'old', deletedAt: 900 }];
  const snap = [
    { id: 'a', text: 'kept', updatedAt: 1000 },
    { id: 'c', text: 'deleted since' },
    { id: 'm', text: 'was personal', updatedAt: 1000 },
  ];
  const r = h.hostedRestorePlan(tasks, tombs, 'personal', snap, now);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['a', 'c', 'm', 'w']);
  assert.strictEqual(byId.a.text, 'kept');
  assert.strictEqual(byId.a.updatedAt, now); // newer than any copy on another device, so it wins there too
  assert.strictEqual(byId.m.ws, 'personal');
  assert.strictEqual(byId.w.text, 'another list'); // other lists aren't touched
  assert.deepStrictEqual(byId.c.subs, []);
  assert.ok(r.tombstones.some((x) => x.id === 'b' && x.deletedAt === now)); // added since: gone on every device
  assert.ok(!r.tombstones.some((x) => x.id === 'c')); // back again: its tombstone goes
  assert.ok(r.tombstones.some((x) => x.id === 'old'));
});

test('a paid plan says how much its history uses', () => {
  const MB = 1024 * 1024;
  const t = h.hostedPlanText({ used_bytes: 2 * MB, quota_bytes: 600 * MB, paid_until: '2026-12-09T00:00:00Z', paid_quota_bytes: 600 * MB, history_bytes: 9 * MB }, true);
  assert.match(t.line, /History uses 9 MB more\./);
  assert.doesNotMatch(h.hostedPlanText({ used_bytes: 1, quota_bytes: 5 * MB, history_bytes: 9 * MB }, true).line, /History/);
});
