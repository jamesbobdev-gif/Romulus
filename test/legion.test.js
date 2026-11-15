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
  // the first word without a colon counts too
  assert.ok(legion.isLegion({ title: 'legion I need to travel from Cleveland to Pottstown' }));
  assert.equal(legion.topicOf({ title: 'Legion I need to travel' }), 'I need to travel');
  assert.ok(!legion.isLegion({ title: 'legion' }));
  assert.ok(!legion.isLegion({ title: 'legionnaires disease symptoms' }));
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

test('a follow-up is answered by Lupa alone, knowing what he said since the report', async () => {
  const l = lupa();
  assert.deepEqual(await legion.followUp(TOPIC, '# report', 'which is lightest?', { think: l.think }), { answer: 'From the report: A.', research: false, task: false, lookup: '' });
  const j = lupa({ think: async (prompt) => /follow-up/.test(prompt) ? JSON.stringify({ answer: 'Driving is out: you can\'t drive.', research: false }) : null });
  const f = await legion.followUp(TOPIC, '# report', 'why not the car?', { think: j.think, earlier: 'He said: I can\'t drive at all' });
  assert.equal(f.answer, 'Driving is out: you can\'t drive.');
  assert.match(j.thoughts[0].prompt, /Since the report\nHe said: I can't drive at all/);
});

test('a follow-up that needs new facts sends the legion out on that question', async () => {
  const l = lupa({ think: async (prompt) => /follow-up/.test(prompt) ? JSON.stringify({ answer: 'Flights for Dec 22–27', next: 'research', lookup: 'flights Boston to Denver Dec 22–27' }) : null });
  assert.deepEqual(await legion.followUp(TOPIC, '# report', 'give me the flight options', { think: l.think }),
    { answer: 'Flights for Dec 22–27', research: true, task: false, lookup: 'flights Boston to Denver Dec 22–27' });
  // the older shape ({research:true}) still counts
  const o = lupa({ think: async (prompt) => /follow-up/.test(prompt) ? JSON.stringify({ answer: 'x', research: true }) : null });
  assert.equal((await legion.followUp(TOPIC, '# report', 'more?', { think: o.think })).research, true);
});

test('a follow-up that asks for something done comes back as a task, no tag needed', async () => {
  const l = lupa({ think: async (prompt) => /follow-up/.test(prompt) ? JSON.stringify({ answer: 'I’ll get stroller A ready to order', next: 'task' }) : null });
  const f = await legion.followUp(TOPIC, '# report', 'order A for me', { think: l.think });
  assert.equal(f.task, true); assert.equal(f.research, false);
  assert.match(l.thoughts[0].prompt, /"task" when he wants something done/);
});

test('a request to get something done is a task; a question is not', () => {
  assert.ok(legion.isTask('book the cheapest train to Boston for Dec 22'));
  assert.ok(legion.isTask('Please buy a stroller for twins under $400'));
  assert.ok(!legion.isTask('best stroller for my twins under $400'));
});

test('a follow-up legion keeps the bigger request hidden too', async () => {
  const leaky = [...PIECES.slice(0, 2), { title: 'Whole', question: 'Best stroller for twins under $400 that fits a small apartment: which folds smallest?' }];
  const l = lupa({ think: async (prompt) => /Split his request/.test(prompt) ? JSON.stringify({ pieces: leaky }) : /give away too much/.test(prompt) ? '{}' : null });
  const p = await legion.planPieces('which folds smallest', '', { order: ['claude', 'gemini', 'openrouter'], think: l.think, whole: TOPIC });
  assert.equal(p.pieces.length, 2);
  assert.deepEqual(p.dropped.map((d) => d.title), ['Whole']);
});

test('a second wave goes out on what the first answers left open, and the report is written from both', async () => {
  const gaps = [{ title: 'Price check', question: 'What does the Baby Jogger City Mini double cost today?' },
    { title: 'Weight', question: 'How much do double strollers weigh?' }, PIECES[0],
    { title: 'Whole', question: 'Best stroller for twins under $400 that fits a small apartment?' }];
  const l = lupa({ think: async (prompt) => /second round/.test(prompt) ? JSON.stringify({ pieces: gaps }) : null });
  const p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini', 'openrouter'], run: p.run, think: l.think, names });
  assert.equal(p.calls.length, 5); // 3 + 2: the repeat and the revealing one never go out
  const second = r.scouts.filter((s) => s.wave === 2);
  assert.deepEqual(second.map((s) => s.piece.title), ['Price check', 'Weight']);
  assert.deepEqual(second.map((s) => s.via), ['claude', 'gemini']); // each to an AI holding the fewest pieces, in his order
  assert.deepEqual(r.dropped.map((d) => d.title), ['Whole']);
  const ask = l.thoughts.find((x) => /second round/.test(x.prompt));
  assert.match(ask.prompt, /gemini answered: Which strollers/); // Lupa read the first answers before asking for more
  const write = l.thoughts.find((x) => /put it back together/.test(x.prompt));
  assert.match(write.prompt, /Price check \(second wave\)[\s\S]*claude answered: What does the Baby Jogger/);
  assert.match(legion.credits(r, names), /Second wave: Price check \(Claude\) · Weight \(Gemini\)/);
  // waves: 1 turns it off
  const one = lupa({ think: async (prompt) => /second round/.test(prompt) ? JSON.stringify({ pieces: gaps }) : null }), q = pool();
  await legion.research(TOPIC, { order: ['claude', 'gemini'], run: q.run, think: one.think, names, waves: 1 });
  assert.equal(q.calls.length, 3);
  assert.ok(!one.thoughts.some((x) => /second round/.test(x.prompt)));
});

test('a long answer is boiled down by Lupa before the report is written; a short one is used as it came', async () => {
  const long = 'A costs $350 at Target. ' + 'Filler sentence about nothing in particular. '.repeat(80) + 'Sources: https://a.example/a';
  assert.ok(long.length > legion.FINDING_CHARS);
  const p = pool({ claude: async () => ({ text: long }) });
  const l = lupa({ think: async (prompt) => /Boil its answer down/.test(prompt) ? '- A: $350 at Target (https://a.example/a)' : null });
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini', 'openrouter'], run: p.run, think: l.think, names });
  assert.equal(l.thoughts.filter((x) => /Boil its answer down/.test(x.prompt)).length, 1); // only the long one
  assert.equal(r.scouts[0].digest, '- A: $350 at Target (https://a.example/a)');
  const write = l.thoughts.find((x) => /put it back together/.test(x.prompt));
  assert.match(write.prompt, /- A: \$350 at Target/);
  assert.ok(!/Filler sentence/.test(write.prompt));
  assert.match(write.prompt, /gemini answered: Which strollers/); // the short ones as they came
});

test('no AI collects pieces that together give the request away', async () => {
  const pieces = [{ title: 'Twins', question: 'Which strollers suit twins?' }, { title: 'Space', question: 'What fits in a small apartment?' },
    { title: 'Budget', question: 'Under $400, what fits small spaces for twins?' }];
  const l = lupa({ think: async (prompt) => /Split his request/.test(prompt) ? JSON.stringify({ pieces }) : null });
  const p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini'], run: p.run, think: l.think, names });
  assert.deepEqual(r.scouts.map((s) => s.via), ['claude', 'gemini']);
  assert.deepEqual(r.dropped, [{ title: 'Budget', why: 'with what each AI already holds, it would give the request away' }]);
  // with one AI there is nothing to hide from it: everything goes
  const one = pool();
  const r1 = await legion.research(TOPIC, { order: ['claude'], run: one.run, think: l.think, names });
  assert.equal(r1.scouts.length, 3);
  assert.equal(r1.dropped.length, 0);
});

test('a cloud AI leading (no local model) is named as the one that saw the whole request', async () => {
  const l = lupa(), p = pool();
  const r = await legion.research(TOPIC, { order: ['claude', 'gemini'], run: p.run, think: l.think, names, lead: 'Claude', cloud: true });
  const c = legion.credits(r, names, 'Claude', { cloud: true });
  assert.match(c, /written by Claude in the cloud \(no local model is set up\)/);
  assert.match(c, /Only Claude saw your whole request; every other AI got one general question/);
  assert.match(legion.credits(r, names, 'Lupa'), /No cloud AI saw your whole request/);
});
