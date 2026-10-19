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

test('theaters keep names, addresses, days and real coordinates only', () => {
  const { cleanTheaters } = require('../agent/seats');
  const s = cleanTheaters({ movie: 'You Can See Everything', days: ['Sat Oct 17', ''], here: { lat: 1, lng: 1 }, theaters: [
    { name: 'Cinemark Springfield', address: '100 Main St, Springfield, IL', lat: 39.8, lng: -89.65, days: ['Sat Oct 17'], url: 'https://cinemark.com/x' },
    { name: 'Bogus spot', lat: 'x', lng: 500, url: 'javascript:1' }, { address: 'no name' }, null] });
  assert.deepStrictEqual(s, { movie: 'You Can See Everything', days: ['Sat Oct 17'], theaters: [
    { name: 'Cinemark Springfield', address: '100 Main St, Springfield, IL', lat: 39.8, lng: -89.65, days: ['Sat Oct 17'], url: 'https://cinemark.com/x' },
    { name: 'Bogus spot' }] });
  assert.strictEqual(cleanTheaters({ theaters: [] }), undefined);
  assert.strictEqual(cleanTheaters(null), undefined);
});

test('theaters get pinned from their address and sorted by his distance', async () => {
  const { placeTheaters } = require('../agent/seats');
  const { miles } = require('../agent/where');
  const spots = { 'far st': { lat: 40.0, lng: -89.4 }, 'near st': { lat: 39.81, lng: -89.61 } };
  const s = { theaters: [{ name: 'Far', address: 'far st' }, { name: 'Unknown', address: 'nowhere' }, { name: 'Near', address: 'near st', lat: 10, lng: 10 }] };
  await placeTheaters(s, { lat: 39.8, lng: -89.6, accuracyM: 100 }, { geocode: async (a) => spots[a] || null, miles });
  assert.deepStrictEqual(s.here, { lat: 39.8, lng: -89.6 });
  assert.deepStrictEqual(s.theaters.map((t) => t.name), ['Near', 'Far', 'Unknown']);
  assert.deepStrictEqual([s.theaters[0].lat, s.theaters[0].lng, s.theaters[0].dist], [39.81, -89.61, '0.9 mi']);
  assert.strictEqual(s.theaters[2].lat, undefined);
});
