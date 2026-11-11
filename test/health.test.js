const test = require('node:test');
const assert = require('node:assert');
const { healthProfileOf, healthGoal, healthGoalWords, isHealthWord, healthMet, healthSay, normHealth, healthMergeDocs, healthDue } = require('../renderer/js/health');
const { tagFromWords } = require('../renderer/js/quick-add');

test('goals in a title, as a hashtag', () => {
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
});

test('goals in plain words, written the ways people write them', () => {
  assert.deepStrictEqual(healthGoal('Walk 8000 steps'), { kind: 'steps', target: 8000 }); // the same goal without the #
  assert.deepStrictEqual(healthGoalWords('Walk 8,000 steps'), { kind: 'steps', target: 8000 });
  assert.deepStrictEqual(healthGoalWords('10k steps'), { kind: 'steps', target: 10000 });
  assert.deepStrictEqual(healthGoalWords('get 7.5k steps in'), { kind: 'steps', target: 7500 });
  assert.deepStrictEqual(healthGoalWords('6000 steps'), { kind: 'steps', target: 6000 });
  assert.deepStrictEqual(healthGoalWords('Sleep 7 hours'), { kind: 'sleep', target: 420 });
  assert.deepStrictEqual(healthGoalWords('8h of sleep'), { kind: 'sleep', target: 480 });
  assert.deepStrictEqual(healthGoalWords('sleep at least 7.5 hrs'), { kind: 'sleep', target: 450 });
  assert.deepStrictEqual(healthGoalWords('Work out 30 min'), { kind: 'exercise', target: 30 });
  assert.deepStrictEqual(healthGoalWords('45 minutes of yoga'), { kind: 'exercise', target: 45 });
  assert.deepStrictEqual(healthGoalWords('Run 1 hour'), { kind: 'exercise', target: 60 });
  assert.deepStrictEqual(healthGoalWords('workout 20 mins'), { kind: 'exercise', target: 20 });
});

test('ordinary to-dos are not goals', () => {
  for (const t of ['Plan the 3 steps for the launch', 'Sleep on the decision', 'Walk the dog at 5', 'Run 5k',
    'Call mom', 'Book a 30 min meeting', 'Sleep by 11pm', 'Next steps', '']) assert.strictEqual(healthGoal(t), null, t);
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

const ws = (t) => t.ws || 'personal';

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
    { id: 'i', title: 'Walk the dog', done: false, due: null },
    { id: 'j', title: 'Walk 8,000 steps', done: false, due: null },               // in words: yes
  ];
  const due = healthDue(tasks, health, '2026-11-07', ws);
  assert.deepStrictEqual(due.map((x) => x.task.id), ['a', 'b', 'j']);
  assert.strictEqual(due[1].said, '12,000 steps');
});

test('a goal unticked by hand stays unticked for that day; another day ticks again', () => {
  const health = { days: { '2026-11-07': { steps: 8500, at: 1 }, '2026-11-06': { steps: 9000, at: 1 } } };
  const tasks = [{ id: 'a', title: 'Walk #steps 8000', done: false, due: null }, { id: 'b', title: 'Walk #steps 8000', done: false, due: '2026-11-06' }];
  assert.deepStrictEqual(healthDue(tasks, health, '2026-11-07', ws, { a: '2026-11-07', b: '2026-11-07' }).map((x) => x.task.id), ['b']);
  assert.deepStrictEqual(healthDue(tasks, health, '2026-11-07', ws, { a: '2026-11-06' }).map((x) => x.task.id), ['a', 'b']);
});

/* the Food plan (renderer/js/health.js): his per-day macros, which grocery runs are built to */
test('a food plan keeps its numbers per day and its span; nothing set is no plan', () => {
  const { macroPlanClean, macroPlanUntil } = require('../renderer/js/health');
  assert.deepStrictEqual(macroPlanClean({ kcal: '2100', protein: 160.4, carbs: '', fat: -5, span: 'week', from: '2026-11-07', until: '2026-11-13', at: 7 }),
    { kcal: 2100, protein: 160, span: 'week', from: '2026-11-07', until: '2026-11-13', at: 7 });
  assert.strictEqual(macroPlanClean({ kcal: '', protein: 0, span: 'week' }), null);
  assert.strictEqual(macroPlanClean(null), null);
  assert.strictEqual(macroPlanClean({ protein: 150, span: 'forever', from: 'soon' }).span, 'open');
  assert.strictEqual(macroPlanUntil('week', '2026-11-07'), '2026-11-13');
  assert.strictEqual(macroPlanUntil('2weeks', '2026-11-07'), '2026-11-20');
  assert.strictEqual(macroPlanUntil('month', '2026-11-07'), '2026-12-06');
  assert.strictEqual(macroPlanUntil('open', '2026-11-07'), null);
});

