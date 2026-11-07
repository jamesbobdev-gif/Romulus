// The family list (renderer/js/family-list.js): the code that hands its key over, what its online copy carries,
// and the new key handed to the devices that stay when someone leaves the plan. Plus the sync.js side: a fifth
// list with a key of its own that only carries its own deletions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const f = require('../renderer/js/family-list');
const pair = require('../renderer/js/pair');
const dev = require('../renderer/js/devices');

const keyPair = async () => {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const j = await crypto.subtle.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
};
const LIST_KEY = 'tk_0f6c1a52-8f1e-4d3a-9b7e-3c2d1e0f9a8b';

test('a family list code opens the list key on the other device, and only that code does', async () => {
  const code = pair.pairNewCode();
  const a = await f.familyDerive(code), b = await f.familyDerive(pair.pairNormalize(pair.pairFormat(code).toLowerCase()));
  assert.match(a.id, /^[0-9a-f]{64}$/); // the shape sync_family_share_put takes
  assert.strictEqual(a.id, b.id);
  assert.notStrictEqual(a.id, (await pair.pairDerive(code)).id); // never the id of a pairing code made of the same letters
  const sealed = await pair.pairSeal(a.key, f.familyCodeText(LIST_KEY));
  assert.ok(!sealed.includes('tk_') && !sealed.includes(code)); // what the server keeps says nothing
  assert.strictEqual(f.familyCodeKey(await pair.pairOpen(b.key, sealed)), LIST_KEY);
  const other = await f.familyDerive(pair.pairNewCode());
  assert.strictEqual(await pair.pairOpen(other.key, sealed), null);
  for (const bad of ['', 'null', '{"s":"not a key"}', '{"s":"tk_short"}', 'tasks-sync:abc']) assert.strictEqual(f.familyCodeKey(bad), null, bad);
});

test('the online copy carries only the family list’s own deletions, never private ones', () => {
  const remote = { tasks: [{ id: 'milk' }, { id: 'eggs' }], tombstones: [{ id: 'bread', deletedAt: 5 }] };
  const mine = [{ id: 'eggs', deletedAt: 9 }, { id: 'bread', deletedAt: 5 }, { id: 'doctor-appointment', deletedAt: 7 }];
  assert.deepStrictEqual(f.familyTombs(mine, remote).map((x) => x.id), ['eggs', 'bread']);
  assert.deepStrictEqual(f.familyTombs(mine, null), []);
});

test('each device puts itself on the list once, and again only when something about it changed', () => {
  const me = { acct: 'a1', pub: { x: '1', y: '2' }, name: 'Pixel' };
  const first = f.familyPeopleWithMe({ other: { acct: 'a2', pub: null, name: 'Desk' } }, 'd1', me);
  assert.ok(first.changed);
  assert.deepStrictEqual(Object.keys(first.people).sort(), ['d1', 'other']);
  assert.strictEqual(f.familyPeopleWithMe(first.people, 'd1', me).changed, false);
  assert.ok(f.familyPeopleWithMe(first.people, 'd1', Object.assign({}, me, { name: 'Pixel 9' })).changed);
  assert.deepStrictEqual(f.familyCount(first.people), { people: 2, devices: 2 });
});

test('taken off the plan: the new key reaches the devices that stay, not theirs', async () => {
  const mom = await keyPair(), kid = await keyPair(), gone = await keyPair(), old = await keyPair();
  const people = {
    momPhone: { acct: 'mom', pub: mom.pub, name: 'Phone' },
    kidPhone: { acct: 'kid', pub: kid.pub, name: 'Phone' },
    exPhone: { acct: 'ex', pub: gone.pub, name: 'Phone' },
    oldTablet: { acct: 'kid', pub: null, name: 'Tablet' }, // no key pair: can't be handed anything
  };
  const allowed = ['mom', 'kid'];
  assert.deepStrictEqual(f.familyStale(people, allowed), ['exPhone']);
  const keep = Object.keys(people).filter((id) => allowed.includes(people[id].acct));
  const doc = f.familyClosedDoc(await f.familyHandoff(people, keep, 'tk_new_family_list_key_1234567890', dev.devicesSeal), 1);
  assert.deepStrictEqual(Object.keys(doc.rotated.handoff).sort(), ['kidPhone', 'momPhone']);
  assert.deepStrictEqual(doc.tasks, []); // the closed row holds no tasks
  assert.strictEqual(f.familyCodeKey(await dev.devicesOpen(kid.priv, doc.rotated.handoff.kidPhone)), 'tk_new_family_list_key_1234567890');
  await assert.rejects(dev.devicesOpen(gone.priv, doc.rotated.handoff.momPhone)); // the one who left can't open anyone's
  await assert.rejects(dev.devicesOpen(old.priv, doc.rotated.handoff.kidPhone));
  assert.deepStrictEqual(f.familyDropLocal([{ id: 'a', ws: 'family' }, { id: 'b' }, { id: 'c', ws: 'work' }]).map((t) => t.id), ['b', 'c']);
});

test('every reason the server can give has words', () => {
  for (const why of ['not_family', 'no_code', 'rate', 'no_account', 'bad']) assert.ok(f.FAMILY_WHY[why], why);
});

