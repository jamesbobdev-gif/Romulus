const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* renderer/js/agent-results.js against a fake desktop bridge: the page globals it uses are stubbed here */
function load(tasks) {
  const cb = {};
  const on = (name) => (f) => { cb[name] = f; };
  const ctx = {
    window: { desktop: { onAgentResults: on('results'), onAgentWorking: on('working'), onAgentLive: on('live'), onAgentWaiting: on('waiting') } },
    state: { tasks }, liveText: {}, livePlan: {}, liveHeard: {}, fillPlan() {}, taskWs: (t) => t.ws,
    agentSay(t, who, text, extra) { t.history = t.history || []; t.history.push(Object.assign({ who, text, at: Date.now() }, extra || {})); },
    touch() {}, appendPrefs() {}, setInterval() {}, setTimeout() {}, document: { querySelector: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/agent-results.js'), 'utf8'), ctx);
  return { cb, ctx };
}

test('a reply sent while the mini PC works: its answer is kept, and the reply goes next', () => {
  const t = { id: 'a', ws: 'agent', lane: 'local', status: 'queued', reply: 'you answer', history: [] };
  const { cb, ctx } = load([t]);
  cb.working({ ids: ['a'], lane: 'local' });
  assert.strictEqual(t.status, 'working');
  t.history.push({ who: 'you', text: 'yes', at: t.runFrom + 1 }); // what the reply box does mid-run now: status stays working
  ctx.liveText.a = 'Opening the quiz…';
  cb.results([{ id: 'a', lane: 'local', status: 'needs-you', note: 'Answered 10 questions. Reply yes to submit.', thoughts: 'Opening the quiz…\nAnswering Q1…' }]);
  const ans = t.history.find((h) => h.who === 'claude');
  assert.strictEqual(ans.text, 'Answered 10 questions. Reply yes to submit.');
  assert.strictEqual(ans.thoughts, 'Opening the quiz…\nAnswering Q1…');
  assert.strictEqual(t.status, 'queued');
  assert.strictEqual(t.reply, 'yes');
});

test('a device without the fix put it back in the queue mid-run: the answer still counts', () => {
  const t = { id: 'b', ws: 'agent', lane: 'local', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working({ ids: ['b'], lane: 'local' });
  t.status = 'queued'; t.reply = 'submit'; // the old reply box
  cb.results([{ id: 'b', lane: 'local', status: 'needs-you', note: 'Ready.' }]);
  assert.ok(t.history.some((h) => h.who === 'claude' && h.text === 'Ready.'));
  assert.strictEqual(t.status, 'queued');
  assert.strictEqual(t.reply, 'submit');
});

test('no reply mid-run: the answer stands as usual, with what it did kept', () => {
  const t = { id: 'c', ws: 'agent', lane: 'local', status: 'queued', history: [] };
  const { cb, ctx } = load([t]);
  cb.working({ ids: ['c'], lane: 'local' });
  ctx.liveText.c = 'Searching…';
  cb.results([{ id: 'c', lane: 'local', status: 'done', note: 'Done.' }]);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.reply, null);
  assert.strictEqual(t.history.find((h) => h.who === 'claude').thoughts, 'Searching…');
});

test('an answer from the other lane is still ignored', () => {
  const t = { id: 'd', ws: 'agent', lane: 'claude', status: 'working', history: [] };
  const { cb } = load([t]);
  cb.results([{ id: 'd', lane: 'local', status: 'done', note: 'x' }]);
  assert.strictEqual(t.status, 'working');
});

test('switched to another AI mid-run (runFrom cleared): a late answer from the old one is ignored', () => {
  const t = { id: 'e', ws: 'agent', lane: 'claude', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working(['e']);
  t.status = 'queued'; t.cloud = 'gemini'; delete t.runFrom; // what setLane does
  cb.results([{ id: 'e', status: 'done', note: 'late Claude answer' }]);
  assert.strictEqual(t.history.some((h) => h.who === 'claude'), false);
});

test('the pill is set by itself: to the AI being asked, then to whoever answered', () => {
  const t = { id: 'f', ws: 'agent', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working({ ids: ['f'], lane: 'claude', reasons: { f: 'auto' } });
  assert.strictEqual(t.lane, 'claude');
  cb.working({ ids: ['f'], lane: 'claude', cloud: 'gemini' }); // the runner asking Gemini first
  assert.strictEqual(t.cloud, 'gemini');
  cb.working({ ids: ['f'], lane: 'claude', cloud: 'openrouter' }); // Gemini was out of usage
  assert.strictEqual(t.cloud, 'openrouter');
  cb.results([{ id: 'f', status: 'needs-you', note: 'Here you go.', via: 'openrouter' }]);
  assert.strictEqual(t.cloud, 'openrouter');
});

test('answered by Claude: its pill is Claude', () => {
  const t = { id: 'g', ws: 'agent', lane: 'claude', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working(['g']);
  cb.results([{ id: 'g', status: 'done', note: 'Done.' }]);
  assert.strictEqual(t.cloud, 'claude');
});

test('a message Claude took mid-run counts as heard: no second run for it', () => {
  const t = { id: 'h', ws: 'agent', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working(['h']);
  const at = t.runFrom + 5;
  t.history.push({ who: 'you', text: 'make it blue', at });
  cb.results([{ id: 'h', status: 'needs-you', note: 'Found a blue one.', heard: [at] }]);
  assert.strictEqual(t.status, 'needs-you');
  assert.strictEqual(t.reply, null);
  assert.strictEqual(t.history.find((h) => h.at === at).heard, true);
});

test('a mid-run message Claude never took still goes next', () => {
  const t = { id: 'g', ws: 'agent', status: 'queued', history: [] };
  const { cb } = load([t]);
  cb.working(['g']);
  t.history.push({ who: 'you', text: 'first', at: t.runFrom + 1 }, { who: 'you', text: 'and also this', at: t.runFrom + 2 });
  cb.results([{ id: 'g', status: 'needs-you', note: 'Done the first part.', heard: [t.runFrom + 1] }]);
  assert.strictEqual(t.status, 'queued');
  assert.strictEqual(t.reply, 'and also this');
});

test('the computer slept mid-run: the task goes back in the queue and says why, with no failure', () => {
  const t = { id: 's', ws: 'agent', status: 'queued', history: [] };
  const { cb, ctx } = load([t]);
  cb.working(['s']);
  ctx.liveText.s = 'Opening walmart.com';
  cb.waiting({ ids: ['s'], until: Date.now(), slept: true });
  assert.strictEqual(t.status, 'queued');
  assert.ok(!(t.waitUntil > Date.now()), 'not shown as out of usage');
  assert.strictEqual(t.runFrom, undefined);
  assert.strictEqual(ctx.liveText.s, undefined);
  assert.match(t.history.pop().text, /went to sleep/);
});
