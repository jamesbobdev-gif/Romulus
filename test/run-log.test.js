const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runLog = require('../agent/run-log');
const { textToolCalls } = require('../agent/local-answer');
const cs = require('../agent/course-sites');
const worker = require('../agent/worker');

test('a tool call Holo4 wrote as text is read as a call', () => {
  const xml = '<tool_call>\n<function=search_my_data>\n<parameter=query>\nPHYS 1010 discussion\n</parameter>\n</function>\n</tool_call>';
  assert.deepStrictEqual(textToolCalls(xml, ['search_my_data']), { calls: [{ function: { name: 'search_my_data', arguments: { query: 'PHYS 1010 discussion' } } }], text: '' });
  const json = 'Let me open it. <tool_call>{"name": "browser_click", "arguments": {"target": "f1e15"}}</tool_call>';
  assert.deepStrictEqual(textToolCalls(json, ['browser_click']).calls[0].function, { name: 'browser_click', arguments: { target: 'f1e15' } });
  assert.strictEqual(textToolCalls(json, ['browser_click']).text, 'Let me open it.');
  // cut off before its closing tags (num_predict ran out)
  assert.strictEqual(textToolCalls('<tool_call>\n<function=browser_navigate>\n<parameter=url>\nhttps://d2llearn.tri-c.edu', ['browser_navigate']).calls[0].function.arguments.url, 'https://d2llearn.tri-c.edu');
  // a list given as JSON
  assert.deepStrictEqual(textToolCalls('<tool_call><function=ask_helpers><parameter=questions>["a", "b"]</parameter></function></tool_call>', ['ask_helpers']).calls[0].function.arguments, { questions: ['a', 'b'] });
});

test('a tool it was not offered stays text', () => {
  const r = textToolCalls('<tool_call><function=run_shell><parameter=cmd>ls</parameter></function></tool_call>', ['browser_click']);
  assert.deepStrictEqual(r.calls, []);
  assert.match(r.text, /run_shell/);
  assert.deepStrictEqual(textToolCalls('{"status": "done", "note": "Posted."}', ['browser_click']).calls, []);
});

test('asking him for the questions sends it to the class site first, once it has not looked', () => {
  const site = { course: 'PHYS 1010', kind: 'D2L', host: 'd2llearn.tri-c.edu' };
  const ask = cs.lookFirst('I need the actual questions from the Ch 20 Reading Comprehension assignment. Could you share them?', { site, visited: new Set() });
  assert.match(ask, /Open D2L \(https:\/\/d2llearn\.tri-c\.edu\)/);
  assert.strictEqual(cs.lookFirst('I need the actual questions', { site, visited: new Set(['d2llearn.tri-c.edu']) }), null, 'it looked: his answer is fine');
  assert.strictEqual(cs.lookFirst('Posted your reply to the discussion.', { site, visited: new Set() }), null);
  assert.ok(cs.lookFirst('What exactly do you need?', { visited: new Set(['google.com']) }), 'no site known: any school site counts');
  assert.strictEqual(cs.lookFirst('What exactly do you need?', { visited: new Set(['bb-csuohio.blackboard.com']) }), null);
});

test('a past due date is said before it starts', () => {
  assert.match(cs.pastDue('2026-10-23', '2026-10-31'), /due 2026-10-23 \(8 days ago\).*If it is closed, stop/);
  assert.match(cs.pastDue('2026-10-30', '2026-10-31'), /1 day ago/);
  assert.strictEqual(cs.pastDue('2026-10-31', '2026-10-31'), null, 'due today is not late');
  assert.strictEqual(cs.pastDue(null, '2026-10-31'), null);
});

test('each run is sorted into why it ended', () => {
  const e = (final, stuck, extra) => runLog.entry(Object.assign({ t: { id: 'a', tag: 'PHYS 1010', fromWs: 'school' }, final, stuck, steps: 12, ms: 300000 }, extra));
  assert.strictEqual(e({ status: 'done', note: 'Posted.' }).why, 'done');
  assert.strictEqual(e({ status: 'needs-you', note: 'x' }, { reason: 'The local model needs you for a sign-in', verify: true }).why, 'needs his sign-in or code');
  assert.strictEqual(e({ status: 'needs-you', note: 'x' }, { reason: 'It used all 40 of its steps without finishing.' }).why, 'ran out of steps');
  assert.strictEqual(e({ status: 'needs-you', note: 'The quiz is closed: it was due Oct 23.' }, null, { pastDue: true }).why, 'past due');
  assert.strictEqual(e({ status: 'needs-you', note: 'I need more details about the assignment.' }).why, 'asked him for details');
  assert.strictEqual(e({ status: 'needs-you', note: '<tool_call>\n<function=search_my_data>' }).why, 'broken answer');
  const line = e({ status: 'done', note: 'His private essay text' });
  assert.ok(!('note' in line), 'the note itself is never logged');
  assert.strictEqual(line.class, 'PHYS 1010');
  assert.strictEqual(line.secs, 300);
});

test('his reply before a run says whether it was sent back', () => {
  assert.strictEqual(runLog.replyKind('Done, try again'), 'retry');
  assert.strictEqual(runLog.replyKind("That's wrong, it's chapter 9"), 'correction');
  assert.strictEqual(runLog.replyKind('use the second link'), 'reply');
  assert.strictEqual(runLog.replyKind(''), null);
});

test('the last 30 days, summed up', () => {
  const now = Date.parse('2026-11-02T12:00:00Z'), day = 864e5;
  const runs = [
    { at: now - day, status: 'done', why: 'done', secs: 600, class: 'PHYS 1010', textCalls: 1 },
    { at: now - 2 * day, status: 'needs-you', why: 'asked him for details', secs: 300, class: 'PHYS 1010', lookedFirst: true },
    { at: now - 3 * day, status: 'needs-you', why: 'past due', secs: 120, class: 'ACT 222', reply: 'retry' },
    { at: now - 40 * day, status: 'needs-you', why: 'other', secs: 60 }, // too old
  ];
  assert.deepStrictEqual(runLog.summary(runs, { now }), { days: 30, runs: 3, done: 1, rate: 0.33, minutes: 5.7, retried: 1, corrected: 0, textCalls: 1, lookedFirst: 1,
    why: { 'asked him for details': 1, 'past due': 1 }, byClass: { 'PHYS 1010': [1, 2], 'ACT 222': [0, 1] } });
});

test('the log file keeps its last lines and survives a bad one', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-')), 'local-runs.jsonl');
  for (let i = 0; i < 2500; i++) runLog.record(file, { at: i, status: 'done', why: 'done' });
  fs.appendFileSync(file, 'not json\n');
  const all = runLog.load(file);
  assert.ok(all.length <= 2400 && all.length >= 2000, String(all.length));
  assert.strictEqual(all[all.length - 1].at, 2499);
});

test('the heartbeat carries the summary', () => {
  const hb = worker.heartbeat({ name: 'Lupa', model: 'holo4', busy: false, stats: { runs: 3, rate: 0.33 } }, 1);
  assert.deepStrictEqual(hb.stats, { runs: 3, rate: 0.33 });
  assert.ok(!('stats' in worker.heartbeat({ name: 'Lupa' }, 1)));
});
