/* How the local model's runs went, so whether it is any good at its job is a number, not a feeling.
   Each run on the worker adds one line to local-runs.jsonl in its user data: how it ended, why it stopped,
   steps and time, the app's own corrections that run (tool calls read from text, sent to the class site
   first), and whether his reply before it was a "try again" or a correction. Nothing of the task's text but
   its class. The last 30 days, summed up, ride on the worker's heartbeat (agent/worker.js), so any of his
   computers (or Claude, reading the row) can see it without reaching the mini PC.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');

const KEEP = 2000; // lines kept: months of runs, a few hundred KB
const DAY = 24 * 60 * 60 * 1000;

// why a run ended, in a few buckets
function reasonOf(e) {
  if (e.status === 'done') return 'done';
  const r = String(e.reason || '').toLowerCase();
  if (e.verify) return 'needs his sign-in or code';
  if (/signed out/.test(r)) return 'signed out';
  if (/its steps|ran out of steps/.test(r)) return 'ran out of steps';
  if (/timing out|taking over a minute|not reachable|isn.t reachable/.test(r)) return 'browser slow or unreachable';
  if (e.pastDue && /closed|passed|past|late|due/.test(String(e.note || '').toLowerCase())) return 'past due';
  if (/i need|could you|what exactly|more (details|info)/.test(String(e.note || '').toLowerCase())) return 'asked him for details';
  if (/<tool_call>/.test(String(e.note || ''))) return 'broken answer';
  return 'other';
}
// what his reply before this run was: 'retry' ("try again", "done"), 'correction' ("that's wrong", "no, …"), or null
function replyKind(reply) {
  const s = String(reply || '').trim().toLowerCase();
  if (!s) return null;
  if (/\b(wrong|incorrect|not (right|what)|that's not|no,|nope|you missed|redo)\b/.test(s)) return 'correction';
  if (/\b(try again|retry|again|done|keep going|continue|go ahead|carry on|signed in|logged in)\b/.test(s)) return 'retry';
  return 'reply';
}

// one run → its line (pure)
function entry({ t, final, stuck, steps, ms, textCalls, lookedFirst, pastDue, now = Date.now() }) {
  const e = { at: now, id: String((t && t.id) || '').slice(0, 40), class: (t && t.tag) || null, from: (t && t.fromWs) || null,
    status: (final && final.status) || 'needs-you', reason: stuck ? String(stuck.reason || '').slice(0, 160) : null, verify: !!(stuck && stuck.verify),
    steps: steps || 0, secs: Math.round((ms || 0) / 1000), textCalls: textCalls || 0, lookedFirst: !!lookedFirst, pastDue: !!pastDue,
    reply: replyKind(t && t.reply), note: String((final && final.note) || '').slice(0, 200) };
  e.why = reasonOf(e);
  delete e.note; // only used to sort it into a bucket: the note itself stays on the task
  return e;
}

function load(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}
function record(file, e) {
  try {
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
    const all = load(file);
    if (all.length > KEEP * 1.2) fs.writeFileSync(file, all.slice(-KEEP).map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch (e2) {}
}

/* the last `days` days → {days, runs, done, rate, minutes, retried, corrected, textCalls, lookedFirst, why: {bucket: n}, byClass: {class: [done, runs]}} (pure).
   rate: done / runs. A task he had to send back counts again on its next run, so retried shows how often that was */
function summary(entries, { now = Date.now(), days = 30 } = {}) {
  const recent = (entries || []).filter((e) => e && now - e.at <= days * DAY);
  const out = { days, runs: recent.length, done: 0, rate: 0, minutes: 0, retried: 0, corrected: 0, textCalls: 0, lookedFirst: 0, why: {}, byClass: {} };
  let secs = 0;
  for (const e of recent) {
    if (e.status === 'done') out.done++;
    secs += e.secs || 0;
    if (e.reply === 'retry') out.retried++;
    if (e.reply === 'correction') out.corrected++;
    out.textCalls += e.textCalls || 0;
    if (e.lookedFirst) out.lookedFirst++;
    if (e.why !== 'done') out.why[e.why] = (out.why[e.why] || 0) + 1;
    if (e.class) { const c = out.byClass[e.class] = out.byClass[e.class] || [0, 0]; c[1]++; if (e.status === 'done') c[0]++; }
  }
  out.rate = recent.length ? Math.round((out.done / recent.length) * 100) / 100 : 0;
  out.minutes = recent.length ? Math.round(secs / recent.length / 6) / 10 : 0; // average, one decimal
  return out;
}

module.exports = { reasonOf, replyKind, entry, load, record, summary };
