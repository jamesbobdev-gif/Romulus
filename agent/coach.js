/* Coach: a task only he can do (record the video for class, give the presentation, the speech, the interview).
   The Agent can't do it for him, so instead of "I can't" it gets him ready: Lupa (the mini PC's model, the
   only one signed in to his Blackboard / D2L) goes through everything the course has on it (the assignment,
   its attachments and rubric, the week's material, the professor's announcements, his earlier feedback),
   sends the outside research to his cloud AIs the legion way (each gets one general question, none sees the
   assignment), and writes him a brief: what to do, step by step, and what to say, word for word.
   Two passes: it gathers with the browser, noting each thing it finds with keep_note (its memory keeps only
   the latest page in full, so a page read 20 steps ago is gone by the end), then writes the brief from those
   notes alone, with a fresh context. A reply rewrites the brief from the same notes without browsing again.
   Tagged #coach, starting "Coach me:", or a human-only act in the title. No Electron here, so it can be tested on its own. */

const TAG = /(^|\s)#coach\b/i;
const LEAD_IN = /^\s*(coach me|help me (do|prep(are)?( for)?)|prep me( for)?|what do i (say|do) for)\s*[:\-–]?\s*/i;
/* what only he can do: be on camera or on the mic, stand up in front of people, show up in person.
   "make a video" counts, "find a video" or "watch the video" doesn't */
const HUMAN_ONLY = new RegExp([
  '\\b(record|film|shoot|make|create|do|tape|upload|submit|post)\\b[^.\\n]{0,40}\\b(videos?|vlogs?|video (essay|response|reflection|presentation)|recordings?|voice ?threads?|flip ?grids?|podcasts?|screencasts?)\\b',
  '\\b(video|oral|recorded|voice|audio) (presentation|reflection|response|introduction|intro|assignment|essay|pitch|report)s?\\b',
  '\\b(give|do|present|deliver|practice|prep(are)?( for)?)\\b[^.\\n]{0,30}\\b(presentation|speech|talk|pitch|demo|toast|eulogy|oral (exam|report))s?\\b',
  '\\b(present|presenting) (in|to) (class|the class)\\b',
  '\\b(job |mock |phone |video )?interview (prep|practice)\\b|\\bprep(are)? for (my |the |an? )?(job |phone |video )?interview\\b',
  '\\b(speech|presentation|oral exam|oral report|lab practical|in-person|in person)\\b[^.\\n]{0,20}\\b(due|today|tomorrow|on|for)\\b',
].join('|'), 'i');
// "Find a video on photosynthesis" is research, not something only he can do
const NOT_HIS = /^\s*(find|look up|search|research|watch|summari[sz]e|transcribe|download|compare)\b/i;

