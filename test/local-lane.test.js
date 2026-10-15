const test = require('node:test');
const assert = require('node:assert');
const lane = require('../agent/local-lane');
const tools = require('../agent/local-tools');

test('staleMarked marks what the agents said before his latest reply', () => {
  const h = [{ who: 'claude', text: 'screen is locked' }, { who: 'you', text: 'unlocked it' }, { who: 'claude', text: 'ok' }];
  const out = lane.staleMarked(h);
  assert.strictEqual(out[0].stale, true);
  assert.strictEqual(out[1].stale, undefined);
  assert.strictEqual(out[2].stale, undefined);
  assert.strictEqual(h[0].stale, undefined); // the original is left alone
});

test('localApproved: his yes to what the mini PC asked', () => {
  const asked = [{ who: 'claude', lane: 'local', text: 'All filled. Reply **yes** to submit it.' }];
  assert.ok(lane.localApproved({ reply: 'yes', history: asked }));
  assert.ok(!lane.localApproved({ reply: 'yes', history: [{ who: 'claude', text: 'Reply yes to submit it.' }] })); // Claude asked, not the mini PC
  assert.ok(!lane.localApproved({ reply: 'wait', history: asked }));
});

test('cleanStuck trims and fills in the missing half', () => {
  assert.strictEqual(lane.cleanStuck(null), null);
  assert.strictEqual(lane.cleanStuck({}), null);
  assert.deepStrictEqual(lane.cleanStuck({ reason: '  Login needed ' }), { reason: 'Login needed', fix: 'Reply “try again”, or switch it to Claude.' });
  assert.strictEqual(lane.cleanStuck({ fix: 'x'.repeat(500) }).fix.length, 400);
});

test('htmlText strips tags, scripts and entities', () => {
  assert.strictEqual(tools.htmlText('<p>A &amp; B</p><script>x()</script>\n<b>c</b>'), 'A & B c');
});

test('searchMyData: best matches first, stop words ignored', () => {
  const sources = [
    { label: 'task: lamp', text: 'buy a desk lamp' },
    { label: 'task: desk lamp warm', text: 'warm desk lamp under $40' },
    { label: 'note', text: 'nothing here' },
  ];
  const out = tools.searchMyData('find the warm desk lamp', {}, sources);
  assert.match(out, /^- task: desk lamp warm/);
  assert.match(out, /- task: lamp/);
  assert.ok(!out.includes('note'));
  assert.strictEqual(tools.searchMyData('the a', {}, sources), 'Search with a few specific words.');
  assert.match(tools.searchMyData('zebra', {}, sources), /^Nothing in his Tasks app matches/);
});
