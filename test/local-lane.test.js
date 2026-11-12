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
  // Holo4 quotes the yes instead of bolding it (the Chapter 8 post asked twice for that)
  for (const text of ['The post is typed. **Reply "yes" to submit it.**', 'Reply “yes” to post it.', '**Reply \'yes\'** to send it'])
    assert.ok(lane.localApproved({ reply: 'yes', history: [{ who: 'claude', lane: 'local', text }] }), text);
  assert.ok(!lane.localApproved({ reply: 'yes', history: [{ who: 'claude', lane: 'local', text: 'Reply yesterday’s date and I’ll look.' }] }));
  // his yes with his own version of the post (renderer/js/agent-draft.js) still unlocks the final click
  assert.ok(lane.localApproved({ reply: 'yes, but first replace what you typed with exactly this text, then post it:\n\nHi all', history: asked }));
});

test('claimableWhileDown leaves a task to a computer that reaches the mini PC, then takes it', () => {
  const held = new Map(), a = { id: 'a' }, b = { id: 'b' };
  assert.deepStrictEqual(lane.claimableWhileDown([a], held, 1000), []); // first seen: held back
  assert.deepStrictEqual(lane.claimableWhileDown([a, b], held, 1000 + lane.LOCAL_HOLD_MS - 1), []);
  assert.deepStrictEqual(lane.claimableWhileDown([a, b], held, 1000 + lane.LOCAL_HOLD_MS), [a]); // no taker in time
  assert.deepStrictEqual(lane.claimableWhileDown([b], held, 1000 + lane.LOCAL_HOLD_MS), []); // a was taken: forgotten
  assert.ok(!held.has('a'));
});

test('claimableWhileDown waits longer for a worker it has heard from, and never gives up a private task', () => {
  const held = new Map(), a = { id: 'a' }, p = { id: 'p', private: true };
  const opts = { holdMs: lane.WORKER_HOLD_MS, waitsForWorker: (t) => !!t.private };
  assert.deepStrictEqual(lane.claimableWhileDown([a, p], held, 1000, opts), []);
  assert.deepStrictEqual(lane.claimableWhileDown([a, p], held, 1000 + lane.LOCAL_HOLD_MS, opts), []); // the old 2 min isn't enough
  assert.deepStrictEqual(lane.claimableWhileDown([a, p], held, 1000 + lane.WORKER_HOLD_MS, opts), [a]);
  assert.deepStrictEqual(lane.claimableWhileDown([a, p], held, 1000 + 10 * lane.WORKER_HOLD_MS, opts), [a]); // p waits for the worker
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
