/* What a cloud AI's brief carries of a task's latest note (agent/runner.js briefNote): the local model's own note
   stays on his computer, like its lines in the conversation. */
const test = require('node:test');
const assert = require('node:assert');
const { briefNote } = require('../agent/runner');

test('a note the local model wrote is not passed on to a cloud AI', () => {
  const mine = { who: 'you', text: 'fill the form' };
  assert.strictEqual(briefNote({ note: 'Filled it with the address on file.', history: [mine, { who: 'claude', lane: 'local', text: 'Filled it with the address on file.' }] }), null);
  assert.strictEqual(briefNote({ note: 'old', history: [{ who: 'claude', lane: 'local', text: 'old' }, mine, { who: 'sys', text: 'passing it to the next AI' }] }), null);
});

test('a cloud AI still gets its own latest note', () => {
  assert.strictEqual(briefNote({ note: 'Two options found.', history: [{ who: 'claude', lane: 'local', text: 'x' }, { who: 'claude', text: 'Two options found.' }] }), 'Two options found.');
  assert.strictEqual(briefNote({ note: 'Imported note' }), 'Imported note');
  assert.strictEqual(briefNote({ history: [] }), null);
});
