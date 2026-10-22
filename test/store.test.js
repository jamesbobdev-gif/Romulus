const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../main/store');

// stands in for Electron's safeStorage: "encrypts" by reversing the text
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (b) => b.toString().split('').reverse().join(''),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-store-'));
store.init({ userData: () => dir, safeStorage: fakeSafe });

test('secrets are sealed on disk and opened on read', () => {
  store.writeConfig({ sync: { personal: { url: 'https://x', key: 'secret-key' } }, ai: { geminiKey: 'g' }, theme: 'dark' });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.match(disk.sync.personal.key, /^enc:v1:/);
  assert.strictEqual(disk.sync.personal.url, 'https://x'); // not a secret
  assert.strictEqual(disk.theme, 'dark');
  assert.deepStrictEqual(store.readConfig(), { sync: { personal: { url: 'https://x', key: 'secret-key' } }, ai: { geminiKey: 'g' }, theme: 'dark' });
});

test('calAccounts[].url is a secret, url elsewhere is not', () => {
  const sealed = store.mapSecrets({ calAccounts: [{ url: 'https://cal/private' }], site: { url: 'https://a' } }, store.sealValue);
  assert.match(sealed.calAccounts[0].url, /^enc:v1:/);
  assert.strictEqual(sealed.site.url, 'https://a');
});

test('arrays of secrets are sealed item by item; plain values pass through open', () => {
  const sealed = store.sealValue(['a', 'b']);
  assert.ok(sealed.every((v) => v.startsWith('enc:v1:')));
  assert.deepStrictEqual(store.openValue(sealed), ['a', 'b']);
  assert.strictEqual(store.openValue('plain'), 'plain');
});

test('a missing or broken config reads as {}', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), '{not json');
  assert.deepStrictEqual(store.readConfig(), {});
});

test('agentLog appends a timestamped line', () => {
  store.agentLog('hello');
  assert.match(fs.readFileSync(path.join(dir, 'agent-runner.log'), 'utf8'), /^\d{4}-\d\d-\d\dT.* hello\n$/);
});
