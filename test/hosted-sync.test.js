const test = require('node:test');
const assert = require('node:assert');
// sync.js's rule for the keys made from the personal one (deriveSyncKey), which hosted-sync.js uses as a page global
global.deriveSyncKey = (k, list) => { const id = String(k || '').replace(/^tk_/, ''); return id ? 'tk_' + list + '_' + id : ''; };
const h = require('../renderer/js/hosted-sync');

test('every plain key a list or its side rows could be looked for under gets the encrypted-list marker', () => {
  const keys = h.hostedMarkerKeys('tk_abc');
  assert.deepStrictEqual(keys, [
    'tk_abc', 'tk_abc:ideas', 'tk_abc:hours', 'tk_abc:kitchen', 'tk_abc:devices',
    'tk_work_abc',
    'tk_agent_abc', 'tk_agent_abc:prefs', 'tk_agent_abc:locked', 'tk_agent_abc:routing', 'tk_agent_abc:standing',
    'tk_school_abc',
  ]);
  // each one is a key the database's sync_set takes (supabase/setup.sql)
  const shape = /^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices|kitchen))?$/;
  for (const k of h.hostedMarkerKeys('tk_26dbc739-a57d-4d40-900d-984640e0415d')) assert.ok(shape.test(k), k);
});

test('the space line, and the choice once the free space is nearly used', () => {
  const MB = 1024 * 1024;
  const quiet = h.hostedPlanText({ used_bytes: 900 * 1024, quota_bytes: 5 * MB, paid_quota_bytes: 600 * MB }, true);
  assert.strictEqual(quiet.full, false);
  assert.match(quiet.line, /^Using 900 KB of 5 MB free\.$/);
  const near = h.hostedPlanText({ used_bytes: 4.6 * MB, quota_bytes: 5 * MB, paid_quota_bytes: 600 * MB }, true);
  assert.strictEqual(near.full, true);
  assert.match(near.line, /with a plan \(600 MB\)/);
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
    // plain lists: the sealed health row sits under the personal lookup id, so that goes too
    const plain = { personal: { url: 'https://romulus.supabase.co', key: 'pk', syncKey: 'tk_abc' } };
    const b2 = await h.hostedDeleteBody(plain, async (p) => p.syncKey, async (k) => k.replace(/abc$/, 'LOOKUP'));
    assert.deepStrictEqual(b2.keys, ['tk_abc', 'tk_LOOKUP']);
    assert.deepStrictEqual((await h.hostedDeleteBody(cfg, rowKeyOf, async (k) => k.replace(/abc$/, 'LOOKUP'))).keys, body.keys);
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
  assert.doesNotMatch(t.line, /History/); // kept short: history size isn't shown
  assert.doesNotMatch(h.hostedPlanText({ used_bytes: 1, quota_bytes: 5 * MB, history_bytes: 9 * MB }, true).line, /History/);
});

test('the plan is offered as the Group plan, with a free trial only when the links have one', () => {
  const plain = h.hostedPlanPitch({ pay: 'https://buy.stripe.com/x' });
  assert.strictEqual(plain.button, 'Group plan: $5 a month for up to 5 people');
  assert.match(plain.pitch, /^The Group plan: share lists and send each other to-dos with up to 4 more people/);
  assert.strictEqual(plain.personal, null); // no Personal links: one plan, at what the existing links charge
  assert.ok(plain.pitch.indexOf('30 days of history') < plain.pitch.indexOf('600 MB')); // storage comes last
  assert.doesNotMatch(plain.pitch, /free for|trial/i);
  const trial = h.hostedPlanPitch({ pay: 'https://buy.stripe.com/x', trialDays: 14 });
  assert.strictEqual(trial.button, 'Try the Group plan free for 14 days');
  assert.match(trial.pitch, /Free for 14 days, then \$5 a month\. Cancel before the trial ends and you pay nothing\.$/);
  assert.strictEqual(h.hostedPlanPitch({ trialDays: 'junk' }).button, plain.button);
  assert.strictEqual(h.hostedPlanPitch(null).year, 'Pay yearly: 2 months free');
});

test('with Personal links there are two plans, Group $6 and Personal $4', () => {
  const two = h.hostedPlanPitch({ pay: 'https://buy.stripe.com/g', payPersonal: 'https://buy.stripe.com/p', payPersonalYear: 'https://buy.stripe.com/py' });
  assert.strictEqual(two.button, 'Group plan: $6 a month for up to 5 people');
  assert.strictEqual(two.personal, 'Personal: $4 a month');
  assert.strictEqual(two.personalYear, 'Personal yearly: $40');
  assert.match(two.pitch, /Just you\? The Personal plan is \$4 a month/);
  assert.ok(two.pitch.indexOf('Group plan') < two.pitch.indexOf('Personal plan')); // Group is the one offered first
  assert.strictEqual(h.hostedPlanPitch({ payPersonal: 'x' }).personalYear, null); // no yearly link, no yearly button
  assert.match(h.hostedPlanPitch({ payPersonal: 'x', trialDays: 7 }).pitch, /then \$6 a month/);
});

