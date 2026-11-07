const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../main/store');

// stand-ins for Electron's safeStorage: "encrypts" by reversing the text, so both kinds read each other's
const rev = (s) => s.split('').reverse().join('');
// Electron 46 and later: only the asynchronous calls
const asyncSafe = (opts = {}) => ({
  isAsyncEncryptionAvailable: async () => opts.available !== false,
  encryptStringAsync: async (s) => { if (opts.onEncrypt) opts.onEncrypt(s); return Buffer.from(rev(s)); },
  decryptStringAsync: async (b) => ({ result: rev(b.toString()), shouldReEncrypt: !!opts.reEncrypt }),
});
// Electron 33..45's synchronous calls (what sealed every config.json up to now)
const syncSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(rev(s)),
  decryptString: (b) => rev(b.toString()),
};
const fresh = (safeStorage) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-store-'));
  store.init({ userData: () => dir, safeStorage });
  return dir;
};
const disk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('secrets are sealed on disk and opened on read', async () => {
  const dir = fresh(asyncSafe());
  await store.load();
  await store.writeConfig({ sync: { personal: { url: 'https://x', key: 'secret-key' } }, ai: { geminiKey: 'g' }, theme: 'dark' });
  const d = disk(dir);
  assert.match(d.sync.personal.key, /^enc:v1:/);
  assert.strictEqual(d.sync.personal.url, 'https://x'); // not a secret
  assert.strictEqual(d.theme, 'dark');
  assert.deepStrictEqual(store.readConfig(), { sync: { personal: { url: 'https://x', key: 'secret-key' } }, ai: { geminiKey: 'g' }, theme: 'dark' });
});

test('a read sees a write at once; the file has it after flush, never the secret in the clear', async () => {
  const dir = fresh(asyncSafe());
  await store.load();
  store.writeConfig({ ai: { anthropicKey: 'sk-1' }, theme: 'a' });
  assert.deepStrictEqual(store.readConfig(), { ai: { anthropicKey: 'sk-1' }, theme: 'a' });
  assert.strictEqual(store.writing(), true);
  await store.flush();
  assert.strictEqual(store.writing(), false);
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('sk-1'));
  // a read hands back a copy: changing it doesn't change the config until it's written
  const c = store.readConfig(); c.theme = 'changed';
  assert.strictEqual(store.readConfig().theme, 'a');
});

test('quick writes land in order: the last one is what stays on disk', async () => {
  const dir = fresh(asyncSafe());
  await store.load();
  for (let i = 0; i < 20; i++) store.writeConfig({ n: i, ai: { geminiKey: 'k' + i } });
  await store.flush();
  assert.strictEqual(disk(dir).n, 19);
  store.init({ userData: () => dir, safeStorage: asyncSafe() }); // as after a restart
  await store.load();
  assert.deepStrictEqual(store.readConfig(), { n: 19, ai: { geminiKey: 'k19' } });
});

test('a config.json sealed by the old synchronous calls opens with the asynchronous ones', async () => {
  const dir = fresh(syncSafe);
  await store.writeConfig({ sync: { personal: { key: 'old-key' } }, calAccounts: [{ url: 'https://cal/private', refresh_token: 'rt' }] });
  assert.match(disk(dir).sync.personal.key, /^enc:v1:/);
  store.init({ userData: () => dir, safeStorage: asyncSafe() }); // the next Electron: no synchronous calls
  await store.load();
  assert.deepStrictEqual(store.readConfig(), { sync: { personal: { key: 'old-key' } }, calAccounts: [{ url: 'https://cal/private', refresh_token: 'rt' }] });
});

test('before load() on an Electron without synchronous calls, secrets read as sealed, never as wrong values', async () => {
  const dir = fresh(syncSafe);
  await store.writeConfig({ ai: { openaiKey: 'o' }, theme: 't' });
  store.init({ userData: () => dir, safeStorage: asyncSafe() });
  const early = store.readConfig();
  assert.match(early.ai.openaiKey, /^enc:v1:/);
  assert.strictEqual(early.theme, 't');
  await store.load();
  assert.strictEqual(store.readConfig().ai.openaiKey, 'o');
  // and writing what was read early doesn't seal the sealed text again
  await store.writeConfig(early);
  store.init({ userData: () => dir, safeStorage: asyncSafe() });
  await store.load();
  assert.strictEqual(store.readConfig().ai.openaiKey, 'o');
});

test('load() encrypts secrets still sitting in config.json as plain text', async () => {
  const dir = fresh(asyncSafe());
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ai: { groqKey: 'typed-by-hand' }, theme: 'x' }));
  await store.load();
  assert.match(disk(dir).ai.groqKey, /^enc:v1:/);
  assert.deepStrictEqual(store.readConfig(), { ai: { groqKey: 'typed-by-hand' }, theme: 'x' });
});