test('the plan line says what a day is and how long it runs', () => {
  const { macroPlanSay, macroPlanDaysLeft } = require('../renderer/js/health');
  const p = { kcal: 2100, protein: 160, carbs: 200, fat: 65, span: 'week', from: '2026-11-07', until: '2026-11-13', at: 1 };
  assert.strictEqual(macroPlanSay(p, '2026-11-07'), '2,100 kcal · 160 g protein · 200 g carbs · 65 g fat a day · 7 days left (ends Nov 13)');
  assert.strictEqual(macroPlanSay(p, '2026-11-13'), '2,100 kcal · 160 g protein · 200 g carbs · 65 g fat a day · last day today (ends Nov 13)');
  assert.strictEqual(macroPlanSay(p, '2026-11-14'), '2,100 kcal · 160 g protein · 200 g carbs · 65 g fat a day · ended Nov 13');
  assert.strictEqual(macroPlanSay({ protein: 150, span: 'open', until: null }, '2026-11-07'), '150 g protein a day · until you change it');
  assert.strictEqual(macroPlanDaysLeft(p, '2026-11-10'), 4);
  assert.strictEqual(macroPlanDaysLeft({ until: null }, '2026-11-10'), null);
});

test('a plan the Agent set remembers which task it came from; his own save drops that', () => {
  const { macroPlanClean } = require('../renderer/js/health');
  assert.strictEqual(macroPlanClean({ protein: 150, span: 'week', source: '  Plan my   meals ' }).source, 'Plan my meals');
  assert.strictEqual(macroPlanClean({ protein: 150, span: 'week' }).source, undefined);
});

test('the health row is always sealed, whether or not the lists are encrypted', () => {
  const plain = { url: 'https://x.supabase.co', key: 'pk', syncKey: 'tk_abc' };
  assert.deepStrictEqual(healthProfileOf(plain, true), { url: 'https://x.supabase.co', key: 'pk', syncKey: 'tk_abc:health', v2: true });
  assert.strictEqual(healthProfileOf(Object.assign({ v2: true }, plain), true).v2, true);
  assert.strictEqual(healthProfileOf(plain, false), null); // a device that can't encrypt keeps the totals to itself
  assert.strictEqual(healthProfileOf(null, true), null);
});

