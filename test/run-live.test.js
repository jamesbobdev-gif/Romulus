const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runLive = require('../agent/run-live');

const ev = (o) => JSON.stringify(o) + '\n';
const use = (id, name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

function setup(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-live-'));
  const sent = [];
  const live = runLive.start({ dir, tasks, send: (ch, p) => sent.push(p), node: null });
  return { dir, sent, live };
}

test('Claude\'s checklist and steps become the task\'s plan and live log', async () => {
  const { live, sent } = setup([{ id: 'a', title: 'Bottle' }]);
  live.feed(use('u1', 'TaskCreate', { subject: 'Find 32 oz bottles' }) + result('u1', 'Task #1 created successfully: Find 32 oz bottles'));
  live.feed(use('u2', 'TaskCreate', { subject: 'Compare the top 3' }));
  live.feed(result('u2', 'Task #2 created successfully: Compare the top 3') + use('u3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }));
  live.feed(use('u4', 'WebSearch', { query: '32 oz water bottle' }) + use('u5', 'mcp__browser__browser_navigate', { url: 'https://www.amazon.com/dp/B0X' }));
  live.feed(use('u6', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  await new Promise((r) => setTimeout(r, 400));
  const last = sent.filter((p) => p.id === 'a').pop();
  assert.deepStrictEqual(last.plan, [{ text: 'Find 32 oz bottles', status: 'completed' }, { text: 'Compare the top 3', status: 'pending' }]);
  assert.match(last.text, /Searching: 32 oz water bottle/);
  assert.match(last.text, /Opening amazon\.com\/dp\/B0X/);
  assert.match(live.thoughts('a'), /^Plan:\n☑ Find 32 oz bottles\n☐ Compare the top 3/);
  live.stop();
});

test('with several tasks, "[n]" puts a plan item on that task only', async () => {
  const { live, sent } = setup([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  live.feed(use('u1', 'TaskCreate', { subject: '[2] Check B' }) + result('u1', 'Task #1 created successfully'));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual(sent.filter((p) => p.id === 'b').pop().plan, [{ text: 'Check B', status: 'pending' }]);
  assert.strictEqual(sent.filter((p) => p.id === 'a').length, 0);
  live.stop();
});

test('his mid-run messages go to the inbox; the ones Claude took are heard, a yes still goes round again', () => {
  const { dir, live } = setup([{ id: 'a', title: 'Bottle' }]);
  const hooks = live.open({ PreToolUse: [] });
  assert.ok(hooks.PreToolUse, 'the web guard\'s hooks are kept');
  const data = { tasks: [{ id: 'a', title: 'Bottle', runFrom: 100, history: [
    { who: 'you', text: 'before the run', at: 50 }, { who: 'you', text: 'make it blue', at: 200 }, { who: 'you', text: 'yes', at: 300 }] }] };
  live.forward(JSON.stringify(data));
  live.forward(JSON.stringify(data)); // saved again: not sent twice
  const files = fs.readdirSync(path.join(dir, 'inbox'));
  assert.strictEqual(files.length, 2);
  for (const f of files) fs.renameSync(path.join(dir, 'inbox', f), path.join(dir, 'heard', f)); // what the hook does
  live.close();
  assert.deepStrictEqual(live.heard('a'), [200]);
  live.stop();
});

test('messages Claude never took are not heard, and are cleared from the inbox', () => {
  const { dir, live } = setup([{ id: 'a', title: 'Bottle' }]);
  live.open(null);
  live.forward(JSON.stringify({ tasks: [{ id: 'a', runFrom: 1, history: [{ who: 'you', text: 'hi', at: 5 }] }] }));
  live.close();
  assert.deepStrictEqual(live.heard('a'), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'inbox')), []);
  live.stop();
});

test('the hook hands waiting messages to Claude and moves them to heard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-inbox-'));
  fs.mkdirSync(path.join(dir, 'inbox')); fs.mkdirSync(path.join(dir, 'heard'));
  fs.writeFileSync(path.join(dir, 'inbox', '1.json'), JSON.stringify({ id: 'a', title: 'Bottle', text: 'make it blue' }));
  const run = (ev) => require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../agent/run-inbox.js'), path.join(dir, 'inbox'), path.join(dir, 'heard'), ev], { input: '{}' }).toString();
  const out = JSON.parse(run('PostToolUse'));
  assert.match(out.hookSpecificOutput.additionalContext, /make it blue/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'heard')), ['1.json']);
  assert.strictEqual(run('Stop'), ''); // nothing waiting: Claude may finish
});
