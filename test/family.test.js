const test = require('node:test');
const assert = require('node:assert');
const f = require('../renderer/js/family');

const T = 1_800_000_000_000;
const list = (id, name, at) => ({ id, name, created: at, updatedAt: at });
const item = (id, l, text, at, extra) => Object.assign({ id, list: l, text, done: false, by: 'me', created: T + Number(id), updatedAt: at }, extra);

test('two devices merging each other end up with the very same document', () => {
  const a = { lists: [list('g', 'Groceries', T)], items: [item('1', 'g', 'eggs', T), item('2', 'g', 'milk', T + 5, { done: true })] };
  const b = { lists: [list('g', 'Groceries', T), list('h', 'House', T + 1)], items: [item('2', 'g', 'milk', T + 2), item('3', 'g', 'bread', T + 3)] };
  const ab = f.famMerge(a, b, T), ba = f.famMerge(b, a, T);
  assert.strictEqual(f.famStable(ab), f.famStable(ba));
  assert.deepStrictEqual(ab.items.map((x) => x.text), ['eggs', 'milk', 'bread']);
  assert.strictEqual(ab.items.find((x) => x.id === '2').done, true); // the newer tick wins
  // merging the result again changes nothing, so neither side uploads forever
  assert.strictEqual(f.famStable(f.famMerge(ab, ba, T)), f.famStable(ab));
});

test('a deletion beats older copies but not an edit made after it', () => {
  const a = { items: [item('1', 'g', 'eggs', T), item('2', 'g', 'milk', T + 10)], lists: [list('g', 'Groceries', T)] };
  const b = { tombstones: [{ id: '1', deletedAt: T + 5 }, { id: '2', deletedAt: T + 5 }] };
  const m = f.famMerge(a, b, T);
  assert.deepStrictEqual(m.items.map((x) => x.id), ['2']);
  assert.strictEqual(m.tombstones.length, 2);
});

test('deleting a list takes its lines with it, even ones added elsewhere meanwhile', () => {
  const a = { lists: [list('g', 'Groceries', T)], items: [item('1', 'g', 'eggs', T + 20)] };
  const m = f.famMerge(a, { tombstones: [{ id: 'g', deletedAt: T + 10 }] }, T);
  assert.strictEqual(m.lists.length, 0);
  assert.strictEqual(m.items.length, 0);
});

test('records that are not ours are dropped, and text is kept to size', () => {
  const d = f.famNorm({ items: [{ id: 'x', list: 'g', text: '' }, { list: 'g', text: 'no id' }, { id: 'y', list: 'g', text: 'a'.repeat(500), updatedAt: 1 }], offers: [{ id: 'o', title: 'no one to send to' }] });
  assert.strictEqual(d.items.length, 1);
  assert.strictEqual(d.items[0].text.length, 200);
  assert.strictEqual(d.offers.length, 0);
});

test('a to-do waits for its person, then the answer stays a week and goes the same way everywhere', () => {
  const offer = { id: 'o', from: 'me', to: 'sam', title: 'Pick up the prescription', due: '2026-11-08', created: T, updatedAt: T };
  let d = f.famMerge({ offers: [offer] }, {}, T);
  assert.deepStrictEqual(f.famForMe(d, 'sam').map((o) => o.id), ['o']);
  assert.deepStrictEqual(f.famForMe(d, 'me'), []);
  assert.strictEqual(f.famSentByMe(d, 'me').length, 1);
  d = f.famMerge(d, { offers: [Object.assign({}, offer, { answer: 'added', answeredAt: T + 1000, updatedAt: T + 1000 })] }, T);
  assert.deepStrictEqual(f.famForMe(d, 'sam'), []);
  assert.strictEqual(f.famTidy(d, T + 3 * 864e5).offers.length, 1);
  const x = f.famTidy(d, T + 8 * 864e5), y = f.famTidy(d, T + 9 * 864e5);
  assert.strictEqual(x.offers.length, 0);
  assert.strictEqual(f.famStable(x.tombstones), f.famStable(y.tombstones)); // two devices tidying on different days agree
});

test('an invite code is the server part plus a secret, and splits back the same way', () => {
  const secret = f.famNewSecret(new Uint8Array(16).map((_, i) => i * 7));
  assert.match(secret, /^[A-HJ-NP-Z2-9]{16}$/);
  const shown = f.famCodeShow('F0B3-65FB-585B', secret);
  assert.match(shown, /^F0B3-65FB-585B(-[A-Z0-9]{4}){4}$/);
  assert.deepStrictEqual(f.famCodeSplit(shown), { server: 'F0B365FB585B', secret });
  assert.deepStrictEqual(f.famCodeSplit(' f0b3 65fb 585b ' + secret.toLowerCase()), { server: 'F0B365FB585B', secret });
  // a code from an older build has no secret: it still joins the plan
  assert.deepStrictEqual(f.famCodeSplit('F0B3-65FB-585B'), { server: 'F0B365FB585B', secret: null });
});

test('names fall back when someone has not picked one yet', () => {
  const d = f.famNorm({ people: [{ id: 'sam', name: 'Sam', updatedAt: 1 }] });
  assert.strictEqual(f.famName(d, 'sam'), 'Sam');
  assert.strictEqual(f.famName(d, 'who'), 'Someone');
});
