const test = require('node:test');
const assert = require('node:assert');
const { reviewYearFor, tasksYear, agentYear, hoursYear, moneyYear, reviewLogAdd, reviewSample } = require('../renderer/js/year-review');

const at = (m, d, h) => new Date(2026, m, d, h || 12).getTime();
const sec = (y, m, d) => Math.floor(new Date(y, m, d, 12).getTime() / 1000);

test('the review is for last year through January and February, then gone', () => {
  assert.strictEqual(reviewYearFor(new Date(2027, 0, 1, 0, 5).getTime()), 2026);
  assert.strictEqual(reviewYearFor(new Date(2027, 1, 28).getTime()), 2026);
  assert.strictEqual(reviewYearFor(new Date(2027, 2, 1).getTime()), null);
  assert.strictEqual(reviewYearFor(new Date(2026, 11, 31).getTime()), null);
});

test('tasks: checked off this year, by list, month, best day and longest streak', () => {
  const tasks = [
    { id: 'a', title: 'A', done: true, ws: 'personal', tag: 'home', doneAt: at(2, 1) },
    { id: 'b', title: 'B', done: true, ws: 'work', doneAt: at(2, 2) },
    { id: 'c', title: 'C', done: true, ws: 'work', tag: 'home', doneAt: at(2, 3, 9) },
    { id: 'd', title: 'D', done: true, ws: 'school', doneAt: at(2, 3, 18) },
    { id: 'e', title: 'E', done: true, ws: 'personal', updatedAt: at(6, 4) }, // no doneAt: its last change
    { id: 'f', title: 'F', done: false, ws: 'personal', due: '2026-07-04', updatedAt: at(6, 4) }, // not done
    { id: 'g', title: 'G', done: true, ws: 'personal', doneAt: new Date(2025, 11, 31, 23).getTime() }, // last year
  ];
  const log = [{ id: 'h', at: at(2, 5), ws: 'agent', title: 'Cleared', due: '2026-03-05' }, { id: 'a', at: at(0, 1), ws: 'personal' }];
  const r = tasksYear(tasks, log, 2026);
  assert.strictEqual(r.total, 6, 'a–e and the cleared one; the log copy of a counts once');
  assert.deepStrictEqual(r.byList, { personal: 2, work: 2, school: 1, agent: 1 });
  assert.strictEqual(r.byMonth[2], 5);
  assert.strictEqual(r.busiestMonth, 2);
  assert.deepStrictEqual(r.bestDay, { day: '2026-03-03', count: 2 });
  assert.deepStrictEqual(r.streak, { days: 3, from: '2026-03-01', to: '2026-03-03' }, 'Mar 5 is after a gap');
  assert.strictEqual(r.activeDays, 5);
  assert.deepStrictEqual(r.topTags[0], { name: 'home', count: 2 });
  assert.strictEqual(r.lastYear, 1);
  assert.strictEqual(r.dated.total, 2);
  assert.strictEqual(r.dated.byMonth[2], 1);
});

test('a streak runs across the end of a month', () => {
  const tasks = [at(0, 30), at(0, 31), at(1, 1), at(1, 2)].map((t, i) => ({ id: 'x' + i, done: true, doneAt: t }));
  assert.strictEqual(tasksYear(tasks, [], 2026).streak.days, 4);
});

test('clearing done tasks keeps them in the log, once each, and drops older years', () => {
  const now = at(9, 31);
  let log = [{ id: 'old', at: new Date(2024, 5, 1).getTime() }, { id: 'kept', at: new Date(2025, 5, 1).getTime() }];
  const t = { id: 'n', title: 'Ask about rates', done: true, ws: 'agent', doneAt: at(9, 30), history: [{ who: 'you', at: at(9, 29) }, { who: 'claude', at: at(9, 29, 13), lane: 'local' }] };
  log = reviewLogAdd(log, [t, { id: 'open', done: false }], now);
  log = reviewLogAdd(log, [t], now);
  assert.deepStrictEqual(log.map((e) => e.id), ['kept', 'n']);
  assert.deepStrictEqual(log[1].runs, [[at(9, 29, 13), 'local']]);
});

test('Agent: answers this year by who wrote them, cleared tasks too', () => {
  const tasks = [
    { id: 'a', ws: 'agent', title: 'Phone plans', done: false, history: [
      { who: 'you', at: at(4, 1) }, { who: 'claude', at: at(4, 1, 13) }, { who: 'claude', at: at(4, 2), via: 'gemini' }, { who: 'claude', at: at(4, 3), lane: 'local' }] },
    { id: 'b', ws: 'agent', title: 'Old one', done: true, doneAt: at(0, 2), history: [{ who: 'claude', at: new Date(2025, 11, 30).getTime() }] },
    { id: 'c', ws: 'personal', title: 'Not Agent', history: [{ who: 'claude', at: at(4, 1) }] },
  ];
  const log = [{ id: 'd', at: at(8, 9), ws: 'agent', title: 'Flights', runs: [[at(8, 8), 'local']] }];
  const r = agentYear(tasks, log, 2026);
  assert.strictEqual(r.answers, 4);
  assert.strictEqual(r.tasks, 2, 'b had no answer this year');
  assert.strictEqual(r.finished, 2, 'b and d were checked off this year');
  assert.strictEqual(r.local, 2);
  assert.deepStrictEqual(r.byWho, [{ name: 'local', count: 2 }, { name: 'claude', count: 1 }, { name: 'gemini', count: 1 }]);
  assert.strictEqual(r.busiestMonth, 4);
  assert.deepStrictEqual(r.longest, { title: 'Phone plans', count: 3 });
});