/* which apps fed each number: Samsung Health, Garmin, Oura... read through Health Connect or Apple Health */
test('a day keeps the apps behind each number, tidied, and they sync with it', () => {
  const { normHealth, healthFrom, healthFromAll, healthMergeDocs } = require('../renderer/js/health');
  assert.deepStrictEqual(healthFrom({ steps: [' Samsung  Health ', 'Samsung Health', '', null, 'Garmin Connect'], sleep: 'Oura', exercise: [] }),
    { steps: ['Samsung Health', 'Garmin Connect'] });
  assert.strictEqual(healthFrom(null), null);
  assert.strictEqual(healthFrom({ steps: [] }), null);
  assert.strictEqual(healthFrom({ steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).steps.length, 6);
  assert.strictEqual(healthFrom({ steps: ['x'.repeat(80)] }).steps[0].length, 40);
  const h = normHealth({ days: { '2026-11-09': { steps: 4000, at: 5, from: { steps: ['iPhone'], sleep: ['Oura', 'Apple Watch'] } }, '2026-11-08': { steps: 10, at: 1 } } });
  assert.deepStrictEqual(h.days['2026-11-09'].from, { steps: ['iPhone'], sleep: ['Oura', 'Apple Watch'] });
  assert.strictEqual(h.days['2026-11-08'].from, undefined);
  assert.deepStrictEqual(healthFromAll(h.days['2026-11-09']), ['iPhone', 'Oura', 'Apple Watch']);
  assert.deepStrictEqual(healthFromAll(h.days['2026-11-08']), []);
  // only the names changed: still a change worth syncing
  const now = new Date('2026-11-09T12:00:00').getTime();
  const local = normHealth({ days: { '2026-11-09': { steps: 4000, at: 5 } } });
  const r = healthMergeDocs(local, { days: { '2026-11-09': { steps: 4000, at: 6, from: { steps: ['Fitbit'] } } } }, now);
  assert.ok(r.changedLocal);
  assert.deepStrictEqual(r.merged.days['2026-11-09'].from, { steps: ['Fitbit'] });
});

test('a one-number change ("1 g of protein per pound") keeps the rest of the plan and its dates', () => {
  const { macroPlanMerge } = require('../renderer/js/health');
  const old = { kcal: 2100, protein: 140, carbs: 200, fat: 65, span: 'week', from: '2026-11-07', until: '2026-11-13', at: 1 };
  const k = macroPlanMerge(old, { protein: 180, keep: true, source: 'protein per pound' }, '2026-11-09', 5);
  assert.deepStrictEqual(k, { kcal: 2100, protein: 180, carbs: 200, fat: 65, span: 'week', from: '2026-11-07', until: '2026-11-13', at: 5, source: 'protein per pound' });
  // a new length with it: from today
  const m = macroPlanMerge(old, { protein: 180, keep: true, span: 'month' }, '2026-11-09', 5);
  assert.deepStrictEqual([m.kcal, m.protein, m.span, m.from, m.until], [2100, 180, 'month', '2026-11-09', '2026-12-08']);
  // no plan, or one that ran out: just that number, until he changes it
  const n = macroPlanMerge(null, { protein: 180, keep: true }, '2026-11-09', 5);
  assert.deepStrictEqual([n.protein, n.kcal, n.span, n.from, n.until], [180, undefined, 'open', '2026-11-09', null]);
  const ended = macroPlanMerge(Object.assign({}, old, { until: '2026-11-08' }), { protein: 180, keep: true }, '2026-11-09', 5);
  assert.deepStrictEqual([ended.protein, ended.kcal, ended.span], [180, undefined, 'open']);
  // a whole meal plan replaces it, from today
  const w = macroPlanMerge(old, { kcal: 2300, protein: 170, span: '2weeks' }, '2026-11-09', 5);
  assert.deepStrictEqual([w.kcal, w.protein, w.carbs, w.from, w.until], [2300, 170, undefined, '2026-11-09', '2026-11-22']);
  assert.strictEqual(macroPlanMerge(old, { keep: true }, '2026-11-09', 5).protein, 140); // nothing new: the plan as it was
  assert.strictEqual(macroPlanMerge(null, { keep: true }, '2026-11-09', 5), null);
});

test('his weight: typed or from the phone, the newer wins, and it rides in the Food plan row', () => {
  const { weightClean, weightFromStore, weightNewer, weightSay, macroRowText, macroPlanClean } = require('../renderer/js/health');
  assert.deepStrictEqual(weightClean({ lb: '182.44', at: 5, from: ' typed  in ' }), { lb: 182.4, at: 5, from: 'typed in' });
  assert.strictEqual(weightClean({ lb: 12 }), null); // not a person's weight
  assert.strictEqual(weightClean({ lb: 'abc' }), null);
  // Health Connect answers in kg; "This phone" is just the store's own name
  assert.deepStrictEqual(weightFromStore({ kg: 82.5, at: 9, from: 'Withings' }, 'Health Connect'), { lb: 181.9, at: 9, from: 'Withings' });
  assert.strictEqual(weightFromStore({ kg: 82.5, at: 9, from: 'This phone' }, 'Health Connect').from, 'Health Connect');
  assert.strictEqual(weightFromStore(null, 'Health Connect'), null);
  assert.strictEqual(weightNewer({ lb: 180, at: 1 }, { lb: 185, at: 2 }).lb, 185);
  assert.strictEqual(weightNewer({ lb: 180, at: 3 }, { lb: 185, at: 2 }).lb, 180);
  assert.strictEqual(weightNewer(null, null), null);
  assert.match(weightSay({ lb: 182, at: new Date('2026-11-09T12:00:00').getTime(), from: 'Withings' }), /^182 lb, from Withings, Nov 9$/);
  // the row: the plan plus his weight; weight alone still saves, and doesn't read back as a plan
  const plan = { protein: 180, span: 'open', from: '2026-11-09', until: null, at: 5 };
  assert.deepStrictEqual(JSON.parse(macroRowText(plan, { lb: 182, at: 4 })), Object.assign({}, plan, { weight: { lb: 182, at: 4 } }));
  const alone = macroRowText(null, { lb: 182, at: 4 });
  assert.strictEqual(macroPlanClean(JSON.parse(alone)), null);
  assert.strictEqual(macroRowText(null, null), '');
});

test('the top of the Health tab: the week, the goals, the sleep word', () => {
  const { healthWeek, healthTarget, healthSleepWord, healthPct } = require('../renderer/js/health');
  // Wednesday 2026-11-11: Monday the 9th through today count, last Sunday doesn't
  const days = { '2026-11-08': { exerciseMin: 90 }, '2026-11-09': { exerciseMin: 20 }, '2026-11-10': { steps: 4000 }, '2026-11-11': { exerciseMin: 10 } };
  assert.deepStrictEqual(healthWeek(days, new Date(2026, 10, 11, 15).getTime()), { week: 30, today: 10 });
  assert.deepStrictEqual(healthWeek({}, new Date(2026, 10, 9, 8).getTime()), { week: 0, today: 0 });
  const tasks = [{ title: 'Walk #steps 8000' }, { title: 'Run 12k steps', due: '2026-11-12' }, { title: 'Gym #exercise 45' }, { title: 'Agent walk 20000 steps' }];
  assert.strictEqual(healthTarget(tasks, 'steps', '2026-11-11', 10000, t => t.title.startsWith('Agent') ? 'agent' : 'personal'), 8000);
  assert.strictEqual(healthTarget(tasks, 'exercise', '2026-11-11', 0), 45);
  assert.strictEqual(healthTarget(tasks, 'sleep', '2026-11-11', 420), 420);
  assert.strictEqual(healthSleepWord(495, 420), 'Good');
  assert.strictEqual(healthSleepWord(400, 420), 'Fair');
  assert.strictEqual(healthSleepWord(300, 420), 'Short');
  assert.strictEqual(healthSleepWord(undefined, 420), '');
  assert.strictEqual(healthPct(567, 10000), 6);
  assert.strictEqual(healthPct(20000, 10000), 100);
  assert.strictEqual(healthPct(undefined, 10000), 0);
});
