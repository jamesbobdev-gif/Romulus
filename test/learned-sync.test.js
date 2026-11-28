const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ls = require('../agent/learned-sync');
const howtos = require('../agent/howtos');

const how = (id, date, extra) => Object.assign({ id, task: 'Find the due dates', words: ['due', 'date'], sites: ['school.example.edu'], text: 'Open Courses, then Calendar: it lists everything due.', lane: 'local', date }, extra);
const ids = (list) => list.map((h) => h.id);

test('how-tos from both computers are joined, oldest first', () => {
  const out = ls.mergeHowtos([how('aaaaaaaa0001', '2026-11-02')], [how('bbbbbbbb0001', '2026-11-01')], null);
  assert.deepStrictEqual(ids(out), ['bbbbbbbb0001', 'aaaaaaaa0001']);
});

test('a how-to deleted on one computer goes on the other, and does not come back', () => {
  const both = [how('aaaaaaaa0001', '2026-11-01'), how('bbbbbbbb0001', '2026-11-02')];
  // deleted here since the last sync: the row still has it, this computer remembers having had it
  assert.deepStrictEqual(ids(ls.mergeHowtos([both[0]], both, ids(both))), ['aaaaaaaa0001']);
  // deleted on the other computer: gone from the row, still here
  assert.deepStrictEqual(ids(ls.mergeHowtos(both, [both[1]], ids(both))), ['bbbbbbbb0001']);
  // one learned here since the last sync is new, not deleted
  assert.deepStrictEqual(ids(ls.mergeHowtos(both.concat(how('cccccccc0001', '2026-11-03')), both, ids(both))), ['aaaaaaaa0001', 'bbbbbbbb0001', 'cccccccc0001']);
});

test('a how-to from the row is checked before it is kept: no personal details, no odd shapes, the private mark stays', () => {
  const out = ls.mergeHowtos([], [
    how('aaaaaaaa0001', '2026-11-01', { text: 'Write to someone@example.com and ask for the form.' }),
    how('../../etc', '2026-11-01'),
    { id: 'bbbbbbbb0001', text: 'no words at all, so it could never be found again' },
    how('cccccccc0001', '2026-11-01', { priv: true, extra: 'dropped' }),
  ], null);
  assert.deepStrictEqual(out, [{ id: 'cccccccc0001', task: 'Find the due dates', words: ['due', 'date'], sites: ['school.example.edu'], text: 'Open Courses, then Calendar: it lists everything due.', lane: 'local', date: '2026-11-01', priv: true }]);
});

test('site tips are joined per site, the same tip once, the newest ten kept', () => {
  const out = ls.mergeTips(
    { 'shop.example.com': ['- (2026-11-01) Apply opens a popup window', '- (2026-11-05) The cart is under the bag icon'] },
    { 'shop.example.com': ['- (2026-11-03) apply opens a popup window', '- (2026-11-04) Checkout asks for a code sent by email'], '../evil': ['- (2026-11-01) never written anywhere'], 'b.example.org': ['not a tip line', '- (2026-11-02) Call 555 123 4567 to get in'] });
  assert.deepStrictEqual(out, { 'shop.example.com': ['- (2026-11-01) Apply opens a popup window', '- (2026-11-04) Checkout asks for a code sent by email', '- (2026-11-05) The cart is under the bag icon'] });
  const many = Array.from({ length: 14 }, (_, i) => '- (2026-11-' + String(i + 1).padStart(2, '0') + ') tip number ' + i + ' about the site');
  assert.deepStrictEqual(ls.mergeTips({ 'a.example.com': many.slice(0, 7) }, { 'a.example.com': many.slice(7) })['a.example.com'], many.slice(-ls.MAX_TIPS));
});

