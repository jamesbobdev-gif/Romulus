/* Standing jobs the Agent suggests after accounts are connected (agent/jobs.js). */
const test = require('node:test');
const assert = require('node:assert');
const jobs = require('../agent/jobs');

const NOW = new Date(2026, 10, 13, 15, 0).getTime(); // Fri 13 Nov 2026, 3 pm
let n = 0; const uid = () => 'j' + (++n);

test('the setup task is spotted by its flag, not its words', () => {
  const t = jobs.setupTask({ uid, now: NOW });
  assert.ok(jobs.isSetup(t));
  assert.strictEqual(t.title, jobs.TITLE);
  assert.strictEqual(t.status, 'queued');
  assert.strictEqual(t.useInbox, true, 'a mailbox is connected: an inbox run');
  assert.strictEqual(t.lane, 'claude');
  assert.strictEqual(jobs.setupTask({ uid, now: NOW, mail: false }).useInbox, null, 'calendar only: an ordinary run');
  assert.ok(!jobs.isSetup({ title: jobs.TITLE }), 'the same words typed by hand are an ordinary task');
});

test('cleanJobs keeps 1–4 sane jobs with a schedule the Agent can run', () => {
  const got = jobs.cleanJobs([
    { title: ' Look at my inbox and list what needs an answer ', why: 'a dozen unanswered threads', every: 'weekday', at: '08:00' },
    { title: 'List the week\'s deadlines', every: 'week', day: 1, at: '7:30' },
    { title: 'Order the groceries', every: 'week', day: 9, at: '09:00', why: 'a Walmart order every Sunday' },
    { title: 'Check the electric bill', every: 'month', at: '09:00' },
    { title: '', every: 'day' },
    { title: 'Five', every: 'day' }, { title: 'Six', every: 'day' },
  ]);
  assert.deepStrictEqual(got, [
    { title: 'Look at my inbox and list what needs an answer', why: 'a dozen unanswered threads', every: 'weekday', day: null, at: '08:00' },
    { title: 'List the week\'s deadlines', why: '', every: 'week', day: 1, at: '08:00' },
    { title: 'Order the groceries', why: 'a Walmart order every Sunday', every: 'week', day: 1, at: '09:00' },
    { title: 'Five', why: '', every: 'day', day: null, at: '08:00' },
  ]);
  assert.strictEqual(jobs.cleanJobs([{ title: 'Check the bill', every: 'month' }]), null, 'monthly is not a schedule the Agent has');
  assert.strictEqual(jobs.cleanJobs('no'), null);
  assert.strictEqual(jobs.cleanJobs([]), null);
});

test('when: plain English for each schedule', () => {
  assert.strictEqual(jobs.when({ every: 'weekday', at: '08:00' }), 'Weekdays at 8:00 AM');
  assert.strictEqual(jobs.when({ every: 'day', at: '17:30' }), 'Every day at 5:30 PM');
  assert.strictEqual(jobs.when({ every: 'week', day: 0, at: '12:00' }), 'Every Sunday at 12:00 PM');
  assert.strictEqual(jobs.when({ every: 'week', at: '00:15' }), 'Every Monday at 12:15 AM');
});

test('Start makes an Agent task on its schedule, queued now, with why it was suggested', () => {
  const setup = jobs.setupTask({ uid, now: NOW, tag: null });
  const j = { title: 'Order the groceries', why: 'a Walmart order every Sunday', every: 'week', day: 0, at: '09:00' };
  const t = jobs.jobTask(setup, j, { now: NOW, uid, nextRunAt: (r, from) => from + 1000 });
  assert.strictEqual(t.ws, 'agent');
  assert.strictEqual(t.status, 'queued');
  assert.deepStrictEqual(t.repeat, { every: 'week', at: '09:00', day: 0 });
  assert.strictEqual(t.nextRun, NOW + 1000);
  assert.match(t.notes, /Why the Agent suggested it: a Walmart order/);
  assert.match(t.history[0].text, /runs now, then every sunday at 9:00 am/);
  assert.ok(!t.jobsSetup);
  const d = jobs.jobTask(setup, { title: 'Inbox', every: 'day', at: '08:00' }, { now: NOW, uid });
  assert.deepStrictEqual(d.repeat, { every: 'day', at: '08:00', day: null });
  assert.strictEqual(d.nextRun, null);
});

test('summary lists them for the log', () => {
  assert.strictEqual(jobs.summary([{ title: 'A', every: 'day', at: '08:00', why: 'because' }, { title: 'B', every: 'weekday', at: '09:00' }]),
    '1. A (Every day at 8:00 AM) — because\n2. B (Weekdays at 9:00 AM)');
});
