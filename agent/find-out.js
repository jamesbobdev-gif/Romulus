/* Find out first: a task that only names a piece of school work ("chapter 8", "ch 8 hw", "module 3 quiz",
   "week 5"), with no class or no instructions. Instead of asking him "which class? what exactly?", Lupa (the
   only computer signed in to his Blackboard / D2L) works out which class it is from his School list, opens
   that class, finds the real item, and pins it down with pin_down_task: its class, its full name, due date,
   link and what it asks for. The window then rewrites his task with that (renderer/js/agent-results.js
   applyPinned), and Lupa goes on to do it in the same run. No Electron here, so it can be tested on its own. */

const COURSE = /^\s*([A-Za-z]{2,5})[ -]?(\d{3,4}[A-Za-z]?)\s*$/;

// the unit words a bare reference uses, and the one word each comes down to
const UNITS = {
  chapter: 'chapter', chapters: 'chapter', ch: 'chapter', chap: 'chapter', chpt: 'chapter',
  module: 'module', modules: 'module', mod: 'module',
  unit: 'unit', units: 'unit', week: 'week', weeks: 'week', wk: 'week', lesson: 'lesson', lessons: 'lesson',
  section: 'section', sec: 'section', topic: 'topic', lab: 'lab', labs: 'lab', lecture: 'lecture',
  quiz: 'quiz', test: 'test', exam: 'exam', homework: 'homework', hw: 'homework', assignment: 'assignment',
  ps: 'problem set', 'problem set': 'problem set', exercise: 'exercise', exercises: 'exercise',
  reading: 'reading', discussion: 'discussion', project: 'project', part: 'part',
};
const UNIT_RE = new RegExp('\\b(' + Object.keys(UNITS).sort((a, b) => b.length - a.length).map((w) => w.replace(' ', '\\s+')).join('|') +
  ')\\.?\\s*#?(\\d{1,3}[a-z]?)(?:\\.\\d+)?\\b', 'gi');
// "do the homework", "finish the reading for tomorrow": school work with nothing to tell which
const BARE = /^\s*(do|finish|start|complete|work on)?\s*(the|my)?\s*(homework|hw|reading|quiz|discussion( post)?|assignment|lab)\s*(for (today|tonight|tomorrow|this week|next week|class|(mon|tues|wednes|thurs|fri|satur|sun)day))?\s*$/i;
// a chapter of a book or a show is his own reading, not a class's
const NOT_SCHOOL = /\b(episode|season|manga|anime|novel|book club|audiobook|podcast|chapter \d+ of [A-Z])/;

const clean = (s) => String(s || '').replace(/(^|\s)#[a-z]+\b/gi, ' ').replace(/\s+/g, ' ').trim();
// "Ch. 8 HW" → [{unit:'chapter', n:'8'}, {unit:'homework'...}] (only the ones with a number)
function refs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(UNIT_RE)) out.push({ unit: UNITS[m[1].toLowerCase().replace(/\s+/g, ' ')], n: m[2].toLowerCase() });
  return out;
}
// the task says what it is already: instructions of its own, or a link to the page
const hasDetail = (t) => /https?:\/\//i.test(String(t.title || '') + String(t.notes || '')) || clean(t.notes).length >= 40;

