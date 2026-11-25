const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// renderer/js/task-actions.js is a page script that touches the page as it loads: lift out just hashTag and run that
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'task-actions.js'), 'utf8');
const m = /function hashTag\(text\)\{[\s\S]*?\n\}/.exec(src);
assert.ok(m, 'hashTag is defined in task-actions.js');
// run in this context, so what comes back is an ordinary object and deepStrictEqual can compare it
const hashTag = vm.runInThisContext("(function(){" + m[0] + ";return hashTag;})()");

test('a hashtag in a typed task becomes its tag and leaves the title', () => {
  assert.deepStrictEqual(hashTag('Call the dentist #health'), { title: 'Call the dentist', tag: 'health' });
  assert.deepStrictEqual(hashTag('#errands pick up the dry cleaning'), { title: 'pick up the dry cleaning', tag: 'errands' });
  assert.deepStrictEqual(hashTag('Email #work the landlord'), { title: 'Email the landlord', tag: 'work' });
});

test('only the first hashtag is the tag; later ones stay in the title', () => {
  assert.deepStrictEqual(hashTag('Plan trip #travel #summer'), { title: 'Plan trip #summer', tag: 'travel' });
});

test('no hashtag, a hashtag with nothing else, or a # inside a word: null', () => {
  assert.strictEqual(hashTag('Call the dentist'), null);
  assert.strictEqual(hashTag('#health'), null);
  assert.strictEqual(hashTag('   #health  '), null);
  assert.strictEqual(hashTag('Room C#101 is booked'), null);
  assert.strictEqual(hashTag(''), null);
  assert.strictEqual(hashTag(null), null);
});
