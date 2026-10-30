const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// the phone's update check, loaded with no Capacitor so only the pure helpers run
function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'update-phone.js'), 'utf8');
  const window = {};
  vm.runInNewContext(src, { window, document: {}, setTimeout, localStorage: {} });
  return window.phoneUpdate;
}

test('isNewer compares versions numerically, ignoring a leading v', () => {
  const { isNewer } = load();
  assert.equal(isNewer('1.0.5', '1.0.4'), true);
  assert.equal(isNewer('v1.0.5', '1.0.4'), true);
  assert.equal(isNewer('1.0.10', '1.0.9'), true);
  assert.equal(isNewer('1.0.4', '1.0.4'), false);
  assert.equal(isNewer('1.0.3', '1.0.4'), false);
  assert.equal(isNewer('2.0', '1.9.9'), true);
  assert.equal(isNewer('garbage', '1.0.4'), false);
});

test("pickRelease finds the APK among a release's files", () => {
  const { pickRelease } = load();
  const rel = pickRelease({ tag_name: 'v1.0.5', html_url: 'https://x/releases/tag/v1.0.5', assets: [
    { name: 'Romulus-Setup-1.0.5.exe', browser_download_url: 'https://x/exe' },
    { name: 'Romulus-1.0.5.apk', browser_download_url: 'https://x/apk' }
  ] });
  assert.deepEqual(rel, { version: '1.0.5', apkUrl: 'https://x/apk', page: 'https://x/releases/tag/v1.0.5' });
  assert.equal(pickRelease({ tag_name: 'v1.0.5', assets: [] }).apkUrl, null);
  assert.equal(pickRelease(null), null);
});

// with Capacitor present: does the check get as far as scheduling itself?
function scheduled(store) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'update-phone.js'), 'utf8');
  const window = { ROMULUS_VERSION: '1.0.5', ROMULUS_RELEASES: 'o/r', ROMULUS_STORE: store,
    Capacitor: { isNativePlatform: () => true } };
  let timers = 0;
  vm.runInNewContext(src, { window, document: { readyState: 'complete', addEventListener() {} },
    setTimeout: () => { timers++; }, localStorage: {} });
  return timers > 0;
}

test('only the APK from the releases page checks for updates; the Google Play build leaves that to Play', () => {
  assert.equal(scheduled('github'), true);
  assert.equal(scheduled('play'), false);
  assert.equal(scheduled(undefined), false);
});
