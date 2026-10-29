/* The agent channel's Supabase calls from this computer: rows in tasks_sync next to the agent list
   (sync_key = <agent syncKey><suffix>, e.g. ':prefs', ':routing', ':locked') and the claim RPC.
   `a` is config.json → sync.agent: {url, key, syncKey}.
   Every row is reached through a database function that needs its sync key (sync_get / sync_put,
   supabase/migrations/20261021_sync_rpc_lockdown.sql): the table itself is closed to the anon key.
   No Electron here, so it can be tested on its own. */

const crypto = require('crypto');

const base = (a) => String(a.url).replace(/\/+$/, '') + '/rest/v1';
const headers = (a, extra) => Object.assign({ apikey: a.key, Authorization: 'Bearer ' + a.key }, extra);
const rpcUrl = (a, fn) => base(a) + '/rpc/' + fn;

// a list's key made from the personal sync key (the same rule as renderer/js/sync.js deriveSyncKey)
function deriveSyncKey(personalKey, list) {
  const id = String(personalKey || '').replace(/^tk_/, '');
  return id ? 'tk_' + list + '_' + id : '';
}
// The channel from a config, or null when it isn't set up. Without an agent profile of its own, the
// agent list lives in the personal project under a key made from the personal one.
function channel(cfg) {
  const s = (cfg && cfg.sync) || {};
  const a = s.agent;
  if (a && a.url && a.key && a.syncKey) return a;
  const p = s.personal;
  if (p && p.url && p.key && p.syncKey) return { url: p.url, key: p.key, syncKey: deriveSyncKey(p.syncKey, 'agent'), derived: true };
  return null;
}

async function rpc(a, fn, body, { timeout = 10000, fetch: f = fetch } = {}) {
  const r = await f(rpcUrl(a, fn), { method: 'POST', headers: headers(a, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// One row ({doc, updated_at}) or undefined when there isn't one. Throws on a network or HTTP error.
// The last row read is kept per key and its time sent as p_since: an unchanged row comes back without its
// document (about a hundred bytes), and the kept copy is used (supabase/migrations/20261029_sync_get_since.sql).
const seenRows = new Map(); // url|key → {doc, updated_at}
let noSince = false; // an older database without p_since: whole rows, as before
async function readRow(a, suffix, opts = {}) {
  const k = a.url + '|' + a.syncKey + suffix, c = seenRows.get(k);
  let rows;
  if (c && !noSince) {
    try { rows = await rpc(a, 'sync_get', { p_sync_key: a.syncKey + suffix, p_since: c.updated_at }, opts); }
    catch (e) { if (!/HTTP 404/.test(e.message)) throw e; noSince = true; }
  }
  if (!rows) rows = await rpc(a, 'sync_get', { p_sync_key: a.syncKey + suffix }, opts);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (row && row.unchanged && c && row.updated_at === c.updated_at) return c;
  if (!row || row.doc == null) { seenRows.delete(k); return undefined; }
  const out = { doc: row.doc, updated_at: row.updated_at };
  seenRows.set(k, out);
  return out;
}

/* The Locked profile row (':locked') is encrypted by the app before it goes up (renderer/js/settings.js
   lockedEncrypt): AES-256-GCM under a key made from the agent sync key by HKDF-SHA256 with
   'romulus-locked-v1' as both salt and info; the row is {v:2, iv, ct}, base64, the GCM tag at the end of
   ct (as WebCrypto writes it). The same derivation here undoes it. A {v:1, text} row (from before) still
   reads as is; the app re-saves it encrypted the next time Settings opens it. */
const LOCKED_INFO = 'romulus-locked-v1';
function lockedKey(syncKey) {
  const s = Buffer.from(LOCKED_INFO, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(syncKey), 'utf8'), s, s, 32));
}
function decryptLocked(syncKey, doc) {
  const iv = Buffer.from(String(doc.iv), 'base64'), ct = Buffer.from(String(doc.ct), 'base64');
  if (iv.length !== 12 || ct.length < 16) throw new Error('bad locked row');
  const d = crypto.createDecipheriv('aes-256-gcm', lockedKey(syncKey), iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
}
// the text of a doc row: {v:1, text} as is, {v:2, iv, ct} decrypted with the channel's key
function docText(syncKey, doc) {
  if (!doc || typeof doc !== 'object') return '';
  if (doc.v === 2 && doc.ct) return decryptLocked(syncKey, doc);
  return doc.text || '';
}

// The text of a {v, text} doc row (decrypted when it is a v:2 row), '' when it's missing, unreachable or unreadable
async function readText(a, suffix, opts) {
  try {
    const row = await readRow(a, suffix, opts);
    return docText(a.syncKey, row && row.doc) || '';
  } catch (e) { return ''; }
}

// Compare-and-swap write: prev = the updated_at read (null to make the row). → true, or false when the
// row changed meanwhile (read it again and merge). Throws on a network or HTTP error.
async function writeRow(a, suffix, doc, prev, opts) {
  return (await rpc(a, 'sync_put', { p_sync_key: a.syncKey + suffix, p_doc: doc, p_prev: prev || null }, opts)) === true;
}

module.exports = { base, headers, rpcUrl, channel, deriveSyncKey, rpc, readRow, readText, writeRow, lockedKey, decryptLocked, docText, LOCKED_INFO };
