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

test('wipesTasks: only a full list turning into nothing with no deletions', () => {
  const full = JSON.stringify({ tasks: [{ id: 'a' }] });
  assert.ok(persistence.wipesTasks(full, JSON.stringify({ tasks: [], tombstones: [] })));
  assert.ok(!persistence.wipesTasks(full, JSON.stringify({ tasks: [], tombstones: [{ id: 'a' }] })));
  assert.ok(!persistence.wipesTasks(JSON.stringify({ tasks: [] }), JSON.stringify({ tasks: [], tombstones: [] })));
  assert.ok(!persistence.wipesTasks('not json', JSON.stringify({ tasks: [] })));
});
