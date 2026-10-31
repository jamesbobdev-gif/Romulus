/* End-to-end encrypted sync: the page seals and opens rows with WebCrypto (renderer/js/sync-crypto.js) and the
   computer's agent side with Node's crypto (agent/sync-crypto.js). These load the page script as it ships and
   prove both sides make the same lookup ids and open each other's rows. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const node = require('../agent/sync-crypto');
const supabase = require('../agent/supabase');

// the page script in a sandbox with the browser globals it uses
const page = (() => {
  const ctx = { window: {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Uint8Array, Map, Promise, JSON };
  ctx.window.crypto = globalThis.crypto;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/sync-crypto.js'), 'utf8')
    + '\n;this.api={syncV2RowKey,syncSeal,syncOpen,syncIsSealed,syncSplitKey,syncCryptoOk};', ctx);
  return ctx.api;
})();

const KEY = 'tk_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
const AGENT = 'tk_agent_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
const DOC = { v: 1, tasks: [{ id: 'a1', title: 'Call the dentist about the crown — Zürich 東京', updatedAt: 1 }], tombstones: [] };
// what the database accepts as a key (supabase/setup.sql sync_put)
const SHAPE = /^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours))?$/;

test('both sides make the same lookup id, in a shape the database takes, and it gives nothing away', async () => {
  for (const k of [KEY, AGENT, KEY + ':ideas', AGENT + ':locked']) {
    const id = node.rowKey(k);
    assert.strictEqual(await page.syncV2RowKey(k), id);
    assert.match(id, SHAPE);
    assert.ok(!id.includes('6f1d2c3b'), 'the sync key is not in the lookup id');
  }
  assert.match(node.rowKey(AGENT), /^tk_agent_/); // the list stays recognisable
  assert.match(node.rowKey(KEY + ':prefs'), /:prefs$/);
});

test('lists made from one sync key share the id part, so they stay one account', () => {
  const id = (k) => node.rowKey(k).replace(/^tk_(work_|agent_|school_)?/, '');
  assert.strictEqual(id(KEY), id(AGENT));
  assert.strictEqual(id(KEY), id('tk_work_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c'));
  assert.notStrictEqual(id(KEY), id('tk_0000000-1111-2222-3333-444444444444'));
});

test('the page seals, Node opens; Node seals, the page opens', async () => {
  const fromPage = await page.syncSeal(KEY, DOC);
  assert.deepStrictEqual(Object.keys(fromPage).sort(), ['ct', 'e', 'iv']);
  assert.ok(!JSON.stringify(fromPage).includes('dentist'));
  assert.deepStrictEqual(node.open(KEY, fromPage), DOC);
  const fromNode = node.seal(KEY, DOC);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await page.syncOpen(KEY, fromNode))), DOC);
  assert.ok(node.isSealed(fromNode) && page.syncIsSealed(fromNode));
  assert.ok(!node.isSealed(DOC));
  // a side row uses its list's key: sealed as tk_…:ideas, opened as tk_…:ideas or tk_…
  assert.deepStrictEqual(node.open(KEY, node.seal(KEY + ':ideas', DOC)), DOC);
});

test('each list has its own content key, and a changed row does not open', async () => {
  const sealed = node.seal(KEY, DOC);
  assert.throws(() => node.open(AGENT, sealed));
  await assert.rejects(page.syncOpen(AGENT, sealed));
  const ct = Buffer.from(sealed.ct, 'base64'); ct[0] ^= 1;
  assert.throws(() => node.open(KEY, Object.assign({}, sealed, { ct: ct.toString('base64') })));
  // the same document never seals the same way twice
  assert.notStrictEqual(node.seal(KEY, DOC).ct, node.seal(KEY, DOC).ct);
});

test('readRow and writeRow on a v2 channel: lookup id on the wire, sealed out, opened in', async () => {
  const a = { url: 'https://x.supabase.co', key: 'k', syncKey: AGENT, v2: true };
  const sent = [];
  const fakeFetch = (reply) => async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => reply }; };
  assert.strictEqual(await supabase.writeRow(a, ':prefs', { v: 1, text: 'likes window seats' }, null, { fetch: fakeFetch(true) }), true);
  const w = sent.pop();
  assert.strictEqual(w.p_sync_key, node.rowKey(AGENT + ':prefs'));
  assert.ok(node.isSealed(w.p_doc) && !JSON.stringify(w).includes('window seats'));
  const row = await supabase.readRow(a, ':prefs', { fetch: fakeFetch([{ doc: w.p_doc, updated_at: 't9' }]) });
  assert.strictEqual(sent.pop().p_sync_key, node.rowKey(AGENT + ':prefs'));
  assert.deepStrictEqual(row, { doc: { v: 1, text: 'likes window seats' }, updated_at: 't9' });
  assert.strictEqual(supabase.docText(a.syncKey, row.doc), 'likes window seats');
  // a plain row where a sealed one should be is refused, not used
  await assert.rejects(supabase.readRow(a, ':routing', { fetch: fakeFetch([{ doc: { v: 1, text: 'x' }, updated_at: 't1' }]) }));
});

test('a personal profile with v2 hands it to the agent channel made from it', () => {
  const p = { url: 'https://x.supabase.co', key: 'anon', syncKey: KEY, v2: true };
  assert.strictEqual(supabase.channel({ sync: { personal: p } }).v2, true);
  assert.strictEqual(supabase.channel({ sync: { personal: Object.assign({}, p, { v2: false }) } }).v2, undefined);
});
