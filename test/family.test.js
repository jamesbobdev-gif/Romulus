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

const person = (id, name, acct, extra) => Object.assign({ id, name, acct, created: T, updatedAt: T }, extra);
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

test('people keep their account id and whether they run the group', () => {
  const d = f.famNorm({ people: [person('p1', 'Ana', A, { owner: true }), person('p2', 'Bo', 'not-an-id')] });
  assert.strictEqual(d.people[0].acct, A);
  assert.strictEqual(d.people[0].owner, true);
  assert.strictEqual(d.people[1].acct, null);
  assert.strictEqual(d.people[1].owner, false);
});

test('someone the server no longer lists is gone, along with to-dos to and from them', () => {
  const doc = {
    people: [person('p1', 'Ana', A, { owner: true }), person('p2', 'Bo', B), person('p3', 'Cy', C), person('p4', 'Old', null)],
    lists: [list('g', 'Groceries', T)],
    items: [item('1', 'g', 'eggs', T, { by: 'p3' })],
    offers: [{ id: 'o1', from: 'p1', to: 'p3', title: 'Call', created: T, updatedAt: T }, { id: 'o2', from: 'p1', to: 'p2', title: 'Bins', created: T, updatedAt: T }],
  };
  assert.deepStrictEqual(f.famGone(doc, [A, B]).map((x) => x.name), ['Cy']); // no account id: can't tell, never counts
  const out = f.famWithout(doc, [A, B], T + 10);
  assert.deepStrictEqual(out.people.map((x) => x.name), ['Ana', 'Bo', 'Old']);
  assert.deepStrictEqual(out.offers.map((x) => x.id), ['o2']);
  assert.deepStrictEqual(out.items.map((x) => x.text), ['eggs']); // what they added stays
  // an old copy that still has them doesn't bring them back
  assert.deepStrictEqual(f.famMerge(out, doc, T + 10).people.map((x) => x.name), ['Ana', 'Bo', 'Old']);
  assert.strictEqual(f.famGone(out, [A, B]).length, 0);
});

test('the shared Groceries list goes on the next grocery order, once', () => {
  const same = (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
  const doc = f.famNorm({ lists: [list('h', 'House', T), list('g', ' groceries ', T)],
    items: [item('1', 'g', 'Eggs', T), item('2', 'g', 'Milk', T), item('3', 'g', 'Bread', T, { done: true }), item('4', 'h', 'Bulbs', T)] });
  assert.strictEqual(f.famGroceryList(doc).id, 'g');
  const open = f.famOpenGroceries(doc);
  assert.deepStrictEqual(open.map((x) => x.text), ['Eggs', 'Milk']);
  const mine = [{ name: 'eggs', every: 1, last: null, out: false }];
  const next = f.famFeedList(mine, open, same);
  assert.deepStrictEqual(next, [{ name: 'eggs', every: 1, last: null, out: true }, { name: 'Milk', every: 1, last: null, out: true }]);
  assert.strictEqual(mine[0].out, false); // his list isn't changed in place
  assert.strictEqual(f.famFeedList(next, open, same), null); // nothing new: no write
  // bought after the shared line was last edited: not flagged again before the tick-off arrives
  const bought = [{ name: 'Eggs', every: 1, last: new Date(T + 864e5).toISOString().slice(0, 10), out: false }, { name: 'Milk', every: 1, last: null, out: true }];
  assert.strictEqual(f.famFeedList(bought, open, same), null);
  assert.strictEqual(f.famFeedList(mine, [], same), null);
});

test('@name in a typed task picks the person and comes out of the title', () => {
  const people = [{ id: 'me', name: 'James' }, { id: 's', name: 'Sam Lee' }, { id: 'm', name: 'Mary' }, { id: 'ma', name: 'Mary Ann' }];
  assert.deepStrictEqual(f.famMention('Pick up milk @Sam', people, 'me'), { to: 's', name: 'Sam Lee', title: 'Pick up milk' });
  assert.deepStrictEqual(f.famMention('@sam lee take out the trash', people, 'me'), { to: 's', name: 'Sam Lee', title: 'take out the trash' });
  assert.strictEqual(f.famMention('call @Mary Ann, please', people, 'me').to, 'ma');
  assert.strictEqual(f.famMention('call @Mary today', people, 'me').to, 'm');
  assert.strictEqual(f.famMention('email bob@samco.com', people, 'me'), null);
  assert.strictEqual(f.famMention('remind @James', people, 'me'), null); // not to myself
  assert.strictEqual(f.famMention('ask @Samantha', people, 'me'), null);
});

test('the to-do lines in an Agent reply', () => {
  const md = 'Here is the plan:\n\n- **Call** the [landlord](https://x.y)\n2. Pay the water bill\n* [ ] Buy filters\nThat is all.\n- ok';
  assert.deepStrictEqual(f.famTodoLines(md), ['Call the landlord', 'Pay the water bill', 'Buy filters']);
  assert.deepStrictEqual(f.famTodoLines('No list here.'), []);
});

test('a shopping list sent to the group goes on its Groceries list, without doubles', () => {
  let n = 0; const id = () => 'n' + (++n);
  const doc = { people: [], lists: [list('g', 'groceries', T)], items: [item('1', 'g', 'Eggs', T)], offers: [], tombstones: [] };
  const r = f.famWithItems(doc, 'Groceries', ['Eggs', 'Rice, 2 lb', 'rice, 2 LB', ''], 'me', T + 5, id);
  assert.strictEqual(r.added, 1);
  assert.deepStrictEqual(r.doc.items.filter(x => x.list === 'g').map(x => x.text), ['Eggs', 'Rice, 2 lb']);
  // no list by that name yet: it's made
  const r2 = f.famWithItems(f.famEmpty(), 'Groceries', ['Milk'], 'me', T, id);
  assert.strictEqual(r2.doc.lists.length, 1);
  assert.strictEqual(r2.doc.lists[0].name, 'Groceries');
  assert.strictEqual(r2.doc.items[0].list, r2.doc.lists[0].id);
});

test('a list sent to one person rides in the note and comes back out as a checklist', () => {
  const note = f.famListNote(['Rice, 2 lb', 'Eggs']);
  assert.strictEqual(note, '- Rice, 2 lb\n- Eggs');
  assert.deepStrictEqual(f.famNoteSplit(note), { subs: ['Rice, 2 lb', 'Eggs'], rest: '' });
  assert.deepStrictEqual(f.famNoteSplit('Pick up after work'), { subs: [], rest: 'Pick up after work' });
  assert.deepStrictEqual(f.famNoteSplit(null), { subs: [], rest: '' });
});

test('a note keeps its line breaks through a merge, and a flattened one still splits', () => {
  const doc = { offers: [{ id: 'o1', from: 'a', to: 'b', title: 'Shopping list', note: '- Rice\r\n- Eggs', created: T, updatedAt: T }] };
  assert.strictEqual(f.famNorm(doc).offers[0].note, '- Rice\n- Eggs');
  assert.deepStrictEqual(f.famNoteSplit('- Rice, 2 lb - Eggs').subs, ['Rice, 2 lb', 'Eggs']);
});
