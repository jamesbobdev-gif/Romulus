/* Lanes: each Agent task goes to ONE worker — 'claude' (this computer's Claude runner) or 'local' (the user's
   own model on the mini PC). A task that already has a lane keeps it (switching changes it). A new one
   is routed by HIS rules, no AI involved: a #local / #claude tag in the title, then his rules in order
   (first match wins), then his default (claude, local, 'auto' = the app picks, or 'ask' = he picks). The
   rules live next to the agent list (doc {v, rules:[{words, lane}], default}) and are edited in ⚙ Settings
   on any device.
   'auto' looks at what is up right now (main.js keeps noteSituation current: is the mini PC answering, is
   any cloud AI connected, is Claude near its limit) and at what the task needs: the inbox, the open web
   and shopping go to the cloud; writing and forms go to the mini PC; anything else to the cloud (faster).
   With auto on, a rule that names a lane that's down hands the task to the other one instead of waiting.
   d1 (agent/decider.js, a small decision model on the mini PC) looks at each new task first: it adds to the
   private words, holds a stray scrap of talk instead of running it, and makes auto's cloud-or-mini-PC pick.
   Without d1 (mini PC off, model missing) the keyword rules here decide everything, as before. */
const fs = require('fs');
const supabase = require('./supabase');
const decider = require('./decider');
const { isLegion } = require('./legion');

let ctx = null; // { readConfig, dataFile, sendToRenderer, scheduleAgentRun, scheduleLocalRun }
function init(c) { ctx = c; decider.init(c); }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();
const sendToRenderer = (ch, p) => ctx.sendToRenderer(ch, p);

// private words: checked before his rules (only a #claude tag beats them); a match always stays on the mini PC
const PRIVATE_DEFAULT = 'password, passcode, pin number, bank, bank account, credit card, debit card, ssn, social security, ' +
  'passport, tax, taxes, salary, payslip, medical, doctor, health, therapy, therapist, prescription, grades, transcript, report card';