test('an unchanged secret is not encrypted again on every write; one the key store asks to redo is', async () => {
  const seen = [];
  fresh(asyncSafe({ onEncrypt: (s) => seen.push(s) }));
  await store.load();
  await store.writeConfig({ ai: { geminiKey: 'same' }, n: 1 });
  await store.writeConfig({ ai: { geminiKey: 'same' }, n: 2 });
  assert.deepStrictEqual(seen, ['same']);
  const seen2 = [];
  const dir = fresh(syncSafe);
  await store.writeConfig({ ai: { geminiKey: 'old' } });
  store.init({ userData: () => dir, safeStorage: asyncSafe({ reEncrypt: true, onEncrypt: (s) => seen2.push(s) }) });
  await store.load();
  await store.writeConfig(store.readConfig());
  assert.deepStrictEqual(seen2, ['old']);
});

test('a change made to config.json by something else is read again', async () => {
  const dir = fresh(asyncSafe());
  await store.load();
  await store.writeConfig({ theme: 'mine' });
  assert.strictEqual(store.readConfig().theme, 'mine');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ theme: 'edited by hand, longer' }));
  assert.strictEqual(store.readConfig().theme, 'edited by hand, longer');
});

test('when Windows can\'t encrypt, secrets are kept as they are (as before)', async () => {
  const dir = fresh(asyncSafe({ available: false }));
  await store.load();
  await store.writeConfig({ ai: { xaiKey: 'x' } });
  assert.strictEqual(disk(dir).ai.xaiKey, 'x');
  assert.strictEqual(await store.sealAsync('whole file'), 'whole file');
});

test('sealAsync/openAsync: a whole file\'s text, round trip', async () => {
  fresh(asyncSafe());
  const sealed = await store.sealAsync('{"vault":1}');
  assert.match(sealed, /^enc:v1:/);
  assert.strictEqual(await store.openAsync(sealed), '{"vault":1}');
  assert.strictEqual(await store.openAsync('plain'), 'plain');
});

test('calAccounts[].url is a secret, url elsewhere is not', () => {
  fresh(syncSafe);
  const sealed = store.mapSecrets({ calAccounts: [{ url: 'https://cal/private' }], site: { url: 'https://a' } }, store.sealValue);
  assert.match(sealed.calAccounts[0].url, /^enc:v1:/);
  assert.strictEqual(sealed.site.url, 'https://a');
});

test('arrays of secrets are sealed item by item; plain values pass through open', async () => {
  fresh(syncSafe);
  const sealed = store.sealValue(['a', 'b']);
  assert.ok(sealed.every((v) => v.startsWith('enc:v1:')));
  assert.deepStrictEqual(store.openValue(sealed), ['a', 'b']);
  assert.strictEqual(store.openValue('plain'), 'plain');
  const dir = fresh(asyncSafe());
  await store.load();
  await store.writeConfig({ calendarFeeds: ['https://f/1', 'https://f/2'] });
  assert.ok(disk(dir).calendarFeeds.every((v) => v.startsWith('enc:v1:')));
  assert.deepStrictEqual(store.readConfig().calendarFeeds, ['https://f/1', 'https://f/2']);
});

test('a broken config.json falls back to the last good copy; nothing at all reads as {}', async () => {
  const dir = fresh(asyncSafe());
  await store.load();
  const file = path.join(dir, 'config.json');
  await store.writeConfig({ theme: 'first' });
  await store.writeConfig({ theme: 'second', ai: { geminiKey: 'g' } }); // the first write is now config.json.bak
  assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).theme, 'first');
  fs.writeFileSync(file, '{not json'); // a crash mid-write, or a stray edit
  assert.deepStrictEqual(store.readConfig(), { theme: 'first' });
  // a write while the file is broken keeps the good .bak rather than copying the broken file over it
  await store.writeConfig({ theme: 'third' });
  assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).theme, 'first');
  assert.deepStrictEqual(store.readConfig(), { theme: 'third' });
  assert.ok(!fs.existsSync(file + '.tmp'));
  fs.unlinkSync(file); fs.unlinkSync(file + '.bak');
  assert.deepStrictEqual(store.readConfig(), {});
});

test('agentLog appends a timestamped line', () => {
  const dir = fresh(syncSafe);
  store.agentLog('hello');
  assert.match(fs.readFileSync(path.join(dir, 'agent-runner.log'), 'utf8'), /^\d{4}-\d\d-\d\dT.* hello\n$/);
});
