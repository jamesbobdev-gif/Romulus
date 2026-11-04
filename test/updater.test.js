const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const updater = require('../main/updater');
const { shouldInstallNow, mode, onAvailable } = updater;

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

test('an Update said on any device covers that version and older ones', () => {
  assert.strictEqual(onAvailable('1.0.9', { updateYes: '1.0.9' }), 'download');
  assert.strictEqual(onAvailable('1.0.8', { updateYes: '1.0.10' }), 'offer'); // a yes names one version: a shared yes of "999" can't approve every release
  assert.strictEqual(onAvailable('1.0.10', { updateYes: '1.0.9' }), 'offer');
  assert.strictEqual(onAvailable('1.0.9', { updateYes: '1.0.9', updateSkip: '1.0.9' }), 'download');
});

test('the answer from another device is remembered here', () => {
  let cfg = { updateYes: '1.0.9' };
  updater.init({ readConfig: () => Object.assign({}, cfg), writeConfig: (c) => { cfg = c; }, version: '1.0.8', agentLog: () => {} });
  updater.shared({ yes: '1.0.8', no: '1.0.11' });
  assert.deepStrictEqual(cfg, { updateYes: '1.0.9', updateSkip: '1.0.11' }); // an older yes doesn't replace a newer one
  updater.shared({ yes: '1.0.10' });
  assert.strictEqual(cfg.updateYes, '1.0.10');
  assert.strictEqual(updater.shared(null).state, 'none');
});

// renderer/js/update-sync.js, with the sync functions it uses stood in for
function loadShared(row) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'update-sync.js'), 'utf8');
  const box = { row, pushes: 0 };
  const sandbox = {
    syncState: { cfg: { personal: { url: 'u', key: 'k', syncKey: 'tk_abc' } } },
    validProfile: (p) => !!(p && p.url && p.key && p.syncKey),
    syncPullRow: async (p) => { box.key = p.syncKey; return { doc: box.row, updatedAt: 't' }; },
    syncPushCas: async (_p, doc) => { box.row = doc; box.pushes++; return true; },
  };
  vm.runInNewContext(src + '\nthis.api={versionNewer,updateAnswer,updateChoiceRead,updateChoiceWrite};', sandbox);
  return Object.assign(sandbox.api, { box });
}

test('the shared answer: a yes covers older versions, a Not now only its own', () => {
  const { updateAnswer, versionNewer } = loadShared(null);
  assert.strictEqual(versionNewer('1.0.10', '1.0.9'), true);
  assert.strictEqual(updateAnswer({ yes: '1.0.9' }, '1.0.9'), 'yes');
  assert.strictEqual(updateAnswer({ yes: '1.0.9' }, '1.0.10'), null);
  assert.strictEqual(updateAnswer({ no: '1.0.9' }, '1.0.9'), 'no');
  assert.strictEqual(updateAnswer({ no: '1.0.9' }, '1.0.10'), null);
  assert.strictEqual(updateAnswer({ yes: '1.0.9', no: '1.0.9' }, '1.0.9'), 'yes');
  assert.strictEqual(updateAnswer(null, '1.0.9'), null);
});

test('saying Update or Not now writes the shared row next to the personal list', async () => {
  const s = loadShared(null);
  assert.strictEqual(await s.updateChoiceWrite('no', '1.0.9'), true);
  assert.strictEqual(s.box.key, 'tk_abc:updates');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.box.row)), { v: 1, yes: null, no: '1.0.9' });
  await s.updateChoiceWrite('yes', '1.0.9'); // a yes after a Not now (here or elsewhere) wins
  assert.strictEqual(s.box.row.yes, '1.0.9');
  const pushes = s.box.pushes;
  await s.updateChoiceWrite('no', '1.0.9'); // and a later Not now doesn't take it back
  await s.updateChoiceWrite('yes', '1.0.8'); // nor an older yes
  assert.strictEqual(s.box.pushes, pushes);
  assert.strictEqual(s.box.row.yes, '1.0.9');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await s.updateChoiceRead())), { v: 1, yes: '1.0.9', no: '1.0.9' });
});
