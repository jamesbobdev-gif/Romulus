const test = require('node:test');
const assert = require('node:assert');
const pair = require('../renderer/js/pair');

test('a pairing code is 12 characters of the 32-letter alphabet, new every time', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = pair.pairNewCode();
    assert.strictEqual(c.length, pair.PAIR_LEN);
    for (const ch of c) assert.ok(pair.PAIR_ALPHABET.includes(ch), ch);
    seen.add(c);
  }
  assert.strictEqual(seen.size, 200);
  assert.strictEqual(pair.pairFormat('K7QM4XR9PB2T'), 'K7QM-4XR9-PB2T');
});

test('what he types is read the forgiving way, and anything else is refused', () => {
  assert.strictEqual(pair.pairNormalize(' k7qm-4xr9 pb2t '), 'K7QM4XR9PB2T');
  assert.strictEqual(pair.pairNormalize('KOQM-4XR9-PB2T'), 'K0QM4XR9PB2T'); // O is 0
  assert.strictEqual(pair.pairNormalize('KIQM-4XL9-PB2T'), 'K1QM4X19PB2T'); // I and L are 1
  for (const bad of ['', 'K7QM-4XR9', 'K7QM-4XR9-PB2T-1', 'K7QM-4XR9-PB2U', 'tasks-sync:abc']) assert.strictEqual(pair.pairNormalize(bad), null, bad);
});

test('the code makes the same id and key on both devices; another code opens nothing', async () => {
  const code = 'K7QM4XR9PB2T', msg = 'tasks-sync:eyJ1IjoiaHR0cHM6Ly94LnN1cGFiYXNlLmNvIn0=';
  const a = await pair.pairDerive(code), b = await pair.pairDerive(code);
  assert.match(a.id, /^[0-9a-f]{64}$/); // the shape sync_pair_put accepts
  assert.strictEqual(a.id, b.id);
  const sealed = await pair.pairSeal(a.key, msg);
  assert.ok(!sealed.includes('tasks-sync') && !sealed.includes(code));
  assert.strictEqual(await pair.pairOpen(b.key, sealed), msg);
  const other = await pair.pairDerive('K7QM4XR9PB2V');
  assert.notStrictEqual(other.id, a.id);
  assert.strictEqual(await pair.pairOpen(other.key, sealed), null);
  const bytes = Buffer.from(sealed, 'base64'); bytes[bytes.length - 1] ^= 1; // a changed byte
  assert.strictEqual(await pair.pairOpen(a.key, bytes.toString('base64')), null);
});

test('codes meet in the release project when the build has one, else in this device’s own', () => {
  global.window = {};
  assert.deepStrictEqual(pair.pairServer('https://own.supabase.co', 'k'), { url: 'https://own.supabase.co', key: 'k' });
  assert.strictEqual(pair.pairServer('', ''), null);
  window.ROMULUS_PAIR = { url: 'https://rel.supabase.co', key: 'sb_publishable_x' };
  assert.deepStrictEqual(pair.pairServer('https://own.supabase.co', 'k'), { url: 'https://rel.supabase.co', key: 'sb_publishable_x' });
  delete global.window;
});