function isVague(t) {
  if (!t) return false;
  const title = clean(t.title);
  if (!title || title.split(' ').length > 7 || NOT_SCHOOL.test(String(t.title || ''))) return false;
  if (/(^|\s)#(legion|research|coach)\b/i.test(String(t.title || ''))) return false;
  if (!refs(title).length && !BARE.test(title)) return false;
  // instructions or a link of its own say what it is already (a calendar item has both)
  return !hasDetail(t);
}

/* his School list, as clues to which class it is: per class, the items with the same unit word ("Chapter 7
   Homework", due last week), the likeliest class first (the one whose numbers come closest to this one) */
function clues(t, tasks) {
  const want = refs(clean(t && t.title));
  const school = (Array.isArray(tasks) ? tasks : []).filter((x) => x && x.id !== (t && t.id) && x.tag && (x.ws === 'school' || x.fromWs === 'school'));
  const byClass = {};
  for (const x of school) {
    const theirs = refs(x.title);
    const near = want.length ? Math.min(...want.map((w) => Math.min(...theirs.filter((r) => r.unit === w.unit).map((r) => Math.abs(parseInt(r.n, 10) - parseInt(w.n, 10))), 999))) : 999;
    const c = byClass[x.tag] = byClass[x.tag] || { course: x.tag, near: 999, items: [] };
    c.near = Math.min(c.near, near);
    if (near < 999 || !want.length) c.items.push(x);
  }
  const list = Object.values(byClass).sort((a, b) => a.near - b.near || a.course.localeCompare(b.course));
  list.forEach((c) => c.items.sort((a, b) => String(b.due || '').localeCompare(String(a.due || ''))));
  return list;
}
function cluesText(t, tasks) {
  const list = clues(t, tasks);
  const head = '\n\n## Clues from his School list';
  if (!list.length) return head + '\n(nothing on it yet: use search_my_data and his classes on the course sites)';
  const best = list[0].near < 999 && (list.length < 2 || list[1].near > list[0].near) ? list[0].course : null;
  return head + (t && t.tag ? '\nThe task is labeled ' + t.tag + ': that is the class, unless the course shows otherwise.' : '') +
    (best && !(t && t.tag) ? '\nLikeliest class: ' + best + ' (its numbering comes closest). Check it first.' : '') + '\n' +
    list.slice(0, 8).map((c) => '- ' + c.course + (c.items.length ? ': ' + c.items.slice(0, 5).map((x) => x.title + (x.due ? ' (due ' + x.due + ')' : '') + (x.done ? ' [done]' : '')).join('; ') : ': nothing numbered like this')).join('\n');
}

const PIN_TOOL = { type: 'function', function: { name: 'pin_down_task', description: 'Say what this task really is, once you have found it on the course site: his task is rewritten with it. Call it as soon as you are sure, before you start the work itself.', parameters: { type: 'object', properties: {
  course: { type: 'string', description: 'the course code only, like "ECN 201"' },
  title: { type: 'string', description: 'its full name as the course shows it, like "Chapter 8 Homework"' },
  due: { type: 'string', description: 'due date YYYY-MM-DD, or "" when the course gives none' },
  time: { type: 'string', description: 'due time HH:MM (24-hour), or ""' },
  link: { type: 'string', description: 'the address of the page it is on' },
  details: { type: 'string', description: 'two to four lines: what it asks for (how many questions, pages, what to read or post) and where it is done (Blackboard, D2L, Connect)' } }, required: ['course', 'title', 'details'] } } };

// one pin_down_task call → kept in pinned.item, and what the model is told back
function pin(pinned, args) {
  args = args || {};
  const m = String(args.course || '').match(COURSE);
  if (!m) return 'course must be the course code only, like "ECN 201".';
  const title = String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (title.length < 3) return 'Give its full name as the course shows it in title.';
  const details = String(args.details || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (details.length < 10) return 'Say in details what it asks for and where it is done.';
  let due = String(args.due || '').trim(), time = String(args.time || '').trim();
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(due + 'T12:00')))) return 'due must be YYYY-MM-DD, or "" when the course gives no date.';
  if (!due || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) time = '';
  const link = /^https:\/\//i.test(String(args.link || '')) ? String(args.link).slice(0, 500) : null;
  pinned.item = { course: m[1].toUpperCase() + ' ' + m[2].toUpperCase(), title, due: due || null, dueTime: time || null, details, url: link };
  return 'Pinned down: ' + pinned.item.course + ', ' + title + (due ? ' (due ' + due + (time ? ' ' + time : '') + ')' : '') +
    '. His task now says so. Now do it, as your usual rules say (anything final, like Submit or Post, waits for his yes).';
}

// what Lupa is told on top of its usual rules (agent/local-prompt.md)
const RULES = `

## This task only names the work: find out what it is first, then do it
The title only says something like "chapter 8": no class, or no instructions. Don't ask him which class
or what exactly. Find out yourself:
1. Which class: the clues from his School list below (a class whose numbering is near this one, or the
   label on the task), and search_my_data for anything else he wrote about it.
2. Open that class on the site "Where each of his classes is" names (his school's own address, never
   blackboard.com or d2l.com) and find the item: the content / modules, the assignments, the gradebook,
   a McGraw Hill Connect (or other publisher) link from the course, the syllabus schedule (read_file it).
   It is the one not done yet with the nearest due date. Not in the likeliest class? Try his other
   current classes before giving up.
3. As soon as you are sure, call pin_down_task with its class, its full name, due date, link and what it
   asks for. His task gets rewritten with that.
4. Then do it in the same run, the way you'd do that kind of work: read its instructions and attached
   files, then work it. Anything final (Submit, Post, starting a timed quiz or test) waits for his yes.
Only when two classes both have an open item that fits equally, or none does after looking in every
class, answer needs-you: name what you found in each and where you looked, and ask which one.
Signed out? Answer needs-you: he signs in on the mini PC's browser, then replies "try again".`;

const NOT_PINNED = 'Before you finish: you haven\'t pinned down what this task is (pin_down_task). Open the class on its site, ' +
  'find the item, and call pin_down_task, then do it. If you really couldn\'t find it, answer again and say per class where you looked.';

module.exports = { isVague, refs, clues, cluesText, PIN_TOOL, pin, RULES, NOT_PINNED };
