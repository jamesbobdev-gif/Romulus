const test = require('node:test');
const assert = require('node:assert');
const { recurFromWords, tagFromWords } = require('../renderer/js/quick-add');

const FRI = new Date(2026, 10, 6, 9, 0); // Friday 6 Nov 2026

test('every <weekday>: weekly, first due that day', () => {
  assert.deepStrictEqual(recurFromWords('Call mom every sunday', FRI), { title: 'Call mom', every: 'week', due: '2026-11-08', onDay: true });
  assert.deepStrictEqual(recurFromWords('Trash out every Mon at 7pm', FRI), { title: 'Trash out at 7pm', every: 'week', due: '2026-11-09', onDay: true });
  assert.strictEqual(recurFromWords('Team lunch every friday', FRI).due, '2026-11-06'); // today is Friday
});

test('every day / weekdays / week / other week / month / year', () => {
  assert.deepStrictEqual(recurFromWords('Take vitamins every day', FRI), { title: 'Take vitamins', every: 'day', due: '2026-11-06', onDay: false });
  assert.strictEqual(recurFromWords('Take vitamins daily', FRI).every, 'day');
  assert.strictEqual(recurFromWords('Stand-up on weekdays', FRI).every, 'weekday');
  assert.strictEqual(recurFromWords('Stand-up every weekday', new Date(2026, 10, 7)).due, '2026-11-09'); // Saturday → Monday
  assert.strictEqual(recurFromWords('Review budget every week', FRI).every, 'week');
  assert.strictEqual(recurFromWords('Payday every other week', FRI).every, '2week');
  assert.strictEqual(recurFromWords('Pay rent every month on the 1st', FRI).title, 'Pay rent on the 1st');
  assert.strictEqual(recurFromWords('Renew license every year', FRI).every, 'year');
});

test('leaves ordinary titles alone', () => {
  assert.strictEqual(recurFromWords('Weekly report', FRI), null); // "weekly" only counts at the end
  assert.strictEqual(recurFromWords('Read Every Breath', FRI), null);
  assert.strictEqual(recurFromWords('Every day', FRI), null); // nothing left for a title
  assert.strictEqual(recurFromWords('Buy milk tomorrow', FRI), null);
});

test('#tag becomes the tag', () => {
  assert.deepStrictEqual(tagFromWords('Call mom #family'), { title: 'Call mom', tag: 'family' });
  assert.deepStrictEqual(tagFromWords('#errands Buy stamps'), { title: 'Buy stamps', tag: 'errands' });
  assert.deepStrictEqual(tagFromWords('Fix bug #42, then ship'), { title: 'Fix bug, then ship', tag: '42' });
  assert.deepStrictEqual(tagFromWords('#family'), { title: '#family', tag: null });
  assert.deepStrictEqual(tagFromWords('Email bob@site.com'), { title: 'Email bob@site.com', tag: null });
  assert.deepStrictEqual(tagFromWords('Learn C#'), { title: 'Learn C#', tag: null });
});
