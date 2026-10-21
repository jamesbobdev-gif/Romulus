const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../agent/signin-watch');

const SAML = 'https://login.microsoftonline.com/d7f3e79a/saml2?SAMLRequest=abc';

test('sign-in pages: Microsoft\'s, a site\'s own login page, a "Pick an account" title', () => {
  assert.ok(sw.isLoginPage(SAML));
  assert.ok(sw.isLoginPage('https://bb-csuohio.blackboard.com/webapps/login/'));
  assert.ok(sw.isLoginPage('https://d2llearn.tri-c.edu/d2l/login?target=%2fd2l%2fhome'));
  assert.ok(sw.isLoginPage('https://example.edu/x', 'Sign in to your account'));
  assert.ok(!sw.isLoginPage('https://bb-csuohio.blackboard.com/ultra/courses/_203944_1/outline', 'Content / ENT 315'));
  assert.ok(!sw.isLoginPage('https://www.blog.com/authors/jane')); // "authors" isn't /auth/
});

test('Blackboard sending him to Microsoft puts one Blackboard to-do on his list', () => {
  const sent = [];
  const tr = sw.tracker((ch, p) => sent.push([ch, p]));
  tr.see('https://bb-csuohio.blackboard.com/ultra/course', 'Courses');
  assert.strictEqual(tr.see(SAML, 'Sign in to your account'), 'signed-out');
  tr.see(SAML, 'Sign in to your account'); // again: no second to-do
  const todos = sent.filter((s) => s[0] === 'agent:reconnect');
  assert.strictEqual(todos.length, 1);
  assert.match(todos[0][1].title, /^Sign in to Blackboard on Lupa Au Palatine: /);
  assert.deepStrictEqual(tr.signedOut(), ['Blackboard']);
});

test('a signed-in page checks the to-do off, by the same prefix the to-do starts with', () => {
  const sent = [];
  const tr = sw.tracker((ch, p) => sent.push([ch, p]));
  assert.strictEqual(tr.see('https://d2llearn.tri-c.edu/d2l/home', 'Homepage'), 'signed-in');
  const done = sent.find((s) => s[0] === 'agent:reconnected');
  assert.ok(sw.todoTitle(sw.siteFor('d2llearn.tri-c.edu')).startsWith(done[1].prefix));
  assert.ok(done[1].prefix.endsWith(':'));
});

test('a sign-in page with no school site before it is left alone', () => {
  const sent = [];
  const tr = sw.tracker((ch, p) => sent.push([ch, p]));
  assert.strictEqual(tr.see('https://accounts.google.com/signin'), null);
  assert.strictEqual(sent.length, 0);
});

test('due once a day, from 7 am', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
  assert.ok(!sw.due(dir, new Date(2026, 9, 21, 6, 30)));
  assert.ok(sw.due(dir, new Date(2026, 9, 21, 7, 5)));
  fs.writeFileSync(path.join(dir, 'signin-check.json'), JSON.stringify({ day: new Date(2026, 9, 21).toLocaleDateString('en-CA') }));
  assert.ok(!sw.due(dir, new Date(2026, 9, 21, 9, 0)));
  assert.ok(sw.due(dir, new Date(2026, 9, 22, 9, 0)));
});

test('the daily check opens each school site, reads where it landed, and closes its tab', async () => {
  const tabs = {}; let n = 0; const closed = [];
  // a fake browser debugging port: Blackboard lands on Microsoft's sign-in, D2L on its home page
  const server = http.createServer((req, res) => {
    const u = decodeURI(req.url);
    if (u.startsWith('/json/new?')) {
      const want = u.slice('/json/new?'.length), id = 't' + (++n);
      tabs[id] = /blackboard/.test(want) ? { id, url: SAML, title: 'Sign in to your account' } : { id, url: want, title: 'Homepage - D2L' };
      return res.end(JSON.stringify(tabs[id]));
    }
    if (u === '/json/list') return res.end(JSON.stringify(Object.values(tabs)));
    if (u.startsWith('/json/close/')) { closed.push(u.slice(12)); delete tabs[u.slice(12)]; return res.end('ok'); }
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
  const sent = [];
  try {
    const out = await sw.dailyCheck({ port: server.address().port, sites: ['https://bb-csuohio.blackboard.com', 'https://d2llearn.tri-c.edu', 'walmart.com'], send: (ch, p) => sent.push([ch, p]), userData: dir, pauseMs: 1 });
    assert.deepStrictEqual(out.map((o) => [o.site, o.state]), [['Blackboard', 'signed-out'], ['D2L', 'signed-in']]);
    assert.deepStrictEqual(closed, ['t1', 't2']);
    assert.ok(sent.some((s) => s[0] === 'agent:reconnect' && /Blackboard/.test(s[1].title)));
    assert.ok(sent.some((s) => s[0] === 'agent:reconnected' && /D2L/.test(s[1].prefix)));
    // signed out of Blackboard: yesterday's to-do isn't checked off and replaced
    assert.ok(!sent.some((s) => s[0] === 'agent:reconnected' && /Blackboard/.test(s[1].prefix)));
    assert.ok(!sw.due(dir, new Date(new Date().setHours(12))));
  } finally { server.close(); }
});
