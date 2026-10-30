/* The Locked profile goes to Supabase encrypted (renderer/js/settings.js lockedEncrypt, WebCrypto) and is read
   back on the computer by agent/supabase.js (Node crypto). These tests encrypt the way the renderer does, with
   WebCrypto itself (globalThis.crypto.subtle, the same API the page uses), and prove the Node side reads it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const supabase = require('../agent/supabase');

const subtle = globalThis.crypto.subtle;
const INFO = 'romulus-locked-v1';
// a copy of the renderer's lockedKey/lockedEncrypt (renderer/js/settings.js), same calls, same constants
async function webKey(syncKey, usage) {
  const enc = new TextEncoder();
  const raw = await subtle.importKey('raw', enc.encode(syncKey), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(INFO), info: enc.encode(INFO) }, raw, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
async function webEncrypt(syncKey, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await webKey(syncKey, 'encrypt'), new TextEncoder().encode(text));
  return { v: 2, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

const KEY = 'tk_agent_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
const TEXT = '## Contact for forms\n- Phone: 555-0100\n- DOB: 2001-01-01\n- Address: 1 Main St, Springfield IL 62701\n- Authorized to work in the US: yes';

test('the renderer\'s WebCrypto encryption is read by the Node reader', async () => {
  const doc = await webEncrypt(KEY, TEXT);
  assert.strictEqual(doc.v, 2);
  assert.notStrictEqual(doc.ct, '');
  assert.ok(!JSON.stringify(doc).includes('555-0100'), 'the row never carries the text');
  assert.strictEqual(supabase.decryptLocked(KEY, doc), TEXT);
  assert.strictEqual(supabase.docText(KEY, doc), TEXT);
  // an empty profile encrypts and decrypts too (ct is just the tag)
  assert.strictEqual(supabase.docText(KEY, await webEncrypt(KEY, '')), '');
  // unicode survives
  const u = 'Résumé — Zürich • 東京';
  assert.strictEqual(supabase.docText(KEY, await webEncrypt(KEY, u)), u);
});

test('the key comes from the agent sync key alone: another key or a changed byte fails', async () => {
  const doc = await webEncrypt(KEY, TEXT);
  assert.throws(() => supabase.decryptLocked('tk_agent_someone-elses-key-0000000000', doc));
  const tampered = Buffer.from(doc.ct, 'base64'); tampered[0] ^= 1;
  assert.throws(() => supabase.decryptLocked(KEY, { v: 2, iv: doc.iv, ct: tampered.toString('base64') }));
  assert.throws(() => supabase.decryptLocked(KEY, { v: 2, iv: 'AAAA', ct: doc.ct })); // bad iv length
  // HKDF with the fixed salt/info is deterministic, so both sides agree on the key bytes
  const k = supabase.lockedKey(KEY);
  assert.strictEqual(k.length, 32);
  assert.deepStrictEqual(k, supabase.lockedKey(KEY));
  const raw = await subtle.exportKey('raw', await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(INFO), info: new TextEncoder().encode(INFO) },
    await subtle.importKey('raw', new TextEncoder().encode(KEY), 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, true, ['encrypt']));
  assert.deepStrictEqual(Buffer.from(raw), k);
});

test('a v:1 plain row still reads, and junk reads as nothing', async () => {
  assert.strictEqual(supabase.docText(KEY, { v: 1, text: 'plain' }), 'plain');
  assert.strictEqual(supabase.docText(KEY, { v: 1 }), '');
  assert.strictEqual(supabase.docText(KEY, null), '');
  assert.strictEqual(supabase.docText(KEY, 'text'), '');
  // readText: an unreadable v:2 row (wrong key) is '' rather than a throw, like a missing row
  const a = { url: 'https://x.supabase.co', key: 'k', syncKey: 'tk_agent_other-key-00000000000000000' };
  const doc = await webEncrypt(KEY, TEXT);
  const f = async () => ({ ok: true, status: 200, json: async () => [{ doc, updated_at: 't', topic: 'x' }] });
  assert.strictEqual(await supabase.readText(a, ':locked', { fetch: f }), '');
  assert.strictEqual(await supabase.readText({ ...a, syncKey: KEY }, ':locked', { fetch: f }), TEXT);
});

test('the renderer uses the same algorithm and strings (settings.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'settings.js'), 'utf8');
  assert.ok(src.includes("const LOCKED_INFO='romulus-locked-v1'"));
  assert.strictEqual(supabase.LOCKED_INFO, 'romulus-locked-v1');
  assert.ok(/name:'HKDF',hash:'SHA-256',salt:enc\.encode\(LOCKED_INFO\),info:enc\.encode\(LOCKED_INFO\)/.test(src));
  assert.ok(/\{name:'AES-GCM',length:256\}/.test(src));
  assert.ok(/new Uint8Array\(12\)/.test(src), 'a 12-byte iv');
  assert.ok(/\{v:2,iv:lockedB64\(iv\),ct:lockedB64\(new Uint8Array\(ct\)\)\}/.test(src), 'the {v:2, iv, ct} row');
  assert.ok(!/syncPushDoc\(p,\{v:1,text:/.test(src), 'the Locked profile is never saved as plain text any more');
});

test('the sync key shape the database checks matches every key the app makes', () => {
  // the same regex as supabase/setup.sql sync_put / sync_set (there as a POSIX regex)
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'setup.sql'), 'utf8');
  const m = sql.match(/p_sync_key !~ '([^']+)'/);
  assert.ok(m, 'setup.sql checks the key shape');
  const re = new RegExp(m[1]);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261030_sync_standing_key.sql'), 'utf8');
  assert.ok(mig.includes(m[1]), 'the latest migration carries the same regex');
  const uuid = '6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c', short = 'm2k9x1a7' + 'q8w3e5r1'; // Generate key, and its fallback without randomUUID
  const personal = ['tk_' + uuid, 'tk_' + short];
  for (const p of personal) {
    assert.ok(re.test(p), p);
    for (const ws of ['work', 'agent', 'school']) assert.ok(re.test(supabase.deriveSyncKey(p, ws)), ws);
    for (const sfx of [':ideas', ':hours']) assert.ok(re.test(p + sfx), sfx);
    for (const sfx of [':prefs', ':locked', ':routing', ':standing']) assert.ok(re.test(supabase.deriveSyncKey(p, 'agent') + sfx), sfx);
  }
  // what it refuses: no tk_, too short, other suffixes, spaces, the storage folder name alone is fine but not a row key with slashes
  for (const bad of ['plainkey12345678', 'tk_short', 'tk_' + uuid + ':other', 'tk_' + uuid + ' ', 'tk_agent_att_abc/stuck-1', '', 'tk_' + uuid + ':prefs:prefs'])
    assert.ok(!re.test(bad), bad);
});
