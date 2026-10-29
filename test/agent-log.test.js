const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tail } = require('../main/agent-log');

test('tail: the last lines with their stamps, the rotated part first when the new file is short', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-'));
  const f = path.join(dir, 'agent-runner.log');
  fs.writeFileSync(f + '.old', '2026-10-27T08:00:00.000Z old one\n2026-10-27T09:00:00.000Z old two\n');
  fs.writeFileSync(f, '2026-10-28T08:00:00.000Z queued: 1 task(s)\nno stamp here\n');
  const all = tail(f, 10);
  assert.deepStrictEqual(all.map((l) => l.text), ['old one', 'old two', 'queued: 1 task(s)', 'no stamp here']);
  assert.strictEqual(all[2].at, Date.parse('2026-10-28T08:00:00.000Z'));
  assert.strictEqual(all[3].at, 0);
  assert.deepStrictEqual(tail(f, 1).map((l) => l.text), ['no stamp here']);
  assert.deepStrictEqual(tail(path.join(dir, 'missing.log')), []);
});
