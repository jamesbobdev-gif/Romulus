const test = require('node:test');
const assert = require('node:assert');
const g = require('../agent/goals');

const goal = { id: 'g1', title: 'Goal: get a summer internship', tag: 'career', notes: 'Chicago only. No unpaid ones.', ws: 'agent' };

test('a goal is spotted by its lead-in or tag, and needs a plan until started', () => {
  assert.ok(g.isGoal(goal));
  assert.ok(g.isGoal({ title: 'plan my move #goal' }));
  assert.ok(!g.isGoal({ title: 'find a goalkeeper jersey' }));
  assert.strictEqual(g.topicOf(goal), 'get a summer internship');
  assert.strictEqual(g.topicOf({ title: ' plan my move  #goal ' }), 'plan my move');
  assert.ok(g.needsPlan(goal));
  assert.ok(!g.needsPlan(Object.assign({}, goal, { goalStarted: true })));
});

test('cleanPlan keeps 2–10 sane steps', () => {
  const p = g.cleanPlan([{ title: ' Find 10 open internships ', why: 'the list', needs: '', minutes: '15' }, { title: 'Tailor the resume', minutes: 0 }, { title: '' }]);
  assert.deepStrictEqual(p, [{ title: 'Find 10 open internships', why: 'the list', needs: '', minutes: 15 }, { title: 'Tailor the resume', why: '', needs: '', minutes: 10 }]);
  assert.strictEqual(g.cleanPlan([{ title: 'only one' }]), null);
  assert.strictEqual(g.cleanPlan('nope'), null);
  assert.strictEqual(g.cleanPlan(Array.from({ length: 14 }, (_, i) => ({ title: 'S' + i, minutes: 10 }))).length, g.MAX_STEPS);
  assert.match(g.summary(p), /1\. Find 10 open internships — the list \(≈15 min\)\n2\. Tailor the resume \(≈10 min\)\nAbout 25 minutes of Agent time across 2 steps\./);
});

test('stepTasks: the first is queued, the rest wait, each carries the goal and his instructions', () => {
  let n = 0; const uid = () => 's' + (++n);
  const plan = g.cleanPlan([{ title: 'Find openings', why: 'the list', minutes: 10 }, { title: 'Tailor the resume', why: 'for each', minutes: 20 }, { title: 'Apply to the top 3', minutes: 30 }]);
  const steps = g.stepTasks(goal, plan, { now: 1000, uid });
  assert.strictEqual(steps.length, 3);
  assert.strictEqual(steps[0].status, 'queued'); assert.strictEqual(steps[0].goalWait, undefined);
  assert.strictEqual(steps[1].status, 'done'); assert.strictEqual(steps[1].goalWait, true);
  assert.deepStrictEqual(steps.map((s) => s.goalStep), [1, 2, 3]);
  assert.ok(steps.every((s) => s.goalId === 'g1' && s.ws === 'agent' && s.tag === 'career'));
  assert.match(steps[1].notes, /Step 2 of 3 toward his goal: "get a summer internship"\. for each\nEarlier steps: 1\. Find openings\.\n\nHis instructions for the whole goal:\nChicago only/);
  assert.match(steps[2].history[0].text, /waits for step 2/);
});

test('progress: one step at a time, the next queued only when the one before is finished', () => {
  const s1 = { id: 's1', ws: 'agent', goalId: 'g1', goalStep: 1, status: 'working' };
  const s2 = { id: 's2', ws: 'agent', goalId: 'g1', goalStep: 2, status: 'done', goalWait: true };
  const s3 = { id: 's3', ws: 'agent', goalId: 'g1', goalStep: 3, status: 'done', goalWait: true };
  let p = g.progress(goal, [s3, s1, s2, { id: 'x', ws: 'agent', title: 'unrelated' }]);
  assert.deepStrictEqual([p.total, p.finished, p.busy && p.busy.id, p.next, p.all], [3, 0, 's1', null, false]);
  s1.status = 'needs-you'; // waiting on him: nothing moves
  assert.strictEqual(g.progress(goal, [s1, s2, s3]).next, null);
  s1.status = 'done'; // its answer said nothing is left
  p = g.progress(goal, [s1, s2, s3]);
  assert.deepStrictEqual([p.finished, p.next && p.next.id], [1, 's2']);
  s2.goalWait = undefined; s2.status = 'queued';
  assert.strictEqual(g.progress(goal, [s1, s2, s3]).next, null);
  s2.done = true; s3.goalWait = undefined; s3.done = true; // he checked the rest off himself
  p = g.progress(goal, [s1, s2, s3]);
  assert.deepStrictEqual([p.finished, p.all], [3, true]);
  assert.deepStrictEqual(g.progress(goal, []).all, false);
});
