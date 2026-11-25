const test = require('node:test');
const assert = require('node:assert');
const sp = require('../agent/study-plan');
const coach = require('../agent/coach');
const routing = require('../agent/routing');
const cs = require('../agent/course-sites');

test('getting ready for a class exam is a study plan', () => {
  [
    'Study plan for ECN 201 final (Wed Dec 9)',
    'Study for the BIO 101 midterm',
    'prep for my stats final',
    'Help me prepare for the chemistry exam',
    'Review for the quiz on Friday',
    'Cram for finals',
    "What's on the ECN 201 final?",
    'What will the midterm cover',
    'Study for ECN 201',
    'exam review #study',
    'What topics are on the ECN 201 final',
    'Make flashcards for the ECN 201 final',
    'Prep me for the BIO 101 midterm',
    'Study for the chapter 5 test',
  ].forEach((title) => assert.ok(sp.isStudy({ title }), title));
  assert.ok(sp.isStudy({ title: 'Study guide for the final', tag: 'ECN 201' }));
  assert.ok(sp.isStudy({ title: 'Study for it', fromWs: 'school', tag: 'ECN 201' }));
});

test('a plain label, a year or a form number is not a class', () => {
  [
    { title: 'Review for the meeting', tag: 'work' },
    { title: 'Get ready for the party', tag: 'look-ahead' },
    { title: "Prepare for Monday's client meeting", tag: 'look-ahead' },
    { title: 'Get ready for the IRS 1040 deadline' },
    { title: 'Prepare for the ACL 2026 conference' },
    { title: 'Get ready for the hearing test' },
    { title: 'Prep for my CPR test' },
    { title: 'Prepare for the unit tests' },
    { title: 'Prep for the stress test' },
  ].forEach((t) => assert.ok(!sp.isStudy(t), t.title));
});

test('a final presentation or interview stays with coach mode', () => {
  ['Prepare for my final speech', 'Help me prepare for the final presentation in COM 110', 'Prep for my final interview']
    .forEach((title) => { assert.ok(!sp.isStudy({ title }), title); });
  assert.ok(coach.isCoach({ title: 'Help me prepare for the final presentation in COM 110' }));
});

test('other studying, tests that are not a class, and other lanes are not', () => {
  [
    'Study abroad application',
    'Study for my driving test',
    'Prep for the SAT',
    'Study plan for the GRE',
    'Prepare for the speech on Friday',
    'Prep for my job interview at Acme',
    'Study plan for ECN 201 final #claude',
    '#legion how to study for finals',
    'Coach me: study for the final',
    'Do the practice test for chapter 5',
    'Buy a test tube rack',
  ].forEach((title) => assert.ok(!sp.isStudy({ title }), title));
});

test('a study plan goes to the local model, which is signed in to his classes', () => {
  routing.useRouting(null);
  const r = routing.routeTask({ title: 'Study plan for ECN 201 final (Wed Dec 9)', notes: 'Want me to find the study material?' });
  assert.strictEqual(r.lane, 'local');
  assert.match(r.reason, /reads the course/);
  // a cloud AI had it first (the look-ahead sent it there): it moves, because no cloud AI can open his courses
  assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final (Wed Dec 9)', lane: 'claude' }), 'local');
  assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final #claude', lane: 'claude' }), 'claude'); // his tag still wins
  // he switched it to a cloud AI himself on its pill: that sticks ("Keep Gemini" alone isn't a switch)
  assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final', lane: 'claude', lanePick: 'claude' }), 'claude');
  assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final', lane: 'claude', laneOk: true }), 'local');
});

test('with the local model off, a study plan stays with the cloud AIs, which read the course in the browser', () => {
  routing.useRouting(null);
  routing.noteSituation({ localUp: false, cloudUp: true });
  try {
    const r = routing.routeTask({ title: 'Study plan for ECN 201 final (Wed Dec 9)' });
    assert.strictEqual(r.lane, 'claude');
    assert.match(r.reason, /cloud AI reads the course/);
    assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final (Wed Dec 9)', lane: 'claude' }), 'claude');
    assert.strictEqual(routing.laneOf({ title: 'Make the intro video for COMM 101', lane: 'claude' }), 'local'); // a coach brief still waits for it
    // one Lupa had before it went off: the cloud AIs take it (unless he pinned it to Lupa himself)
    assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final', lane: 'local' }), 'claude');
    assert.strictEqual(routing.laneOf({ title: 'Study plan for ECN 201 final', lane: 'local', lanePick: 'local' }), 'local');
    // his private words still keep it on his own computer
    routing.useRouting({ v: 2, default: 'auto', private: 'adhd', rules: [] });
    const priv = routing.routeTask({ title: 'Study plan for PSY 210 final (my ADHD accommodations)' });
    assert.strictEqual(priv.lane, 'local');
    assert.match(priv.reason, /private/);
    assert.strictEqual(routing.laneOf({ title: 'Study plan for PSY 210 final (my ADHD accommodations)', lane: 'local' }), 'local');
  } finally { routing.noteSituation({ localUp: null, cloudUp: null }); routing.useRouting(null); }
});

