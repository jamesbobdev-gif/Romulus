const test = require('node:test');
const assert = require('node:assert');
const fo = require('../agent/find-out');

test('a title that only names the work is vague', () => {
  ['chapter 8', 'Ch 8', 'ch. 8 hw', 'Chapter 8 #local', 'module 3 quiz', 'week 5', 'HW 4', 'do the reading for tomorrow', 'Lab 2']
    .forEach((title) => assert.ok(fo.isVague({ title }), title));
  assert.ok(fo.isVague({ title: 'chapter 8', tag: 'ECN 201' }), 'its class but no instructions: still find out what it is');
});

test('a task that says what it is already is not', () => {
  assert.ok(!fo.isVague({ title: 'Chapter 8 Homework', tag: 'ECN 201', notes: 'Answer the 20 questions at the end of chapter 8 in Connect.\n\nhttps://x.blackboard.com/ultra/1' }));
  assert.ok(!fo.isVague({ title: 'chapter 8', notes: 'https://bb.school.edu/ultra/courses/_1/outline' }), 'a link to it');
  assert.ok(!fo.isVague({ title: 'Read chapter 8 of Dune' }), 'his own book');
  assert.ok(!fo.isVague({ title: 'Watch season 2 episode 8' }));
  assert.ok(!fo.isVague({ title: 'chapter 8 #legion' }));
  assert.ok(!fo.isVague({ title: 'Order paper towels' }));
  assert.ok(!fo.isVague({ title: 'Write a summary of how the federal reserve sets rates in chapter 8 of the book' }), 'long: it says enough');
  assert.ok(!fo.isVague(null));
});

test('units come down to one word, with their number', () => {
  assert.deepStrictEqual(fo.refs('Ch. 8 HW 3'), [{ unit: 'chapter', n: '8' }, { unit: 'homework', n: '3' }]);
  assert.deepStrictEqual(fo.refs('Chapter 7 Homework'), [{ unit: 'chapter', n: '7' }]);
});

test('the class whose numbering comes closest is the likeliest', () => {
  const tasks = [
    { id: 'a', ws: 'school', tag: 'ECN 201', title: 'Chapter 7 Homework', due: '2026-11-03', done: true },
    { id: 'b', ws: 'school', tag: 'ACT 222', title: 'Chapter 12 Quiz', due: '2026-11-05' },
    { id: 'c', ws: 'school', tag: 'MKT 301', title: 'Discussion 4', due: '2026-11-09' },
    { id: 'd', ws: 'personal', tag: 'ECN 201', title: 'Chapter 8 groceries' },
  ];
  const c = fo.clues({ id: 'x', title: 'chapter 8' }, tasks);
  assert.strictEqual(c[0].course, 'ECN 201');
  assert.strictEqual(c[1].course, 'ACT 222');
  const text = fo.cluesText({ id: 'x', title: 'chapter 8' }, tasks);
  assert.match(text, /Likeliest class: ECN 201/);
  assert.match(text, /Chapter 7 Homework \(due 2026-11-03\) \[done\]/);
  assert.match(text, /MKT 301: nothing numbered like this/);
  assert.doesNotMatch(text, /groceries/);
  assert.match(fo.cluesText({ id: 'x', title: 'chapter 8', tag: 'ACT 222' }, tasks), /labeled ACT 222/);
  assert.match(fo.cluesText({ id: 'x', title: 'chapter 8' }, []), /nothing on it yet/);
});

test('pin_down_task keeps a clean item and says to go on', () => {
  const p = {};
  const r = fo.pin(p, { course: 'ecn-201', title: ' Chapter 8   Homework ', due: '2026-11-10', time: '23:59', link: 'https://bb.school.edu/ultra/x', details: '20 questions in McGraw Hill Connect, from the course.' });
  assert.match(r, /Pinned down: ECN 201, Chapter 8 Homework \(due 2026-11-10 23:59\)/);
  assert.match(r, /waits for his yes/);
  assert.deepStrictEqual(p.item, { course: 'ECN 201', title: 'Chapter 8 Homework', due: '2026-11-10', dueTime: '23:59', details: '20 questions in McGraw Hill Connect, from the course.', url: 'https://bb.school.edu/ultra/x' });
  fo.pin(p, { course: 'ECN 201', title: 'Chapter 8 Reading', due: '', time: '10:00', link: 'javascript:alert(1)', details: 'Read pages 200 to 230.' });
  assert.strictEqual(p.item.title, 'Chapter 8 Reading', 'a second call replaces the first');
  assert.strictEqual(p.item.dueTime, null); assert.strictEqual(p.item.url, null);
});

test('pin_down_task turns back what it can\'t use', () => {
  const p = {};
  assert.match(fo.pin(p, { course: 'Macroeconomics', title: 'Chapter 8', details: 'twenty questions' }), /course code/);
  assert.match(fo.pin(p, { course: 'ECN 201', title: 'C', details: 'twenty questions' }), /full name/);
  assert.match(fo.pin(p, { course: 'ECN 201', title: 'Chapter 8', details: 'hw' }), /details/);
  assert.match(fo.pin(p, { course: 'ECN 201', title: 'Chapter 8', due: '11/10', details: 'twenty questions' }), /YYYY-MM-DD/);
  assert.strictEqual(p.item, undefined);
});
