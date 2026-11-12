/* Routing learns from how tasks turn out. Every Agent task gets a type (groceries, shopping, email, writing...)
   from its words. When one finishes on a lane, that lane gets a point for the type; when he switches a task
   off the lane it was sent to (or the mini PC fails and the cloud takes over), that lane loses one. The chance
   a lane does a type well is (good + 1) / (all + 2), so it starts at 50% and moves with each task.
   agent/routing.js asks pick() before its own guesses: once a type has enough history, the lane with the
   better record gets it. The counts live in route-stats.json next to the task data. */
const fs = require('fs');
const path = require('path');

// first match wins: "order food" is groceries, not shopping
const TYPES = [
  { type: 'groceries', words: ['grocery', 'groceries', 'food', 'meal', 'meals', 'ebt', 'snap', 'milk', 'eggs', 'bread', 'produce', 'walmart grocery', 'restock fridge'] },
  { type: 'email', words: ['email', 'emails', 'inbox', 'gmail', 'outlook', 'reply to', 'respond to', 'unsubscribe'] },
  { type: 'booking', words: ['book', 'reserve', 'reservation', 'appointment', 'flight', 'flights', 'hotel', 'tickets', 'movie', 'schedule', 'calendar', 'meeting'] },
  { type: 'shopping', words: ['buy', 'order', 'purchase', 'shop', 'amazon', 'target', 'best buy', 'cart', 'cheapest', 'price', 'prices'] },
  { type: 'schoolwork', words: ['chapter', 'quiz', 'homework', 'assignment', 'discussion', 'module', 'exam', 'lab', 'blackboard', 'd2l', 'class', 'course', 'lecture'] },
  { type: 'writing', words: ['write', 'rewrite', 'draft', 'essay', 'letter', 'cover letter', 'story', 'poem', 'proofread', 'edit', 'summarize', 'summarise', 'outline', 'brainstorm'] },
  { type: 'forms', words: ['fill', 'form', 'forms', 'apply', 'application', 'questionnaire', 'survey', 'sign up', 'register'] },
  { type: 'research', words: ['research', 'find', 'look up', 'search', 'compare', 'news', 'latest', 'review', 'reviews', 'what is', 'how do', 'how to', 'best'] },
];
const LANES = ['claude', 'local'];
const MIN_TASKS = 3;   // a type needs this many outcomes before its record picks the lane
const MIN_GAP = 0.1;   // and one lane must be this much better than the other
const KEEP_COUNTED = 3000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hit = (text, words) => words.some((w) => new RegExp('(^|[^a-z0-9])' + escapeRe(w) + '([^a-z0-9]|$)').test(text));
// → the task's type ('other' when nothing fits)
function typeOf(t) {
  if (t && typeof t.taskType === 'string' && t.taskType) return t.taskType;
  const text = (String((t && t.title) || '') + '\n' + String((t && t.notes) || '')).toLowerCase();
  const m = TYPES.find((x) => hit(text, x.words));
  return m ? m.type : 'other';
}

let file = null;
let stats = null;
function init(dir) { file = dir ? path.join(dir, 'route-stats.json') : null; stats = null; }
const empty = () => ({ v: 1, types: {}, counted: {} });
function load() {
  if (stats) return stats;
  try { stats = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { stats = null; }
  if (!stats || typeof stats.types !== 'object' || typeof stats.counted !== 'object') stats = empty();
  return stats;
}
function save() {
  if (!file || !stats) return;
  const ids = Object.keys(stats.counted);
  if (ids.length > KEEP_COUNTED) ids.slice(0, ids.length - KEEP_COUNTED).forEach((k) => delete stats.counted[k]);
  try { fs.writeFileSync(file + '.tmp', JSON.stringify(stats)); fs.renameSync(file + '.tmp', file); } catch (e) {}
}
function bump(type, lane, good) {
  const s = load();
  const row = s.types[type] || (s.types[type] = {});
  const c = row[lane] || (row[lane] = { ok: 0, bad: 0 });
  if (good) c.ok++; else c.bad++;
}
// → {p, n}: the chance this lane does this type well, and how many of its tasks that's from
function chance(type, lane) {
  const c = ((load().types[type] || {})[lane]) || { ok: 0, bad: 0 };
  const n = c.ok + c.bad;
  return { p: (c.ok + 1) / (n + 2), n };
}
// → {lane, p, n} when the record is clear enough to decide, else null. lanesUp: which lanes can take it now
function pick(type, lanesUp) {
  const ok = LANES.filter((l) => !lanesUp || lanesUp.includes(l));
  if (ok.length < 2) return null;
  const a = chance(type, 'claude'), b = chance(type, 'local');
  if (a.n + b.n < MIN_TASKS || Math.abs(a.p - b.p) < MIN_GAP) return null;
  return a.p > b.p ? Object.assign({ lane: 'claude' }, a) : Object.assign({ lane: 'local' }, b);
}
const pct = (p) => Math.round(p * 100) + '%';
// "groceries: Claude 75% (from 6)" — what the routed note shows
function describe(type, lane) {
  const c = chance(type, lane);
  return type + ': ' + (lane === 'local' ? 'local model' : 'Claude') + ' ' + pct(c.p) + (c.n ? ' (from ' + c.n + ')' : ' (no history yet)');
}

/* reads the saved task list and counts what's new: a task switched off the lane it was first sent to counts
   against that lane (once); a finished task counts for the lane that finished it (once). Called on every save. */
function learn(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return false; }
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
  const s = load();
  let changed = false;
  for (const t of tasks) {
    if (!t || t.ws !== 'agent' || !t.id) continue;
    const first = t.routedLane, now = t.lane;
    if (!LANES.includes(first)) continue;
    const type = typeOf(t);
    if (LANES.includes(now) && now !== first && !s.counted[t.id + '|moved']) {
      bump(type, first, false); s.counted[t.id + '|moved'] = 1; changed = true;
    }
    if ((t.done || t.status === 'done') && LANES.includes(now) && !s.counted[t.id + '|done']) {
      bump(type, now, true); s.counted[t.id + '|done'] = 1; changed = true;
    }
  }
  if (changed) save();
  return changed;
}

module.exports = { init, typeOf, chance, pick, describe, learn, TYPES, MIN_TASKS, _reset: () => { stats = empty(); } };