test('fireworks only when this device saw the free space and now sees the plan', () => {
  assert.equal(h.hostedJustPaid('free', true), true);
  assert.equal(h.hostedJustPaid('paid', true), false); // a restart
  assert.equal(h.hostedJustPaid(null, true), false); // a new device of someone already paying
  assert.equal(h.hostedJustPaid('free', false), false);
});

test('Settings says which plan someone is on', () => {
  const MB = 1024 * 1024;
  assert.equal(h.hostedMyPlanText('payer', { paid_until: '2026-12-01', quota_bytes: 600 * MB, paid_quota_bytes: 600 * MB }).title, 'Group plan');
  assert.match(h.hostedMyPlanText('payer', null).text, /30 days of history, up to 4 more people/);
  assert.match(h.hostedMyPlanText('member', null).text, /Covered by the person who runs your group/);
  assert.equal(h.hostedMyPlanText('personal', null).title, 'Personal plan');
  assert.doesNotMatch(h.hostedMyPlanText('personal', null).text, /more people/);
  assert.match(h.hostedMyPlanText('member-free', { quota_bytes: 5 * MB }).text, /Your own space: 5 MB/);
  assert.doesNotMatch(h.hostedMyPlanText('member', null).text, /4 more people/);
  const free = h.hostedMyPlanText('free', { quota_bytes: 5 * MB, paid_quota_bytes: 600 * MB });
  assert.equal(free.title, 'Free plan');
  assert.match(free.text, /^5 MB of space\.$/);
  assert.equal(h.hostedMyPlanText('own', null).title, 'Your own Supabase');
});

test('moving to your own project leaves the encrypted-list marker under every plain key there, and stops if a list key is refused', async () => {
  const sent = [];
  global.syncRpc = async (p, fn, body) => { sent.push([p.url, fn, body.p_sync_key, JSON.stringify(body.p_doc)]); return true; };
  await h.hostedSealMarkers({ url: 'https://own.supabase.co', key: 'k' }, 'tk_abc');
  assert.deepStrictEqual(sent.map((s) => s[2]), h.hostedMarkerKeys('tk_abc'));
  assert.ok(sent.every((s) => s[0] === 'https://own.supabase.co' && s[1] === 'sync_set' && s[3] === '{"moved":"v2"}'));
  // a side row an older setup.sql doesn't know may be refused; a list's own key may not
  global.syncRpc = async (p, fn, body) => body.p_sync_key.indexOf(':') !== -1 ? false : true;
  await h.hostedSealMarkers({ url: 'u', key: 'k' }, 'tk_abc');
  global.syncRpc = async (p, fn, body) => body.p_sync_key === 'tk_work_abc' ? false : true;
  global.syncRefusal = async () => 'the project is full';
  await assert.rejects(h.hostedSealMarkers({ url: 'u', key: 'k' }, 'tk_abc'), /the project is full/);
  delete global.syncRpc; delete global.syncRefusal;
});

test('deleting the account: a 16-digit number, typed back with or without spaces', () => {
  const code = h.hostedDeleteCode();
  assert.match(code, /^[1-9]\d{15}$/);
  assert.notEqual(h.hostedDeleteCode(), code); // fresh each time (1 in 10^15 to collide)
  assert.equal(h.hostedDeleteCodeShown('1234567890123456'), '1234 5678 9012 3456');
  assert.ok(h.hostedDeleteCodeMatches('1234567890123456', '1234 5678 9012 3456'));
  assert.ok(h.hostedDeleteCodeMatches('1234567890123456', '1234567890123456'));
  assert.ok(!h.hostedDeleteCodeMatches('1234567890123456', '1234 5678 9012 345'));
  assert.ok(!h.hostedDeleteCodeMatches('1234567890123456', '12345678901234567'));
  assert.ok(!h.hostedDeleteCodeMatches('', ''));
  // a leading zero is turned into a 7, so the number never starts with one
  assert.match(h.hostedDeleteCode((b) => b.fill(0)), /^70{15}$/);
});

test('deleting the account takes three clicks: the button says which one is next', () => {
  assert.equal(h.hostedDeleteStepText(0).button, 'Delete my account');
  assert.match(h.hostedDeleteStepText(1).button, /2 of 3/);
  assert.match(h.hostedDeleteStepText(1).text, /can’t be undone/);
  assert.match(h.hostedDeleteStepText(2).button, /3 of 3/);
  assert.match(h.hostedDeleteStepText(2).text, /Type the number/);
});
