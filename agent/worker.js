/* The local model's own computer as the worker for every device (config.json localModel.worker: true).
   The app on that computer (Lupa) takes the local lane's tasks itself, straight from the synced Agent list,
   and talks to its own Ollama on localhost. No device has to reach it: it only reaches out, to Supabase,
   like the phone does. So no Tailscale, no address to type, and it works behind any router or VPN.

   It says it's there with a heartbeat in the ':worker' row next to the agent list ({v:1, at, name, model,
   host, busy}), every couple of minutes. The other computers read it: while it is fresh they leave the local
   lane to it (only money questions stay with them, since Finance lives on them), and the status line says
   the local model is answering. No Electron here, so it can be tested on its own. */
const os = require('os');
const supabase = require('./supabase');

const SUFFIX = ':worker';
const BEAT_MS = 2 * 60 * 1000;
const FRESH_MS = 6 * 60 * 1000; // three heartbeats missed: it's off, asleep or off the network
// money questions it can't answer (Finance lives on his other computer): it leaves them that long for a
// computer that can, then says so on the task instead of leaving it queued
const MONEY_WAIT_MS = 5 * 60 * 1000;

const isWorker = (cfg) => !!((cfg && cfg.localModel) || {}).worker;
// a heartbeat doc → the worker it describes while it's fresh, else null (pure, for tests)
function freshWorker(doc, now = Date.now()) {
  if (!doc || typeof doc !== 'object' || !doc.at) return null;
  const age = now - Number(doc.at);
  if (!(age >= -60 * 1000 && age < FRESH_MS)) return null; // a clock a minute ahead is fine
  return { name: String(doc.name || doc.host || 'the local model').slice(0, 60), model: String(doc.model || '').slice(0, 80),
    host: String(doc.host || '').slice(0, 60), busy: !!doc.busy, at: Number(doc.at) };
}
// stats: how its runs went lately (agent/run-log.js summary), so his other computers can see it
const heartbeat = ({ name, model, busy, stats }, now = Date.now()) =>
  ({ v: 1, at: now, name: String(name || os.hostname()).slice(0, 60), model: String(model || '').slice(0, 80), host: os.hostname().slice(0, 60), busy: !!busy, ...(stats ? { stats } : {}) });

// written compare-and-swap like every row; a write that lost a race reads again and tries once more
async function beat(a, info) {
  if (!a) return false;
  for (let i = 0; i < 2; i++) {
    let prev = null;
    try { const row = await supabase.readRow(a, SUFFIX); prev = row ? row.updated_at : null; } catch (e) { return false; }
    try { if (await supabase.writeRow(a, SUFFIX, heartbeat(info), prev)) return true; } catch (e) { return false; }
  }
  return false;
}

// the other computers' view, read at most once a minute: the fresh worker, or null
let seen = { at: 0, doc: null };
async function present(a, { now = Date.now() } = {}) {
  if (!a) return null;
  if (now - seen.at < 60 * 1000) return freshWorker(seen.doc, now);
  try {
    const row = await supabase.readRow(a, SUFFIX);
    seen = { at: now, doc: row ? row.doc : null };
  } catch (e) { seen = { at: now, doc: seen.doc }; } // unreachable: the last heartbeat read still counts until it goes stale
  return freshWorker(seen.doc, now);
}
// what present() last found, without a network call (for the run schedulers, which can't wait)
const lastSeen = (now = Date.now()) => freshWorker(seen.doc, now);
// the worker as another computer sees it: 'none' (no worker has ever said it's there), 'up' or 'quiet'
function workerState(doc, now = Date.now()) {
  if (!doc || typeof doc !== 'object' || !doc.at) return 'none';
  return freshWorker(doc, now) ? 'up' : 'quiet';
}
/* What to tell him when the worker goes quiet or comes back (pure, for tests): {is, title, body}, with
   title null when nothing changed. A worker that's quiet is off, asleep, crashed or off the network. */
function stateNotice(was, doc, now = Date.now()) {
  const is = workerState(doc, now);
  const name = is === 'none' ? '' : String(doc.name || doc.host || 'The local model').slice(0, 60);
  if (was === 'up' && is === 'quiet') {
    const min = Math.max(1, Math.round((now - Number(doc.at)) / 60000));
    return { is, title: name + ' stopped answering', body: 'Last heard ' + min + ' min ago. Local tasks wait for it, or run here if this computer can reach it.' };
  }
  if (was === 'quiet' && is === 'up') return { is, title: name + ' is back', body: 'It’s taking local tasks again.' };
  return { is, title: null, body: null };
}
const lastDoc = () => seen.doc;
const forget = () => { seen = { at: 0, doc: null }; };

/* Which queued local-lane tasks this computer should start (pure, for tests):
   - the worker: all of them, except money questions (no Finance here), which it leaves for MONEY_WAIT_MS
     and then answers with a note ('money-wait' in the result, see local-lane.js)
   - another computer while a worker is fresh: only money questions (Finance is here)
   - another computer with no worker: all of them, as before */
function share(tasks, { worker, workerUp, isMoney, now = Date.now() }) {
  if (worker) return tasks.filter((t) => !isMoney(t) || now - (t.updatedAt || 0) > MONEY_WAIT_MS);
  if (workerUp) return tasks.filter(isMoney);
  return tasks;
}

module.exports = { SUFFIX, BEAT_MS, FRESH_MS, MONEY_WAIT_MS, isWorker, freshWorker, heartbeat, beat, present, lastSeen, forget, share, workerState, stateNotice, lastDoc };
