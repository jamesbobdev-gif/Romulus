const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const routing = require('../agent/routing');
const decider = require('../agent/decider');

// d1's answers by task title, as the mini PC's /v1/systemone would give them
const D1 = {
  'refill my Lexapro at CVS': { private: 0.98, real: 0.93, lane: 'web', sure: 0.48 },
  'Yeah': { private: 0.02, real: 0.15, lane: 'local', sure: 0.17 },
  'Quiz: Inner Solar System': { private: 0.02, real: 0.93, lane: 'local', sure: 0.93 },
  'Ch 8 Quiz': { private: 0.2, real: 0.66, lane: 'local', sure: 0.14 },
};
let calls = 0, down = false;
global.fetch = async (url, opts) => {
  calls++;
  if (down) throw new Error('fetch failed');
  assert.match(url, /\/v1\/systemone$/);
  const body = JSON.parse(opts.body);
  assert.strictEqual(body.model, decider.DEFAULT_MODEL);
  const a = D1[body.state] || { private: 0.1, real: 0.9, lane: 'web', sure: 0.9 };
  return { ok: true, status: 200, json: async () => ({ answers: {
    private: { type: 'noul', noul: a.private }, real_task: { type: 'noul', noul: a.real },
    lane: { type: 'choice', choice: a.lane, confidence: a.sure } } }) };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-'));
const dataFile = path.join(dir, 'tasks.json');
const sent = [];
let scheduled = 0, onScheduled = null;
let config = { localModel: { url: 'http://lupa:11434', model: 'holo' } };
routing.init({ readConfig: () => config, dataFile: () => dataFile, agentLog: () => {},
  sendToRenderer: (ch, p) => sent.push([ch, p]),
  scheduleAgentRun: () => { scheduled++; if (onScheduled) onScheduled(); }, scheduleLocalRun: () => {} });
const agentTask = (id, title, extra) => Object.assign({ id, title, ws: 'agent', done: false, status: 'queued' }, extra);
// runs decided() and waits for d1 to finish (it schedules the runs again when it's done)
function decide(tasks) {
  const raw = JSON.stringify({ tasks });
  if (routing.decided(raw)) return Promise.resolve(true);
  return new Promise((res) => { onScheduled = () => { onScheduled = null; res(routing.decided(raw)); }; });
}

test('new tasks wait for d1, then route with its answers', async () => {
  routing.useRouting(null); decider.forget(); sent.length = 0;
  const tasks = [agentTask('a', 'refill my Lexapro at CVS'), agentTask('b', 'Yeah'), agentTask('c', 'Quiz: Inner Solar System'), agentTask('d', 'Ch 8 Quiz')];
  assert.strictEqual(await decide(tasks), true);
  // private: d1 catches what the word list misses
  assert.deepStrictEqual(routing.routeTask(tasks[0]), { lane: 'local', reason: 'private: d1 thinks it’s personal (health, money, IDs or grades)' });
  // a scrap is held, and he's told once
  assert.strictEqual(routing.laneOf(tasks[1]), 'hold');
  assert.deepStrictEqual(sent.map(([ch, p]) => [ch, p.map((u) => u.id + ':' + u.status)]), [['agent:results', ['b:needs-you']]]);
  // auto: d1's sure pick, or the keyword rules when it isn't sure
  assert.deepStrictEqual(routing.routeTask(tasks[2]), { lane: 'local', reason: 'auto: d1 says the local model can do this without the web' });
  assert.deepStrictEqual(routing.routeTask(tasks[3]), { lane: 'claude', reason: 'auto: quickest for everyday tasks' });
  // asked once per task
  const before = calls;
  assert.strictEqual(routing.decided(JSON.stringify({ tasks })), true);
  assert.strictEqual(calls, before);
});

test('his tags, his rules and a reply still win over d1', async () => {
  routing.useRouting(null); decider.forget();
  const tagged = agentTask('e', 'Yeah #claude');
  const replied = agentTask('f', 'Yeah', { history: [{ who: 'you', text: 'I meant it: say yeah to the invite' }] });
  await decide([tagged, replied, agentTask('g', 'Yeah')]);
  assert.deepStrictEqual(routing.routeTask(tagged), { lane: 'claude', reason: 'tagged #claude' });
  assert.notStrictEqual(routing.laneOf(replied), 'hold');
  // his rule ("write, draft, essay" → local) comes before d1's auto pick
  const draft = agentTask('h', 'draft a toast for the wedding');
  await decide([draft]);
  assert.deepStrictEqual(routing.routeTask(draft), { lane: 'local', reason: 'rule: write, draft, essay' });
});

test('with the mini PC down, the keyword rules decide alone', async () => {
  routing.useRouting(null); decider.forget(); down = true;
  const t = agentTask('i', 'refill my Lexapro at CVS');
  assert.strictEqual(await decide([t]), true);
  assert.strictEqual(routing.privateMatch(t), null); // as before d1
  const before = calls; // and it doesn't keep knocking
  assert.strictEqual(routing.decided(JSON.stringify({ tasks: [agentTask('j', 'something new')] })), true);
  assert.strictEqual(calls, before);
  down = false; decider.forget();
});

test('turned off, or no mini PC set up: d1 is never asked', () => {
  decider.forget();
  const before = calls;
  config = { localModel: { url: 'http://lupa:11434', model: 'holo' }, decisionModel: { enabled: false } };
  assert.strictEqual(routing.decided(JSON.stringify({ tasks: [agentTask('k', 'Yeah')] })), true);
  config = {};
  assert.strictEqual(routing.decided(JSON.stringify({ tasks: [agentTask('k', 'Yeah')] })), true);
  assert.strictEqual(calls, before);
  config = { localModel: { url: 'http://lupa:11434', model: 'holo' } };
});
