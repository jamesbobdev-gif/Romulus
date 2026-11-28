const test = require('node:test');
const assert = require('node:assert');
const s = require('../renderer/js/shared-settings');

const NOW = Date.UTC(2026, 10, 27, 12);
const KEYS = ['tasks.themeMode.v1', 'tabsOff', 'ebt.on'];

test('the first look counts what was already set as old, and a setting never touched as nothing', () => {
  const st = s.sharedNote({}, { 'tasks.themeMode.v1': 'dark', tabsOff: null }, KEYS, NOW);
  assert.deepStrictEqual(st['tasks.themeMode.v1'], { at: 1, seen: 'dark' });
  assert.deepStrictEqual(st.tabsOff, { at: 0, seen: null });
  assert.deepStrictEqual(st['ebt.on'], { at: 0, seen: null });
});

test('a value that differs from the one seen last was changed here, now; an unchanged one keeps its time', () => {
  const first = s.sharedNote({}, { 'tasks.themeMode.v1': 'dark' }, KEYS, NOW);
  const later = s.sharedNote(first, { 'tasks.themeMode.v1': 'light', tabsOff: '["work"]' }, KEYS, NOW + 5000);
  assert.deepStrictEqual(later['tasks.themeMode.v1'], { at: NOW + 5000, seen: 'light' });
  assert.deepStrictEqual(later.tabsOff, { at: NOW + 5000, seen: '["work"]' });
  assert.deepStrictEqual(s.sharedNote(later, { 'tasks.themeMode.v1': 'light', tabsOff: '["work"]' }, KEYS, NOW + 9000), later);
  // switched back off (the key removed): that is a change too
  assert.deepStrictEqual(s.sharedNote(later, { 'tasks.themeMode.v1': 'light' }, KEYS, NOW + 9000).tabsOff, { at: NOW + 9000, seen: null });
});

test('a device with settings puts them up; one nobody set up puts up nothing', () => {
  const pc = s.sharedMerge(s.sharedNote({}, { 'tasks.themeMode.v1': 'dark' }, KEYS, NOW), null, KEYS);
  assert.strictEqual(pc.changedRemote, true);
  assert.deepStrictEqual(pc.doc, { v: 1, s: { 'tasks.themeMode.v1': { v: 'dark', at: 1 } } });
  assert.deepStrictEqual(pc.set, {});
  const blank = s.sharedMerge(s.sharedNote({}, {}, KEYS, NOW), null, KEYS);
  assert.strictEqual(blank.changedRemote, false);
  assert.deepStrictEqual(blank.doc.s, {});
});

test('the newer change wins, key by key, in both directions', () => {
  const stamps = { 'tasks.themeMode.v1': { at: NOW, seen: 'light' }, tabsOff: { at: NOW + 10, seen: '["work"]' } };
  const doc = { v: 1, s: { 'tasks.themeMode.v1': { v: 'dark', at: NOW + 1 }, tabsOff: { v: '["hours"]', at: NOW }, later: { v: 'x', at: 5 } } };
  const r = s.sharedMerge(stamps, doc, KEYS);
  assert.deepStrictEqual(r.set, { 'tasks.themeMode.v1': 'dark' });
  assert.deepStrictEqual(r.stamps['tasks.themeMode.v1'], { at: NOW + 1, seen: 'dark' });
  assert.strictEqual(r.changedRemote, true);
  assert.deepStrictEqual(r.doc.s.tabsOff, { v: '["work"]', at: NOW + 10 });
  assert.deepStrictEqual(r.doc.s.later, { v: 'x', at: 5 }); // a key a newer version added is kept
  // once both sides agree nothing moves
  const again = s.sharedMerge(r.stamps, r.doc, KEYS);
  assert.deepStrictEqual(again.set, {});
  assert.strictEqual(again.changedRemote, false);
});

test('two devices that each had their own before: the first one up wins, and the other takes it', () => {
  const phone = s.sharedNote({}, { 'tasks.themeMode.v1': 'light' }, KEYS, NOW);
  const r = s.sharedMerge(phone, { v: 1, s: { 'tasks.themeMode.v1': { v: 'dark', at: 1 } } }, KEYS);
  assert.deepStrictEqual(r.set, { 'tasks.themeMode.v1': 'dark' });
  assert.strictEqual(r.changedRemote, false);
});

