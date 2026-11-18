// scripts/audit-gate.js: only the listed advisories are let through; every other high or critical one blocks.
const test = require('node:test');
const assert = require('node:assert');
const { blockingAdvisories } = require('../scripts/audit-gate.js');

const adv = (name, severity, id) => ({ name, severity, title: name + ' problem', url: 'https://github.com/advisories/' + id });
const report = { vulnerabilities: {
  picomatch: { via: [adv('picomatch', 'high', 'GHSA-aaaa')] },
  tinyglobby: { via: ['picomatch'] },
  minimatch: { via: [adv('minimatch', 'moderate', 'GHSA-bbbb')] },
  other: { via: [adv('other', 'critical', 'GHSA-cccc')] },
} };

test('allowed advisory is marked allowed, others block, moderate ignored', () => {
  const found = blockingAdvisories(report, { 'GHSA-aaaa': 'reason' });
  assert.deepStrictEqual(found.map(a => [a.id, a.allowed]), [['GHSA-aaaa', true], ['GHSA-cccc', false]]);
});

test('nothing allowed means every high or critical blocks', () => {
  assert.strictEqual(blockingAdvisories(report, {}).filter(a => !a.allowed).length, 2);
});

test('empty report has nothing', () => {
  assert.deepStrictEqual(blockingAdvisories({}, {}), []);
});