test('hours: this year only, by kind and month', () => {
  const r = hoursYear([
    { date: '2026-01-05', kind: 'school', hours: 3 }, { date: '2026-01-06', kind: 'work', hours: 4.5 },
    { date: '2026-02-01', kind: 'work', hours: 2 }, { date: '2025-12-31', kind: 'work', hours: 8 }, { date: 'bad', hours: 1 },
  ], 2026);
  assert.deepStrictEqual([r.total, r.byKind.school, r.byKind.work, r.byMonth[0], r.busiestMonth, r.days], [9.5, 3, 6.5, 7.5, 0, 3]);
});

test('money: the income statement over the year, transfers and card payments left out', () => {
  const now = new Date(2027, 0, 4).getTime();
  const checking = { id: 'c', name: 'Checking', org: 'Bank', balance: 1000, transactions: [
    { description: 'ACME PAYROLL DIRECT DEP', amount: 3000, posted: sec(2026, 0, 2) },
    { description: 'ACME PAYROLL DIRECT DEP', amount: 3000, posted: sec(2026, 11, 2) },
    { description: 'Maple Rent', amount: -1200, posted: sec(2026, 0, 3) },
    { description: 'Maple Rent', amount: -1200, posted: sec(2026, 11, 3) },
    { description: 'Corner Deli 12', amount: -40, posted: sec(2026, 0, 10) },
    { description: 'Best Buy 0412', amount: -900, posted: sec(2026, 11, 20) },
    { description: 'Amazon refund', amount: 25, posted: sec(2026, 11, 22) },
    { description: 'Transfer to Savings', amount: -500, posted: sec(2026, 11, 5) },
    { description: 'Payment Thank You - Web', amount: -300, posted: sec(2026, 11, 6) },
    { description: 'ACME PAYROLL DIRECT DEP', amount: 3000, posted: sec(2027, 0, 2) }, // next year
  ] };
  const visa = { id: 'v', name: 'Visa', org: 'Bank', balance: -200, transactions: [{ description: 'Payment Thank You', amount: 300, posted: sec(2026, 11, 6) }] };
  const m = moneyYear([checking, visa], {}, 2026, now);
  assert.strictEqual(m.months.length, 12);
  assert.strictEqual(m.partial, false);
  assert.strictEqual(m.in, 6000);
  assert.strictEqual(m.out, 2400 + 40 + 900 - 25);
  assert.strictEqual(m.months[0].in, 3000);
  assert.strictEqual(m.months[11].out, 1200 + 900 - 25);
  assert.ok(m.months.slice(1, 11).every((x) => x.in === 0 && x.out === 0));
  assert.strictEqual(m.fixed, 2400);
  assert.strictEqual(m.refunds, 25);
  assert.deepStrictEqual(m.biggest && [m.biggest.name, m.biggest.amount], ['Best Buy', 900], 'the rent is a bill, not a purchase');
  assert.deepStrictEqual(m.places.map((p) => p.name), ['Best Buy', 'Corner Deli']);
  assert.strictEqual(m.bestMonth, 0);
  assert.strictEqual(m.priciestMonth, 11);
  // net worth: today's 800, minus next year's paycheck = 800-3000 at the end of the year
  assert.strictEqual(Math.round(m.worth.end), 800 - 3000);
});

test('money: months before the oldest transaction are marked as having no data', () => {
  const now = new Date(2026, 9, 20).getTime();
  const a = { id: 'c', balance: 500, transactions: [{ description: 'Corner Deli', amount: -20, posted: sec(2026, 7, 4) }] };
  const m = moneyYear([a], {}, 2026, now);
  assert.strictEqual(m.months.length, 10, 'Jan to Oct so far');
  assert.strictEqual(m.partial, true);
  assert.deepStrictEqual(m.months.map((x) => x.noData), [true, true, true, true, true, true, true, false, false, false]);
  assert.strictEqual(new Date(m.worth.startAt).getMonth(), 7);
  assert.strictEqual(Math.round(m.worth.start), 520);
  assert.strictEqual(moneyYear([a], {}, 2027, now), null, 'next year has not started');
});

test('money in January, while the year is a month old', () => {
  const a = { id: 'c', balance: 0, transactions: [{ description: 'Corner Deli', amount: -20, posted: sec(2027, 0, 4) }, { description: 'Corner Deli', amount: -30, posted: sec(2026, 11, 4) }] };
  const m = moneyYear([a], {}, 2027, new Date(2027, 0, 10).getTime());
  assert.deepStrictEqual(m.months.map((x) => [x.label, x.out]), [['Jan', 20]]);
});

test('the made-up year is the same every time and covers every part', () => {
  const now = new Date(2027, 0, 3).getTime();
  const a = reviewSample(2026, now), b = reviewSample(2026, now);
  assert.deepStrictEqual(a, b);
  const t = tasksYear(a.tasks, a.log, 2026);
  assert.ok(t.total > 200 && t.streak.days > 3);
  assert.ok(agentYear(a.tasks, a.log, 2026).answers > 20);
  assert.ok(hoursYear(a.hours, 2026).total > 100);
  const m = moneyYear(a.accounts, a.kinds, 2026, now);
  assert.ok(m.in > m.out && m.places.length === 5 && m.biggest.name === 'Best Buy');
  const soFar = reviewSample(2026, new Date(2026, 9, 31).getTime());
  assert.ok(soFar.tasks.concat(soFar.log).every((x) => (x.doneAt || x.at || 0) <= new Date(2026, 9, 31).getTime() || !x.done && !x.at));
});