const isCoach = (t) => {
  const title = String((t && t.title) || '');
  if (TAG.test(title) || LEAD_IN.test(title)) return true;
  if (/(^|\s)#(legion|research|claude)\b/i.test(title) || NOT_HIS.test(title)) return false;
  return HUMAN_ONLY.test(title + '\n' + String((t && t.notes) || '').slice(0, 400));
};
// "Coach me: record the intro video #coach" → "record the intro video"
const topicOf = (t) => String((t && t.title) || '').replace(TAG, ' ').replace(LEAD_IN, '').replace(/(^|\s)#(local|coach)\b/gi, ' ').replace(/\s+/g, ' ').trim();

// his school sites, so their site notes come with the task even though it has no link to them yet
const SCHOOL_HOSTS = ['https://school.blackboard.com', 'https://school.brightspace.com'];

/* what makes a good video (or talk), and where it is. The first four it must look for; the rest it notes when
   the course has them. Each is one keep_note "part". */
const PARTS = {
  instructions: 'the full assignment instructions, every requirement and question it must answer, in the professor\'s words',
  rubric: 'the rubric or grading criteria: each criterion and what earns full points',
  format: 'length or time limit, camera / face / slides, which tool to record or upload in, file type, group or solo, who it is for',
  due_submit: 'due date and time, late policy, and exactly how and where to submit',
  attachments: 'what the attached files say (instruction sheet, template, rubric file, example): download each and read_file it',
  course_material: 'the readings, slides or lecture of the week or module the assignment sits in: the ideas, terms and examples it should use',
  announcements: 'announcements or discussion posts from the professor about this assignment (tips, changes, what they want to see)',
  examples: 'sample or example videos/presentations the professor posted, and what makes them good',
  feedback: 'his earlier feedback or grades on similar work in this course (what to fix this time)',
  his_notes: 'what he already has or said about it (search_my_data: his notes, earlier tasks for this course)',
  topic_facts: 'outside facts the topic needs that the course doesn\'t give (from ask_helpers or the web), with sources',
};
const MUST = ['instructions', 'rubric', 'format', 'due_submit'];
const NOTE_CHARS = 3500, DOSSIER_CHARS = 26000;

const KEEP_NOTE_TOOL = { type: 'function', function: { name: 'keep_note', description: 'Keep what you found for his brief. Your memory only keeps the latest page, so note everything that matters as soon as you read it: the brief is written from these notes alone. Copy the important parts close to word for word.', parameters: { type: 'object', properties: {
  part: { type: 'string', enum: Object.keys(PARTS) }, text: { type: 'string', description: 'what you found, close to the exact words' }, source: { type: 'string', description: 'the page address or file name it came from' } }, required: ['part', 'text'] } } };

// the notes so far: {part: [{text, source}]}. → the result the model sees
function keepNote(dossier, args) {
  const part = PARTS[args && args.part] ? args.part : null;
  const text = String((args && args.text) || '').trim();
  if (!part) return 'part must be one of: ' + Object.keys(PARTS).join(', ');
  if (!text) return 'Nothing to keep: put what you found in text.';
  const used = dossierText(dossier).length;
  if (used >= DOSSIER_CHARS) return 'Your notes are full. Answer now: the brief gets written from them.';
  (dossier[part] = dossier[part] || []).push({ text: text.slice(0, Math.min(NOTE_CHARS, DOSSIER_CHARS - used)), source: String((args && args.source) || '').slice(0, 300) });
  return 'Kept (' + part + '). ' + progress(dossier);
}
const missing = (dossier) => MUST.filter((p) => !(dossier[p] && dossier[p].length));
function progress(dossier) {
  const have = Object.keys(PARTS).filter((p) => dossier[p] && dossier[p].length);
  const need = missing(dossier), may = Object.keys(PARTS).filter((p) => !have.includes(p) && !MUST.includes(p));
  return 'Notes so far: ' + (have.join(', ') || 'none') + '.' + (need.length ? ' Still to find: ' + need.join(', ') + '.' : '') +
    (may.length ? ' If the course has them: ' + may.join(', ') + '.' : '');
}
function dossierText(dossier) {
  return Object.keys(PARTS).filter((p) => dossier[p] && dossier[p].length)
    .map((p) => '### ' + p + '\n' + dossier[p].map((n) => n.text + (n.source ? '\n(from: ' + n.source + ')' : '')).join('\n\n')).join('\n\n');
}

// what Lupa is told on top of its usual rules (agent/local-prompt.md) while it gathers
const RULES = `

## This is something only he can do (coach mode): gather first
He has to do this one himself (be on camera, speak, show up). You can't do it and must not say
"I can't": your job is to find EVERYTHING the course says about it, so the brief he gets covers it all.
The brief is written afterwards from your keep_note notes alone: anything you don't note is lost.

Go through these, in order, noting each with keep_note as soon as you read it:
${Object.keys(PARTS).map((p) => '- ' + p + (MUST.includes(p) ? ' (must)' : '') + ': ' + PARTS[p]).join('\n')}

Where to look:
1. Use search_my_data first for the course name or code if the task doesn't say it.
2. Open the course on Blackboard or D2L (his school's address is in his preferences; the site notes
   below say where things are). Find the assignment itself (Assignments / the module or week it's in /
   the calendar item) and read ALL of it. Signed out? Answer needs-you: he signs in on the mini PC's
   browser, then replies "try again".
3. Every attachment on it (an instruction sheet, a template, a rubric file): click it to download, then
   read_file it. A rubric often sits behind a "View Rubric" / "Grading criteria" link: open it.
4. The module or week it sits in: the readings, slides or lecture it builds on (read the pages and files
   the instructions name, and skim the rest of that week for the main ideas).
5. Announcements, and any discussion or Q&A thread about this assignment.
6. His grades or feedback on earlier work in the course, if it's there (what to fix this time).
7. Research the topic outside the course only for what the course doesn't cover: ask_helpers, the
   legion way: each question general and on its own (a fact, a definition, an example), never the
   assignment itself, the course, the school or anything about him. Up to 4 questions. Note the answers
   as topic_facts with their sources.
Read only: never submit, upload, post, record or start anything on the course site.

When you have looked everywhere, answer with the JSON: status "needs-you" and a note of one or two lines
on what you found and anything you couldn't find (where you looked). The brief itself is written next
from your notes: don't write it now.`;

// the second pass: the brief, from the notes alone. reply: his reply when he asked for changes; before: the last brief
const WRITE_PROMPT = (topic, due, dossier, { reply, before, gathered } = {}) => 'You are getting him ready to do this himself: ' + topic +
  (due ? ' (due ' + due + ')' : '') + '. You went through his course and noted everything below. Write his brief from these notes ' +
  'ONLY: never make up a requirement, a criterion, a date, a fact or a link. Where the notes don\'t say something he needs, say so ' +
  'plainly ("the instructions don\'t give a time limit: check with the professor").\n\n## Your notes from the course\n\n' +
  (dossierText(dossier) || '(nothing was found)') + (gathered ? '\n\n## What you said after looking\n' + gathered : '') +
  (before ? '\n\n## The brief you gave him before\n' + before : '') + (reply ? '\n\n## What he asked for now\n' + reply +
    '\nRewrite the brief with that change. Keep everything else that still holds.' : '') +
  '\n\n## Write the brief\nMarkdown, in this order:\n' +
  '# <what it is> (due <date and time>)\n' +
  '**What they want:** 2–3 lines straight from the instructions (length, format, where it goes).\n' +
  '## Before you start\n(what to have ready: setup, notes, slides, a quiet room, the recording tool and how to open it)\n' +
  '## What to do\n(numbered steps, from setting up to submitted, with how to submit)\n' +
  '## What to say\n(the script, word for word, in the parts the instructions ask for, each part headed with roughly how long it ' +
  'takes spoken, at ~130 words a minute, so the whole fits the time limit. Use the ideas, terms and examples from the course ' +
  'material and the topic facts. Written as he\'d say it: plain, first person, short sentences. Put [his own example] where only ' +
  'he can fill it in.)\n' +
  '## Rubric check\n(every rubric criterion → where the script covers it; say if one isn\'t covered and how to cover it)\n' +
  '## Tips from the course\n(the professor\'s announcements, examples and his earlier feedback, as do\'s and don\'ts; skip if none)\n' +
  '## Couldn\'t find\n(anything that matters and wasn\'t in the course; skip if nothing)\n' +
  '## Where it came from\n(the pages and files, one per line)\n' +
  'If the topic needed more research than the notes have, end with one line: "⚔ For a deeper look, add a #legion task: ' +
  '<a research question that names the topic, not the course>".\nAnswer with the Markdown only.';

// his reply sends Lupa back to the course (signed in now, "look again"), or just changes the brief
const LOOK_AGAIN = /\b(try again|(look|check|go|read)\b[^.\n]{0,40}\bagain|re-?check|start over|from scratch|signed in|logged in|go back to|look (at|for|in)|find|open)\b/i;
const wantsLookAgain = (reply) => !String(reply || '').trim() || LOOK_AGAIN.test(String(reply));

module.exports = { isCoach, topicOf, RULES, SCHOOL_HOSTS, PARTS, MUST, KEEP_NOTE_TOOL, keepNote, missing, progress, dossierText, WRITE_PROMPT, wantsLookAgain };