/* ── the sync.js side ── */
function anything() {
  const fn = function () {};
  return new Proxy(fn, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : anything()), apply: () => anything(), set: () => true });
}
function loadSync() {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder,
    window: {}, document: anything(),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/sync.js'), 'utf8'), ctx);
  ctx.state = { tasks: [], tombstones: [] };
  ctx.familyTombs = f.familyTombs; // what family-list.js gives the page
  ctx.familyDocExtras = (remote) => ({ tombstones: f.familyTombs(ctx.state.tombstones, remote), people: (remote && remote.people) || {} });
  return ctx;
}
const HOSTED = 'https://hostedhostedhostedhost.supabase.co';
const ME = 'tk_26dbc739-a57d-4d40-900d-984640e0415d';

test('the family list keeps its own key, follows nobody’s personal key, and syncs as a fifth list', () => {
  const c = loadSync();
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(ME)}, v2: true },
    family: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(LIST_KEY)}, v2: true } });`, c);
  const cfg = JSON.parse(JSON.stringify(vm.runInContext('syncState.cfg', c)));
  assert.strictEqual(cfg.family.syncKey, LIST_KEY);
  assert.ok(!cfg.family.derived);
  assert.ok(cfg.work.derived); // the others are still made from the personal key
  assert.deepStrictEqual(Array.from(vm.runInContext('profileList()', c)), ['personal', 'work', 'agent', 'school', 'family']);
  assert.ok(vm.runInContext('familyConfigured()', c));
  // a derived family profile (nobody makes one) is never kept
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'k', syncKey: ${JSON.stringify(ME)} }, family: { url: ${JSON.stringify(HOSTED)}, key: 'k', syncKey: 'tk_family_x', derived: true } });`, c);
  assert.ok(!vm.runInContext('familyConfigured()', c));
  // its tasks are on the Family tab only
  assert.strictEqual(vm.runInContext("taskWs({ws:'family'})", c), 'family');
  assert.ok(vm.runInContext("inTab({ws:'family'},'family')", c));
  assert.ok(!vm.runInContext("inTab({ws:'family'},'list')", c));
  assert.ok(!vm.runInContext("inTab({ws:'personal'},'family')", c));
});

test('moving the other lists to another project leaves the family list on the Romulus server', () => {
  const c = loadSync();
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(ME)}, v2: true },
    family: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(LIST_KEY)}, v2: true } });`, c);
  c.syncFollowMove(vm.runInContext('syncState.cfg.personal', c), { url: 'https://ownownownownownownown1.supabase.co', key: 'sb_publishable_own123' });
  const cfg = JSON.parse(JSON.stringify(vm.runInContext('syncState.cfg', c)));
  assert.notStrictEqual(cfg.personal.url, HOSTED);
  assert.strictEqual(cfg.family.url, HOSTED);
  assert.strictEqual(cfg.family.syncKey, LIST_KEY);
});

test('a family member’s change merges in, private deletions stay home, and a settled list stops uploading', () => {
  const c = loadSync();
  c.state.tasks = [
    { id: 'dentist', ws: 'personal', title: 'Dentist', updatedAt: 1, subs: [] },
    { id: 'milk', ws: 'family', title: 'Milk', updatedAt: 10, subs: [] },
  ];
  c.state.tombstones = [{ id: 'eggs', deletedAt: Date.now() }, { id: 'secret-gift', deletedAt: Date.now() }];
  // the online copy: eggs (which this device deleted) and bread, added on someone else's phone
  const remote = { v: 1, tasks: [{ id: 'milk', title: 'Milk', updatedAt: 10, subs: [] }, { id: 'eggs', title: 'Eggs', updatedAt: 2, subs: [] }, { id: 'bread', title: 'Bread', updatedAt: 20, subs: [] }], tombstones: [], people: { d1: { acct: 'a' } } };
  const r = c.mergeRemoteWs(remote, 'family');
  assert.ok(r.changedLocal && r.changedRemote);
  assert.deepStrictEqual(c.state.tasks.filter((t) => t.ws === 'family').map((t) => t.id).sort(), ['bread', 'milk']);
  assert.ok(c.state.tasks.some((t) => t.id === 'dentist' && t.ws === 'personal')); // the private list is untouched
  const up = JSON.parse(JSON.stringify(c.wsDoc('family', remote)));
  assert.deepStrictEqual(up.tasks.map((t) => t.id).sort(), ['bread', 'milk']);
  assert.ok(up.tasks.every((t) => !('ws' in t)));
  assert.deepStrictEqual(up.tombstones.map((x) => x.id), ['eggs']); // not secret-gift
  assert.deepStrictEqual(up.people, { d1: { acct: 'a' } });
  // the next round reads back what went up: nothing left to upload, so live updates don't wake each other forever
  const again = c.mergeRemoteWs(up, 'family');
  assert.strictEqual(again.changedRemote, false);
  assert.strictEqual(again.changedLocal, false);
  // the personal list still carries every deletion, as before
  assert.strictEqual(c.wsDoc('personal').tombstones.length, 2);
});