test('the class log is joined; the newer entry for the same item wins', () => {
  const out = ls.mergeLog(
    [{ course: 'HIS 110', title: 'Quiz 3', due: '2026-11-10', at: '2026-11-02' }],
    [{ course: 'HIS 110', title: 'quiz 3', due: '2026-11-12', at: '2026-11-04' }, { course: 'BIO 101', title: 'Lab 2', due: null, at: '2026-11-01' }, { title: 'no course' }]);
  assert.deepStrictEqual(out, [{ course: 'BIO 101', title: 'Lab 2', due: null, at: '2026-11-01' }, { course: 'HIS 110', title: 'quiz 3', due: '2026-11-12', at: '2026-11-04' }]);
});

test('the lane record takes the higher count, never the sum, and shares what was already counted', () => {
  const a = { v: 1, types: { email: { claude: { ok: 5, bad: 1 } }, writing: { local: { ok: 2, bad: 0 } } }, counted: { 't1|done': 1, 't2|done': 1 } };
  const b = { types: { email: { claude: { ok: 4, bad: 2 }, local: { ok: 1, bad: 0 } } }, counted: { 't2|done': 1, 't3|moved': 1, 'not a mark': 1 } };
  const r = ls.mergeRoutes(a, b);
  assert.deepStrictEqual(r.local.types, { email: { claude: { ok: 5, bad: 2 }, local: { ok: 1, bad: 0 } }, writing: { local: { ok: 2, bad: 0 } } });
  assert.deepStrictEqual(Object.keys(r.local.counted).sort(), ['t1|done', 't2|done', 't3|moved']);
  assert.deepStrictEqual(r.remote, { types: r.local.types, counted: { 't1|done': 1, 't2|done': 1, 't3|moved': 1 } });
});

test('two computers that agree write nothing, whichever one looks', () => {
  const pc = { howtos: [how('aaaaaaaa0001', '2026-11-02')], tips: { 'a.example.com': ['- (2026-11-01) Sign in is under the menu'] }, classLog: [], routes: { v: 1, types: { email: { claude: { ok: 1, bad: 0 } } }, counted: { 't1|done': 1 } } };
  const lupa = { howtos: [how('bbbbbbbb0001', '2026-11-01')], tips: {}, classLog: [{ course: 'HIS 110', title: 'Quiz 3', due: null, at: '2026-11-02' }], routes: { v: 1, types: {}, counted: {} } };
  const first = ls.merge(pc, null, null);
  assert.strictEqual(first.changedRemote, true);
  assert.deepStrictEqual(first.changed, { howtos: false, tips: [], classLog: false, routes: false });
  const second = ls.merge(lupa, first.doc, null);
  assert.strictEqual(second.changedRemote, true);
  assert.deepStrictEqual(second.changed, { howtos: true, tips: ['a.example.com'], classLog: false, routes: true });
  assert.deepStrictEqual(ids(second.local.howtos), ['bbbbbbbb0001', 'aaaaaaaa0001']);
  const third = ls.merge(pc, second.doc, first.base); // the PC takes Lupa's
  assert.strictEqual(third.changedRemote, false);
  assert.deepStrictEqual(third.changed, { howtos: true, tips: [], classLog: true, routes: false });
  // and now neither has anything to say; the row goes through JSON on the way, as it does for real
  const row = JSON.parse(JSON.stringify(second.doc));
  for (const [local, base] of [[third.local, third.base], [second.local, second.base]]) {
    const again = ls.merge(local, row, base);
    assert.strictEqual(again.changedRemote, false);
    assert.deepStrictEqual(again.changed, { howtos: false, tips: [], classLog: false, routes: false });
  }
});

test('a how-to the row cannot carry stays on this computer, unshared', () => {
  const oddOne = { id: 'OLD-1', task: 'x', words: [], sites: [], text: 'kept from a much older version of the app', lane: 'local', date: '2026-01-01' };
  const r = ls.merge({ howtos: [oddOne, how('aaaaaaaa0001', '2026-11-02')], tips: {}, classLog: [], routes: {} }, null, null);
  assert.deepStrictEqual(ids(r.doc.howtos), ['aaaaaaaa0001']);
  assert.deepStrictEqual(ids(r.local.howtos), ['OLD-1', 'aaaaaaaa0001']);
  assert.strictEqual(r.changed.howtos, false);
});

