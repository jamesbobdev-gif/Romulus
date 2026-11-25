const test = require('node:test');
const assert = require('node:assert');
const { HIST_KEEP_DAYS, histSynced, histUpForm, histCarry, histArchive } = require('../renderer/js/history-trim');

const DAY = 86400000, NOW = new Date(2026, 10, 18, 12).getTime();
const said = (who, at) => ({ who, text: who + ' at ' + at, at });
const old = () => ({ id: 'a', ws: 'agent', done: true, status: 'done', updatedAt: NOW - (HIST_KEEP_DAYS + 1) * DAY,
  history: [said('you', NOW - 20 * DAY), said('claude', NOW - 19 * DAY)] });

test('a finished Agent task untouched for a week stops sending its conversation; the task keeps it', () => {
  const t = old();
  assert.strictEqual(histArchive([t], NOW), 1);
  assert.strictEqual(t.histFrom, NOW);
  assert.strictEqual(t.updatedAt, NOW); // newer than every other copy
  assert.strictEqual(t.history.length, 2); // this device still has it all
  const up = histUpForm(t);
  assert.deepStrictEqual(up.history, []);
  assert.strictEqual(t.history.length, 2); // sending it changes nothing here
  assert.strictEqual(histArchive([t], NOW + DAY * 30), 0); // nothing new to hold back: not stamped again
});

test('left whole: open tasks, recent ones, other lists, and ones that run again by themselves', () => {
  const open = Object.assign(old(), { done: false, status: 'needs-you' });
  const fresh = Object.assign(old(), { updatedAt: NOW - DAY });
  const human = Object.assign(old(), { ws: 'personal' });
  const repeats = Object.assign(old(), { repeat: 'weekly' });
  const waits = Object.assign(old(), { trigger: { kind: 'date' } });
  const silent = Object.assign(old(), { history: [] });
  assert.strictEqual(histArchive([open, fresh, human, repeats, waits, silent], NOW), 0);
  [open, fresh, human, repeats, waits, silent].forEach((t) => assert.strictEqual(t.histFrom, undefined));
  assert.strictEqual(histUpForm(open), open); // untouched tasks go up as the same object
});

test('what is said after that syncs as usual, and a later quiet week holds it back too', () => {
  const t = old();
  histArchive([t], NOW);
  t.history.push(said('you', NOW + DAY));
  assert.deepStrictEqual(histSynced(t).map((h) => h.at), [NOW + DAY]);
  assert.strictEqual(histUpForm(t).history.length, 1);
  t.updatedAt = NOW + DAY;
  assert.strictEqual(histArchive([t], NOW + 9 * DAY), 1);
  assert.deepStrictEqual(histUpForm(t).history, []);
  assert.strictEqual(t.history.length, 3);
});

test('a newer copy from online keeps the old conversation this device holds', () => {
  const mine = old();
  const online = { id: 'a', done: true, status: 'done', histFrom: NOW, updatedAt: NOW, history: [said('you', NOW + 5)] };
  const kept = histCarry(online, mine);
  assert.deepStrictEqual(kept.history.map((h) => h.at), [NOW - 20 * DAY, NOW - 19 * DAY, NOW + 5]);
  assert.deepStrictEqual(histUpForm(kept).history, online.history); // and goes back up exactly as it came
  assert.strictEqual(online.history.length, 1); // the copy it was given is left alone
  // nothing to carry: a device that never had it, or a copy that isn't held back
  assert.strictEqual(histCarry(online, { id: 'a', history: [] }), online);
  assert.strictEqual(histCarry(online, undefined), online);
  const plain = { id: 'a', history: [said('claude', 5)] };
  assert.strictEqual(histCarry(plain, mine), plain);
});

test('an online copy that still carries old lines (an older build sent it) never doubles them', () => {
  const mine = old();
  const online = { id: 'a', histFrom: NOW, updatedAt: NOW + 1, history: mine.history.concat(said('claude', NOW + 9)) };
  assert.deepStrictEqual(histCarry(online, mine).history.map((h) => h.at), [NOW - 20 * DAY, NOW - 19 * DAY, NOW + 9]);
});
