const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentBrowser = require('../agent/agent-browser');
const taskTabs = require('../agent/task-tabs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-tabs-'));
fs.mkdirSync(path.join(dir, 'agent-browser'), { recursive: true });
agentBrowser.init({ userData: () => dir, readConfig: () => ({}), agentLog: () => {} });

// a stand-in for Chrome's tab list (/json/*), most recently used first
let tabs = [], next = 1;
const closed = [];
global.fetch = async (url, opts) => {
  const u = String(url).replace('http://127.0.0.1:' + agentBrowser.AGENT_BROWSER_PORT, '');
  const ok = (j) => ({ ok: true, json: async () => j });
  if (u === '/json/version') return ok({});
  if (u === '/json/list') return ok(tabs.map((t) => Object.assign({ type: 'page', webSocketDebuggerUrl: 'ws://x/' + t.id }, t)));
  if (u.startsWith('/json/new?')) { const t = { id: 'T' + next++, url: u.slice(10) }; tabs.unshift(t); return ok(t); }
  if (u.startsWith('/json/close/')) { const id = u.slice(12); closed.push(id); tabs = tabs.filter((t) => t.id !== id); return ok({}); }
  if (u.startsWith('/json/activate/')) { const id = u.slice(15); const t = tabs.find((x) => x.id === id); tabs = [t].concat(tabs.filter((x) => x !== t)); return ok({}); }
  throw new Error('unexpected ' + u);
};

test('each task works and is watched in its own tabs; logins are shared, tabs are not', async () => {
  tabs = [{ id: 'OLD', url: 'https://example.com/' }]; // nobody's: closed when a run starts

  // task A runs: starts on a new blank tab of its own, opens a store and a Microsoft sign-in
  const startA = await taskTabs.startRun(['A'], ['A', 'B']);
  assert.match(startA, /^about:blank#task-A$/);
  assert.deepStrictEqual(closed, ['OLD']);
  tabs.unshift({ id: 'A1', url: 'https://www.walmart.com/cart' });
  tabs.unshift({ id: 'A2', url: 'https://login.microsoftonline.com/common/saml2' });
  assert.deepStrictEqual((await taskTabs.pagesFor('A')).map((p) => p.id).sort(), ['A1', 'A2', 'T1']);
  // where it ended: the real page, not the one-time sign-in step
  assert.strictEqual(await taskTabs.endRun(), 'https://www.walmart.com/cart');

  // task B runs while A waits for him: A's tabs stay, B gets its own
  await taskTabs.startRun(['B'], ['A', 'B']);
  tabs.unshift({ id: 'B1', url: 'https://www.amazon.com/' });
  assert.deepStrictEqual((await taskTabs.pagesFor('B')).map((p) => p.id).sort(), ['B1', 'T2']);
  // watching A during B's run never shows B's new tabs
  tabs.unshift({ id: 'B2', url: 'https://www.amazon.com/cart' });
  assert.deepStrictEqual((await taskTabs.pagesFor('A')).map((p) => p.id).sort(), ['A1', 'A2', 'T1']);
  assert.ok((await taskTabs.pagesFor('B')).some((p) => p.id === 'B2'));
  await taskTabs.endRun();
  assert.ok(tabs.some((t) => t.id === 'A1'));

  // he answers A: its run picks up on A's own page (no new tab), and B's tabs stay
  const resumeA = await taskTabs.startRun(['A'], ['A', 'B']);
  assert.strictEqual(resumeA, 'https://www.walmart.com/cart'); // its own page, not the sign-in step
  await taskTabs.endRun();

  // B is done: its tabs go at the next run
  await taskTabs.startRun(['A'], ['A']);
  assert.ok(!tabs.some((t) => /^B|^T2$/.test(t.id)));
  assert.ok(tabs.some((t) => t.id === 'A1'));
  await taskTabs.endRun();
});

test('sign-in steps are never reopened by address', () => {
  assert.ok(taskTabs.signInPage('https://login.microsoftonline.com/abc/saml2?SAMLRequest=x'));
  assert.ok(taskTabs.signInPage('https://accounts.google.com/o/oauth2/auth'));
  assert.ok(taskTabs.signInPage('https://shop.example.com/sso?x=1'));
  assert.ok(!taskTabs.signInPage('https://www.walmart.com/cart'));
});
