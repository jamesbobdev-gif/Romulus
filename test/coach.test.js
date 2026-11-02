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

test('the brief asks for what to do and what to say, and keeps the course out of helper questions', () => {
  assert.match(coach.RULES, /## What to do/);
  assert.match(coach.RULES, /## What to say/);
  assert.match(coach.RULES, /Rubric check/);
  assert.match(coach.RULES, /never the assignment/);
  assert.match(coach.RULES, /Never submit/);
});
