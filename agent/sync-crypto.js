/* End-to-end encrypted sync ("v2") on the Node side: the same derivation as renderer/js/sync-crypto.js
   (read that for the design). HKDF-SHA256 over the list's sync key, salt 'romulus-sync-v2': info 'lookup'
   → the row's id (tk_[list_] + 24 bytes base64url), info 'content' → the AES-256-GCM key. A sealed row is
   {e:1, iv, ct}, base64, the GCM tag at the end of ct (as WebCrypto writes it).
   test/sync-crypto.test.js proves this side and the page's WebCrypto side agree. */
const crypto = require('crypto');

const SALT = 'romulus-sync-v2';
const cache = new Map(); // base sync key → {lookup, key}

const splitKey = (k) => { const m = /^(.*?)(:[a-z-]+)?$/.exec(String(k || '')); return { base: m[1], sfx: m[2] || '' }; };
const keyPrefix = (base) => { const m = /^tk_(?:(?:work|agent|school)_)?/.exec(base); return m ? m[0] : 'tk_'; };
function keys(base) {
  if (!cache.has(base)) {
    const pre = keyPrefix(base);
    const hk = (ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.from(info, 'utf8'), n));
    // the id from the key without its tk_[list_] prefix (one account per sync key); the cipher key from all of it
    cache.set(base, { lookup: pre + hk(base.slice(pre.length), 'lookup', 24).toString('base64url'), key: hk(base, 'content', 32) });
  }
  return cache.get(base);
}
// the key the database knows a row by: lookup id + suffix
function rowKey(syncKey) { const s = splitKey(syncKey); return keys(s.base).lookup + s.sfx; }
const isSealed = (doc) => !!(doc && doc.e === 1 && doc.iv && doc.ct);
function seal(syncKey, doc) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys(splitKey(syncKey).base).key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(doc), 'utf8'), c.final(), c.getAuthTag()]);
  return { e: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function open(syncKey, env) {
  const iv = Buffer.from(String(env.iv), 'base64'), ct = Buffer.from(String(env.ct), 'base64');
  if (iv.length !== 12 || ct.length < 16) throw new Error('bad sealed row');
  const d = crypto.createDecipheriv('aes-256-gcm', keys(splitKey(syncKey).base).key, iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}

module.exports = { SALT, splitKey, rowKey, isSealed, seal, open };
