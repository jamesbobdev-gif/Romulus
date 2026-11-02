const test = require('node:test');
const assert = require('node:assert');
const cs = require('../agent/course-sites');

const school = (tag, extra) => Object.assign({ ws: 'school', tag, title: 'x' }, extra);

test('each class goes to the site its items came from', () => {
  const tasks = [
    school('ACT 222', { site: 'bb-csuohio.blackboard.com' }), school('ACT 222', { site: 'bb-csuohio.blackboard.com' }),
    school('PHYS 1010', { notes: 'Read chapter 3\n\nhttps://d2llearn.tri-c.edu/d2l/le/calendar/1/event/2' }),
    school('WGS 1510', { site: 'd2llearn.tri-c.edu' }),
    school('ECN 201'), // added by hand: no site of its own
    { ws: 'personal', tag: 'ACT 222', site: 'd2llearn.tri-c.edu' }, // not the School list
    school(null, { site: 'bb-csuohio.blackboard.com' }), // no class yet
  ];
  assert.deepStrictEqual(cs.courseSites(tasks), [
    { course: 'ACT 222', kind: 'Blackboard', host: 'bb-csuohio.blackboard.com' },
    { course: 'PHYS 1010', kind: 'D2L', host: 'd2llearn.tri-c.edu' },
    { course: 'WGS 1510', kind: 'D2L', host: 'd2llearn.tri-c.edu' },
  ]);
});

test('a class with items on both sites goes with most of them', () => {
  const tasks = [school('MKT 301', { site: 'bb-csuohio.blackboard.com' }), school('MKT 301', { site: 'bb-csuohio.blackboard.com' }),
    school('MKT 301', { notes: 'https://d2llearn.tri-c.edu/x' })];
  assert.strictEqual(cs.courseSites(tasks)[0].kind, 'Blackboard');
});

test('links that are not a school site are ignored', () => {
  assert.deepStrictEqual(cs.courseSites([school('ENG 101', { notes: 'https://youtube.com/watch?v=1' }), school('ENG 101', { site: 'example.com' })]), []);
  assert.strictEqual(cs.siteKind('school.brightspace.com'), 'D2L');
  assert.strictEqual(cs.siteKind('mycourses.desire2learn.com'), 'D2L');
  assert.strictEqual(cs.siteKind('learn.example.edu'), null);
});

test('the model is told which classes are on which site', () => {
  const text = cs.show([{ course: 'ACT 222', kind: 'Blackboard', host: 'bb-csuohio.blackboard.com' },
    { course: 'HIST 1700', kind: 'D2L', host: 'd2llearn.tri-c.edu' }, { course: 'PHYS 1010', kind: 'D2L', host: 'd2llearn.tri-c.edu' }]);
  assert.match(text, /- Blackboard \(https:\/\/bb-csuohio\.blackboard\.com\): ACT 222\n/);
  assert.match(text, /- D2L \(https:\/\/d2llearn\.tri-c\.edu\): HIST 1700, PHYS 1010$/);
  assert.match(text, /never look for a class on the other site/);
  assert.strictEqual(cs.show([]), '');
});

test('only school tasks get the list', () => {
  const list = [{ course: 'PHYS 1010', kind: 'D2L', host: 'd2llearn.tri-c.edu' }];
  assert.ok(cs.relevant({ title: 'Do the Syllabus Quiz' }, list));
  assert.ok(cs.relevant({ title: 'phys1010 lab writeup' }, list), 'the course code, any spacing');
  assert.ok(cs.relevant({ title: 'Record the intro video' }, list, { coaching: true }));
  assert.ok(!cs.relevant({ title: 'Order paper towels on Amazon' }, list));
  assert.ok(!cs.relevant({ title: 'Do the Syllabus Quiz' }, []), 'nothing known: nothing to add');
});
