/* The tasks file (main/persistence.js): a read error is not a first run, and a save never empties the file. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const persistence = require('../main/persistence');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-persist-'));
const file = path.join(tmp, 'tasks.json');
const calls = [];
persistence.init({ dataFile: () => file, refreshTrayStatus: () => calls.push('tray'), scheduleAgentRun: () => {}, scheduleLocalRun: () => {}, serverWork: () => false });
const load = () => persistence.handlers['tasks:load']({});
const save = (doc) => persistence.handlers['tasks:save']({}, JSON.stringify(doc));

test('load: no file is a first run (null); a file that cannot be read throws instead', async () => {
  assert.strictEqual(await load(), null);
  fs.mkdirSync(file); // a directory where the file should be: EISDIR every time
  await assert.rejects(load, /could not read tasks\.json/);
  fs.rmdirSync(file);
});

test('save: keeps the last good copy, and refuses to write an empty list over a full one', async () => {
  const full = { v: 1, tasks: [{ id: 'a', title: 'one' }], tombstones: [] };
  assert.strictEqual(await save(full), true);
  assert.strictEqual(JSON.parse(await load()).tasks.length, 1);
  // a page that never loaded the file (its list is empty, nothing was deleted) must not win
  assert.strictEqual(await save({ v: 1, tasks: [], tombstones: [] }), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 1);
  // deleting the last task leaves a tombstone: that save is real
  assert.strictEqual(await save({ v: 1, tasks: [], tombstones: [{ id: 'a', at: 1 }] }), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).tasks.length, 1, 'the .bak holds the version before');
});

test('load: a damaged or missing file falls back to .bak, then the newest daily copy, and says so', async () => {
  const doc = (n) => JSON.stringify({ v: 1, tasks: Array.from({ length: n }, (_, i) => ({ id: 'x' + i })), tombstones: [] });
  fs.rmSync(path.join(tmp, 'backups'), { recursive: true, force: true }); // today's copy from the saves above
  fs.writeFileSync(file, doc(3));
  fs.writeFileSync(file + '.bak', doc(2));
  assert.strictEqual(JSON.parse(await load()).tasks.length, 3);
  assert.strictEqual(await persistence.handlers['tasks:restored'](), null, 'a good file restores nothing');
  fs.writeFileSync(file, '{"v":1,"tasks":[{"id":'); // cut off mid-write
  assert.strictEqual(JSON.parse(await load()).tasks.length, 2);
  assert.strictEqual(await persistence.handlers['tasks:restored'](), 'tasks.json.bak');
  fs.unlinkSync(file + '.bak');
  fs.unlinkSync(file);
  persistence.dailyCopy(file, doc(5), new Date(2026, 9, 29));
  assert.strictEqual(JSON.parse(await load()).tasks.length, 5, 'no file and no .bak, but a daily copy: not a first run');
  assert.strictEqual(await persistence.handlers['tasks:restored'](), 'tasks-2026-10-29.json');
  fs.rmSync(path.join(tmp, 'backups'), { recursive: true });
  assert.strictEqual(await load(), null, 'nothing at all is a first run');
});

test('dailyCopy: one a day, the newest DAILY_KEEP kept', () => {
  const dir = path.join(tmp, 'backups');
  fs.rmSync(dir, { recursive: true, force: true });
  for (let d = 1; d <= 10; d++) persistence.dailyCopy(file, JSON.stringify({ tasks: [{ id: 'd' + d }] }), new Date(2026, 9, d));
  persistence.dailyCopy(file, JSON.stringify({ tasks: [] }), new Date(2026, 9, 10, 23)); // same day again: the first copy stays
  const names = fs.readdirSync(dir).sort();
  assert.strictEqual(names.length, persistence.DAILY_KEEP);
  assert.strictEqual(names[0], 'tasks-2026-10-04.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'tasks-2026-10-10.json'), 'utf8')).tasks[0].id, 'd10');
  fs.rmSync(dir, { recursive: true });
});

test('wipesTasks: only a full list turning into nothing with no deletions', () => {
  const full = JSON.stringify({ tasks: [{ id: 'a' }] });
  assert.ok(persistence.wipesTasks(full, JSON.stringify({ tasks: [], tombstones: [] })));
  assert.ok(!persistence.wipesTasks(full, JSON.stringify({ tasks: [], tombstones: [{ id: 'a' }] })));
  assert.ok(!persistence.wipesTasks(JSON.stringify({ tasks: [] }), JSON.stringify({ tasks: [], tombstones: [] })));
  assert.ok(!persistence.wipesTasks('not json', JSON.stringify({ tasks: [] })));
});