test('a how-to from a private task is never among the ones a cloud AI may read', () => {
  const r = howtos.learn([], { task: 'Sort out the bank letter', text: 'The letters are under Documents, then Statements, newest first.', urls: [], lane: 'local', today: '2026-11-28', priv: true });
  assert.strictEqual(r.howto.priv, true);
  const plain = howtos.learn(r.list, { task: 'Find the quiz due dates', text: 'Open Courses, then Calendar: it lists everything due.', urls: [], lane: 'local', today: '2026-11-28' });
  assert.strictEqual(plain.howto.priv, undefined);
  assert.deepStrictEqual(howtos.open(plain.list).map((h) => h.id), [plain.howto.id]);
});

test('one pass: reads the row, keeps what is new here, writes what is new there, and a lost race tries again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-'));
  const files = { howtos: path.join(dir, 'task-howtos.json'), tipsDir: path.join(dir, 'site-notes'), classLog: path.join(dir, 'class-log.json'), state: path.join(dir, 'learned-sync.json') };
  howtos.save(files.howtos, [how('aaaaaaaa0001', '2026-11-02')]);
  let stats = { v: 1, types: {}, counted: {} };
  const routeLearn = { snapshot: () => JSON.parse(JSON.stringify(stats)), adopt: (s) => { stats = s; } };
  let row = { doc: { v: 1, howtos: [how('bbbbbbbb0001', '2026-11-01')], tips: { 'a.example.com': ['- (2026-11-01) Sign in is under the menu'] }, classLog: [], routes: { types: { email: { claude: { ok: 2, bad: 0 } } }, counted: { 't1|done': 1 } } }, updated_at: 't1' };
  let writes = 0, refuse = 1;
  const supabase = {
    readRow: async (a, sfx) => { assert.strictEqual(sfx, ':learned'); return row; },
    writeRow: async (a, sfx, doc, prev) => { assert.strictEqual(prev, row.updated_at); if (refuse-- > 0) return false; writes++; row = { doc: JSON.parse(JSON.stringify(doc)), updated_at: 't2' }; return true; },
  };
  const o = { a: {}, supabase, howtos, routeLearn, files };
  const r = await ls.sync(o);
  assert.deepStrictEqual(r, { ok: true, got: [], sent: true }); // the second try had nothing more to take in
  assert.strictEqual(writes, 1);
  assert.deepStrictEqual(ids(howtos.load(files.howtos)), ['bbbbbbbb0001', 'aaaaaaaa0001']);
  assert.deepStrictEqual(ls.readTips(files.tipsDir), { 'a.example.com': ['- (2026-11-01) Sign in is under the menu'] });
  assert.deepStrictEqual(stats.types, { email: { claude: { ok: 2, bad: 0 } } });
  assert.deepStrictEqual(ids(row.doc.howtos), ['bbbbbbbb0001', 'aaaaaaaa0001']);
  // nothing new on either side: nothing written
  assert.deepStrictEqual(await ls.sync(o), { ok: true, got: [], sent: false });
  assert.strictEqual(writes, 1);
  // deleted here: it leaves the row too
  howtos.save(files.howtos, howtos.load(files.howtos).filter((h) => h.id !== 'bbbbbbbb0001'));
  assert.deepStrictEqual(await ls.sync(o), { ok: true, got: [], sent: true });
  assert.deepStrictEqual(ids(row.doc.howtos), ['aaaaaaaa0001']);
  // a server that does not know the row yet: said, not thrown
  const down = await ls.sync(Object.assign({}, o, { supabase: { readRow: async () => { throw new Error('HTTP 400'); } } }));
  assert.deepStrictEqual(down, { ok: false, error: 'HTTP 400' });
  assert.deepStrictEqual(await ls.sync(Object.assign({}, o, { a: null })), { ok: false, error: 'sync isn’t set up on this computer' });
  fs.rmSync(dir, { recursive: true, force: true });
});
