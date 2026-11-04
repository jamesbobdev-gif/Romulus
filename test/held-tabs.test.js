const test = require('node:test');
const assert = require('node:assert');
const qb = require('../agent/qwen-browser');
qb.init({ readConfig: () => ({}), agentLog: () => {} });

// a fake of the mini PC browser's /json endpoints
function fakeBrowser(pages) {
  let n = 0;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(url);
    const u = String(url);
    if (u.endsWith('/json/list')) return { json: async () => pages.map((p) => Object.assign({ type: 'page' }, p)) };
    let m = u.match(/\/json\/new\?(.*)$/);
    if (m) { const p = { id: 'new' + (++n), url: m[1] }; pages.push(p); return { json: async () => p }; }
    m = u.match(/\/json\/close\/(.+)$/);
    if (m) { const i = pages.findIndex((p) => p.id === m[1]); if (i >= 0) pages.splice(i, 1); return { ok: true }; }
    throw new Error('unexpected ' + u + ' ' + JSON.stringify(opts));
  };
  return { pages, calls };
}

test('the next task finishing leaves a sign-in he was asked to do open', async () => {
  const b = fakeBrowser([{ id: 'signin', url: 'https://login.microsoftonline.com/common/oauth2' }]);
  await qb.holdTabs('task-verify');
  assert.ok(qb.isHeld('signin'));
  // the next task starts on a blank tab of its own, not in the sign-in
  assert.strictEqual(await qb.startTab('task-next'), 'about:blank');
  assert.deepStrictEqual(b.pages.map((p) => p.url), ['https://login.microsoftonline.com/common/oauth2', 'about:blank']);
  b.pages.push({ id: 'bb', url: 'https://bb-csuohio.blackboard.com/ultra/course' });
  await qb.tidyAgentTabs(); // it finished
  assert.deepStrictEqual(b.pages.map((p) => p.id).sort(), ['new2', 'signin'], 'its tabs went, the sign-in stayed');
  // he signed in and pressed "Done, try again": it picks up where the page is now
  b.pages.find((p) => p.id === 'signin').url = 'https://bb-csuohio.blackboard.com/ultra/stream';
  assert.strictEqual(await qb.startTab('task-verify'), 'https://bb-csuohio.blackboard.com/ultra/stream');
  assert.ok(!qb.isHeld('signin'), 'the hold ends when it runs again');
  await qb.tidyAgentTabs();
  assert.deepStrictEqual(b.pages.map((p) => p.url), ['about:blank']);
});

test('with nothing held a run starts wherever it always did', async () => {
  fakeBrowser([{ id: 'a', url: 'about:blank' }]);
  assert.strictEqual(await qb.startTab('anything'), '');
});

test('a held tab is never taken over by a second task stopping', async () => {
  fakeBrowser([{ id: 'one', url: 'https://d2llearn.tri-c.edu/d2l/home' }]);
  await qb.holdTabs('first');
  await qb.holdTabs('second'); // nothing of its own open
  assert.strictEqual(await qb.startTab('second'), 'about:blank', 'second has no tab: a blank one, since first holds its tab');
  assert.strictEqual(await qb.startTab('first'), 'https://d2llearn.tri-c.edu/d2l/home');
});

test('looseTabs keeps the held ones', () => {
  assert.deepStrictEqual(qb.looseTabs([{ id: 'a' }, { id: 'b' }], new Set(['b'])), [{ id: 'a' }]);
});
