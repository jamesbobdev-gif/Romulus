/* The agent channel's Supabase calls from this computer: rows in tasks_sync next to the agent list
   (sync_key = <agent syncKey><suffix>, e.g. ':prefs', ':routing', ':locked') and the claim RPC.
   `a` is config.json → sync.agent: {url, key, syncKey}.
   Every row is reached through a database function that needs its sync key (sync_get / sync_put,
   supabase/migrations/20261021_sync_rpc_lockdown.sql): the table itself is closed to the anon key.
   No Electron here, so it can be tested on its own. */

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
async function readRow(a, suffix, opts = {}) {
  const rows = await rpc(a, 'sync_get', { p_sync_key: a.syncKey + suffix }, opts);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row && row.doc != null ? { doc: row.doc, updated_at: row.updated_at } : undefined;
}

// The text of a {v, text} doc row, '' when it's missing or unreachable
async function readText(a, suffix, opts) {
  try {
    const row = await readRow(a, suffix, opts);
    return (row && row.doc && row.doc.text) || '';
  } catch (e) { return ''; }
}

// Compare-and-swap write: prev = the updated_at read (null to make the row). → true, or false when the
// row changed meanwhile (read it again and merge). Throws on a network or HTTP error.
async function writeRow(a, suffix, doc, prev, opts) {
  return (await rpc(a, 'sync_put', { p_sync_key: a.syncKey + suffix, p_doc: doc, p_prev: prev || null }, opts)) === true;
}

module.exports = { base, headers, rpcUrl, channel, deriveSyncKey, rpc, readRow, readText, writeRow };
