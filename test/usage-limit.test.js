const test = require('node:test');
const assert = require('node:assert');
const { parseUsageLimit } = require('../agent/usage-limit');

test('not a usage-limit message → null', () => {
  assert.strictEqual(parseUsageLimit('everything went fine'), null);
  assert.strictEqual(parseUsageLimit(''), null);
});

test('epoch form, seconds or milliseconds', () => {
  assert.strictEqual(parseUsageLimit('Claude AI usage limit reached|1760000000'), 1760000000000);
  assert.strictEqual(parseUsageLimit('limit reached|1760000000123'), 1760000000123);
});

test('"resets 3pm" is the next 3pm', () => {
  const at = parseUsageLimit("You've hit your limit · resets 3pm");
  const d = new Date(at);
  assert.strictEqual(d.getHours(), 15);
  assert.strictEqual(d.getMinutes(), 0);
  assert.ok(at > Date.now() && at <= Date.now() + 24 * 3600 * 1000);
});

test('"resets at 3:30 AM" and 12am', () => {
  assert.strictEqual(new Date(parseUsageLimit('5-hour limit reached, resets at 3:30 AM')).getMinutes(), 30);
  assert.strictEqual(new Date(parseUsageLimit('weekly limit · resets 12am')).getHours(), 0);
});

test('"resets Oct 5, 3pm" uses the date', () => {
  const d = new Date(parseUsageLimit('usage limit · resets Oct 5, 3pm'));
  assert.strictEqual(d.getMonth(), 9);
  assert.strictEqual(d.getDate(), 5);
  assert.strictEqual(d.getHours(), 15);
});

test('limit with no time given: about 30 minutes', () => {
  const at = parseUsageLimit('out of usage');
  assert.ok(Math.abs(at - (Date.now() + 30 * 60 * 1000)) < 5000);
});
