const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateUserData } = require('../main/migrate-data');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'romulus-migrate-')); }
function seed(dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tasks.json'), '{"v":1,"tasks":[{"id":"a"}]}'); fs.writeFileSync(path.join(dir, 'config.json'), '{"k":1}'); }

test('copies the old Tasks folder to the new Romulus folder on first run, keeping the old one', () => {
  const root = tmp(); const oldDir = path.join(root, 'Tasks'); const newDir = path.join(root, 'Romulus');
  seed(oldDir);
  const r = migrateUserData(oldDir, newDir);
  assert.strictEqual(r.moved, true);
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'tasks.json'), 'utf8'), '{"v":1,"tasks":[{"id":"a"}]}');
  assert.ok(fs.existsSync(path.join(newDir, 'config.json')));
  assert.ok(fs.existsSync(path.join(oldDir, 'tasks.json')), 'the old folder is left as a backup');
  fs.rmSync(root, { recursive: true, force: true });
});

test('copies into a new folder Electron already created: its own files stay, the old ones win', () => {
  const root = tmp(); const oldDir = path.join(root, 'Tasks'); const newDir = path.join(root, 'Romulus');
  seed(oldDir); fs.writeFileSync(path.join(oldDir, 'Local State'), 'OLD KEY');
  fs.mkdirSync(newDir); fs.writeFileSync(path.join(newDir, 'Preferences'), 'chromium');
  fs.writeFileSync(path.join(newDir, 'Local State'), 'NEW KEY'); fs.writeFileSync(path.join(newDir, 'config.json'), '{}'); // a launch that started empty
  const r = migrateUserData(oldDir, newDir);
  assert.strictEqual(r.how, 'copied');
  assert.ok(fs.existsSync(path.join(newDir, 'tasks.json')));
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'Preferences'), 'utf8'), 'chromium');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'Local State'), 'utf8'), 'OLD KEY', 'the key that opens the sealed data');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8'), '{"k":1}');
  assert.ok(fs.existsSync(path.join(oldDir, 'tasks.json')), 'the old folder is left as a backup');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file in use is skipped, the rest still comes, and tasks.json marks it done', () => {
  const root = tmp(); const oldDir = path.join(root, 'Tasks'); const newDir = path.join(root, 'Romulus');
  seed(oldDir);
  const prof = path.join(oldDir, 'agent-browser', 'profile', 'Default');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'Network'), 'locked'); fs.writeFileSync(path.join(prof, 'Cookies'), 'c');
  fs.writeFileSync(path.join(oldDir, 'finance.vault'), 'vault');
  const order = [];
  const fsx = Object.assign({}, fs, { copyFileSync: (s, d) => {
    order.push(path.basename(s));
    if (path.basename(s) === 'Network') throw Object.assign(new Error('EBUSY: in use'), { code: 'EBUSY' });
    return fs.copyFileSync(s, d);
  } });
  const r = migrateUserData(oldDir, newDir, fsx);
  assert.deepStrictEqual([r.moved, r.skipped], [true, 1]);
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'finance.vault'), 'utf8'), 'vault');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'agent-browser', 'profile', 'Default', 'Cookies'), 'utf8'), 'c');
  assert.strictEqual(order[order.length - 1], 'tasks.json', 'the marker goes last');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tasks.json itself failing leaves no marker, so the next launch copies again', () => {
  const root = tmp(); const oldDir = path.join(root, 'Tasks'); const newDir = path.join(root, 'Romulus');
  seed(oldDir);
  const fsx = Object.assign({}, fs, { copyFileSync: (s, d) => { if (path.basename(s) === 'tasks.json') throw new Error('EBUSY'); return fs.copyFileSync(s, d); } });
  assert.throws(() => migrateUserData(oldDir, newDir, fsx));
  assert.ok(!fs.existsSync(path.join(newDir, 'tasks.json')));
  assert.strictEqual(migrateUserData(oldDir, newDir).moved, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('does nothing when there is nothing old, or the new folder already has data', () => {
  const root = tmp(); const oldDir = path.join(root, 'Tasks'); const newDir = path.join(root, 'Romulus');
  assert.strictEqual(migrateUserData(oldDir, newDir).moved, false);
  seed(oldDir); seed(newDir); fs.writeFileSync(path.join(newDir, 'tasks.json'), 'NEW');
  assert.strictEqual(migrateUserData(oldDir, newDir).reason, 'already migrated');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'tasks.json'), 'utf8'), 'NEW');
  assert.strictEqual(migrateUserData(oldDir, oldDir).reason, 'same folder');
  fs.rmSync(root, { recursive: true, force: true });
});