const ROUTING_DEFAULT = { v: 2, default: 'auto', private: PRIVATE_DEFAULT, rules: [
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
  // 'ask' was the starting default before auto existed: those docs move to auto (one he saves from now on is v2)
  if (!(routing.v >= 2) && (routing.default == null || routing.default === 'ask')) routing = Object.assign({}, routing, { default: 'auto' });
}
// what auto knows about right now: null = not checked yet (counted as up)
let situation = { localUp: null, cloudUp: null, claudeTight: false };
function noteSituation(s) { situation = Object.assign({}, situation, s); }
const up = (lane) => (lane === 'local' ? situation.localUp : situation.cloudUp) !== false;
const other = (lane) => (lane === 'local' ? 'claude' : 'local');
// words that mean the task needs the inbox, the open web or a purchase (cloud), or is writing / a form (mini PC)
const CLOUD_WORDS = ['email', 'emails', 'inbox', 'gmail', 'outlook', 'reply', 'send', 'calendar', 'meeting', 'buy', 'order', 'shop',
  'price', 'prices', 'cheapest', 'compare', 'book', 'reserve', 'flight', 'flights', 'hotel', 'tickets', 'research', 'news', 'latest',
  'today', 'weather', 'find', 'look up', 'search', 'website', 'http', 'https', 'www', 'amazon', 'review', 'reviews'];
const LOCAL_WORDS = ['write', 'rewrite', 'draft', 'essay', 'letter', 'cover letter', 'story', 'poem', 'proofread', 'edit', 'summarize',
  'summarise', 'outline', 'brainstorm', 'notes', 'fill', 'form', 'forms', 'apply', 'application', 'questionnaire', 'survey'];
// → {lane, reason} picked by the app
function autoRoute(text, t) {
  if (!up('local')) return { lane: 'claude', reason: 'auto: The local model isn’t answering' };
  if (!up('claude')) return { lane: 'local', reason: 'auto: no cloud AI is connected' };
  const d1 = t && decider.laneFor(t);
  if (d1) return { lane: d1, reason: d1 === 'local' ? 'auto: d1 says the local model can do this without the web' : 'auto: d1 says this needs the web' };
  const cloudHit = wordHit(text, CLOUD_WORDS), localHit = !cloudHit && wordHit(text, LOCAL_WORDS);
  if (cloudHit) return { lane: 'claude', reason: 'auto: needs the web or inbox (' + cloudHit + ')' };
  if (localHit) return { lane: 'local', reason: 'auto: writing/forms suit the local model (' + localHit + ')' };
  if (situation.claudeTight) return { lane: 'local', reason: 'auto: Claude is near its limit' };
  return { lane: 'claude', reason: 'auto: quickest for everyday tasks' };
}
// with auto on, a lane that's down hands over to the other one (only if that one is up)
function fallBack(r) {
  if (routing.default !== 'auto' || up(r.lane) || !up(other(r.lane))) return r;
  return { lane: other(r.lane), reason: r.reason + ', but ' + (r.lane === 'local' ? 'The local model isn’t answering' : 'no cloud AI is connected') };
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
  if (t && t.financeSeen) return 'his finances'; // The local model read Finance for it (agent/local-lane.js)
  const text = [t.title, t.notes].concat((Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'you').map((h) => h.text))
    .map((x) => String(x || '')).join('\n').toLowerCase();
  const words = String(routing.private || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const hit = wordHit(text, words);
  if (hit) return hit;
  if (/(^|[^0-9])(\d[ -]?){12,18}\d([^0-9]|$)/.test(text)) return 'a card number';
  if (/(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/.test(text)) return 'a social security number';
  if (decider.looksPrivate(t)) return 'd1 thinks it’s personal (health, money, IDs or grades)';
  return null;
}
/* a question about HIS money ("how much did I spend on gas", "my bank balance", "what are my bills"), which
   The local model answers from Finance on this computer (agent/local-lane.js). Not shopping ("budget $50", "compare costs") */
const MY_MONEY = new RegExp([
  '\\b(my|our)\\s+(spending|bank|accounts?|balances?|budget|bills|income|finances?|money|net worth|transactions?|statements?|subscriptions?|savings|portfolio|stocks|investments|expenses|purchases|paychecks?|credit cards?|debts?|cash flow|charges)\\b',
  '\\bhow much (did|have|has|do) (i|we) (spend|spent|pay|paid|earn|earned|make|made|save|saved|owe)\\b',
  '\\b(i|we) (spent|paid|earned|saved|owe)\\b',
  '\\bwhat did (i|we) (spend|buy|pay)\\b',
  '\\b(spent|spending|spend) on\\b',
  '\\b(income statement|balance sheet|net worth|contribution margin)\\b',
].join('|'), 'i');
function moneyQuestion(t) {
  const text = [t.title, t.notes, t.reply].concat((Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'you').slice(-2).map((h) => h.text))
    .map((x) => String(x || '')).join('\n');
  return MY_MONEY.test(text);
}
// → {lane: 'claude' | 'local' | 'ask', reason}
function routeTask(t) {
  const title = String(t.title || '');
  if (/(^|\s)#local\b/i.test(title)) return { lane: 'local', reason: 'tagged #local' };
  if (t.financeSeen) return { lane: 'local', reason: 'private: his finances' }; // not even #claude moves it
  if (ctx && ctx.finance && moneyQuestion(t)) return { lane: 'local', reason: 'about his money: The local model reads Finance' };
  // deep research: Lupa splits it so no cloud AI sees the whole request, and writes the report itself (agent/legion.js)
  if (isLegion(t)) return { lane: 'local', reason: 'deep research: Lupa leads a legion of cloud AIs' };
  if (/(^|\s)#claude\b/i.test(title)) return { lane: 'claude', reason: 'tagged #claude' };
  if (decider.looksLikeScrap(t)) return { lane: 'hold', reason: 'sounded like a stray bit of talk, not a request' }; // runs on neither
  const priv = privateMatch(t);
  if (priv) return { lane: 'local', reason: 'private: ' + priv };
  // an ongoing conversation (from before lanes existed) stays with whoever has been answering it
  const answered = (Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'claude').slice(-1)[0];
  if (answered) return { lane: answered.lane === 'local' ? 'local' : 'claude', reason: 'continuing the conversation' };
  const text = (title + '\n' + String(t.notes || '')).toLowerCase();
  for (const rule of routing.rules || []) {
    const words = String(rule.words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const hit = wordHit(text, words);
    if (hit && (rule.lane === 'claude' || rule.lane === 'local')) return fallBack({ lane: rule.lane, reason: 'rule: ' + words.join(', ') });
  }
  if (routing.default === 'auto') return autoRoute(text, t);
  const d = routing.default === 'local' || routing.default === 'claude' ? routing.default : 'ask';
  return { lane: d, reason: d === 'ask' ? 'no rule matched' : 'default' };
}
// a task the local model read his Finance for stays on the mini PC even if it was switched to Claude by hand
// a #legion task is Lupa's even if it was on Claude before (its title was edited): only Lupa may see the whole request
const laneOf = (t) => t.financeSeen || isLegion(t) ? 'local' : t.lane === 'claude' || t.lane === 'local' ? t.lane : routeTask(t).lane;
function isClaudeLane(t) { return laneOf(t) === 'claude'; }
// unassigned tasks whose route is 'ask': the user picks (the renderer turns them into a question with two buttons)
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

/* d1 sees new Agent tasks before they're routed. false = it's still looking (both runs are scheduled again
   once it's done); true = go ahead (decided, or d1 isn't available and the rules decide alone) */
let deciding = false;
const toldScrap = new Set();
function decided(raw) {
  if (deciding) return false;
  if (!decider.usable()) return true;
  let data;
  try { data = JSON.parse(raw != null ? raw : fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return true; }
  const fresh = (Array.isArray(data.tasks) ? data.tasks : []).filter((t) => t.ws === 'agent' && !t.done && (t.status || 'queued') === 'queued' &&
    !t.lane && !t.financeSeen && String(t.title || '').trim() && !decider.get(t));
  if (!fresh.length) return true;
  deciding = true;
  decider.decide(fresh).then(() => {
    // a scrap waits for him: it shows as needing him, and a reply (or the lane switch) sends it on
    const scraps = fresh.filter((t) => decider.looksLikeScrap(t) && !toldScrap.has(t.id));
    scraps.forEach((t) => toldScrap.add(t.id));
    if (scraps.length) sendToRenderer('agent:results', scraps.map((t) => ({ id: t.id, status: 'needs-you', options: undefined, pref: null,
      note: 'This sounded like a bit of conversation Hey Romulus picked up, not a request, so nothing ran. Reply if you meant it.' })));
  }).finally(() => { deciding = false; ctx.scheduleAgentRun(); ctx.scheduleLocalRun(); });
  return false;
}

module.exports = { init, decided, handlers, loadRouting, useRouting, getRouting, noteSituation, privateMatch, moneyQuestion, routeTask, laneOf, isClaudeLane, askForRoutes, ROUTING_DEFAULT };
