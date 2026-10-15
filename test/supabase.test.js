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

test('readRow builds the URL and headers', async () => {
  const seen = {};
  const row = await supabase.readRow(a, ':prefs', { select: 'doc,updated_at', fetch: fakeFetch(200, [{ doc: { text: 'hi' } }], seen) });
  assert.strictEqual(seen.url, 'https://x.supabase.co/rest/v1/tasks_sync?sync_key=eq.abc%3Aprefs&select=doc,updated_at');
  assert.deepStrictEqual(seen.opts.headers, { apikey: 'k', Authorization: 'Bearer k' });
  assert.deepStrictEqual(row, { doc: { text: 'hi' } });
});

test('readRow: no row → undefined, HTTP error → throws', async () => {
  assert.strictEqual(await supabase.readRow(a, ':x', { fetch: fakeFetch(200, []) }), undefined);
  await assert.rejects(supabase.readRow(a, ':x', { fetch: fakeFetch(401, { message: 'no' }) }), /HTTP 401/);
});

test('readText falls back to empty on errors', async () => {
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: fakeFetch(200, [{ doc: { text: 'likes tea' } }]) }), 'likes tea');
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: fakeFetch(500, {}) }), '');
  assert.strictEqual(await supabase.readText(a, ':prefs', { fetch: async () => { throw new Error('offline'); } }), '');
});

test('headers merge extras', () => {
  assert.deepStrictEqual(supabase.headers(a, { 'Content-Type': 'application/json' }),
    { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' });
});
