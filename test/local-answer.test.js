const test = require('node:test');
const assert = require('node:assert');
const { readAnswer, escapeInStrings, keepDraft } = require('../agent/local-answer');

test('readAnswer reads plain and fenced JSON', () => {
  assert.deepStrictEqual(readAnswer('{"status":"done","note":"ok"}'), { status: 'done', note: 'ok' });
  assert.deepStrictEqual(readAnswer('```json\n{"status":"done","note":"ok"}\n```'), { status: 'done', note: 'ok' });
});

test('readAnswer accepts raw line breaks inside strings', () => {
  assert.strictEqual(readAnswer('{"status":"done","note":"line 1\nline 2"}').note, 'line 1\nline 2');
});

test('readAnswer uses text written before an empty note', () => {
  const essay = Array.from({ length: 30 }, (_, i) => 'word' + i).join(' ');
  const a = readAnswer("Here's your essay:\n" + essay + '\n{"status":"done","note":""}');
  assert.strictEqual(a.note, essay);
});

test('readAnswer gives null without a JSON object', () => {
  assert.strictEqual(readAnswer('no json here'), null);
  assert.strictEqual(readAnswer('[1,2]'), null);
});

test('escapeInStrings leaves text outside strings alone', () => {
  assert.strictEqual(escapeInStrings('{\n"a":"x\ty"}'), '{\n"a":"x\\ty"}');
});

test('keepDraft swaps in the longer plain-text answer', () => {
  const draft = 'one two three four five six seven eight nine ten';
  assert.strictEqual(keepDraft({ note: 'short' }, draft).note, draft);
  assert.strictEqual(keepDraft({ note: draft }, 'tiny').note, draft);
});
