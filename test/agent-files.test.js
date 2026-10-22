const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../agent/agent-files');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-files-'));
const dir = files.dirFor(tmp);
const src = path.join(tmp, 'My Resume (2026).pdf');
fs.writeFileSync(src, '%PDF-1.4 test');

test('add copies the file in, list shows it with its path, remove takes it out', () => {
  assert.deepStrictEqual(files.list(dir), []); // no folder yet
  const r = files.add(dir, src);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.file.name, 'My Resume (2026).pdf');
  const l = files.list(dir);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].path, path.join(dir, 'My Resume (2026).pdf'));
  assert.ok(l[0].size > 0);
  assert.match(files.brief(l), /^- My Resume \(2026\)\.pdf → .*My Resume \(2026\)\.pdf$/);
  assert.ok(files.remove(dir, 'My Resume (2026).pdf').ok);
  assert.deepStrictEqual(files.list(dir), []);
  assert.ok(!files.remove(dir, 'My Resume (2026).pdf').ok);
});

test('documents only, nothing hidden in a name, nothing huge', () => {
  const exe = path.join(tmp, 'setup.exe'); fs.writeFileSync(exe, 'x');
  assert.match(files.add(dir, exe).error, /PDF, Word/);
  assert.match(files.add(dir, path.join(tmp, 'missing.pdf')).error, /could not read/);
  assert.ok(!/[\\/]/.test(files.safeName('../../etc/passwd.pdf')));
  assert.ok(!files.remove(dir, '../package.json').ok);
  const big = path.join(tmp, 'big.pdf'); fs.writeFileSync(big, Buffer.alloc(files.MAX_BYTES + 1));
  assert.match(files.add(dir, big).error, /too big/);
});