test('a task saved on one lane is claimed under that lane when the other one takes it', () => {
  const { claimLane } = require('../agent/task-context');
  assert.strictEqual(claimLane({ lane: 'local', title: 'Study plan for ECN 201 final' }, 'claude'), 'local');
  assert.strictEqual(claimLane({ lane: 'local', title: 'Write my essay' }, 'claude'), 'claude'); // nothing else of Lupa's
  assert.strictEqual(claimLane({ lane: 'local', title: 'Study plan for ECN 201 final', financeSeen: true }, 'claude'), 'claude');
  assert.strictEqual(claimLane({}, 'claude'), 'claude');
});

test('the cloud AIs get the study-plan skill: open the class site, never ask him what is on it', () => {
  const fs = require('fs'), path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'agent', 'skills', 'study-plan.md'), 'utf8').replace(/\r/g, '');
  const meta = raw.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(meta, /^name: study-plan$/m);
  assert.match(meta, /^browser: yes$/m);
  // no words of its own: agent/runner.js loads it for what isStudy picks, so "Study for the GRE" never gets it
  assert.doesNotMatch(meta, /^match:/m);
  assert.match(raw, /Never ask him which chapters/);
  assert.match(raw, /classSites/);
  assert.match(raw, /Never type his password/);
  assert.doesNotMatch(raw, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emoji
});

test('it notes what the exam covers and the exam itself before the plan is written', () => {
  assert.deepStrictEqual(sp.MUST, ['exam', 'coverage']);
  assert.deepStrictEqual(sp.KEEP_NOTE_TOOL.function.parameters.properties.part.enum, Object.keys(sp.PARTS));
  const d = {};
  assert.match(sp.keepNote(d, { part: 'coverage', text: 'Chapters 1-12, cumulative', source: 'syllabus.pdf' }), /Still to find: exam/);
  assert.deepStrictEqual(sp.missing(d), ['exam']);
  assert.match(sp.keepNote(d, { part: 'nope', text: 'x' }), /part must be one of/);
  assert.match(sp.RULES, /Never ask him which chapters/);
  assert.match(sp.RULES, /syllabus/);
  assert.match(sp.RULES, /never start, submit or post/);
});

test('the plan is written from the notes alone, day by day until the exam', () => {
  const p = sp.WRITE_PROMPT('Study plan for ECN 201 final', '2026-12-08', { coverage: [{ text: 'Chapters 1-12', source: 'syllabus.pdf' }] }, { today: 'Wed Nov 25 2026' });
  assert.match(p, /Chapters 1-12/);
  assert.match(p, /\(from: syllabus\.pdf\)/);
  assert.match(p, /Today is Wed Nov 25 2026/);
  assert.match(p, /## Day by day/);
  assert.match(p, /ONLY/);
  const again = sp.WRITE_PROMPT('x', '', {}, { reply: 'I only have an hour a day', before: 'old plan' });
  assert.match(again, /I only have an hour a day/);
  assert.match(again, /old plan/);
});

test('coach mode keeps its own notes and brief', () => {
  const d = {};
  assert.match(coach.keepNote(d, { part: 'rubric', text: 'Content 10 pts' }), /Kept \(rubric\)/);
  assert.match(coach.KEEP_NOTE_TOOL.function.description, /his brief/);
  assert.match(sp.KEEP_NOTE_TOOL.function.description, /his study plan/);
  assert.strictEqual(coach.FOLDER, 'Coach');
  assert.strictEqual(sp.FOLDER, 'Study plans');
});

test('"I need to know which chapters" sends it to the class site first', () => {
  const site = { course: 'ECN 201', kind: 'D2L', host: 'd2l.school.edu' };
  const asked = "I'm ready to build your ECN 201 final study schedule, but I need to know which chapters the final covers. Could you let me know the chapter range or specific topics?";
  assert.match(cs.lookFirst(asked, { site, visited: [] }), /haven't opened the class site/);
  assert.strictEqual(cs.lookFirst(asked, { site, visited: ['d2l.school.edu'] }), null); // it did look
  // ordinary questions to him aren't about the class site
  ['Could you let me know if you want this in PDF or Word?', 'Can you let me know your address?', 'Which units do you prefer, metric or imperial?', 'Which sections of the lease concern you?']
    .forEach((note) => assert.strictEqual(cs.lookFirst(note, { site, visited: [] }), null, note));
});

test('notes keep the kind that gathered them', () => {
  assert.strictEqual(coach.KIND, 'coach');
  assert.strictEqual(sp.KIND, 'study');
  assert.strictEqual(sp.dossierText({ instructions: [{ text: 'x' }] }), ''); // why a coach dossier never feeds a study plan
});
