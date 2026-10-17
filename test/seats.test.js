const test = require('node:test');
const assert = require('node:assert');
const { cleanSeats } = require('../agent/seats');

test('a seat map keeps only seat characters, real links and short labels', () => {
  const s = cleanSeats({ where: 'AMC Easton · Dune · 7:30 pm', picked: ['F7', 'F8'], price: '$31.98', url: 'javascript:alert(1)',
    rows: [{ row: 'A', seats: '__ooX x_pp??__', first: 3 }, { row: 'B', seats: '___' }, null, { row: 'C', seats: 'aoo', first: 1 }] });
  assert.deepStrictEqual(s, { screen: 'Screen', where: 'AMC Easton · Dune · 7:30 pm', picked: ['F7', 'F8'], price: '$31.98',
    rows: [{ row: 'A', seats: 'ooxx_pp', first: 3 }, { row: 'C', seats: 'aoo' }] });
});

test('no rows, no map', () => {
  assert.strictEqual(cleanSeats({ rows: [] }), undefined);
  assert.strictEqual(cleanSeats({ rows: [{ row: 'A', seats: '___' }] }), undefined);
  assert.strictEqual(cleanSeats(null), undefined);
  assert.strictEqual(cleanSeats('A1'), undefined);
});

test('showtimes keep real days, theaters and times, and only https links', () => {
  const { cleanShowtimes } = require('../agent/seats');
  const s = cleanShowtimes({ movie: 'You Can See Everything', url: 'http://x.com', days: [
    { day: 'Fri Oct 17', theaters: [{ name: 'AMC Easton 30', dist: '4.2 mi', times: ['7:30 pm', { at: '9:45 pm', fmt: 'IMAX', url: 'https://fandango.com/t/1' }, { at: '' }] },
      { name: 'Empty', times: [] }] },
    { day: 'Sat', theaters: [] }, null] });
  assert.deepStrictEqual(s, { movie: 'You Can See Everything', days: [{ day: 'Fri Oct 17', theaters: [{ name: 'AMC Easton 30', dist: '4.2 mi',
    times: [{ at: '7:30 pm' }, { at: '9:45 pm', fmt: 'IMAX', url: 'https://fandango.com/t/1' }] }] }] });
  assert.strictEqual(cleanShowtimes({ days: [{ day: 'Sat', theaters: [] }] }), undefined);
  assert.strictEqual(cleanShowtimes(null), undefined);
});
