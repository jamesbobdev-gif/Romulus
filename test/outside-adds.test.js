/* A task that came from outside the app becomes a task for its list (renderer/js/outside-adds.js). */
const test = require('node:test');
const assert = require('node:assert');
const { outsideTask } = require('../renderer/js/outside-adds');

const NOW = 1760000000000;
let n = 0; const uid = () => 'o' + (++n);

test('his own to-do: the list, the date and time, no notes kept', () => {
  const t = outsideTask({ file: '1.json', title: ' Call the  dentist ', list: 'todo', due: '2026-11-20', time: '14:30', notes: 'bring the card', from: 'Claude Desktop' }, { uid, now: NOW });
  assert.deepStrictEqual(t, { id: 'o1', title: 'Call the dentist', done: false, due: '2026-11-20', dueTime: '14:30', tag: null, ws: 'personal', subs: [], googleEventId: null, created: NOW });
});

test('an Agent task is queued for the Agent, says where it came from, and keeps the notes', () => {
  const t = outsideTask({ file: '2.json', title: 'Find the cheapest flight to Denver', list: 'agent', notes: 'the weekend of the 14th', from: 'Claude Desktop' }, { uid, now: NOW });
  assert.strictEqual(t.ws, 'agent');
  assert.strictEqual(t.status, 'queued');
  assert.strictEqual(t.notes, 'the weekend of the 14th');
  assert.deepStrictEqual(t.history, [{ who: 'sys', text: 'Added from Claude Desktop', at: NOW }]);
});

test('work and school lists; a time without a date is dropped; no title is no task', () => {
  assert.strictEqual(outsideTask({ title: 'Slides', list: 'work', time: '09:00' }, { uid, now: NOW }).ws, 'work');
  assert.strictEqual(outsideTask({ title: 'Slides', list: 'work', time: '09:00' }, { uid, now: NOW }).dueTime, null);
  const s = outsideTask({ title: 'Essay', list: 'school', notes: 'two pages' }, { uid, now: NOW });
  assert.strictEqual(s.ws, 'school'); assert.strictEqual(s.kind, 'regular'); assert.strictEqual(s.notes, 'two pages');
  assert.strictEqual(outsideTask({ title: 'x', list: 'finance' }, { uid, now: NOW }).ws, 'personal');
  assert.strictEqual(outsideTask({ title: '  ' }, { uid, now: NOW }), null);
  assert.strictEqual(outsideTask(null, { uid, now: NOW }), null);
});
