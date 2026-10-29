const test = require('node:test');
const assert = require('node:assert');
const legion = require('../agent/legion');

const names = { claude: 'Claude', gemini: 'Gemini', openrouter: 'OpenRouter' };
const TOPIC = 'best stroller for my twins under $400 that fits a small apartment';
const PIECES = [
  { title: 'Double strollers', question: 'What double strollers are sold in the US right now, and at what prices?' },
  { title: 'Folded size', question: 'Which strollers have the smallest folded dimensions?' },
  { title: 'Complaints', question: 'What are the common complaints about popular double strollers?' },
];
// Lupa (think) plans and writes; the cloud AIs (run) answer their one question
function lupa(over = {}) {
  const thoughts = [];
  const think = async (prompt, o) => {
    thoughts.push({ prompt, o });
    if (over.think) { const r = await over.think(prompt, o); if (r != null) return r; }
    if (/Split his request/.test(prompt)) return JSON.stringify({ pieces: PIECES });
    if (/put it back together/.test(prompt)) return JSON.stringify({ report: '# Strollers\n**Bottom line:** get A.', options: [{ label: 'A', desc: '$350', url: 'https://a.example/a' }, { label: 'B', url: 'http://b.example' }] });
    if (/follow-up/.test(prompt)) return 'From the report: A.';
    return '{}';
  };
  return { think, thoughts };
}
function pool(over = {}) {
  const calls = [];
  const run = async (id, prompt) => {
    calls.push({ id, prompt });
    if (over[id]) { const r = await over[id](prompt); if (r) return r; }
    return { text: id + ' answered: ' + prompt.match(/Question: (.*)/)[1] };
  };
  return { run, calls };
}

test('#legion and "Deep research:" titles are legion tasks, and the tag comes off the topic', () => {
  assert.ok(legion.isLegion({ title: '#legion best tents under $200' }));
  assert.ok(legion.isLegion({ title: 'Deep research: e-bikes' }));
  assert.ok(legion.isLegion({ title: 'compare phones #research' }));
  assert.ok(!legion.isLegion({ title: 'research the history of Rome' }));
  assert.equal(legion.topicOf({ title: '#legion best tents under $200' }), 'best tents under $200');
  assert.equal(legion.topicOf({ title: 'Deep research: e-bikes #claude' }), 'e-bikes');
});

test('a piece that carries the whole request gives it away; a general one does not', () => {
  assert.ok(legion.tooRevealing('Find the best stroller for twins under $400 for a small apartment', TOPIC));
  assert.ok(!legion.tooRevealing(PIECES[0].question, TOPIC));
  assert.ok(!legion.tooRevealing('What are e-bikes?', 'e-bikes')); // a one-word topic can't be hidden
});

test('Lupa splits it, each AI gets one general question and never the request, and Lupa writes the report', async () => {
  const l = lupa(), p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini', 'openrouter'], run: p.run, think: l.think, names });
  assert.deepEqual(r.scouts.map((s) => s.via), ['claude', 'gemini', 'openrouter']);
  assert.equal(p.calls.length, 3);
  for (const c of p.calls) {
    assert.ok(!/twins|apartment|\$400/i.test(c.prompt), 'a cloud AI saw his details: ' + c.prompt);
    assert.ok(!/report|piece|scout|legion/i.test(c.prompt.replace(/Question:[\s\S]*/, '')), 'a cloud AI was told it is part of something bigger');
  }
  assert.equal(new Set(p.calls.map((c) => c.id)).size, 3); // one piece each
  // only Lupa saw the request and the answers
  const write = l.thoughts.find((x) => /put it back together/.test(x.prompt));
  assert.match(write.prompt, /twins/);
  assert.match(write.prompt, /gemini answered: Which strollers/);
  assert.match(r.report, /get A/);
  assert.deepEqual(r.options, [{ label: 'A', desc: '$350', url: 'https://a.example/a' }]); // http links dropped
  assert.match(legion.credits(r, names, 'Lupa Au Palatine'), /written by Lupa Au Palatine.*Folded size \(Gemini\)/);
});

test('a revealing piece is rewritten by Lupa, and one still revealing is kept back', async () => {
  const telling = { title: 'Everything', question: 'Best stroller for twins under $400 that fits a small apartment?' };
  const l = lupa({ think: async (prompt) => /Split his request/.test(prompt) ? JSON.stringify({ pieces: [telling, PIECES[0], PIECES[1]] })
    : /give away too much/.test(prompt) ? JSON.stringify({ pieces: [{ title: 'Twin strollers', question: 'What strollers suit twins?' }] }) : null });
  const p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini', 'openrouter'], run: p.run, think: l.think, names });
  assert.equal(r.scouts[0].piece.question, 'What strollers suit twins?');
  assert.ok(!p.calls.some((c) => c.prompt.includes('$400')));

  const stubborn = lupa({ think: async (prompt) => /Split his request|give away too much/.test(prompt) ? JSON.stringify({ pieces: [telling, PIECES[0], PIECES[1]] }) : null });
  const r2 = await legion.research(TOPIC, { order: ['claude', 'gemini'], run: pool().run, think: stubborn.think, names });
  assert.deepEqual(r2.dropped.map((d) => d.title), ['Everything']);
  assert.equal(r2.scouts.length, 2);
});

test('private pieces never leave', async () => {
  const l = lupa({ think: async (prompt) => /Split his request/.test(prompt) ? JSON.stringify({ pieces: [
    { title: 'Rates', question: 'Which bank has the best savings rate?' }, PIECES[0], PIECES[1]] }) : null });
  const p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini'], run: p.run, think: l.think, names, privateWords: 'bank' });
  assert.ok(!p.calls.some((c) => /bank/i.test(c.prompt)));
  assert.match(r.dropped[0].why, /bank/);
});

test('a failed piece goes to the AI holding the fewest pieces', async () => {
  const p = pool({ claude: async () => ({ why: 'out of usage' }) });
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini', 'openrouter', 'xai'], run: p.run, think: lupa().think, names });
  assert.equal(r.scouts[0].via, 'xai'); // gemini and openrouter already hold one each; xai holds none
});

test('Lupa not answering, nothing connected, or no AI coming back → an error', async () => {
  const down = async () => { throw new Error('fetch failed (ECONNREFUSED)'); };
  assert.match((await legion.research(TOPIC, { order: ['claude'], run: pool().run, think: down, lead: 'Lupa' })).error, /Lupa couldn’t split it \(fetch failed/);
  assert.match((await legion.research(TOPIC, { order: [], run: pool().run, think: lupa().think })).error, /no cloud AI/);
  const r = await legion.research(TOPIC, { order: ['claude'], run: async () => ({ why: 'down' }), think: lupa().think });
  assert.match(r.error, /none of the AIs/);
});

test('a follow-up is answered by Lupa alone', async () => {
  const l = lupa();
  assert.equal(await legion.followUp(TOPIC, '# report', 'which is lightest?', { think: l.think }), 'From the report: A.');
});
