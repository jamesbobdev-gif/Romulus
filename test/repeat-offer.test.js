/* A schedule read out of his words on an Agent task (renderer/js/repeat-offer.js). */
const test = require('node:test');
const assert = require('node:assert');
const { repeatFromWords, repeatTimeFrom, repeatSame } = require('../renderer/js/repeat-offer');

test('times: a bare hour is the morning from 7 and the afternoon up to 6; am/pm and 24-hour as said', () => {
  assert.strictEqual(repeatTimeFrom('every weekday at 9'), '09:00');
  assert.strictEqual(repeatTimeFrom('every day at 5'), '17:00');
  assert.strictEqual(repeatTimeFrom('each monday at 8am'), '08:00');
  assert.strictEqual(repeatTimeFrom('daily at 7 pm'), '19:00');
  assert.strictEqual(repeatTimeFrom('at 12pm'), '12:00');
  assert.strictEqual(repeatTimeFrom('at 12am'), '00:00');
  assert.strictEqual(repeatTimeFrom('every day at 17:30'), '17:30');
  assert.strictEqual(repeatTimeFrom('every day @ 6:15'), '18:15');
  assert.strictEqual(repeatTimeFrom('every morning'), null);
  assert.strictEqual(repeatTimeFrom('look at 2026-11-20'), null, 'a date is not a time');
  assert.strictEqual(repeatTimeFrom('at 13pm'), null);
});

test('every weekday, every day, each weekday morning', () => {
  assert.deepStrictEqual(repeatFromWords('Check the Amtrak price every weekday at 9'), { every: 'weekday', day: null, at: '09:00' });
  assert.deepStrictEqual(repeatFromWords('do this every day'), { every: 'day', day: null, at: '08:00' });
  assert.deepStrictEqual(repeatFromWords('Look at my inbox every morning and list what needs an answer'), { every: 'day', day: null, at: '08:00' });
  assert.deepStrictEqual(repeatFromWords('remind me every evening'), { every: 'day', day: null, at: '18:00' });
  assert.deepStrictEqual(repeatFromWords('every night at 10pm'), { every: 'day', day: null, at: '22:00' });
  assert.deepStrictEqual(repeatFromWords('on weekdays at 7:45'), { every: 'weekday', day: null, at: '07:45' });
  assert.deepStrictEqual(repeatFromWords('daily'), { every: 'day', day: null, at: '08:00' });
});

test('one weekday a week, and every week with no day', () => {
  assert.deepStrictEqual(repeatFromWords('Each Monday at 8am, plan the week'), { every: 'week', day: 1, at: '08:00' });
  assert.deepStrictEqual(repeatFromWords('order groceries every sunday'), { every: 'week', day: 0, at: '08:00' });
  assert.deepStrictEqual(repeatFromWords('every thursday evening'), { every: 'week', day: 4, at: '18:00' });
  assert.deepStrictEqual(repeatFromWords('on Wednesdays at noon'), { every: 'week', day: 3, at: '12:00' });
  assert.deepStrictEqual(repeatFromWords('weekly'), { every: 'week', day: null, at: '08:00' });
  assert.deepStrictEqual(repeatFromWords('do this once a week'), { every: 'week', day: null, at: '08:00' });
});

test('nothing the Agent’s repeats can do, or no schedule at all: no offer', () => {
  assert.strictEqual(repeatFromWords('every 2 weeks'), null);
  assert.strictEqual(repeatFromWords('every other monday'), null);
  assert.strictEqual(repeatFromWords('every month on the 1st'), null);
  assert.strictEqual(repeatFromWords('check this monthly'), null);
  assert.strictEqual(repeatFromWords('every weekend'), null);
  assert.strictEqual(repeatFromWords('Find the cheapest flight to Denver'), null);
  assert.strictEqual(repeatFromWords('reply to every email from the landlord'), null, '"every email" is a count, not a schedule');
  assert.strictEqual(repeatFromWords(''), null);
});

test('the same schedule is the same whatever the day field says for a daily one', () => {
  assert.ok(repeatSame({ every: 'day', at: '08:00', day: null }, { every: 'day', at: '08:00' }));
  assert.ok(repeatSame({ every: 'week', at: '08:00', day: 1 }, { every: 'week', at: '08:00', day: 1 }));
  assert.ok(!repeatSame({ every: 'week', at: '08:00', day: 1 }, { every: 'week', at: '08:00', day: 2 }));
  assert.ok(!repeatSame({ every: 'day', at: '08:00' }, { every: 'day', at: '09:00' }));
  assert.ok(!repeatSame(null, { every: 'day', at: '08:00' }));
});
