const test = require('node:test');
const assert = require('node:assert');
const { healthGoal, isHealthWord, healthMet, healthSay, normHealth, healthMergeDocs, healthDue } = require('../renderer/js/health');
const { tagFromWords } = require('../renderer/js/quick-add');

test('goals in a title', () => {
  assert.deepStrictEqual(healthGoal('Walk #steps 8000'), { kind: 'steps', target: 8000 });
  assert.deepStrictEqual(healthGoal('Walk #steps 8k'), { kind: 'steps', target: 8000 });
  assert.deepStrictEqual(healthGoal('Walk #STEPS 10000 daily'), { kind: 'steps', target: 10000 });
  assert.deepStrictEqual(healthGoal('Gym #exercise 30'), { kind: 'exercise', target: 30 });
  assert.deepStrictEqual(healthGoal('Gym #workout 1h'), { kind: 'exercise', target: 60 });
  assert.deepStrictEqual(healthGoal('Gym #exercise 45m'), { kind: 'exercise', target: 45 });
  assert.deepStrictEqual(healthGoal('Bed early #sleep 7'), { kind: 'sleep', target: 420 });
  assert.deepStrictEqual(healthGoal('Bed early #sleep 7h30'), { kind: 'sleep', target: 450 });
  assert.deepStrictEqual(healthGoal('Bed early #sleep 7.5h'), { kind: 'sleep', target: 450 });
  assert.deepStrictEqual(healthGoal('Nap #sleep 90m'), { kind: 'sleep', target: 90 });
  assert.strictEqual(healthGoal('Count #steps later'), null);
  assert.strictEqual(healthGoal('Walk #steps 2h'), null);
  assert.strictEqual(healthGoal('Walk #steps 0'), null);
  assert.strictEqual(healthGoal('Buy steps#steps 800'), null); // needs a space before the #
  assert.strictEqual(healthGoal('Walk 8000 steps'), null);
});

test('a goal is not a tag', () => {
  assert.ok(isHealthWord('steps', ' 8000'));
  assert.ok(!isHealthWord('steps', ' later'));
  assert.deepStrictEqual(tagFromWords('Walk #steps 8000'), { title: 'Walk #steps 8000', tag: null });
  assert.deepStrictEqual(tagFromWords('Walk #steps 8000 #home'), { title: 'Walk #steps 8000', tag: 'home' });
  assert.deepStrictEqual(tagFromWords('Water plants #home'), { title: 'Water plants', tag: 'home' });
  assert.deepStrictEqual(tagFromWords('Fix the #steps'), { title: 'Fix the', tag: 'steps' }); // no number: an ordinary tag
});

test('met, and what it says', () => {
  const g = healthGoal('Walk #steps 8000');
  assert.ok(healthMet(g, { steps: 8000 }));
  assert.ok(!healthMet(g, { steps: 7999 }));
  assert.ok(!healthMet(g, { sleepMin: 600 })); // steps not allowed: never met
  assert.ok(!healthMet(g, undefined));
  assert.strictEqual(healthSay(g, { steps: 8412 }), '8,412 steps');
  assert.strictEqual(healthSay(healthGoal('#sleep 7'), { sleepMin: 445 }), '7h 25m of sleep');
  assert.strictEqual(healthSay(healthGoal('#exercise 30'), { exerciseMin: 30 }), '30m of exercise');
});

test('stored days are cleaned up', () => {
  const h = normHealth({ days: { '2026-11-07': { steps: 120.4, sleepMin: -3, at: 5, junk: 1 }, 'nope': { steps: 1 }, '2026-11-06': null } });
  assert.deepStrictEqual(h, { days: { '2026-11-07': { steps: 120, at: 5 } } });
  assert.deepStrictEqual(normHealth(null), { days: {} });
});

test('merging: the newer reading of a day wins, old days go', () => {
  const now = new Date(2026, 10, 7, 12).getTime();
  const local = { days: { '2026-11-07': { steps: 5000, at: 20 }, '2026-11-06': { steps: 9000, at: 10 } } };
  const remote = { v: 1, days: { '2026-11-07': { steps: 4000, at: 15 }, '2026-11-05': { steps: 300, at: 9 }, '2026-08-01': { steps: 1, at: 1 } } };
  const r = healthMergeDocs(local, remote, now);
  assert.deepStrictEqual(Object.keys(r.merged.days).sort(), ['2026-11-05', '2026-11-06', '2026-11-07']);
  assert.strictEqual(r.merged.days['2026-11-07'].steps, 5000);
  assert.ok(r.changedLocal && r.changedRemote);
  const again = healthMergeDocs(r.merged, { v: 1, days: r.merged.days }, now);
  assert.ok(!again.changedLocal && !again.changedRemote);
  const empty = healthMergeDocs({ days: {} }, null, now);
  assert.ok(!empty.changedLocal && !empty.changedRemote);
});

test('which tasks tick off', () => {
  const health = { days: { '2026-11-07': { steps: 8500, sleepMin: 380, at: 1 }, '2026-11-06': { steps: 12000, at: 1 } } };
  const tasks = [
    { id: 'a', title: 'Walk #steps 8000', done: false, due: null },               // today: yes
    { id: 'b', title: 'Walk #steps 10000', done: false, due: '2026-11-06' },      // yesterday's total: yes
    { id: 'c', title: 'Walk #steps 10000', done: false, due: '2026-11-07' },      // not yet
    { id: 'd', title: 'Walk #steps 1000', done: false, due: '2026-11-08' },       // tomorrow: no
    { id: 'e', title: 'Walk #steps 1000', done: true, due: null },                // already done
    { id: 'f', title: 'Bed #sleep 7', done: false, due: null },                   // 6h 20m: no
    { id: 'g', title: 'Gym #exercise 20', done: false, due: null },               // exercise not read: no
    { id: 'h', title: 'Walk #steps 1000', done: false, due: null, ws: 'agent' },  // the Agent's: never
    { id: 'i', title: 'Walk the dog', done: false, due: null }
  ];
  const due = healthDue(tasks, health, '2026-11-07', (t) => t.ws || 'personal');
  assert.deepStrictEqual(due.map((x) => x.task.id), ['a', 'b']);
  assert.strictEqual(due[1].said, '12,000 steps');
});
