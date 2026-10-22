const test = require('node:test');
const assert = require('node:assert');
const pageReader = require('../agent/page-reader');

// a browser whose one action fails with `err`; looking at the page always works
const fakeBrowser = (err) => ({ async call(name) { return name === 'browser_snapshot' ? '- Page URL: https://example.com\n- button "OK" [ref=e1]' : err; } });

test('a page that never finishes loading is a load timeout, not a locked screen', async () => {
  const r = await pageReader.step(fakeBrowser('Refused or failed: ### Error\nError: browserBackend.callTool: Timeout 60000ms exceeded'), 'browser_navigate', { url: 'https://example.com' }, {});
  assert.strictEqual(r.loadTimeout, true);
  assert.strictEqual(r.clickTimeout, false);
  assert.match(r.text, /took too long to load/);
  assert.doesNotMatch(r.text, /screen is probably locked/);
});

test('a click that times out still points at the locked screen', async () => {
  const r = await pageReader.step(fakeBrowser('Refused or failed: ### Error\nTimeoutError: Timeout 5000ms exceeded.\n  - attempting click action'), 'browser_click', { target: 'e1' }, { refs: {} });
  assert.strictEqual(r.clickTimeout, true);
  assert.strictEqual(r.loadTimeout, false);
  assert.match(r.text, /screen is probably locked/);
});

// Blackboard opens discussions and McGraw Hill quizzes in a new tab; Playwright stays on the old one
test('a click that opens a new tab moves to that tab', async () => {
  const calls = [];
  let current = 0;
  const pages = ['- Page URL: https://bb.example/outline\n- link "Chapter 8 Discussion" [ref=e5]', '- Page URL: https://bb.example/discussion/8\n- heading "Chapter 8 Discussion" [level=1]\n- button "Reply" [ref=e9]'];
  const browser = { async call(name, args) {
    calls.push([name, args]);
    if (name === 'browser_tabs' && args.action === 'list') return '### Open tabs\n- 0: (current) [Outline](https://bb.example/outline)';
    if (name === 'browser_tabs' && args.action === 'select') { current = args.index; return 'ok'; }
    if (name === 'browser_click') return '### Ran Playwright code\n```js\nawait page.click()\n```\n### Open tabs\n- 0: (current) [Outline](https://bb.example/outline)\n- 1: [Discussion](https://bb.example/discussion/8)\n### Page\n- Page URL: https://bb.example/outline';
    return pages[current];
  } };
  const r = await pageReader.step(browser, 'browser_click', { target: 'e5' }, {});
  assert.deepStrictEqual(calls.find((c) => c[0] === 'browser_tabs' && c[1].action === 'select'), ['browser_tabs', { action: 'select', index: 1 }]);
  assert.match(r.text, /opened in a new tab/);
  assert.match(r.text, /Reply/);
});

test('a click that stays on the same tab does not switch tabs', async () => {
  const calls = [];
  const browser = { async call(name, args) {
    calls.push(name + (args && args.action ? ':' + args.action : ''));
    if (name === 'browser_tabs') return '### Open tabs\n- 0: [Mail](https://mail.example)\n- 1: (current) [Outline](https://bb.example/outline)';
    if (name === 'browser_click') return '### Open tabs\n- 0: [Mail](https://mail.example)\n- 1: (current) [Next](https://bb.example/next)\n### Page\n- Page URL: https://bb.example/next';
    return '- Page URL: https://bb.example/next\n- button "OK" [ref=e1]';
  } };
  const r = await pageReader.step(browser, 'browser_click', { target: 'e1' }, {});
  assert.ok(!calls.includes('browser_tabs:select'));
  assert.doesNotMatch(r.text, /new tab/);
});

test('clicking an open section says it closed it', async () => {
  const browser = { async call(name) {
    if (name === 'browser_snapshot') return '- Page URL: https://bb.example/outline\n- button "Learning Module, Chapter 8" [expanded] [ref=e3]';
    if (name === 'browser_tabs') return '';
    return 'Done';
  } };
  const r = await pageReader.step(browser, 'browser_click', { target: 'e3' }, {});
  assert.match(r.text, /already open, so this click closed it/);
});

