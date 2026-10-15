/* Lanes: each Agent task goes to ONE worker — 'claude' (this computer's Claude runner) or 'local' (James's
   own model on the mini PC). A task that already has a lane keeps it (switching changes it). A new one
   is routed by HIS rules, no AI involved: a #local / #claude tag in the title, then his rules in order
   (first match wins), then his default (claude, local, or 'ask' = he picks). The rules live next to the
   agent list (doc {v, rules:[{words, lane}], default}) and are edited in ⚙ Settings on any device. */
const fs = require('fs');
const supabase = require('./supabase');

let ctx = null; // { readConfig, dataFile, sendToRenderer, scheduleAgentRun, scheduleLocalRun }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();
const sendToRenderer = (ch, p) => ctx.sendToRenderer(ch, p);

// private words: checked before his rules (only a #claude tag beats them); a match always stays on the mini PC
const PRIVATE_DEFAULT = 'password, passcode, pin number, bank, bank account, credit card, debit card, ssn, social security, ' +
  'passport, tax, taxes, salary, payslip, medical, doctor, health, therapy, therapist, prescription, grades, transcript, report card';
const ROUTING_DEFAULT = { v: 1, default: 'ask', private: PRIVATE_DEFAULT, rules: [
  { words: 'email, send, outlook, gmail', lane: 'claude' },
  { words: 'buy, find, look up, search', lane: 'claude' },
  { words: 'fill, form, apply', lane: 'local' },
  { words: 'write, draft, essay', lane: 'local' },
] };
let routing = ROUTING_DEFAULT;
// the rules doc as saved (or nothing) → the rules used from now on
function useRouting(d) {
  routing = d && Array.isArray(d.rules) ? d : ROUTING_DEFAULT;
  if (typeof routing.private !== 'string') routing = Object.assign({}, routing, { private: PRIVATE_DEFAULT }); // saved before private words existed
}
async function loadRouting() {
  const a = supabase.channel(readConfig());
  if (!a) return;
  try {
    const row = await supabase.readRow(a, ':routing', { timeout: 8000 });
    useRouting(row && row.doc);
  } catch (e) {} // keep the last rules we had
}
const getRouting = () => routing;
const handlers = {
  'routing:changed': async () => { await loadRouting(); ctx.scheduleAgentRun(); ctx.scheduleLocalRun(); return true; },
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordHit = (text, words) => words.find((w) => new RegExp('(^|[^a-z0-9])' + escapeRe(w) + '([^a-z0-9]|$)').test(text));
// → what made a task private (a word from his list, or something shaped like a card / social security number), or null
function privateMatch(t) {
  const text = [t.title, t.notes].concat((Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'you').map((h) => h.text))
    .map((x) => String(x || '')).join('\n').toLowerCase();
  const words = String(routing.private || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const hit = wordHit(text, words);
  if (hit) return hit;
  if (/(^|[^0-9])(\d[ -]?){12,18}\d([^0-9]|$)/.test(text)) return 'a card number';
  if (/(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/.test(text)) return 'a social security number';
  return null;
}
// → {lane: 'claude' | 'local' | 'ask', reason}
function routeTask(t) {
  const title = String(t.title || '');
  if (/(^|\s)#local\b/i.test(title)) return { lane: 'local', reason: 'tagged #local' };
  if (/(^|\s)#claude\b/i.test(title)) return { lane: 'claude', reason: 'tagged #claude' };
  const priv = privateMatch(t);
  if (priv) return { lane: 'local', reason: 'private: ' + priv };
  // an ongoing conversation (from before lanes existed) stays with whoever has been answering it
  const answered = (Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'claude').slice(-1)[0];
  if (answered) return { lane: answered.lane === 'local' ? 'local' : 'claude', reason: 'continuing the conversation' };
  const text = (title + '\n' + String(t.notes || '')).toLowerCase();
  for (const rule of routing.rules || []) {
    const words = String(rule.words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const hit = wordHit(text, words);
    if (hit && (rule.lane === 'claude' || rule.lane === 'local')) return { lane: rule.lane, reason: 'rule: ' + words.join(', ') };
  }
  const d = routing.default === 'local' || routing.default === 'claude' ? routing.default : 'ask';
  return { lane: d, reason: d === 'ask' ? 'no rule matched' : 'default' };
}
const laneOf = (t) => t.lane === 'claude' || t.lane === 'local' ? t.lane : routeTask(t).lane;
function isClaudeLane(t) { return laneOf(t) === 'claude'; }
// unassigned tasks whose route is 'ask': James picks (the renderer turns them into a question with two buttons)
const askedRoute = new Set();
function askForRoutes(raw) {
  let data;
  try { data = JSON.parse(raw != null ? raw : fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return; }
  const ask = (Array.isArray(data.tasks) ? data.tasks : []).filter((t) => t.ws === 'agent' && !t.done && (t.status || 'queued') === 'queued' &&
    !t.lane && laneOf(t) === 'ask' && !askedRoute.has(t.id + '|' + (t.updatedAt || 0)));
  if (!ask.length) return;
  ask.forEach((t) => askedRoute.add(t.id + '|' + (t.updatedAt || 0)));
  sendToRenderer('agent:route-ask', ask.map((t) => t.id));
}

module.exports = { init, handlers, loadRouting, useRouting, getRouting, privateMatch, routeTask, laneOf, isClaudeLane, askForRoutes, ROUTING_DEFAULT };
