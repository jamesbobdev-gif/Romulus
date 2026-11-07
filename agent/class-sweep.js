/* Class sweep: the classes his school calendar links leave out. Blackboard's calendar only lists work a
   professor gave a due date inside Blackboard, so a class run from McGraw Hill Connect, a syllabus schedule
   or undated modules never reached the School list at all. Once a week Lupa (the
   only computer signed in to his Blackboard / D2L) opens his course list, goes through each current class,
   and notes the work still to do with add_class_item; the window adds those to the School list
   (renderer/js/wiring.js importClassItems), skipping what the calendar or he already put there.
   Read only, like coach mode. One task, id CLASS_SWEEP_ID, made by the window when he has a course
   calendar and a local model. No Electron here, so it can be tested on its own. */

const crypto = require('crypto');

const CLASS_SWEEP_ID = 'class-sweep';
const isSweep = (t) => !!t && (t.id === CLASS_SWEEP_ID || t.classSweep === true);

const KINDS = ['assignment', 'quiz', 'exam', 'project', 'discussion', 'reading', 'other'];
const MAX_ITEMS = 60, MAX_UNDATED = 15;
const COURSE = /^\s*([A-Za-z]{2,5})[ -]?(\d{3,4}[A-Za-z]?)\s*$/;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

const ADD_ITEM_TOOL = { type: 'function', function: { name: 'add_class_item', description: 'Put one piece of work still to do in a class on his School list. Call it as soon as you read it on the page: your memory only keeps the latest page. One call per assignment, quiz, exam, discussion or reading.', parameters: { type: 'object', properties: {
  course: { type: 'string', description: 'the course code only, like "BIO 101"' },
  title: { type: 'string', description: 'its name as the course shows it, like "Chapter 9 Homework"' },
  due: { type: 'string', description: 'due date YYYY-MM-DD, or "" when the course gives none' },
  time: { type: 'string', description: 'due time HH:MM (24-hour), or ""' },
  kind: { type: 'string', enum: KINDS },
  link: { type: 'string', description: 'the page address it is on' },
  details: { type: 'string', description: 'one or two lines: what it is and where it is done (Blackboard, Connect, in class)' } }, required: ['course', 'title', 'due', 'kind'] } } };

const kindFor = (k, title) => {
  if (k === 'exam' && !/\b(reflection|review|wrapper|corrections?|prep|practice)\b/i.test(title)) return 'exam';
  if (k === 'project') return 'project';
  return 'regular';
};
// a stable id per class and assignment, so the next sweep updates it instead of adding a copy
const itemId = (course, title) => 'bbs-' + crypto.createHash('sha1')
  .update(course + '|' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 20);

/* one add_class_item call → kept in found (an array), and what the model is told back.
   now: for the date window (a day back, four months ahead) */
function addItem(found, args, now = new Date()) {
  args = args || {};
  const m = String(args.course || '').match(COURSE);
  if (!m) return 'course must be the course code only, like "BIO 101".';
  const course = m[1].toUpperCase() + ' ' + m[2].toUpperCase();
  const title = String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (title.length < 3) return 'Give its name as the course shows it in title.';
  let due = String(args.due || '').trim(), time = String(args.time || '').trim();
  if (due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(due + 'T12:00'))) return 'due must be YYYY-MM-DD, or "" when the course gives no date.';
    const back = new Date(now.getTime() - 864e5), ahead = new Date(now.getTime() + 120 * 864e5);
    if (due < ymd(back)) return 'Not added: ' + due + ' is past. Only add work that is still to do.';
    if (due > ymd(ahead)) return 'Not added: ' + due + ' is more than four months off. Check the year.';
  }
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) time = '';
  if (!due) time = '';
  if (found.length >= MAX_ITEMS) return 'The list is full (' + MAX_ITEMS + '). Answer now.';
  if (!due && found.filter((x) => !x.due).length >= MAX_UNDATED) return 'Enough undated items. Only add ones with a due date now.';
  const id = itemId(course, title);
  const link = /^https:\/\//i.test(String(args.link || '')) ? String(args.link).slice(0, 500) : null;
  const item = { id, course, title, due: due || null, dueTime: time || null, kind: kindFor(args.kind, title),
    notes: String(args.details || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null, url: link,
    source: link ? new URL(link).hostname.toLowerCase() : null };
  const at = found.findIndex((x) => x.id === id);
  if (at >= 0) { found[at] = item; return 'Updated ' + course + ': ' + title + '. ' + count(found); }
  found.push(item);
  return 'Added ' + course + ': ' + title + (due ? ' (due ' + due + (time ? ' ' + time : '') + ')' : ' (no date)') + '. ' + count(found);
}
function count(found) {
  const by = {};
  found.forEach((x) => { by[x.course] = (by[x.course] || 0) + 1; });
  return 'So far: ' + Object.keys(by).map((c) => c + ' ' + by[c]).join(', ') + '.';
}

/* what's on his School list already, so it doesn't add those again: upcoming and undated, open ones */
function listedText(tasks, now = new Date()) {
  const today = ymd(now);
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.ws === 'school' && !t.done && (!t.due || t.due >= today))
    .sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9'))).slice(0, 60);
  if (!open.length) return '\n\n## Already on his School list\n(nothing yet)';
  return '\n\n## Already on his School list (don\'t add these again)\n' +
    open.map((t) => '- ' + (t.tag ? t.tag + ': ' : '') + t.title + (t.due ? ' (due ' + t.due + ')' : '')).join('\n');
}

// what Lupa is told on top of its usual rules (agent/local-prompt.md)
const RULES = `

## This is the weekly class sweep: find his work the calendar misses
His School list gets its items from his schools' calendar links, and those only list work a professor
dated inside Blackboard / D2L. Whole classes are missing (work kept on McGraw Hill Connect, in a syllabus
schedule, or in undated modules). Your job: go through EVERY current class he has and put the work still
to do on his School list with add_class_item.

1. Open each school site "Where each of his classes is" and his preferences name (his own address, never
   blackboard.com or d2l.com). Blackboard: /ultra/course lists his courses. D2L: /d2l/home.
   Only this term's classes: skip ones that ended (an older term, "Closed", "Completed").
2. For each class, open it and look where work is:
   - the course outline / content: the current and next modules, and items with a due date on them
   - its grades page (Blackboard: Gradebook in the course menu), which lists graded work with due dates
   - a McGraw Hill Connect (or other publisher) link: open it from the course and read its assignment
     list with the due dates
   - no dates anywhere: the syllabus or course schedule (download it, then read_file it) for the next
     three weeks
3. Call add_class_item for each piece of work not finished and not past due, as soon as you read it.
   Use the course code ("BIO 101"), the name as the course shows it, and the due date and time. Work with
   no date at all: only the current module's, at most a few per class.
4. Skip anything on "Already on his School list" below, and anything marked done or submitted.
Read only: never submit, post, start a quiz or test attempt, or click anything that does.
Signed out? Stop and answer needs-you: he signs in on the mini PC's browser, then replies "try again".

When you have been through every class, answer with the JSON: status "done" and a note that says, per
class, how many items you added and where they were (Blackboard, Connect, syllabus), and any class you
couldn't read and why. Plain text, no emoji.`;

module.exports = { CLASS_SWEEP_ID, isSweep, ADD_ITEM_TOOL, addItem, listedText, itemId, RULES, KINDS, MAX_ITEMS };
