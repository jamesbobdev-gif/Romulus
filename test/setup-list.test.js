// Settings → Get set up: the phone row (renderer/js/setup-list.js) and the download QR behind it (main/device-sync.js)
const test = require('node:test');
const assert = require('node:assert');
const setup = require('../renderer/js/setup-list.js');
const deviceSync = require('../main/device-sync');

test('the phone row is done once a phone is among the synced devices', () => {
  assert.strictEqual(setup.setupHasPhone(null), false);
  assert.strictEqual(setup.setupHasPhone({}), false);
  assert.strictEqual(setup.setupHasPhone({ devices: {} }), false);
  assert.strictEqual(setup.setupHasPhone({ devices: { d_1: { name: 'Desk', kind: 'computer' }, d_2: { name: 'Tab', kind: 'browser' }, d_3: null } }), false);
  assert.strictEqual(setup.setupHasPhone({ devices: { d_1: { name: 'Desk', kind: 'computer' }, d_2: { name: 'Pixel', kind: 'phone', os: 'Android' } } }), true);
});

test('the computer draws a QR for the phone app’s download page, and for no other web address', async () => {
  const qr = deviceSync.handlers['sync:qr'];
  assert.strictEqual(setup.SETUP_PHONE_URL, deviceSync.PHONE_APP_URL);
  const r = await qr(null, setup.SETUP_PHONE_URL);
  assert.ok(r.ok && /<svg/.test(r.svg));
  for (const bad of [setup.SETUP_PHONE_URL + '/x', setup.SETUP_PHONE_URL.replace('romulus-releases', 'other'), 'https://github.com/']) assert.strictEqual((await qr(null, bad)).ok, false, bad);
});
