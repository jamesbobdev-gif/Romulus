/* How-tos: what worked on a finished task, kept for the next similar one ("Blackboard → Courses →
   ENT 300 → Calendar lists everything due; Assignments misses quizzes"). After a run that didn't get
   stuck, the model may leave 2–3 lines; the next task that shares enough words (or the same site plus
   a word) gets the closest one or two in its instructions, marked as possibly out of date.
   A newer how-to for the same kind of task replaces the old one. Stored on this computer only:
   <userData>/task-howtos.json. No Electron here, so it can be tested on its own. */
const fs = require('fs');

const MAX_KEPT = 60;
const MAX_LEN = 400; // every line of instructions is re-read on each of the mini PC's steps
const STOP = new Set(('a an the my me i you your our for of on in at to from up out into onto through about and or but ' +
  'is are be it this that what which who with please can could should would will just also some any all ' +
  'look find get check see go use do make help try want need have has had new next last one ' +
  'what\'s whats im i\'m it\'s due today tomorrow week local claude').split(' '));
const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };

// the words that say what a task is about (singular-ish, so "internships" matches "internship")
function keyWords(text) {
  return [...new Set((String(text || '').toLowerCase().replace(/#\S+/g, ' ').match(/[a-z0-9$][a-z0-9$'+]{2,}/g) || [])
    .map((w) => w.replace(/'s$/, '').replace(/(?<=[a-z]{3})s$/, ''))
    .filter((w) => !STOP.has(w)))];
}

function load(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter((h) => h && h.id && h.text) : []; }
  catch (e) { return []; }
}
function save(file, list) { fs.writeFileSync(file, JSON.stringify(list.slice(-MAX_KEPT), null, 1)); }

// how close a stored how-to is to this task: shared key words, and the same site counts for two
function score(h, words, hosts) {
  const shared = (h.words || []).filter((w) => words.includes(w)).length;
  const site = (h.sites || []).some((s) => hosts.some((x) => x === s || x.endsWith('.' + s) || s.endsWith('.' + x)));
  // one long, specific word ("entrepreneurship", "internship") says enough on its own
  const specific = (h.words || []).some((w) => w.length >= 8 && words.includes(w));
  return { shared, site, specific, total: shared + (site ? 2 : 0) };
}
// the closest few for a task: 2+ shared words, its site plus 1 word, or one specific word
function forTask(list, text, urls, max = 2) {
  const words = keyWords(text), hosts = (urls || []).map((u) => /^https?:\/\//i.test(u) ? hostOf(u) : String(u).toLowerCase()).filter(Boolean);
  return list.map((h) => ({ h, s: score(h, words, hosts) }))
    .filter((x) => x.s.shared >= 2 || (x.s.shared >= 1 && (x.s.site || x.s.specific)))
    .sort((a, b) => b.s.total - a.s.total || String(b.h.date).localeCompare(String(a.h.date)))
    .slice(0, max).map((x) => x.h);
}

// one how-to as the model reads it
const show = (h) => '- For "' + h.task + '" (' + h.date + (h.lane === 'local' ? ', mini PC' : ', Claude') + '): ' + h.text;

/* keep what worked. Never his details: anything with an email, phone or long number is dropped. A
   how-to for (nearly) the same task, on the same site, is replaced, so a better way wins. */
function learn(list, { task, text, urls, lane, today }) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (text.length < 20) return null;
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN - 1) + '…';
  if (/@|\d{3}[\s.-]?\d{3,}|\b\d{6,}\b/.test(text)) return null;
  const words = keyWords(task);
  if (!words.length) return null;
  const sites = [...new Set((urls || []).map(hostOf).filter(Boolean))].slice(0, 4);
  const same = (h) => { const s = score(h, words, sites); return s.shared >= Math.max(2, Math.ceil(Math.min(words.length, (h.words || []).length) * 0.6)) && (s.site || !sites.length || !(h.sites || []).length); };
  const rest = list.filter((h) => !same(h));
  const h = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), task: String(task).slice(0, 120), words, sites, text, lane: lane === 'local' ? 'local' : 'claude', date: today };
  return { list: rest.concat(h), replaced: list.length - rest.length, howto: h };
}

module.exports = { load, save, forTask, show, learn, keyWords };
