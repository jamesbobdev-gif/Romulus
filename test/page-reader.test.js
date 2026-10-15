const test = require('node:test');
const assert = require('node:assert');
const pageReader = require('../agent/page-reader');

// a browser whose one action fails with `err`; looking at the page always works
const fakeBrowser = (err) => ({ async call(name) { return name === 'browser_snapshot' ? '- Page URL: https://example.com\n- button "OK" [ref=e1]' : err; } });

test('a page that never finishes loading is a load timeout, not a locked screen', async () => {
  const r = await pageReader.step(fakeBrowser('Refused or failed: ### Error\nError: browserBackend.callTool: Timeout 60000ms exceeded'), 'browser_navigate', { url: 'https://example.com' }, {});
  assert.strictEqual(r.loadTimeout, true);
  assert.strictEqual(r.clickTimeout, false);
  assert.match(r.text, /took too long to load/);
  assert.doesNotMatch(r.text, /screen is probably locked/);
});

test('a click that times out still points at the locked screen', async () => {
  const r = await pageReader.step(fakeBrowser('Refused or failed: ### Error\nTimeoutError: Timeout 5000ms exceeded.\n  - attempting click action'), 'browser_click', { target: 'e1' }, { refs: {} });
  assert.strictEqual(r.clickTimeout, true);
  assert.strictEqual(r.loadTimeout, false);
  assert.match(r.text, /screen is probably locked/);
});
