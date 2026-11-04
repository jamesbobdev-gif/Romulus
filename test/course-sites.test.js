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

test('the app\'s own "From School →" line never reaches the model (it took the model\'s name for a course)', () => {
  const { forModel } = require('../agent/local-lane');
  const h = [{ who: 'sys', text: 'From School → Holo4-35B-A3B' }, { who: 'sys', text: 'Routed → The local model (school)' },
    { who: 'sys', text: 'The browser was closed' }, { who: 'you', text: 'try again' }];
  assert.deepStrictEqual(forModel(h).map((x) => x.text), ['The browser was closed', 'try again']);
});

test('the companies\' own sites send it back to his school', () => {
  assert.ok(cs.isVendor('login.community.d2l.com') && cs.isVendor('d2l.com') && cs.isVendor('www.blackboard.com'));
  assert.ok(!cs.isVendor('d2llearn.tri-c.edu') && !cs.isVendor('tri-c.brightspace.com') && !cs.isVendor('bb-csuohio.blackboard.com'));
  const known = cs.schoolHosts([{ course: 'ACT 222', kind: 'Blackboard', host: 'bb-csuohio.blackboard.com' }],
    '## School\n- Tri-C\'s D2L: https://d2llearn.tri-c.edu\n- Bank: https://bankofamerica.com');
  assert.deepStrictEqual(known, ['bb-csuohio.blackboard.com', 'd2llearn.tri-c.edu']);
  assert.match(cs.wrongSite('login.community.d2l.com', known), /https:\/\/d2llearn\.tri-c\.edu: open that/);
  assert.doesNotMatch(cs.wrongSite('login.community.d2l.com', known), /csuohio/);
  assert.match(cs.wrongSite('blackboard.com', []), /in his preferences/);
  assert.strictEqual(cs.wrongSite('d2llearn.tri-c.edu', known), null);
});
