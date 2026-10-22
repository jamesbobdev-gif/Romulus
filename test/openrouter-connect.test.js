const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const or = require('../agent/openrouter-connect');

test('PKCE: the challenge is the S256 of the verifier, both URL-safe', () => {
  const { verifier, challenge } = or.pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const want = crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(challenge, want);
  assert.notStrictEqual(or.pkce().verifier, verifier);
});

test('the sign-in link carries the callback and the challenge', () => {
  const u = new URL(or.authUrl('http://127.0.0.1:4321/callback', 'abc'));
  assert.strictEqual(u.origin + u.pathname, or.AUTH_URL);
  assert.strictEqual(u.searchParams.get('callback_url'), 'http://127.0.0.1:4321/callback');
  assert.strictEqual(u.searchParams.get('code_challenge'), 'abc');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
});

test('the code and verifier are swapped for a key; errors say why', async () => {
  let sent;
  const f = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ key: 'sk-or-v1-test' }) }; };
  assert.strictEqual(await or.exchange('code1', 'ver1', f), 'sk-or-v1-test');
  assert.strictEqual(sent.url, or.KEYS_URL);
  assert.deepStrictEqual(sent.body, { code: 'code1', code_verifier: 'ver1', code_challenge_method: 'S256' });
  const bad = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'bad code' } }) });
  await assert.rejects(or.exchange('x', 'y', bad), /bad code/);
});

test('the whole flow: browser comes back to the local port with a code, the key is saved', async () => {
  const f = async (url, opts) => ({ ok: true, json: async () => ({ key: 'sk-or-v1-' + JSON.parse(opts.body).code }) });
  const r = await or.connect({ fetch: f, openExternal: async (link) => {
    const cb = new URL(link).searchParams.get('callback_url');
    const res = await fetch(cb + '?code=abc123');
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Connected/);
  } });
  assert.deepStrictEqual(r, { ok: true, key: 'sk-or-v1-abc123' });
});

test('no code from the browser is reported, not saved', async () => {
  const r = await or.connect({ timeoutMs: 500, openExternal: async (link) => {
    const cb = new URL(link).searchParams.get('callback_url');
    const res = await fetch(cb);
    assert.strictEqual(res.status, 400);
  } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /5 minutes|no answer/);
});
