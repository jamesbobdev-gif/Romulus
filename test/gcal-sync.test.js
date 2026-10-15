const test = require('node:test');
const assert = require('node:assert');
const { eventFor, addDays, addMinutesIso } = require('../main/gcal-sync');

test('addDays crosses month and year ends', () => {
  assert.strictEqual(addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});

test('addMinutesIso rolls over the hour and day', () => {
  assert.strictEqual(addMinutesIso('2026-10-15', '23:45', 30), '2026-10-16T00:15:00');
  assert.strictEqual(addMinutesIso('2026-10-15', '09:05', 30), '2026-10-15T09:35:00');
});

test('an undated-time task is an all-day event', () => {
  assert.deepStrictEqual(eventFor({ title: 'Dentist', due: '2026-10-20' }, 'X'),
    { summary: 'Dentist', allDay: true, date: '2026-10-20', endDate: '2026-10-21' });
});

test('a timed task is a 30-minute event with its tag', () => {
  assert.deepStrictEqual(eventFor({ title: 'Call', due: '2026-10-20', dueTime: '14:00', tag: 'home' }, 'America/New_York'),
    { summary: 'Call', allDay: false, start: '2026-10-20T14:00:00', end: '2026-10-20T14:30:00', tz: 'America/New_York', description: 'Tag: home' });
});

test('school events say the class and kind', () => {
  assert.strictEqual(eventFor({ ws: 'school', kind: 'exam', title: 'Chapter 4', tag: 'Astronomy', due: '2026-10-20' }).summary, 'Astronomy test: Chapter 4');
  assert.strictEqual(eventFor({ ws: 'school', kind: 'exam', title: 'Midterm', tag: 'Astronomy', due: '2026-10-20' }).summary, 'Astronomy — Midterm');
  assert.strictEqual(eventFor({ ws: 'school', kind: 'project', title: 'Rocket', due: '2026-10-20' }).summary, 'Project: Rocket');
  const ev = eventFor({ ws: 'school', kind: 'exam', title: 'Astronomy test 2', tag: 'Astronomy', notes: 'bring a calculator', due: '2026-10-20' });
  assert.strictEqual(ev.summary, 'Astronomy test 2');
  assert.strictEqual(ev.description, 'Class: Astronomy\n\nbring a calculator');
});
