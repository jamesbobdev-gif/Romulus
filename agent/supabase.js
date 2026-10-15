/* The agent channel's Supabase calls from this computer: rows in tasks_sync next to the agent list
   (sync_key = <agent syncKey><suffix>, e.g. ':prefs', ':routing', ':locked') and the claim RPC.
   `a` is config.json → sync.agent: {url, key, syncKey}.
   No Electron here, so it can be tested on its own. */

const base = (a) => String(a.url).replace(/\/+$/, '') + '/rest/v1';
const headers = (a, extra) => Object.assign({ apikey: a.key, Authorization: 'Bearer ' + a.key }, extra);
const rowUrl = (a, suffix) => base(a) + '/tasks_sync?sync_key=eq.' + encodeURIComponent(a.syncKey + suffix);

// The channel from a config, or null when it isn't set up
function channel(cfg) {
  const a = ((cfg && cfg.sync) || {}).agent;
  return a && a.url && a.key ? a : null;
}

// One row ({doc, ...select}) or undefined when there isn't one. Throws on a network or HTTP error.
async function readRow(a, suffix, { select = 'doc', timeout = 10000, fetch: f = fetch } = {}) {
  const r = await f(rowUrl(a, suffix) + '&select=' + select, { headers: headers(a), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : undefined;
}

// The text of a {v, text} doc row, '' when it's missing or unreachable
async function readText(a, suffix, opts) {
  try {
    const row = await readRow(a, suffix, opts);
    return (row && row.doc && row.doc.text) || '';
  } catch (e) { return ''; }
}

module.exports = { base, headers, rowUrl, channel, readRow, readText };
