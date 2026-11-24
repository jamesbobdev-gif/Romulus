const test = require('node:test');
const assert = require('node:assert');
const node = require('../agent/util');
const page = require('../renderer/js/util');

test('day and month keys use the local clock, from a Date or ms, and both copies agree', () => {
  const d = new Date(2026, 0, 5, 23, 59);
  for (const u of [node, page]) {
    assert.strictEqual(u.dayKey(d), '2026-01-05');
    assert.strictEqual(u.dayKey(d.getTime()), '2026-01-05');
    assert.strictEqual(u.monthKey(d), '2026-01');
  }
  const t = new Date(2026, 11, 31, 0, 1);
  assert.strictEqual(node.dayKey(t), page.dayKey(t));
});

test('escapeHtml escapes the four characters and treats null as empty, in both copies', () => {
  for (const u of [node, page]) {
    assert.strictEqual(u.escapeHtml('<a href="x">Tom & Jo</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jo&lt;/a&gt;');
    assert.strictEqual(u.escapeHtml(null), '');
  }
});

test('hostOf keeps www, siteOf drops it and takes a bare domain', () => {
  assert.strictEqual(node.hostOf('https://WWW.Walmart.com/cart'), 'www.walmart.com');
  assert.strictEqual(node.hostOf('not a link'), '');
  assert.strictEqual(node.siteOf('https://www.walmart.com/cart'), 'walmart.com');
  assert.strictEqual(node.siteOf('canvas.example.edu'), 'canvas.example.edu');
  assert.strictEqual(node.siteOf(''), '');
});

test('escapeRe makes a string match itself literally', () => {
  const s = 'a.b*c (d)?';
  assert.ok(new RegExp('^' + node.escapeRe(s) + '$').test(s));
  assert.ok(!new RegExp(node.escapeRe('a.b')).test('axb'));
});

test('base64 round trip, including base64url without padding and a big buffer', () => {
  const bytes = new Uint8Array(200000).map((_, i) => i % 256);
  const s = page.bytesToB64(bytes);
  assert.strictEqual(s, Buffer.from(bytes).toString('base64'));
  assert.deepStrictEqual(page.b64ToBytes(s), bytes);
  assert.strictEqual(page.bytesToB64(bytes.buffer), s);
  const url = Buffer.from([251, 255, 0]).toString('base64url');
  assert.deepStrictEqual([...page.b64ToBytes(url)], [251, 255, 0]);
});
