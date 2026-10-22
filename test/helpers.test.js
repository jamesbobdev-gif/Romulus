const test = require('node:test');
const assert = require('node:assert');
const helpers = require('../agent/helpers');

test('questions spread over the pool, each starting on a different AI', async () => {
  const started = [];
  const res = await helpers.askPool(['a', 'b', 'c'], { order: ['claude', 'gemini'], run: async (id, prompt) => { started.push(id); return { text: id + ':' + prompt.slice(-1) }; } });
  assert.deepStrictEqual(res.map((r) => r.via), ['claude', 'gemini', 'claude']);
  assert.strictEqual(res[1].answer, 'gemini:b');
  assert.strictEqual(started.length, 3);
});

test('a helper that fails or throws hands its question to the next', async () => {
  const res = await helpers.askPool(['q'], { order: ['claude', 'gemini', 'openrouter'], run: async (id) => {
    if (id === 'claude') return { why: 'out of usage' };
    if (id === 'gemini') throw new Error('boom');
    return { text: 'ok' };
  } });
  assert.deepStrictEqual(res, [{ question: 'q', via: 'openrouter', answer: 'ok' }]);
});

test('no answer anywhere is reported, not thrown; at most 4 questions go out', async () => {
  const res = await helpers.askPool(['1', '2', '3', '4', '5', ''], { order: ['claude'], run: async () => ({ why: 'no answer' }) });
  assert.strictEqual(res.length, 4);
  assert.match(res[0].error, /claude \(no answer\)/);
  assert.match((await helpers.askPool(['x'], { order: [], run: async () => ({ text: 'y' }) }))[0].error, /no cloud AI/);
});

test('the helper sees only the question', async () => {
  let sent;
  await helpers.askPool(['best tent under $200'], { order: ['gemini'], run: async (id, p) => { sent = p; return { text: 'x' }; } });
  assert.ok(sent.startsWith(helpers.HELPER_PROMPT));
  assert.ok(sent.endsWith('Question: best tent under $200'));
});

test('private words, card/SSN numbers and locked-profile details never leave', () => {
  const opts = { privateWords: 'bank, social security, tax', locked: '## Contact\n- Phone: 555-201-8899\n- Email: james@example.com\nWork authorization: yes' };
  assert.match(helpers.leaksPrivate('Which bank has the best savings rate?', opts), /bank/);
  assert.match(helpers.leaksPrivate('is 4111 1111 1111 1111 valid', opts), /card/);
  assert.match(helpers.leaksPrivate('lookup 123-45-6789', opts), /social security/);
  assert.match(helpers.leaksPrivate('Who owns 555-201-8899?', opts), /locked profile/);
  assert.match(helpers.leaksPrivate('Find JAMES@example.com online', opts), /locked profile/);
  assert.strictEqual(helpers.leaksPrivate('Compare the Sony WH-1000XM6 and Bose QC Ultra', opts), null);
  assert.strictEqual(helpers.leaksPrivate('Is yes a word', opts), null); // short values don't count
  assert.strictEqual(helpers.leaksPrivate('banking history of Rome', opts), null); // whole words only
});

test('show() labels who answered and flags failures', () => {
  const out = helpers.show([{ question: 'a', via: 'gemini', answer: 'line1\nline2' }, { question: 'b', error: 'no helper answered' }], { gemini: 'Gemini' });
  assert.match(out, /1\. a\n   Gemini says:\n   line1\n   line2/);
  assert.match(out, /2\. b\n   \(no helper answered\)/);
});
