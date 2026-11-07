const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { healthGoal, healthToTick, healthSay } = require('../renderer/js/health');

test('steps goals, written the ways people write them', () => {
  assert.deepStrictEqual(healthGoal('Walk 8,000 steps'), { kind: 'steps', target: 8000 });
  assert.deepStrictEqual(healthGoal('10k steps'), { kind: 'steps', target: 10000 });
  assert.deepStrictEqual(healthGoal('get 7.5k steps in'), { kind: 'steps', target: 7500 });
  assert.deepStrictEqual(healthGoal('6000 steps'), { kind: 'steps', target: 6000 });
});

test('sleep goals, in hours either side of the word', () => {
  assert.deepStrictEqual(healthGoal('Sleep 7 hours'), { kind: 'sleep', target: 420 });
  assert.deepStrictEqual(healthGoal('8h of sleep'), { kind: 'sleep', target: 480 });
  assert.deepStrictEqual(healthGoal('sleep at least 7.5 hrs'), { kind: 'sleep', target: 450 });
});

test('exercise goals, in minutes or hours', () => {
  assert.deepStrictEqual(healthGoal('Work out 30 min'), { kind: 'exercise', target: 30 });
  assert.deepStrictEqual(healthGoal('45 minutes of yoga'), { kind: 'exercise', target: 45 });
  assert.deepStrictEqual(healthGoal('Run 1 hour'), { kind: 'exercise', target: 60 });
  assert.deepStrictEqual(healthGoal('workout 20 mins'), { kind: 'exercise', target: 20 });
});

test('ordinary to-dos are not goals', () => {
  for (const t of ['Plan the 3 steps for the launch', 'Sleep on the decision', 'Walk the dog at 5', 'Run 5k',
    'Call mom', 'Book a 30 min meeting', 'Sleep by 11pm', 'Next steps', '']) assert.strictEqual(healthGoal(t), null, t);
});

const ws = (t) => t.ws || 'personal';
const day = { date: '2026-11-04', steps: 8412, sleepMin: 400, exerciseMin: 35 };

test('ticks off met goals due today or undated, and nothing else', () => {
  const tasks = [
    { id: 'a', title: 'Walk 8,000 steps', due: '2026-11-04' },
    { id: 'b', title: '10k steps', due: null },                       // not met yet
    { id: 'c', title: 'Sleep 7 hours', due: null },                   // 6h40m: not met
    { id: 'd', title: 'Work out 30 min' },                            // met, undated
    { id: 'e', title: 'Walk 8,000 steps', due: '2026-11-03' },        // yesterday's: today's numbers don't count
    { id: 'f', title: 'Walk 8,000 steps', due: '2026-11-05' },        // tomorrow's
    { id: 'g', title: 'Walk 8,000 steps', done: true },               // already done
    { id: 'h', title: 'Walk 8,000 steps', ws: 'agent' },              // the Agent's
  ];
  assert.deepStrictEqual(healthToTick(tasks, day, {}, ws).map((h) => h.id), ['a', 'd']);
});

test('a goal unticked by hand today stays unticked; yesterday’s tick does not count', () => {
  const tasks = [{ id: 'a', title: 'Walk 8,000 steps' }, { id: 'b', title: 'Walk 8,000 steps' }];
  assert.deepStrictEqual(healthToTick(tasks, day, { a: '2026-11-04', b: '2026-11-03' }, ws).map((h) => h.id), ['b']);
});

test('a number Health Connect did not give (not allowed, or nothing logged) never ticks', () => {
  const tasks = [{ id: 'a', title: 'Sleep 1 hour' }, { id: 'b', title: '100 steps' }];
  assert.deepStrictEqual(healthToTick(tasks, { date: '2026-11-04', steps: null, sleepMin: null, exerciseMin: null }, {}, ws), []);
  assert.deepStrictEqual(healthToTick(tasks, null, {}, ws), []);
});

test('the toast says what Health Connect saw', () => {
  assert.strictEqual(healthSay('steps', 8412), '8,412 steps today');
  assert.strictEqual(healthSay('sleep', 400), '6h 40m of sleep last night');
  assert.strictEqual(healthSay('sleep', 420), '7h of sleep last night');
  assert.strictEqual(healthSay('exercise', 35), '35m of exercise today');
});

/* mobile/health-phone.js against a fake HealthData plugin */
function loadPhone(plugin) {
  const window = {
    Capacitor: {
      isPluginAvailable: (n) => n === 'HealthData',
      nativePromise: async (n, m) => plugin[m](),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'health-phone.js'), 'utf8'), { window });
  return window.phoneHealth;
}

test('phone bridge: today keeps numbers and turns what is missing into null', async () => {
  const h = loadPhone({ today: () => ({ date: '2026-11-04', steps: 1200, exerciseMin: 0 }) });
  assert.deepStrictEqual({ ...(await h.today()) }, { date: '2026-11-04', steps: 1200, sleepMin: null, exerciseMin: 0 });
});

test('phone bridge: the tab calls it Apple Health on an iPhone, Health Connect elsewhere', () => {
  const load = (platform) => {
    const window = { Capacitor: { isPluginAvailable: () => true, nativePromise: async () => ({}), getPlatform: () => platform } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'health-phone.js'), 'utf8'), { window });
    return window.phoneHealth;
  };
  assert.strictEqual(load('ios').app, 'Apple Health');
  assert.strictEqual(load('ios').ios, true);
  assert.strictEqual(load('android').app, 'Health Connect');
  assert.strictEqual(load('android').ios, false);
});

test('phone bridge: absent without the plugin', () => {
  const window = { Capacitor: { isPluginAvailable: () => false, nativePromise: async () => ({}) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'health-phone.js'), 'utf8'), { window });
  assert.strictEqual(window.phoneHealth, undefined);
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
