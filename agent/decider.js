/* d1, the small decision model on the mini PC (Liquid AI's d1-3B through Ollama's /v1/systemone). Before a new
   Agent task runs it answers three questions about it in ~2 s, no text written and no cloud tokens spent:
   is it private, is it a real request (not a scrap of talk Hey Romulus picked up), and does it need the web.
   agent/routing.js uses the answers next to his keyword rules; with Lupa off or d1 missing, the rules alone decide.
   Answers are kept per task text, so routing can read them without waiting. */
const DEFAULT_MODEL = 'hf.co/LiquidAI/d1-3B-GGUF:Q4_K_M';
const QUESTIONS = {
  real_task: { type: 'noul', instructions: 'Is this a complete request for something to be done or answered, rather than a stray scrap of conversation picked up by a voice assistant?' },
  private: { type: 'noul', instructions: 'Does this involve private personal information: health or medication, money or bank accounts, passwords, government IDs, or school grades?' },
  lane: { type: 'choice', instructions: 'Which worker should do this?', criteria: {
    web: 'Needs the live web: shopping, ordering, booking, looking things up online, email or accounts on websites',
    local: 'Can be done without the web: writing, drafting, quizzes, coursework, forms, answering from knowledge' } },
};
// how sure d1 must be before its answer counts (tried on his past Agent tasks, 2026-10-21)
const PRIVATE_AT = 0.9;  // Pharmacy / bank tasks came out 0.97–0.98, ordinary ones under 0.7
const SCRAP_BELOW = 0.2; // "Yeah", "It's too far": 0.11–0.15; the lowest real task ("Article Review 2") 0.28
const LANE_AT = 0.8;
const PAUSE_MS = 2 * 60 * 1000; // after d1 fails, the rules decide alone for a while instead of waiting on it each time

let ctx = null; // { readConfig, agentLog }
function init(c) { ctx = c; }
const answers = new Map(); // task text → {private, real, lane, laneSure}
let pausedUntil = 0;

function cfg() {
  const c = ctx ? ctx.readConfig() : {};
  const l = c.localModel || {}, d = c.decisionModel || {};
  if (!l.url || l.enabled === false || d.enabled === false) return null;
  return { url: String(l.url).replace(/\/+$/, ''), model: String(d.model || DEFAULT_MODEL) };
}
const stateOf = (t) => [String(t.title || '').trim(), String(t.notes || '').trim()].filter(Boolean).join('\n\n').slice(0, 4000);
const get = (t) => answers.get(stateOf(t)) || null;
const usable = () => !!cfg() && Date.now() >= pausedUntil;

async function ask(c, state, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(c.url + '/v1/systemone', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.model, state, questions: QUESTIONS }) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.answers) throw new Error((j && j.error) || 'HTTP ' + res.status);
    const a = j.answers;
    return { private: Number(a.private && a.private.noul) || 0, real: Number(a.real_task && a.real_task.noul),
      lane: a.lane && a.lane.choice === 'local' ? 'local' : 'claude', laneSure: Number(a.lane && a.lane.confidence) || 0 };
  } finally { clearTimeout(timer); }
}
// asks d1 about the tasks it hasn't seen yet (one at a time: Lupa has one CPU). false = d1 couldn't answer
let going = null;
async function decide(tasks) {
  const c = cfg();
  if (!c || !usable()) return false;
  if (going) await going.catch(() => {});
  const todo = tasks.filter((t) => !answers.has(stateOf(t)) && stateOf(t));
  going = (async () => {
    for (const t of todo) {
      const s = stateOf(t);
      if (answers.has(s)) continue;
      const a = await ask(c, s, answers.size ? 20000 : 60000); // the first call loads d1 into memory
      answers.set(s, a);
      if (ctx && ctx.agentLog) ctx.agentLog('d1: ' + JSON.stringify(s.slice(0, 60)) + ' private ' + a.private.toFixed(2) + ', real ' + a.real.toFixed(2) + ', ' + a.lane + ' ' + a.laneSure.toFixed(2));
    }
  })();
  try { await going; return true; }
  catch (e) {
    pausedUntil = Date.now() + PAUSE_MS;
    if (ctx && ctx.agentLog) ctx.agentLog('d1 unavailable (' + String(e && e.message || e).slice(0, 120) + '): keyword rules only for now');
    return false;
  } finally { going = null; }
}
// d1's verdicts, or null when it hasn't answered (the rules decide then)
function looksPrivate(t) { const a = get(t); return !!a && a.private >= PRIVATE_AT; }
function laneFor(t) { const a = get(t); return a && a.laneSure >= LANE_AT ? a.lane : null; }
/* a bare scrap: a short title alone, never talked about, that d1 doesn't think is a request.
   Anything with notes, a tag (look-ahead, school), a reply or photos counts as meant. */
function looksLikeScrap(t) {
  const a = get(t);
  if (!a || !(a.real < SCRAP_BELOW)) return false;
  if (t.notes || t.tag || t.reply || t.repeat || (Array.isArray(t.history) && t.history.some((h) => h.who === 'you'))) return false;
  return String(t.title || '').trim().split(/\s+/).length <= 10;
}
function forget() { answers.clear(); pausedUntil = 0; }

module.exports = { init, decide, get, usable, looksPrivate, laneFor, looksLikeScrap, forget, DEFAULT_MODEL, PRIVATE_AT, SCRAP_BELOW, LANE_AT };
