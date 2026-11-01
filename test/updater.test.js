const test = require('node:test');
const assert = require('node:assert');
const { shouldInstallNow, mode, onAvailable } = require('../main/updater');

test('installs only after 15 idle minutes with no agent work running', () => {
  assert.strictEqual(shouldInstallNow({ idleSec: 20 * 60, busy: false }), true);
  assert.strictEqual(shouldInstallNow({ idleSec: 20 * 60, busy: true }), false);
  assert.strictEqual(shouldInstallNow({ idleSec: 5 * 60, busy: false }), false);
});

test('asks before updating unless Settings says automatically', () => {
  assert.strictEqual(mode({}), 'ask');
  assert.strictEqual(mode(null), 'ask');
  assert.strictEqual(mode({ updates: 'auto' }), 'auto');
  assert.strictEqual(onAvailable('1.0.9', {}), 'offer');
  assert.strictEqual(onAvailable('1.0.9', { updates: 'auto' }), 'download');
});

test('Not now skips that version only', () => {
  assert.strictEqual(onAvailable('1.0.9', { updateSkip: '1.0.9' }), 'skip');
  assert.strictEqual(onAvailable('1.0.10', { updateSkip: '1.0.9' }), 'offer');
  assert.strictEqual(onAvailable('1.0.9', { updates: 'auto', updateSkip: '1.0.9' }), 'download');
});
