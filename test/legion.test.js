const test = require('node:test');
const assert = require('node:assert');
const legion = require('../agent/legion');

const names = { claude: 'Claude', gemini: 'Gemini', openrouter: 'OpenRouter' };
// a fake pool: the planner gets JSON, scouts their angle, the writer a report with options, the checker its notes
function pool(over = {}) {
  const calls = [];
  const run = async (id, prompt) => {
    calls.push({ id, prompt });
    if (over[id]) { const r = await over[id](prompt); if (r) return r; }
    if (/Split this research request/.test(prompt)) return { text: '{"angles":[{"title":"Prices","question":"q1"},{"title":"Reviews","question":"q2"},{"title":"News","question":"q3"}]}' };
    if (/You are scout/.test(prompt)) return { text: id + ' found: ' + prompt.match(/Your angle: ([^:]+)/)[1] };
    if (/Merge their findings/.test(prompt)) return { text: '# Tents\n**Bottom line:** buy A.\n\n```json\n{"options":[{"label":"A","desc":"$99","url":"https://a.example/tent"},{"label":"B","url":"http://b.example"}]}\n```' };
    if (/Check it hard/.test(prompt)) return { text: 'NO ISSUES' };
    if (/A checker \(a different AI\)/.test(prompt)) return { text: '# Tents\n**Bottom line:** buy A (fixed).\n\n```json\n{"options":[]}\n```' };
    return { text: 'answer' };
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

test('each angle starts on a different AI, and the lead writes the report', async () => {
  const p = pool();
  const r = await legion.research('best tents', { order: ['claude', 'gemini', 'openrouter'], run: p.run, names });
  assert.deepEqual(r.scouts.map((s) => s.via), ['claude', 'gemini', 'openrouter']);
  assert.deepEqual(r.scouts.map((s) => s.angle.title), ['Prices', 'Reviews', 'News']);
  assert.equal(r.lead, 'claude');
  assert.equal(r.checker, 'gemini'); // a different AI checks it
  assert.match(r.report, /buy A\./);
  assert.ok(!/```json/.test(r.report));
  assert.deepEqual(r.options, [{ label: 'A', desc: '$99', url: 'https://a.example/tent' }]); // http links are dropped
  // the writer saw every scout's findings
  const write = p.calls.find((c) => /Merge their findings/.test(c.prompt));
  assert.match(write.prompt, /gemini found: Reviews/);
  assert.match(legion.credits(r, names), /Reviews \(Gemini\).*Written by Claude, checked by Gemini/);
});

test('a scout that fails falls to the next AI; a checker with notes gets the report fixed', async () => {
  const p = pool({ gemini: async (prompt) => /You are scout/.test(prompt) ? { why: 'out of usage' } : /Check it hard/.test(prompt) ? { text: 'Price of A is wrong.' } : null });
  const r = await legion.research('best tents', { order: ['claude', 'gemini', 'openrouter'], run: p.run, names });
  assert.equal(r.scouts[1].via, 'openrouter');
  assert.equal(r.revisedBy, 'claude');
  assert.match(r.report, /\(fixed\)/);
});

test('with no plan it uses the default angles, at least three even with one AI', async () => {
  const p = pool({ claude: async (prompt) => /Split this/.test(prompt) ? { text: 'sorry' } : null });
  const r = await legion.research('x', { order: ['claude'], run: p.run, names });
  assert.equal(r.scouts.length, legion.MIN_SCOUTS);
  assert.equal(r.scouts[0].angle.title, legion.DEFAULT_ANGLES[0].title);
  assert.equal(r.checker, null); // nobody else to check it
});

test('private topics never leave, and nothing connected is an error', async () => {
  let sent = false;
  const run = async () => { sent = true; return { text: 'x' }; };
  assert.match((await legion.research('best bank for me', { order: ['claude'], run, privateWords: 'bank' })).error, /bank/);
  assert.match((await legion.research('tents', { order: [], run })).error, /no cloud AI/);
  assert.ok(!sent);
});

test('no scout comes back → an error, not an empty report', async () => {
  const r = await legion.research('tents', { order: ['claude'], run: async (id, prompt) => /scout/.test(prompt) ? { why: 'down' } : { text: '{}' } });
  assert.match(r.error, /none of the scouts/);
});
