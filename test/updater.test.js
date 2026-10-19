const test = require('node:test');
const assert = require('node:assert');
const { shouldInstallNow } = require('../main/updater');

test('installs only after 15 idle minutes with no agent work running', () => {
  assert.strictEqual(shouldInstallNow({ idleSec: 20 * 60, busy: false }), true);
  assert.strictEqual(shouldInstallNow({ idleSec: 20 * 60, busy: true }), false);
  assert.strictEqual(shouldInstallNow({ idleSec: 5 * 60, busy: false }), false);
});
