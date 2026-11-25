const test = require('node:test');
const assert = require('node:assert');
const { blockingAdvisories, judge } = require('../scripts/audit-gate');

const report = { vulnerabilities: {
  picomatch: { severity: 'high', via: [{ source: 1, title: 'ReDoS', severity: 'high', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf' }] },
  'app-builder-lib': { severity: 'high', via: ['picomatch'] }, // only through another package: counted once, at its source
  minimatch: { severity: 'moderate', via: [{ severity: 'moderate', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249' }] },
  evil: { severity: 'critical', via: [{ severity: 'critical', title: 'Code injection', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
} };

test('only high and critical advisories count, each once', () => {
  assert.deepStrictEqual(blockingAdvisories(report).map((a) => a.id), ['GHSA-fc5q-39xc-vjpf', 'GHSA-aaaa-bbbb-cccc']);
});

test('a listed advisory is let through until its date; a new one blocks', () => {
  const allow = [{ id: 'GHSA-fc5q-39xc-vjpf', reason: 'build only', until: '2027-01-31' }];
  const r = judge(blockingAdvisories(report), allow, '2026-11-18');
  assert.deepStrictEqual(r.allowed.map((a) => a.id), ['GHSA-fc5q-39xc-vjpf']);
  assert.deepStrictEqual(r.blocked.map((a) => a.id), ['GHSA-aaaa-bbbb-cccc']);
});

test('an allowance past its date blocks again', () => {
  const r = judge(blockingAdvisories(report), [{ id: 'GHSA-fc5q-39xc-vjpf', until: '2026-11-01' }], '2026-11-18');
  assert.deepStrictEqual(r.expired.map((a) => a.id), ['GHSA-fc5q-39xc-vjpf']);
  assert.strictEqual(judge([{ id: 'GHSA-x', severity: 'high' }], [{ id: 'GHSA-x' }], '2026-11-18').expired.length, 1, 'no date = not allowed');
});

test('the allow list in the repository is well formed', () => {
  const list = require('../scripts/audit-allow.json');
  for (const a of list) {
    assert.match(a.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    assert.match(a.until, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(a.reason && a.reason.length > 10);
  }
});