test('a setting cleared on another device is cleared here; a key left out is not touched', () => {
  const stamps = { tabsOff: { at: NOW, seen: '["work"]' }, 'ebt.on': { at: NOW, seen: '1' } };
  const doc = { v: 1, s: { tabsOff: { v: null, at: NOW + 1 }, 'ebt.on': { v: '0', at: NOW + 1 } } };
  const r = s.sharedMerge(stamps, doc, ['ebt.on']); // this device keeps its own tabs
  assert.deepStrictEqual(r.set, { 'ebt.on': '0' });
  assert.deepStrictEqual(r.stamps.tabsOff, { at: NOW, seen: '["work"]' });
  assert.deepStrictEqual(s.sharedMerge(stamps, doc, ['tabsOff', 'ebt.on']).set, { tabsOff: null, 'ebt.on': '0' });
});

test('a reply started on one device is in the box on the other, and gone from both once it is sent', () => {
  const all = (drafts, stamps, doc) => s.sharedDraftKeys(drafts, stamps, doc);
  const vals = (drafts, keys) => Object.fromEntries(keys.map((k) => [k, drafts[k.slice(6)] || null]));
  // the phone has half a reply
  let phone = { drafts: { t1: 'Yes, the blue one, but' }, stamps: {} }, pc = { drafts: {}, stamps: {} }, doc = null;
  const pass = (dev, now) => {
    const old = s.sharedDraftForget(dev.stamps, doc, now), keys = all(dev.drafts, old.stamps, old.doc);
    const r = s.sharedMerge(s.sharedNote(old.stamps, vals(dev.drafts, keys), keys, now), old.doc, keys);
    Object.keys(r.set).forEach((k) => { if (r.set[k]) dev.drafts[k.slice(6)] = r.set[k]; else delete dev.drafts[k.slice(6)]; });
    dev.stamps = r.stamps;
    if (r.changedRemote || old.changed) doc = JSON.parse(JSON.stringify(r.doc));
    return r;
  };
  pass(pc, NOW); // nothing yet: a device with no drafts puts up nothing
  assert.strictEqual(doc, null);
  pass(phone, NOW + 1);
  pass(pc, NOW + 2);
  assert.deepStrictEqual(pc.drafts, { t1: 'Yes, the blue one, but' });
  // he goes on typing on the computer, and starts another on the phone: neither costs the other
  pc.drafts.t1 = 'Yes, the blue one, but in a medium';
  phone.drafts.t2 = 'Not that week';
  pass(pc, NOW + 1000); pass(phone, NOW + 2000); pass(pc, NOW + 3000);
  assert.deepStrictEqual(phone.drafts, { t1: 'Yes, the blue one, but in a medium', t2: 'Not that week' });
  assert.deepStrictEqual(pc.drafts, phone.drafts);
  // sent from the computer: the box is empty on the phone too
  delete pc.drafts.t1;
  pass(pc, NOW + 5000); pass(phone, NOW + 6000);
  assert.deepStrictEqual(phone.drafts, { t2: 'Not that week' });
  assert.deepStrictEqual(doc.s['draft:t1'], { v: null, at: NOW + 5000 });
  // and settled: neither has anything more to say
  assert.strictEqual(pass(pc, NOW + 7000).changedRemote, false);
  assert.strictEqual(pass(phone, NOW + 8000).changedRemote, false);
  // a month on, the sent one is forgotten everywhere, the unsent one is still there
  const later = NOW + s.SHARED_DRAFT_FORGET + 9000;
  pass(pc, later); pass(phone, later + 1); pass(pc, later + 2);
  assert.deepStrictEqual(Object.keys(doc.s), ['draft:t2']);
  assert.deepStrictEqual([Object.keys(pc.stamps), Object.keys(phone.stamps)], [['draft:t2'], ['draft:t2']]);
  assert.strictEqual(pass(phone, later + 3).changedRemote, false);
});

test('a very long reply stays on its own device, and odd names in the record are ignored', () => {
  const keys = s.sharedDraftKeys({ short: 'hi', long: 'x'.repeat(9000) }, { 'draft:seen': { at: 5, seen: 'a' }, 'tasks.theme.v1': { at: 1, seen: 'x' } },
    { v: 1, s: { 'draft:theirs': { v: 'b', at: 9 }, 'draft:': { v: 'c', at: 9 }, ['draft:' + 'y'.repeat(200)]: { v: 'd', at: 9 }, 'ai.order': { v: '[]', at: 2 } } });
  assert.deepStrictEqual(keys, ['draft:seen', 'draft:short', 'draft:theirs']);
});
