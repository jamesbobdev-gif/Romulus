const test = require('node:test');
const assert = require('node:assert');
const supabase = require('../agent/supabase');

const a = { url: 'https://x.supabase.co/', key: 'k', syncKey: 'abc' };
const fakeFetch = (status, body, seen = {}) => async (url, opts) => {
  seen.url = url; seen.opts = opts;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

test('channel needs url and key', () => {
  assert.strictEqual(supabase.channel({}), null);
  assert.strictEqual(supabase.channel({ sync: { agent: { url: 'u' } } }), null);
  assert.deepStrictEqual(supabase.channel({ sync: { agent: a } }), a);
});

test('with only a personal profile, the agent list lives in the same project under a key made from it', () => {
  const p = { url: 'https://x.supabase.co', key: 'anon', syncKey: 'tk_abc123def456ghi' };
  const c = supabase.channel({ sync: { personal: p } });
  assert.deepStrictEqual(c, { url: p.url, key: 'anon', syncKey: 'tk_agent_abc123def456ghi', derived: true });
  assert.strictEqual(supabase.deriveSyncKey('tk_abc', 'work'), 'tk_work_abc');
  assert.strictEqual(supabase.deriveSyncKey('plainkey', 'school'), 'tk_school_plainkey');
  assert.strictEqual(supabase.deriveSyncKey('', 'school'), '');
  // an agent profile of its own still wins
  assert.deepStrictEqual(supabase.channel({ sync: { personal: p, agent: a } }), a);
});

test('readRow calls sync_get with the key and headers; never the table', async () => {
  const seen = {};
  const row = await supabase.readRow(a, ':prefs', { fetch: fakeFetch(200, [{ doc: { text: 'hi' }, updated_at: 't1', topic: 'sync:abc' }], seen) });
  assert.strictEqual(seen.url, 'https://x.supabase.co/rest/v1/rpc/sync_get');
  assert.strictEqual(seen.opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { p_sync_key: 'abc:prefs' });
  assert.deepStrictEqual(seen.opts.headers, { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' });
  assert.deepStrictEqual(row, { doc: { text: 'hi' }, updated_at: 't1' });
});

test('readRow: no list yet (sync_get answers a null doc) → undefined, HTTP error → throws', async () => {
  assert.strictEqual(await supabase.readRow(a, ':x', { fetch: fakeFetch(200, [{ doc: null, updated_at: null, topic: 'sync:x' }]) }), undefined);
  assert.strictEqual(await supabase.readRow(a, ':x', { fetch: fakeFetch(200, []) }), undefined);
  await assert.rejects(supabase.readRow(a, ':x', { fetch: fakeFetch(401, { message: 'no' }) }), /HTTP 401/);
});

test('readText falls back to empty on errors', async () => {
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: fakeFetch(200, [{ doc: { text: 'likes tea' } }]) }), 'likes tea');
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: fakeFetch(500, {}) }), '');
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: async () => { throw new Error('offline'); } }), '');
});

test('writeRow is a compare-and-swap through sync_put', async () => {
  const seen = {};
  assert.strictEqual(await supabase.writeRow(a, ':prefs', { v: 1, text: 'new' }, 't1', { fetch: fakeFetch(200, true, seen) }), true);
  assert.strictEqual(seen.url, 'https://x.supabase.co/rest/v1/rpc/sync_put');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { p_sync_key: 'abc:prefs', p_doc: { v: 1, text: 'new' }, p_prev: 't1' });
  assert.strictEqual(await supabase.writeRow(a, ':prefs', { v: 1, text: 'new' }, 't1', { fetch: fakeFetch(200, false) }), false); // someone wrote meanwhile
  const made = {};
  await supabase.writeRow(a, ':prefs', { v: 1, text: 'first' }, null, { fetch: fakeFetch(200, true, made) });
  assert.strictEqual(JSON.parse(made.opts.body).p_prev, null); // no row yet: make it
  await assert.rejects(supabase.writeRow(a, ':prefs', {}, null, { fetch: fakeFetch(500, {}) }), /HTTP 500/);
});

test('headers merge extras', () => {
  assert.deepStrictEqual(supabase.headers(a, { 'Content-Type': 'application/json' }),
    { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' });
});
