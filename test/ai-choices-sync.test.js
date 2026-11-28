const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ac = require('../agent/ai-choices-sync');
const providers = require('../agent/providers');
const page = require('../renderer/js/shared-settings');

const NOW = Date.UTC(2026, 10, 28, 12);
const [P1, P2, P3] = providers.PROVIDERS; // claude, gemini, openai
const ACCT = P1 + '~2';

test('only choices travel: never a key, a sign-in, an extra account or how ChatGPT is reached', () => {
  const ai = { order: [{ id: P2, on: true }, { id: ACCT, on: true }, { id: P1, on: false }, { id: 'made-up', on: true }],
    claudeModel: 'claude-opus-5-5', geminiModel: 'gemini-pro', openrouterWeb: true, helpers: false,
    anthropicKey: 'sk-ant-secret-secret', geminiKey: 'AIza-secret', openaiKey: 'sk-secret', openrouterKey: 'sk-or-secret',
    openaiVia: 'chatgpt', accounts: [{ id: ACCT, label: 'Work', anthropicKey: 'sk-ant-other' }], codexHome: 'C:/somewhere' };
  const v = ac.pick(ai);
  assert.deepStrictEqual(JSON.parse(v['ai.order']), [{ id: P2, on: true }, { id: P1, on: false }]);
  assert.deepStrictEqual(JSON.parse(v['ai.models']), { claudeModel: 'claude-opus-5-5', geminiModel: 'gemini-pro', helpers: false, openrouterWeb: true });
  const all = JSON.stringify(v);
  for (const secret of ['secret', 'chatgpt', 'Work', 'somewhere', '~2', 'made-up']) assert.ok(!all.includes(secret), secret);
  // a computer where nothing was ever chosen has nothing to say
  assert.deepStrictEqual(ac.pick({ anthropicKey: 'sk-ant-secret-secret' }), { 'ai.order': null, 'ai.models': null });
  assert.deepStrictEqual(ac.pick(undefined), { 'ai.order': null, 'ai.models': null });
});

test('choices from another computer go in around what is this computer’s own', () => {
  const mine = { order: [{ id: P1, on: true }, { id: ACCT, on: true }, { id: P2, on: true }], claudeModel: 'old-model', helpers: true,
    anthropicKey: 'sk-ant-mine', openaiVia: 'key', accounts: [{ id: ACCT, label: 'Work' }] };
  const out = ac.apply(mine, { 'ai.order': JSON.stringify([{ id: P2, on: true }, { id: P1, on: false }, { id: 'made-up', on: true }, { id: P2, on: false }]),
    'ai.models': JSON.stringify({ claudeModel: 'claude-opus-5-5', openrouterWeb: true, geminiModel: 'bad model; rm -rf', anthropicKey: 'sk-ant-theirs', openaiVia: 'chatgpt' }) });
  // the order is theirs, with this computer's extra account still right after its AI
  assert.deepStrictEqual(out.order, [{ id: P2, on: true }, { id: P1, on: false }, { id: ACCT, on: true }]);
  assert.strictEqual(out.claudeModel, 'claude-opus-5-5');
  assert.strictEqual(out.openrouterWeb, true);
  assert.strictEqual('helpers' in out, false, 'a switch they have not set is not set here either');
  assert.strictEqual('geminiModel' in out, false, 'a model name that is not a model name is left out');
  // and nothing of this computer's own was touched or taken from the row
  assert.deepStrictEqual([out.anthropicKey, out.openaiVia, out.accounts], ['sk-ant-mine', 'key', [{ id: ACCT, label: 'Work' }]]);
  // one name coming in leaves the other alone
  assert.deepStrictEqual(ac.apply(mine, { 'ai.models': null }).order, mine.order);
});

// two computers, one pretend row
function world() {
  let row = null, n = 0, writes = 0;
  const supabase = {
    readRow: async (p, sfx) => { assert.strictEqual(sfx, ':settings'); assert.strictEqual(p.syncKey, 'tk_personal'); return row ? { doc: JSON.parse(JSON.stringify(row.doc)), updated_at: row.updated_at } : undefined; },
    writeRow: async (p, sfx, doc, prev) => { if ((row ? row.updated_at : null) !== prev) return false; row = { doc: JSON.parse(JSON.stringify(doc)), updated_at: 't' + (++n) }; writes++; return true; },
  };
  const computer = (ai) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-'));
    const c = { cfg: { sync: { personal: { url: 'https://x.example', key: 'k', syncKey: 'tk_personal' } }, ai }, dir };
    c.sync = (now) => ac.sync({ supabase, readConfig: () => JSON.parse(JSON.stringify(c.cfg)), writeConfig: (x) => { c.cfg = x; }, stamps: path.join(dir, 'ai-choices-sync.json'), now: () => now });
    return c;
  };
  return { supabase, computer, row: () => row, writes: () => writes, setRow: (doc) => { row = { doc, updated_at: 't' + (++n) }; } };
}

