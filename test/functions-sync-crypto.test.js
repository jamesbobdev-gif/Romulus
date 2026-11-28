const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const node = require('../agent/sync-crypto');

/* supabase/functions/_shared/sync-crypto.mjs (what the connector and the feeds run) against the app's own
   agent/sync-crypto.js, and its store against a pretend database */
const shared = () => import(pathToFileURL(path.join(__dirname, '../supabase/functions/_shared/sync-crypto.mjs')).href);
const KEYS = ['tk_abcdefghijklmnop', 'tk_agent_abcdefghijklmnop', 'tk_work_abcdefghijklmnop', 'tk_school_abcdefghijklmnop'];

// the table, as sync_get / sync_put treat it: compare-and-swap on updated_at, no plain write onto a moved row
function table() {
  const rows = new Map();
  let clock = 0;
  const gets = [];
  return {
    rows, gets,
    set: (key, doc) => rows.set(key, { doc, updated_at: 't' + (++clock) }),
    get: async (key) => { gets.push(key); const r = rows.get(key); return r ? { doc: r.doc, updated_at: r.updated_at } : null; },
    put: async (key, doc, prev) => {
      const r = rows.get(key);
      if ((r ? r.updated_at : null) !== (prev || null)) return false;
      if (r && r.doc && r.doc.moved === 'v2' && !(doc && doc.moved === 'v2')) return false;
      rows.set(key, { doc, updated_at: 't' + (++clock) });
      return true;
    },
  };
}

test('the functions find and open what the app sealed, and the app opens what they seal', async () => {
  const S = await shared();
  for (const k of KEYS) {
    assert.strictEqual(await S.rowKey(k), node.rowKey(k), 'the same row id for ' + k);
    assert.strictEqual(await S.rowKey(k + ':prefs'), node.rowKey(k + ':prefs'));
    const doc = { v: 1, tasks: [{ id: 'a', title: 'Call the dentist é' }], tombstones: [] };
    assert.deepStrictEqual(await S.open(k, node.seal(k, doc)), doc);
    assert.deepStrictEqual(node.open(k, await S.seal(k, doc)), doc);
    assert.deepStrictEqual(node.open(k + ':prefs', await S.seal(k + ':prefs', { v: 1, text: 'x' })), { v: 1, text: 'x' }, 'a side row under its list’s key');
  }
  const sealed = await S.seal(KEYS[0], { secret: 'Call the dentist' });
  assert.ok(S.isSealed(sealed) && !JSON.stringify(sealed).includes('dentist'));
  await assert.rejects(S.open(KEYS[1], sealed), 'another list’s key does not open it');
});

test('a plain list is read and written as it always was', async () => {
  const S = await shared(), db = table(), key = KEYS[1];
  const store = S.makeStore(db);
  assert.deepStrictEqual(await store.read(key), { doc: null, updated_at: null, v2: false }, 'no row yet');
  db.set(key, { v: 1, tasks: [{ id: 'a' }], tombstones: [] });
  const row = await store.read(key);
  assert.strictEqual(row.v2, false);
  row.doc.tasks.push({ id: 'b' });
  assert.strictEqual(await store.write(key, row.doc, row.updated_at, row.v2), true);
  assert.deepStrictEqual(db.rows.get(key).doc.tasks.map((t) => t.id), ['a', 'b'], 'still in the clear, under the same key');
  assert.strictEqual(await store.write(key, row.doc, row.updated_at, row.v2), false, 'someone wrote since: not saved');
});

test('once a device encrypts the lists, the function follows: opened under the lookup id, sealed on the way back', async () => {
  const S = await shared(), db = table(), key = KEYS[1];
  const store = S.makeStore(db);
  db.set(key, { v: 1, tasks: [{ id: 'old' }], tombstones: [] });
  assert.strictEqual((await store.read(key)).v2, false);
  // the app's move: the sealed copy under the lookup id, the marker under the old key
  db.set(node.rowKey(key), node.seal(key, { v: 1, tasks: [{ id: 'a', title: 'Dentist' }], tombstones: [] }));
  db.set(key, { moved: 'v2' });
  const row = await store.read(key);
  assert.deepStrictEqual([row.v2, row.doc.tasks[0].title], [true, 'Dentist']);
  row.doc.tasks.push({ id: 'b', title: 'Buy stamps' });
  assert.strictEqual(await store.write(key, row.doc, row.updated_at, row.v2), true);
  assert.deepStrictEqual(db.rows.get(key).doc, { moved: 'v2' }, 'the marker is untouched');
  const up = db.rows.get(node.rowKey(key)).doc;
  assert.ok(node.isSealed(up) && !JSON.stringify(up).includes('stamps'), 'what the table holds is ciphertext');
  assert.deepStrictEqual(node.open(key, up).tasks.map((t) => t.id), ['a', 'b'], 'and a device opens it');
  assert.strictEqual(await store.write(key, row.doc, row.updated_at, row.v2), false, 'compare-and-swap still holds');
  db.gets.length = 0;
  await store.read(key);
  assert.deepStrictEqual(db.gets, [node.rowKey(key)], 'a moved list is remembered: straight to the lookup id');
});

test('a side row follows its list, with or without a marker of its own', async () => {
  const S = await shared(), db = table(), key = KEYS[1], prefs = key + ':prefs';
  db.set(key, { moved: 'v2' });
  db.set(node.rowKey(key), node.seal(key, { v: 1, tasks: [], tombstones: [] }));
  // never existed in the clear, so no marker under tk_agent_…:prefs
  let store = S.makeStore(db);
  assert.deepStrictEqual(await store.read(prefs), { doc: null, updated_at: null, v2: true });
  assert.strictEqual(await store.write(prefs, { v: 1, text: '## Food\n- no olives' }, null, true), true);
  assert.strictEqual(db.rows.has(prefs), false, 'nothing lands in the clear');
  assert.strictEqual(node.open(prefs, db.rows.get(node.rowKey(prefs)).doc).text, '## Food\n- no olives');
  store = S.makeStore(db); // a cold start
  assert.strictEqual((await store.read(prefs)).doc.text, '## Food\n- no olives');
  // a plain list's side row stays plain
  const other = S.makeStore(table());
  assert.strictEqual((await other.read(KEYS[0] + ':prefs')).v2, false);
});

test('a plain document where the sealed list should be is refused, not read or overwritten', async () => {
  const S = await shared(), db = table(), key = KEYS[0];
  db.set(key, { moved: 'v2' });
  db.set(node.rowKey(key), { v: 1, tasks: [{ id: 'planted' }], tombstones: [] });
  await assert.rejects(S.makeStore(db).read(key), /unencrypted copy/);
});
