// Moving the lists to another Supabase project (renderer/js/sync.js): the setup check before switching, and
// another device following the moved note so nobody has to pair it again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// a stand-in for anything on the page: every property is another stand-in, and calling one returns one
function anything() {
  const fn = function () {};
  return new Proxy(fn, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : anything()), apply: () => anything(), set: () => true });
}
function load() {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder,
    window: {},
    document: anything(),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/sync.js'), 'utf8'), ctx);
  return ctx;
}

const HOSTED = 'https://hostedhostedhostedhost.supabase.co';
const OWN = 'https://ownownownownownownown1.supabase.co';
const KEY = 'tk_26dbc739-a57d-4d40-900d-984640e0415d';

test('a device follows the moved note to the new project, keeping its sync key', () => {
  const c = load();
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(KEY)}, v2: true } });`, c);
  const from = vm.runInContext('syncState.cfg.personal', c);
  assert.ok(c.syncFollowMove(from, { url: OWN, key: 'sb_publishable_own123', v2: false }));
  const cfg = JSON.parse(JSON.stringify(vm.runInContext('syncState.cfg', c)));
  assert.strictEqual(cfg.personal.url, OWN);
  assert.strictEqual(cfg.personal.key, 'sb_publishable_own123');
  assert.strictEqual(cfg.personal.syncKey, KEY);
  assert.ok(!cfg.personal.v2); // the new project has the lists unsealed, as the moving device put them there
  assert.strictEqual(cfg.work.url, OWN); // the lists made from the sync key go along
  assert.ok(cfg.work.derived && !cfg.work.v2);
});

test('a list with its own key on a different project stays where it is', () => {
  const c = load();
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(KEY)} }, work: { url: 'https://office.example.com', key: 'k_office_123', syncKey: 'tk_work_shared_with_a_colleague' } });`, c);
  c.syncFollowMove(vm.runInContext('syncState.cfg.personal', c), { url: OWN, key: 'sb_publishable_own123' });
  const cfg = vm.runInContext('syncState.cfg', c);
  assert.strictEqual(cfg.work.url, 'https://office.example.com');
  assert.strictEqual(cfg.agent.url, OWN);
});

test('a note that is broken or points where the lists already are is ignored', () => {
  const c = load();
  vm.runInContext(`syncState.cfg = normalizeSyncCfg({ personal: { url: ${JSON.stringify(HOSTED)}, key: 'sb_publishable_hosted', syncKey: ${JSON.stringify(KEY)} } });`, c);
  const from = vm.runInContext('syncState.cfg.personal', c);
  for (const m of [null, {}, { url: 'http://insecure.example.com', key: 'sb_publishable_own123' }, { url: OWN, key: 'short' }, { url: HOSTED + '/', key: 'sb_publishable_own123' }]) {
    assert.strictEqual(c.syncFollowMove(from, m), false, JSON.stringify(m));
  }
  assert.strictEqual(vm.runInContext('syncState.cfg.personal.url', c), HOSTED);
});

test('the setup check says what is wrong with a project before switching to it', async () => {
  const c = load();
  const p = { url: OWN, key: 'sb_publishable_own123', syncKey: KEY };
  const answer = (status) => { c.fetch = async () => ({ ok: status === 200, status }); };
  answer(200); assert.strictEqual(await c.syncCheckProject(p), '');
  answer(404); assert.match(await c.syncCheckProject(p), /Copy setup\.sql/);
  answer(401); assert.match(await c.syncCheckProject(p), /publishable key/);
  c.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.match(await c.syncCheckProject(p), /couldn’t reach/);
  answer(500); assert.strictEqual(await c.syncCheckProject(p), ''); // anything else: the normal sync reports it
});