test('two computers: the one he set up fills in the one he did not, then a change either way carries over', async () => {
  const w = world();
  const pc = w.computer({ order: [{ id: P2, on: true }, { id: P1, on: true }], claudeModel: 'claude-opus-5-5', anthropicKey: 'sk-ant-pc' });
  const lupa = w.computer({ localOnly: 1 }); // nobody chose anything there
  // Lupa looks first and, having nothing, puts up nothing
  assert.deepStrictEqual(await lupa.sync(NOW), { ok: true, got: [], sent: false });
  assert.strictEqual(w.row(), null);
  assert.deepStrictEqual(await pc.sync(NOW + 1), { ok: true, got: [], sent: true });
  assert.deepStrictEqual(await lupa.sync(NOW + 2), { ok: true, got: ['ai.order', 'ai.models'], sent: false });
  assert.deepStrictEqual(lupa.cfg.ai, { localOnly: 1, order: [{ id: P2, on: true }, { id: P1, on: true }], claudeModel: 'claude-opus-5-5' });
  assert.ok(!JSON.stringify(w.row()).includes('sk-ant'), 'no key in the row');
  // settled: neither writes again
  const n = w.writes();
  await pc.sync(NOW + 3); await lupa.sync(NOW + 4);
  assert.strictEqual(w.writes(), n);
  // he reorders on Lupa: the PC follows; his key there is untouched
  lupa.cfg.ai.order = [{ id: P1, on: true }, { id: P2, on: false }];
  assert.deepStrictEqual(await lupa.sync(NOW + 1000), { ok: true, got: [], sent: true });
  assert.deepStrictEqual(await pc.sync(NOW + 2000), { ok: true, got: ['ai.order'], sent: false });
  assert.deepStrictEqual(pc.cfg.ai.order, [{ id: P1, on: true }, { id: P2, on: false }]);
  assert.strictEqual(pc.cfg.ai.anthropicKey, 'sk-ant-pc');
  // and a model picked on the PC reaches Lupa, without undoing the order
  pc.cfg.ai.claudeModel = 'claude-sonnet-5-5';
  await pc.sync(NOW + 3000);
  assert.deepStrictEqual(await lupa.sync(NOW + 4000), { ok: true, got: ['ai.models'], sent: false });
  assert.strictEqual(lupa.cfg.ai.claudeModel, 'claude-sonnet-5-5');
  assert.deepStrictEqual(lupa.cfg.ai.order, [{ id: P1, on: true }, { id: P2, on: false }]);
  for (const c of [pc, lupa]) fs.rmSync(c.dir, { recursive: true, force: true });
});

test('the page’s own settings in the same row are carried, and the page carries these', async () => {
  const w = world();
  w.setRow({ v: 1, s: { 'tasks.themeMode.v1': { v: 'dark', at: 50 } } });
  const pc = w.computer({ order: [{ id: P3, on: true }] });
  assert.deepStrictEqual(await pc.sync(NOW), { ok: true, got: [], sent: true });
  assert.deepStrictEqual(w.row().doc.s['tasks.themeMode.v1'], { v: 'dark', at: 50 });
  assert.deepStrictEqual(w.row().doc.s['ai.order'], { v: JSON.stringify([{ id: P3, on: true }]), at: 1 });
  // the page merging its own keys leaves the AI choices where they are
  const r = page.sharedMerge(page.sharedNote({}, { 'tasks.themeMode.v1': 'light' }, page.SHARED_KEYS, NOW), w.row().doc, page.SHARED_KEYS);
  assert.deepStrictEqual(r.doc.s['ai.order'], w.row().doc.s['ai.order']);
  for (const k of ac.KEYS) assert.ok(!page.SHARED_KEYS.includes(k), k + ' is not one of the page’s own names');
  fs.rmSync(pc.dir, { recursive: true, force: true });
});

test('a choice this version cannot keep whole is not sent back as if he made it here; trouble is said, not thrown', async () => {
  const w = world();
  w.setRow({ v: 1, s: { 'ai.order': { v: JSON.stringify([{ id: 'an-ai-from-a-newer-version', on: true }, { id: P1, on: true }]), at: NOW } } });
  const old = w.computer({});
  assert.deepStrictEqual(await old.sync(NOW + 1), { ok: true, got: ['ai.order'], sent: false });
  assert.deepStrictEqual(old.cfg.ai.order, [{ id: P1, on: true }]);
  const n = w.writes();
  assert.deepStrictEqual(await old.sync(NOW + 5000), { ok: true, got: [], sent: false });
  assert.strictEqual(w.writes(), n, 'the row still names the newer AI');
  assert.deepStrictEqual(await ac.sync({ supabase: { readRow: async () => { throw new Error('HTTP 500'); } }, readConfig: () => old.cfg, writeConfig() {}, stamps: path.join(old.dir, 'x.json') }), { ok: false, error: 'HTTP 500' });
  assert.deepStrictEqual(await ac.sync({ supabase: w.supabase, readConfig: () => ({}), writeConfig() {}, stamps: 'x' }), { ok: false, error: 'sync isn’t set up on this computer' });
  fs.rmSync(old.dir, { recursive: true, force: true });
});
