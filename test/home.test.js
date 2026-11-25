// The Home tab's guess at who a message is for (renderer/js/home.js homeWho) and the one-line answer on a card.
const test = require('node:test');
const assert = require('node:assert');
const { homeWho, homePlain, homeFollows, homeAnswer, homeAdopt, homeSwipeTo, HOME_CHAT_MS } = require('../renderer/js/home.js');

test('things only he can do stay on his list', () => {
  ['call the dentist tomorrow at 9', 'Pay rent every month on the 1st', 'study for the biology quiz', 'buy milk',
    'book dentist appointment', 'write lab report', 'check the mail', 'email mom', ''].forEach((s) => {
    assert.strictEqual(homeWho(s), 'me', s);
  });
});

test('looking up, comparing, drafting and ordering go to the Agent', () => {
  ['find 3 easy dinners for tonight', 'Compare prices for AirPods Pro', 'draft an email to my landlord', 'order paper towels',
    'look up museum hours for Sunday', 'write me a reply to this', 'book a flight to Denver next month', 'buy a tent on amazon',
    'what is on this weekend near me', 'is the library open on Sunday?', 'cheapest flight to Denver', 'track my package'].forEach((s) => {
    assert.strictEqual(homeWho(s), 'agent', s);
  });
});

test('polite lead-ins are ignored, and "remind me" is always his', () => {
  assert.strictEqual(homeWho('can you find a vegetarian lasagna recipe'), 'agent');
  assert.strictEqual(homeWho('Romulus, please order paper towels'), 'agent');
  assert.strictEqual(homeWho('can you call the dentist'), 'me');
  assert.strictEqual(homeWho('remind me to find my passport'), 'me');
  assert.strictEqual(homeWho('I need to order a cake for Saturday'), 'me');
});

test('homePlain: no markdown marks, cut at a word', () => {
  assert.strictEqual(homePlain('**Cheapest** is [Frontier](https://example.com) at `$212`'), 'Cheapest is Frontier at $212');
  const long = homePlain('word '.repeat(100), 40);
  assert.ok(long.length <= 40 && /…$/.test(long));
  assert.strictEqual(homePlain(null), '');
});

test('homeFollows: the next message goes on with the Agent task the thread ends on', () => {
  const now = 1e12, entry = { said: 'find a tent', at: now - 60000, id: 'a' };
  const t = { id: 'a', ws: 'agent', status: 'needs-you', history: [{ who: 'claude', text: 'Three tents', at: now - 30000 }] };
  assert.strictEqual(homeFollows('which one is lightest', entry, t, now), true);
  assert.strictEqual(homeFollows('remind me to call the dentist', entry, t, now), false, 'a to-do of his own');
  assert.strictEqual(homeFollows('which one', Object.assign({ closed: true }, entry), t, now), false, 'New topic was pressed');
  assert.strictEqual(homeFollows('which one', entry, Object.assign({}, t, { done: true }), now), false, 'ticked off');
  assert.strictEqual(homeFollows('which one', entry, Object.assign({}, t, { ws: 'personal' }), now), false, 'his own task');
  assert.strictEqual(homeFollows('which one', entry, t, now + HOME_CHAT_MS), false, 'gone quiet');
  assert.strictEqual(homeFollows('which one', null, null, now), false);
});

test('homeFollows: the half hour counts from the Agent\'s last word, not notes from the app', () => {
  const now = 1e12, entry = { said: 'find a tent', at: now - 2 * HOME_CHAT_MS, id: 'a' };
  const t = { id: 'a', ws: 'agent', status: 'done', history: [{ who: 'claude', text: 'Here', at: now - 1000 }] };
  assert.strictEqual(homeFollows('and a sleeping bag', entry, t, now), true);
  t.history = [{ who: 'sys', text: 'Routed', at: now - 1000 }];
  assert.strictEqual(homeFollows('and a sleeping bag', entry, t, now), false);
});

test('homeAnswer: the first answer after the message; a first message falls back to the note', () => {
  const t = { id: 'a', ws: 'agent', status: 'needs-you', note: 'Second', history: [
    { who: 'claude', text: 'First', at: 100 }, { who: 'you', text: 'cheaper', at: 200 }, { who: 'claude', text: 'Second', at: 300 }] };
  assert.strictEqual(homeAnswer(t, { at: 50 }).text, 'First');
  assert.strictEqual(homeAnswer(t, { at: 200, reply: true }).text, 'Second');
  assert.strictEqual(homeAnswer(t, { at: 400, reply: true }), null, 'not answered yet');
  assert.strictEqual(homeAnswer(t, { at: 400 }).text, 'Second', 'a task he already had');
  assert.strictEqual(homeAnswer(Object.assign({}, t, { status: 'working' }), { at: 400 }), null);
  assert.strictEqual(homeAnswer({ id: 'b', ws: 'personal', note: 'x' }, { at: 1 }), null);
});

test('homeAdopt: a reply typed into a notification joins the thread, once', () => {
  const thread = [{ said: 'find a tent', at: 1000, id: 'a' }, { said: 'cheaper', at: 50000, id: 'a', reply: true }];
  const tasks = [{ id: 'a', ws: 'agent', title: 'find a tent', history: [
    { who: 'you', text: 'cheaper', at: 49990 }, { who: 'claude', text: 'This one', at: 60000 }, { who: 'you', text: 'yes, that one', at: 70000 }] }];
  const out = homeAdopt(thread, tasks, 500);
  assert.deepStrictEqual(out.map((e) => e.said), ['find a tent', 'cheaper', 'yes, that one']);
  assert.deepStrictEqual(out[2], { said: 'yes, that one', at: 70000, id: 'a', reply: true });
  assert.strictEqual(homeAdopt(out, tasks, 500), null, 'nothing new the second time');
});

test('homeAdopt: a task the thread never saw comes in with its card; old and other lists stay out', () => {
  const tasks = [{ id: 'b', ws: 'agent', title: 'order paper towels', history: [{ who: 'you', text: 'old one', at: 100 }, { who: 'sys', text: 'Routed', at: 900 }, { who: 'you', text: 'yes', at: 1000 }] },
    { id: 'c', ws: 'personal', title: 'mine', history: [{ who: 'you', text: 'x', at: 2000 }] }];
  const out = homeAdopt([], tasks, 500);
  assert.deepStrictEqual(out, [{ said: 'order paper towels', at: 999, id: 'b', from: 'task' }, { said: 'yes', at: 1000, id: 'b', reply: true }]);
  assert.strictEqual(homeAdopt([], tasks, 5000), null);
});

test('homeSwipeTo: left from the chat shows the lists, right comes back; scrolls and taps do nothing', () => {
  assert.strictEqual(homeSwipeTo(-120, 10, 'chat'), 'dash');
  assert.strictEqual(homeSwipeTo(120, -10, 'dash'), 'chat');
  assert.strictEqual(homeSwipeTo(120, 0, 'chat'), null);
  assert.strictEqual(homeSwipeTo(-120, 0, 'dash'), null);
  assert.strictEqual(homeSwipeTo(-30, 0, 'chat'), null);
  assert.strictEqual(homeSwipeTo(-100, 90, 'chat'), null);
});
