const test = require('node:test');
const assert = require('node:assert');
const sweep = require('../agent/class-sweep');

const NOW = new Date(2026, 10, 7, 10, 0); // Sat 2026-11-07

test('the sweep task is the one with its id or flag', () => {
  assert.ok(sweep.isSweep({ id: 'class-sweep' }));
  assert.ok(sweep.isSweep({ id: 'x', classSweep: true }));
  assert.ok(!sweep.isSweep({ id: 'x', title: 'Check my classes' }));
  assert.ok(!sweep.isSweep(null));
});

test('an item gets a clean course code, a stable id and its site', () => {
  const found = [];
  const r = sweep.addItem(found, { course: 'econ-101', title: '  Chapter 9   Homework ', due: '2026-11-10', time: '23:59', kind: 'assignment',
    link: 'https://bb-school.blackboard.com/ultra/courses/_1_1/outline', details: 'On Connect' }, NOW);
  assert.match(r, /^Added ECON 101: Chapter 9 Homework \(due 2026-11-10 23:59\)/);
  assert.deepStrictEqual(found[0], { id: sweep.itemId('ECON 101', 'Chapter 9 Homework'), course: 'ECON 101', title: 'Chapter 9 Homework',
    due: '2026-11-10', dueTime: '23:59', kind: 'regular', notes: 'On Connect', url: 'https://bb-school.blackboard.com/ultra/courses/_1_1/outline',
    source: 'bb-school.blackboard.com' });
  assert.match(found[0].id, /^bbs-[0-9a-f]{20}$/);
  // the same one again (different case and spacing) updates it, never a copy
  sweep.addItem(found, { course: 'ECON 101', title: 'chapter 9 homework', due: '2026-11-11', kind: 'assignment' }, NOW);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].due, '2026-11-11');
});

test('bad items are refused with a reason the model can act on', () => {
  const found = [];
  assert.match(sweep.addItem(found, { course: 'Principles of Macroeconomics', title: 'Quiz 3', due: '', kind: 'quiz' }, NOW), /course code/);
  assert.match(sweep.addItem(found, { course: 'ECON 101', title: 'Q', due: '', kind: 'quiz' }, NOW), /name/);
  assert.match(sweep.addItem(found, { course: 'ECON 101', title: 'Quiz 3', due: '11/10/2026', kind: 'quiz' }, NOW), /YYYY-MM-DD/);
  assert.match(sweep.addItem(found, { course: 'ECON 101', title: 'Quiz 1', due: '2026-10-01', kind: 'quiz' }, NOW), /past/);
  assert.match(sweep.addItem(found, { course: 'ECON 101', title: 'Final exam', due: '2027-12-10', kind: 'exam' }, NOW), /four months/);
  assert.strictEqual(found.length, 0);
});

test('kinds map to the School list types; undated items have no time; bad links are dropped', () => {
  const found = [];
  sweep.addItem(found, { course: 'ECON 101', title: 'Midterm Exam', due: '2026-11-20', kind: 'exam' }, NOW);
  sweep.addItem(found, { course: 'ECON 101', title: 'Exam Review', due: '2026-11-19', kind: 'exam' }, NOW);
  sweep.addItem(found, { course: 'ECON 101', title: 'Term paper', due: '', time: '10:00', kind: 'project', link: 'javascript:alert(1)' }, NOW);
  assert.deepStrictEqual(found.map((x) => x.kind), ['exam', 'regular', 'project']);
  assert.strictEqual(found[2].due, null);
  assert.strictEqual(found[2].dueTime, null);
  assert.strictEqual(found[2].url, null);
  assert.strictEqual(found[2].source, null);
});

test('undated items and the whole list are capped', () => {
  const found = [];
  for (let i = 0; i < 20; i++) sweep.addItem(found, { course: 'ECON 101', title: 'Reading ' + i, due: '', kind: 'reading' }, NOW);
  assert.strictEqual(found.length, 15);
  for (let i = 0; i < 60; i++) sweep.addItem(found, { course: 'ACCT 210', title: 'Homework ' + i, due: '2026-11-20', kind: 'assignment' }, NOW);
  assert.strictEqual(found.length, sweep.MAX_ITEMS);
});

test('the prompt lists what the School list already has, open and upcoming only', () => {
  const text = sweep.listedText([
    { ws: 'school', title: 'Chapter 8 Quiz', tag: 'MKT 301', due: '2026-11-08' },
    { ws: 'school', title: 'Old quiz', due: '2026-10-01' },
    { ws: 'school', title: 'Finished', due: '2026-11-09', done: true },
    { ws: 'personal', title: 'Groceries', due: '2026-11-09' },
    { ws: 'school', title: 'Read the syllabus', due: null },
  ], NOW);
  assert.match(text, /- MKT 301: Chapter 8 Quiz \(due 2026-11-08\)/);
  assert.match(text, /- Read the syllabus/);
  assert.doesNotMatch(text, /Old quiz|Finished|Groceries/);
  assert.match(sweep.listedText([], NOW), /nothing yet/);
});

test('work turned in is marked done only on what the page shows', () => {
  const done = [];
  assert.match(sweep.markDone(done, { course: 'phys-1010', title: 'Quiz: Properties of Stars', due: '2026-11-17', evidence: 'Attempts 1 / 1' }), /^Marked done: PHYS 1010/);
  assert.match(sweep.markDone(done, { course: 'PHYS 1010', title: 'ELO Assignment', evidence: 'Submitted' }), /^Marked done/);
  assert.match(sweep.markDone(done, { course: 'PHYS 1010', title: 'Midterm', evidence: 'Attempts 2 / 2' }), /^Marked done/);
  assert.deepStrictEqual(done[0], { course: 'PHYS 1010', title: 'Quiz: Properties of Stars', due: '2026-11-17' });
  assert.strictEqual(done[1].due, null);
  // the same one again is not a second entry
  assert.match(sweep.markDone(done, { course: 'PHYS 1010', title: 'quiz: properties of stars', evidence: '1 / 1' }), /Already/);
  assert.strictEqual(done.length, 3);
});

test('not turned in, or no proof, is never marked done', () => {
  const done = [];
  for (const evidence of ['Not Submitted', 'Attempts 0 / 1', '1 / 2', 'past due', '', 'Not completed'])
    assert.match(sweep.markDone(done, { course: 'PHYS 1010', title: 'Homework: Star Life and Death', evidence }), /Not marked/, evidence);
  assert.match(sweep.markDone(done, { course: 'Astronomy', title: 'Test 2', evidence: 'Submitted' }), /course code/);
  assert.strictEqual(done.length, 0);
  assert.strictEqual(sweep.DONE_TOOL.function.name, 'mark_class_done');
});

test('the rules stay read only and have no emoji', () => {
  assert.match(sweep.RULES, /never submit/i);
  assert.doesNotMatch(sweep.RULES, /\p{Extended_Pictographic}/u);
});
