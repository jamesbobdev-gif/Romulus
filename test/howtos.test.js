const test = require('node:test');
const assert = require('node:assert');
const howtos = require('../agent/howtos');

const note = (id, task, sites, text, date) => ({ id, task, words: howtos.keyWords(task), sites, text, lane: 'claude', date });
const list = [
  note('a', 'need to buy a new backpack', ['amazon.com'], 'WebFetch on amazon.com/dp/<ASIN> gives title and features, not price.', '2026-10-12'),
  note('b', 'buy hdmi dummy plug', ['amazon.com'], 'Searching amazon.com for "<product> 2 pack" returns real /dp/ links.', '2026-10-12'),
  note('c', 'blackboard entrepreneurship class due', ['bb-csuohio.blackboard.com'], 'Courses, then the course, then Calendar shows what is due.', '2026-10-11'),
];

test('notes on the same site group together; a note alone does not', () => {
  const g = howtos.groups(list);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].map((h) => h.id).sort(), ['a', 'b']);
});

test('compact merges a group into one note that is still found for the old tasks', async () => {
  let asked = '';
  const r = await howtos.compact(list, { today: '2026-10-15', ask: async (msgs) => {
    asked = msgs[1].content;
    return JSON.stringify({ label: 'Shopping on Amazon', note: 'Search amazon.com for the product (add "2 pack" for packs); WebFetch /dp/<ASIN> pages for features, not price.' });
  } });
  assert.match(asked, /backpack/); assert.match(asked, /hdmi/);
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(r.list.length, 2);
  const m = r.list.find((h) => h.task === 'Shopping on Amazon');
  assert.strictEqual(m.merged, 2);
  assert.deepStrictEqual(m.sites, ['amazon.com']);
  assert.strictEqual(howtos.forTask(r.list, 'buy a backpack', ['https://www.amazon.com/x'])[0].id, m.id);
});

test('a bad or personal answer leaves the notes as they were', async () => {
  for (const answer of ['not json', JSON.stringify({ label: 'x', note: 'short' }), JSON.stringify({ label: 'Amazon', note: 'Email me at someone@example.com about the order details' })]) {
    const r = await howtos.compact(list, { today: '2026-10-15', ask: async () => answer });
    assert.strictEqual(r.merged, 0);
    assert.strictEqual(r.list.length, 3);
  }
});
