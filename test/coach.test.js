const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const coach = require('../agent/coach');
const routing = require('../agent/routing');
const siteNotes = require('../agent/site-notes');

test('tasks only he can do are coach tasks', () => {
  [
    'Make the intro video for COMM 101',
    'Record video reflection for week 5',
    'Film my how-to video',
    'Upload my VoiceThread for HIST 1700',
    'Oral presentation on climate policy',
    'Give my presentation in class',
    'Prepare for the speech on Friday',
    'Prep for my job interview at Acme',
    'Speech due Thursday',
  ].forEach((title) => assert.ok(coach.isCoach({ title }), title));
});

test('tagged or asked for, it is a coach task whatever it says', () => {
  assert.ok(coach.isCoach({ title: 'week 3 discussion #coach' }));
  assert.ok(coach.isCoach({ title: 'Coach me: lab write-up' }));
  assert.ok(coach.isCoach({ title: 'What do I say for the group meeting' }));
  assert.ok(coach.isCoach({ title: 'Week 6', notes: 'Record a 3 minute video response to the reading' })); // from the instructions
});

test('research, errands and other lanes are not', () => {
  [
    'Find a video on photosynthesis',
    'Watch the lecture video',
    'Summarize the presentation slides',
    'Buy a tripod for my videos #claude',
    '#legion best microphones for recording video',
    'Book a dentist appointment',
    'Draft a cover letter',
    'Read chapter 4',
  ].forEach((title) => assert.ok(!coach.isCoach({ title }), title));
});

test('the topic drops the tag and the lead-in', () => {
  assert.strictEqual(coach.topicOf({ title: 'Coach me: record the intro video #coach' }), 'record the intro video');
  assert.strictEqual(coach.topicOf({ title: 'Make video for class #local' }), 'Make video for class');
});

test('coach tasks go to the local model, which is signed in to his courses', () => {
  routing.useRouting(null);
  assert.deepStrictEqual(routing.routeTask({ title: 'Make the intro video for COMM 101' }),
    { lane: 'local', reason: 'only you can do this one: your local model reads the assignment and coaches you' });
  assert.strictEqual(routing.routeTask({ title: 'Make the intro video #claude' }).lane, 'claude'); // his tag still wins
});

test('both school sites have notes that come with a coach task', () => {
  const notes = siteNotes.forUrls(siteNotes.load([path.join(__dirname, '..', 'agent', 'sites')]), coach.SCHOOL_HOSTS);
  assert.deepStrictEqual(notes.map((n) => n.name).sort(), ['Blackboard', 'D2L (Brightspace)']);
});

test('it gathers everything that makes a good video, the course first, and never submits', () => {
  ['instructions', 'rubric', 'format', 'due_submit', 'attachments', 'course_material', 'announcements', 'examples', 'feedback', 'his_notes', 'topic_facts']
    .forEach((p) => assert.match(coach.RULES, new RegExp('- ' + p)));
  assert.match(coach.RULES, /read_file/);
  assert.match(coach.RULES, /never the\s+assignment/);
  assert.match(coach.RULES, /never submit/);
});

test('keep_note keeps what it found, says what is still missing, and stops when full', () => {
  const d = {};
  assert.deepStrictEqual(coach.missing(d), ['instructions', 'rubric', 'format', 'due_submit']);
  assert.match(coach.keepNote(d, { part: 'nope', text: 'x' }), /part must be one of/);
  assert.match(coach.keepNote(d, { part: 'rubric', text: '' }), /Nothing to keep/);
  const r = coach.keepNote(d, { part: 'instructions', text: 'Record a 3-5 minute video introducing yourself.', source: 'https://x.blackboard.com/a' });
  assert.match(r, /Kept \(instructions\)/);
  assert.match(r, /Still to find: rubric, format, due_submit/);
  assert.match(coach.dossierText(d), /### instructions\nRecord a 3-5 minute video[\s\S]*from: https:\/\/x\.blackboard\.com\/a/);
  for (let i = 0; i < 12; i++) coach.keepNote(d, { part: 'course_material', text: 'y'.repeat(5000) });
  assert.ok(coach.dossierText(d).length <= 26500);
  assert.match(coach.keepNote(d, { part: 'rubric', text: 'z' }), /notes are full/);
});

test('the brief is written from the notes alone: what to do, what to say, rubric check', () => {
  const d = {}; coach.keepNote(d, { part: 'rubric', text: 'Eye contact: 5 pts' });
  const p = coach.WRITE_PROMPT('record the intro video', '2026-11-05', d);
  ['## What to do', '## What to say', '## Rubric check', '## Before you start', 'Eye contact: 5 pts', 'due 2026-11-05', 'ONLY'].forEach((x) => assert.ok(p.includes(x), x));
  const again = coach.WRITE_PROMPT('record the intro video', '', d, { reply: 'make it 2 minutes', before: '# Old brief' });
  assert.match(again, /make it 2 minutes/); assert.match(again, /# Old brief/);
});

test('a reply changes the brief; "look again" or "try again" goes back through the course', () => {
  assert.ok(!coach.wantsLookAgain('make it shorter, 2 minutes'));
  assert.ok(!coach.wantsLookAgain('I want to use my job as the example'));
  assert.ok(!coach.wantsLookAgain('write it'));
  ['try again', 'look again', 'I signed in', 'check the announcements again', ''].forEach((r) => assert.ok(coach.wantsLookAgain(r), r));
});

test('no emoji in coach mode: Lupa\'s brief and the live box lose any it adds', () => {
  // written as escapes, so nothing in the repo shows an emoji: clapper, pin, check, swords, keycap one
  assert.strictEqual(coach.noEmoji('\u{1F3AC} Coach: \u{1F4CC} Noted \u{2713} done \u{2694} deeper 1\u{FE0F}\u{20E3} step'), 'Coach: Noted done deeper 1 step');
  assert.strictEqual(coach.noEmoji('# Intro video \u{1F3A5}\n- \u{1F50E} Look at the rubric\n  - nested'), '# Intro video \n- Look at the rubric\n  - nested');
  assert.strictEqual(coach.noEmoji(null), '');
  assert.match(coach.WRITE_PROMPT('x', '', {}), /No emoji/);
  assert.doesNotMatch(coach.WRITE_PROMPT('x', '', {}) + coach.RULES, /\p{Extended_Pictographic}/u);
});
