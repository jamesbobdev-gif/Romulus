const test = require('node:test');
const assert = require('node:assert');
const { backupMake, backupFileName, backupRead, backupSay, backupForRestore } = require('../renderer/js/backup');

const doc = {
  tasks: [
    { id: 'a', title: 'Buy milk', ws: 'personal', updatedAt: 5 },
    { id: 'g', title: 'Group errand', ws: 'family', updatedAt: 5 },
    { id: 'q', title: 'Order groceries', ws: 'agent', status: 'queued', claimedBy: 'pc', updatedAt: 5 },
    { id: 'n', title: 'Asked already', ws: 'agent', status: 'needs-you', note: 'Which store?', updatedAt: 5 },
  ],
  tombstones: [{ id: 'z', deletedAt: 9 }, { id: '', deletedAt: 1 }],
  ideas: { inbox: {}, groups: [], cards: [{ id: 'c1' }, { id: 'c2' }], tombstones: [] },
  hours: { entries: [{ id: 'h1' }], tombstones: [] },
  health: { days: { '2026-11-10': { steps: 8000 } } },
  kitchen: { items: [{ id: 'i1' }], recipes: [], asks: [{ id: 'k1', state: 'waiting' }], tombstones: [] },
};

test('a backup holds the lists, without the Group list or waiting photo asks, and reads back', () => {
  const b = backupMake(doc, 1000, '1.3.18');
  assert.strictEqual(b.kind, 'romulus-backup');
  assert.deepStrictEqual(b.doc.tasks.map((t) => t.id), ['a', 'q', 'n']);
  assert.deepStrictEqual(b.doc.kitchen.asks, []);
  assert.strictEqual(doc.kitchen.asks.length, 1); // the live state is not touched
  const r = backupRead(JSON.stringify(b));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.at, 1000);
  assert.deepStrictEqual(r.doc.tasks.map((t) => t.id), ['a', 'q', 'n']);
  assert.deepStrictEqual(r.doc.tombstones, [{ id: 'z', deletedAt: 9 }]);
  assert.strictEqual(backupSay(r.doc), '3 tasks, 2 notes, 1 hours entry, 1 pantry food, 1 day of health totals');
  assert.strictEqual(backupSay({ tasks: [] }), 'nothing');
});

test('files that are not a backup are refused with why', () => {
  assert.match(backupRead('not json').error, /couldn’t be read/);
  assert.match(backupRead('[1,2]').error, /isn’t a Romulus backup/);
  assert.match(backupRead(JSON.stringify({ tasks: [] })).error, /isn’t a Romulus backup/); // another app's export
  assert.match(backupRead(JSON.stringify({ kind: 'romulus-backup', v: 2, doc: { tasks: [] } })).error, /newer Romulus/);
  // a hand-edited file: entries without an id, and Group tasks, are left out
  const r = backupRead(JSON.stringify({ kind: 'romulus-backup', v: 1, doc: { tasks: [{ title: 'no id' }, null, { id: 'g', ws: 'family' }, { id: 'ok' }] } }));
  assert.deepStrictEqual(r.doc.tasks.map((t) => t.id), ['ok']);
});

test('an Agent task that was waiting to run comes back asking first, unless it is still here', () => {
  const b = backupRead(JSON.stringify(backupMake(doc, 1000))).doc;
  const back = backupForRestore(b, {}, 2000);
  const q = back.find((t) => t.id === 'q');
  assert.strictEqual(q.status, 'needs-you');
  assert.match(q.note, /has not run again/);
  assert.strictEqual(q.claimedBy, undefined);
  assert.strictEqual(back.find((t) => t.id === 'n').note, 'Which store?'); // already asking: as it was
  assert.strictEqual(back.find((t) => t.id === 'a').title, 'Buy milk');
  assert.strictEqual(backupForRestore(b, { q: 1 }, 2000).find((t) => t.id === 'q').status, 'queued'); // here already: the merge keeps the newer copy
  assert.strictEqual(b.tasks.find((t) => t.id === 'q').status, 'queued'); // the read backup is not changed
});

test('the file is named for its day', () => {
  assert.strictEqual(backupFileName(new Date(2026, 10, 3, 12).getTime()), 'Romulus backup 2026-11-03.json');
});
