/* Things that grow with months of use: the memory tidy can still shorten a long memory, and the agent's
   actions log is cut back instead of growing for good. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tidyProblem, MEMORY_MAX } = require('../agent/memory-tidy');
const { trimActions, ACTIONS_MAX } = require('../agent/browser-proxy');

const memory = (lines, width) => '## About him\n' + Array.from({ length: lines }, (_, i) => '- fact ' + i + ' ' + 'x'.repeat(width)).join('\n');

test('memory tidy: a short answer is fine; a long one only when it shrinks an already long memory', () => {
  const short = memory(10, 20);
  assert.strictEqual(tidyProblem(short, memory(9, 20)), null);
  assert.strictEqual(tidyProblem(short, 'no headings\n- a'), 'no headings');
  assert.strictEqual(tidyProblem(short, memory(5, 20)), 'dropped too many lines');
  // over the limit from the start: the old check refused every answer, so it never got shorter
  const long = memory(80, 100);
  assert.ok(long.length > MEMORY_MAX);
  assert.strictEqual(tidyProblem(long, memory(60, 100)), null, 'shrunk, though still over the limit');
  assert.strictEqual(tidyProblem(long, memory(42, 60)), null, 'condensing a long memory may merge lines');
  assert.strictEqual(tidyProblem(long, long + '\n- one more ' + 'y'.repeat(50)), 'too long');
  assert.strictEqual(tidyProblem(short, memory(70, 100)), 'too long', 'a short memory never balloons past the limit');
});

test('actions log: cut back to its newest whole lines once it passes the limit', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'actions-')), 'agent-actions.log');
  const line = (i) => JSON.stringify({ at: i, what: 'click ' + 'z'.repeat(100) }) + '\n';
  let text = ''; for (let i = 0; text.length <= ACTIONS_MAX; i++) text += line(i);
  fs.writeFileSync(file, text);
  trimActions(file);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.length < ACTIONS_MAX / 1.5);
  assert.ok(text.endsWith(after), 'the newest lines are the ones kept');
  after.trim().split('\n').forEach((l) => JSON.parse(l)); // every line whole
  trimActions(file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), after, 'under the limit: left alone');
});
