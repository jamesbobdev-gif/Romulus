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
// doing: what it's on right now (agent/local-lane.js nowDoing); version: the app it runs
const heartbeat = ({ name, model, busy, stats, doing, version, actions }, now = Date.now()) =>
  ({ v: 1, at: now, name: String(name || os.hostname()).slice(0, 60), model: String(model || '').slice(0, 80), host: os.hostname().slice(0, 60), busy: !!busy,
    ...(doing ? { doing } : {}), ...(version ? { version: String(version).slice(0, 20) } : {}), ...(stats ? { stats } : {}),
    ...(actions && actions.length ? { actions: actionsForBeat(actions) } : {}) });

/* What its browser did that matters (agent/browser-proxy.js logAction: orders, applications, mail opened, uploads)
   is written to its own agent-actions.log, on its own disk. The newest lines ride along in the heartbeat so his
   other computers can show them in Settings → What the Agent did (pure, for tests). */
const ACTIONS_MAX = 30;
const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
function actionsForBeat(lines) { // newest first in, newest first out
  return (Array.isArray(lines) ? lines : []).filter((l) => l && l.at && l.what).slice(0, ACTIONS_MAX).map((l) => {
    const o = { at: Number(l.at), task: cut(l.task, 120), what: cut(l.what, 40) };
    if (l.label) o.label = cut(l.label, 80);
    if (l.url) o.url = cut(l.url, 160);
    if (Array.isArray(l.files)) o.files = l.files.slice(0, 5).map((f) => cut(f, 80));
    return o;
  });
}
// this computer's own lines plus the worker's from its last heartbeat, each worker line marked with where it ran
function mergeActions(local, doc) {
  const own = Array.isArray(local) ? local : [];
  const theirs = doc && Array.isArray(doc.actions) ? doc.actions : [];
  const where = doc ? cut(doc.name || doc.host || 'the local model', 60) : '';
  const seen = new Set(own.map((l) => l.at + '|' + l.what + '|' + (l.url || '')));
  const add = theirs.filter((l) => l && l.at && !seen.has(l.at + '|' + l.what + '|' + (l.url || ''))).map((l) => Object.assign({}, l, { where }));
  return own.concat(add).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// written compare-and-swap like every row; a write that lost a race reads again and tries once more
let beatErr = ''; // why the last heartbeat didn't go out ('' when it did), for the log
async function beat(a, info) {
  if (!a) { beatErr = 'sync isn’t set up on this computer'; return false; }
  for (let i = 0; i < 2; i++) {
    try {
      const row = await supabase.readRow(a, SUFFIX);
      if (await supabase.writeRow(a, SUFFIX, heartbeat(info), row ? row.updated_at : null)) { beatErr = ''; return true; }
      beatErr = 'the row changed while it was being written';
    } catch (e) { beatErr = String((e && e.message) || e); return false; }
  }
  return false;
}
const lastBeatError = () => beatErr;
/* When the next heartbeat goes (pure, for tests). One that went: in BEAT_MS. One that didn't (the network
   dropped for a moment, the server was slow): soon, 15 s then 30 s then a minute, so one lost request doesn't
   cost two minutes of the six his other computers wait before calling it quiet. */
const BEAT_RETRY_MS = 15 * 1000;
const nextBeatIn = (ok, fails) => (ok ? BEAT_MS : Math.min(BEAT_MS, BEAT_RETRY_MS * Math.pow(2, Math.max(0, (fails || 1) - 1))));

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
// the next present() reads the row again instead of answering from the last minute's copy (which it keeps meanwhile)
const lookAgain = () => { seen = { at: 0, doc: seen.doc }; };

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

module.exports = { SUFFIX, BEAT_MS, FRESH_MS, MONEY_WAIT_MS, isWorker, freshWorker, heartbeat, beat, lastBeatError, nextBeatIn, BEAT_RETRY_MS, present, lastSeen, forget, lookAgain, share, workerState, stateNotice, lastDoc, actionsForBeat, mergeActions, ACTIONS_MAX };