test('an empty ref falls back to the element\'s words instead of an empty selector', () => {
  const state = { refs: pageReader.outline('- Page URL: https://bb.example\n- button "Learning Module, Chapter 8 - Business and Financial Analysis" [ref=e7]').refs };
  const a = pageReader.fixArgs('browser_click', { target: '', element: 'Learning Module, Chapter 8 - Business and Financial Analysis' }, state);
  assert.strictEqual(a.target, 'e7');
});

// Blackboard Ultra, as Playwright shows it: names with a colon come YAML-quoted, a module's button sits in a heading
const ULTRA = [
  '- Page URL: https://bb.example/ultra/courses/_1_1/outline',
  '- main [ref=e85]:',
  '  - heading [level=3] [ref=e359]:',
  '    - button "Learning Module, Chapter 8 - Business and Financial Analysis" [expanded] [ref=e360]: Chapter 8 - Business and Financial Analysis',
  '  - region "Learning Module, Chapter 8" [ref=e519]:',
  '    - \'checkbox "Status for Ch 8 Quiz: Completed" [checked] [ref=e446]\'',
  '    - link "Quiz, Ch 8 Quiz" [ref=e457]:',
  '      - /url: "#"',
  '    - \'link "Past due: it\'\'s late" [ref=e169]\':',
  '      - /url: javascript:void(0);',
].join('\n');

test('quoted lines keep their refs, and a button inside a heading is shown', () => {
  const o = pageReader.outline(ULTRA);
  assert.ok(o.refs.e446 && o.refs.e446.role === 'checkbox' && o.refs.e446.name === 'Status for Ch 8 Quiz: Completed');
  assert.strictEqual(o.refs.e169.name, "Past due: it's late");
  assert.match(o.text, /### button "Learning Module, Chapter 8 - Business and Financial Analysis" \[e360\] \(on\)/);
  assert.match(o.text, /checkbox "Status for Ch 8 Quiz: Completed" \[e446\] = checked/);
});

test('find shows the match it can click first, even after many that are only text', async () => {
  const desc = (i) => ['- main [ref=e85]:', '  - heading [level=3] [ref=e' + (300 + i) + ']:', '    - button "Learning Module, Chapter ' + i + '" [ref=e' + (400 + i) + ']: Chapter ' + i,
    '  - generic [ref=e' + (500 + i) + ']: "Contains weekly quiz, assignment, and discussion post. ' + 'Learning objectives go on and on. '.repeat(12) + '"'].join('\n');
  const snippets = [1, 2, 3, 4, 5, 6, 7, 8].map(desc).concat(['- main [ref=e85]:\n  - region "Chapter 8" [ref=e519]:\n    - link "Quiz, Ch 8 Quiz" [ref=e457]:\n      - /url: "#"']);
  const res = '### Result\nFound 9 matches for "Quiz":\n\n' + snippets.join('\n\n----\n\n') + '\n### Page\n- Page URL: https://bb.example/outline';
  const browser = { async call(name) { return name === 'browser_find' ? res : '- Page URL: https://bb.example/outline\n- button "OK" [ref=e1]\n- button "A" [ref=e2]\n- button "B" [ref=e3]\n- button "C" [ref=e4]'; } };
  const r = await pageReader.step(browser, 'browser_find', { text: 'Quiz' }, {});
  assert.match(r.text, /the ones you can click first/);
  assert.ok(r.text.indexOf('Quiz, Ch 8 Quiz') < r.text.indexOf('Chapter 1'));
});

test('after a click on a long page, the view starts at what was clicked', () => {
  const filler = Array.from({ length: 80 }, (_, i) => '- paragraph [ref=p' + i + ']: Module ' + i + ' description that goes on for a while to fill the page up.').join('\n');
  const snap = '- Page URL: https://bb.example\n' + filler + '\n- button "Chapter 8" [expanded] [ref=e360]\n- link "Quiz, Ch 8 Quiz" [ref=e457]';
  const o = pageReader.outline(snap, { max: 2000, focus: 'e360' });
  assert.match(o.text, /top of the page left out/);
  assert.match(o.text, /Quiz, Ch 8 Quiz/);
});
