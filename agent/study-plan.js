/* Study plan: "Study plan for ECN 201 final", "prep for the BIO 101 midterm", "what's on the final". What the
   exam covers is on his course site (the exam's page, the syllabus and course schedule, a review guide, the
   professor's announcements), so asking him "which chapters?" is the wrong answer: a cloud AI can't open his
   classes and did exactly that. Lupa (the mini PC's model, the only one signed in to his Blackboard / D2L)
   goes through the course the way coach mode does (agent/coach.js), noting each thing with keep_note, then
   writes the plan from those notes alone in a pass of its own: what's on it, day by day until the exam,
   weak spots first. A reply ("I only have an hour a day") rewrites the plan from the same notes.
   No Electron here, so it can be tested on its own. */

const coach = require('./coach');

const TAG = /(^|\s)#study\b/i;
// what he wants: to get ready for it, or to know what's on it
const STUDY = /\b(study(ing)? (plan|guide|schedule|sheet|for|up)|help me study|review (for|sheet|guide)|prep(are|aring)? (me )?for|get(ting)? ready for|cram(ming)?( for)?|flash ?cards|(exam|test|final|midterm) (prep|review)|what('?s| is| will be) (on|covered (on|in)) (the|my|this)|what (topics|chapters|units|material) (is|are|will be) (on|covered)|what (does|will) (the|my) (final|midterm|exam|test|quiz) cover)\b/i;
// a class's exam. "test" alone is too many things (a hearing test, unit tests): only with a class word
const EXAM = /\b(finals?|midterms?|exams?|quiz(zes)?)\b/i;
const CLASS_TEST = /\btests?\b/i, CLASS_WORD = /\b(class|course|chapters?|ch\.? ?\d|units? \d|modules?|lectures?|professor|semester|school)\b/i;
// "final presentation", "final round interview": on his feet, coach mode's, not an exam
const SPOKEN = /\b(presentations?|speech(es)?|talks?|pitch(es)?|interviews?|videos?|demos?|recitals?|auditions?|round|projects?|papers?|oral)\b/i;
// a class by its code ("ECN 201", "MATH-1010"); a year or a form number ("IRS 1040", "ACL 2026") is not one
const COURSE = /\b([A-Z]{2,5})[ -]?(\d{3,4})[A-Z]?\b/g;
const NOT_COURSE = /^(IRS|HVAC|BBQ|ACL|CES|SXSW|WWDC|NBA|NFL|MLB|NHL|UFC|FIFA|USB|HDMI|RTX|GTX|DDR|COVID|SARS|ISO|ANSI|PS|XB|FY|Q|TV)$/;
const courseIn = (s) => [...String(s || '').matchAll(COURSE)].some((m) => !NOT_COURSE.test(m[1]) && !/^(19|20)\d\d$/.test(m[2]));
// tests that aren't a class: no course site has them
const NOT_CLASS = /\b(driv(er'?s?|ing)|permit|dmv|road test|citizenship|real estate|bar exam|blood test|drug test|covid|emissions|smog|test drive|eye exam|physical exam|hearing|vision|stress test|cpr|certification|cert)\b|\b(SAT|PSAT|ACT|GRE|GMAT|LSAT|MCAT|DAT|NCLEX|CDL|GED|CPA|TOEFL|IELTS|AWS|PMP|CompTIA)\b/;

// a class: a course code in the title, a label that is one (his School items carry the class as their tag), or from his School list
const isClass = (t, title) => courseIn(title) || courseIn(t && t.tag) || !!(t && (t.ws === 'school' || t.fromWs === 'school'));

function isStudy(t) {
  const title = String((t && t.title) || '');
  if (/(^|\s)#(legion|research|claude|coach)\b/i.test(title) || /^\s*coach me\b/i.test(title)) return false;
  if (TAG.test(title)) return true;
  if (!STUDY.test(title)) return false;
  // "prepare for the speech", "prep for my final presentation": his to do on his feet, coach mode's (an oral exam too)
  // ("help me prepare for the chemistry exam" reads as coach mode's lead-in, but an exam is a study plan)
  if (SPOKEN.test(title) || NOT_CLASS.test(title)) return false;
  const exam = EXAM.test(title) || (CLASS_TEST.test(title) && CLASS_WORD.test(title));
  if (coach.isCoach(t) && !exam) return false;
  // "study for ECN 201" names the class; otherwise it has to be a class's exam
  return isClass(t, title) ? exam || /\bstudy|cram|flash ?cards|review (for|sheet|guide)/i.test(title) : exam;
}
// "Study plan for ECN 201 final (Wed Dec 9) #study" → "Study plan for ECN 201 final (Wed Dec 9)"
const topicOf = (t) => String((t && t.title) || '').replace(/(^|\s)#(local|study)\b/gi, ' ').replace(/\s+/g, ' ').trim();

// what a good plan is built from, and where it is. The first two it must look for; the rest it notes when the course has them
const PARTS = {
  exam: 'the exam itself: date, time, where (in class, online, testing center), how long, the format (multiple choice, problems, essays), open or closed book, calculator or formula sheet, cumulative or not, its weight in the grade',
  coverage: 'what it covers, in the professor\'s words: the chapters, modules, topics or learning objectives named for it (the exam page, a review guide, an announcement, the syllabus)',
  schedule: 'the syllabus or course schedule: which chapters and topics were taught in which week (download it and read_file it)',
  review: 'a review or study guide, practice exam, sample questions or review session the professor posted, and what it says',
  materials: 'where each topic\'s material is: textbook chapters and sections, slides, lecture videos, McGraw Hill Connect or other publisher practice (SmartBook, LearnSmart), notes',
  announcements: 'the professor\'s announcements about the exam (what to focus on, changes, tips)',
  grades: 'his scores on this course\'s quizzes, homework and earlier exams, by chapter or topic (the weak spots go first in the plan)',
  his_notes: 'what he already has or said about it (search_my_data: his notes, earlier tasks for this course)',
};
const MUST = ['exam', 'coverage'];
const { KEEP_NOTE_TOOL, keepNote, missing, progress, dossierText } = coach.notebook(PARTS, MUST, 'study plan');

// what Lupa is told on top of its usual rules (agent/local-prompt.md) while it gathers
const RULES = `

## This is a study plan: what's on the exam comes from his course, not from him
Never ask him which chapters or topics the exam covers: his course site says, and you are signed in to it.
Your job now is to find EVERYTHING the course says about this exam. The plan is written afterwards from
your keep_note notes alone: anything you don't note is lost.

Go through these, noting each with keep_note as soon as you read it:
${Object.keys(PARTS).map((p) => '- ' + p + (MUST.includes(p) ? ' (must)' : '') + ': ' + PARTS[p]).join('\n')}

Where to look:
1. The class: the task names it (a code like ECN 201, or its label). If it doesn't, search_my_data and his
   School list's classes on "Where each of his classes is".
2. Open that class on the site "Where each of his classes is" names (his school's own address, never
   blackboard.com or d2l.com; the site notes below say where things are). Signed out? Answer needs-you:
   he signs in on the mini PC's browser, then replies "try again".
3. The exam's own page or calendar item, and Announcements: date, format, what it covers.
4. The syllabus and the course schedule (often a file under Syllabus, Course Information or Start Here):
   click to download, then read_file it. It lists the chapters week by week and how the final is weighted.
5. Content / Modules: the chapters or modules taught this term, and any review or study guide, practice
   exam or sample questions (open each, read_file any file).
6. His grades: which quizzes and homework went worst (those chapters go first).
7. A McGraw Hill Connect (or other publisher) link from the course: which chapters have practice there.
If the course really doesn't say what the final covers, note what was taught this term (the schedule and
modules) as coverage and say so.
Read only: never start, submit or post anything on the course site, not even a practice quiz that counts.

When you have looked everywhere, answer with the JSON: status "needs-you" and a note of one or two lines on
what you found and anything you couldn't find (where you looked). The plan itself is written next from your
notes: don't write it now.`;

// the second pass: the plan, from the notes alone. reply: his reply when he asked for changes; before: the last plan
const WRITE_PROMPT = (topic, due, dossier, { reply, before, gathered, today } = {}) => 'You are writing his study plan: ' + topic +
  (due ? ' (task due ' + due + ')' : '') + '. Today is ' + (today || new Date().toDateString()) + '. You went through his course and noted ' +
  'everything below. Write the plan from these notes ONLY: never make up a chapter, a topic, a date, a rule or a link. Where the notes ' +
  'don\'t say something he needs, say so plainly ("the course doesn\'t say if it is cumulative: ask the professor").\n\n## Your notes from the course\n\n' +
  (dossierText(dossier) || '(nothing was found)') + (gathered ? '\n\n## What you said after looking\n' + gathered : '') +
  (before ? '\n\n## The plan you gave him before\n' + before : '') + (reply ? '\n\n## What he asked for now\n' + reply +
    '\nRewrite the plan with that change. Keep everything else that still holds.' : '') +
  '\n\n## Write the plan\nMarkdown, in this order:\n' +
  '# Study plan: <the exam> (<its date and time>)\n' +
  '**What\'s on it:** the chapters and topics, straight from the course, and where that came from.\n' +
  '**The exam:** format, length, what is allowed, its weight, and where it is (skip what the notes don\'t say).\n' +
  '## Day by day\n(one line per day from today until the day before the exam, each with the date, the chapters or topics, what to ' +
  'do with them (re-read which sections, which Connect practice, which quiz to redo, which review-guide questions) and about how ' +
  'long. Weak spots from his grades come first; earlier chapters come back for a short review later; the last day or two are a full ' +
  'review and a practice run. Fit the whole thing between today and the exam.)\n' +
  '## Topic checklist\n(every chapter or topic on it, one per line, with where its material is)\n' +
  '## From the professor\n(the review guide and announcements as do\'s and don\'ts; skip if none)\n' +
  '## Couldn\'t find\n(anything that matters and wasn\'t in the course; skip if nothing)\n' +
  '## Where it came from\n(the pages and files, one per line)\n' +
  'No emoji anywhere: he doesn\'t want them. Answer with the Markdown only.';

// how agent/local-lane.js runs it (the same shape as agent/coach.js)
const WRITING = 'Writing your study plan from everything it found (a few minutes on a local model)…';
const FOLDER = 'Study plans', KIND = 'study';
const AFTER = 'Reply with changes ("I only have an hour a day", "chapter 3 is easy for me") and it rewrites this; reply “look again” to go back through the course.';
const LOOK_MORE = 'Look for the missing ones (the exam\'s page or calendar item, Announcements, the syllabus and course schedule with read_file, ' +
  'a review guide in Content / Modules) and keep_note each. If one really isn\'t in the course, answer again and say where you looked.';

module.exports = { isStudy, topicOf, RULES, PARTS, MUST, KEEP_NOTE_TOOL, keepNote, missing, progress, dossierText, WRITE_PROMPT,
  wantsLookAgain: coach.wantsLookAgain, noEmoji: coach.noEmoji, SCHOOL_HOSTS: coach.SCHOOL_HOSTS, WRITING, FOLDER, KIND, AFTER, LOOK_MORE };
