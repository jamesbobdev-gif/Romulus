const test = require('node:test');
const assert = require('node:assert');
const ctx = require('../agent/task-context');
const { saidYes } = require('../agent/agent-browser');

ctx.init({ userData: () => require('os').tmpdir(), readConfig: () => ({}), agentLog: () => {} });

test('prefLine: {section, text} or a plain string', () => {
  assert.strictEqual(ctx.prefLine({ section: 'Shopping', text: 'only Amazon' }), 'Shopping|only Amazon');
  assert.strictEqual(ctx.prefLine({ text: 'a|b\nc' }), 'Other|a|b c');
  assert.strictEqual(ctx.prefLine({ section: 'x' }), null);
  assert.strictEqual(ctx.prefLine('likes\ntea'), 'likes tea');
  assert.strictEqual(ctx.prefLine(null), null);
});

test('wantsCalendar looks at the title, reply and his last message', () => {
  assert.ok(ctx.wantsCalendar({ title: 'gym slot Thursday afternoon' }));
  assert.ok(ctx.wantsCalendar({ title: 'x', history: [{ who: 'you', text: 'when am I free?' }] }));
  assert.ok(!ctx.wantsCalendar({ title: 'buy a lamp' }));
});

test('wantsInbox: internship tasks or useInbox', () => {
  assert.ok(ctx.wantsInbox({ title: 'Daily internship hunt' }));
  assert.ok(ctx.wantsInbox({ title: 'x', useInbox: true }));
  assert.ok(!ctx.wantsInbox({ title: 'internal memo' }));
});

test('skillText is only his words', () => {
  const t = { title: 'T', reply: 'R', notes: 'N', history: [{ who: 'claude', text: 'C' }, { who: 'you', text: 'Y1' }, { who: 'you', text: 'Y2' }, { who: 'you', text: 'Y3' }] };
  assert.strictEqual(ctx.skillText(t), 'T\nR\nN\nY2\nY3');
});

test('taskLinks finds links anywhere in the task', () => {
  assert.deepStrictEqual(ctx.taskLinks({ title: 'see https://a.com/x', options: [{ url: 'https://b.com' }] }), ['https://a.com/x', 'https://b.com']);
});

test('the skills in agent/skills load with their match patterns', () => {
  const skills = ctx.loadSkills();
  assert.ok(skills.length > 0);
  for (const s of skills) { assert.ok(s.name); assert.ok(typeof s.body === 'string'); }
});

test('saidYes: a yes to something Claude asked to say yes to', () => {
  const asked = [{ who: 'claude', text: 'Filled it in. Reply **yes** to submit it.' }];
  assert.ok(saidYes({ reply: 'yes please', history: asked }));
  assert.ok(saidYes({ history: asked.concat({ who: 'you', text: 'go ahead and submit' }) }));
  assert.ok(!saidYes({ reply: 'yes', history: [{ who: 'claude', text: 'Which one?' }] }));
  assert.ok(!saidYes({ reply: 'not yet', history: asked }));
});
