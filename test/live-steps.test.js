/* Live steps for the AIs that aren't Claude: the browser launcher writes each call down (browser-proxy.js
   stepLine), and agent/run-live.js tail() turns those lines into the task's live log and "What it did". */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runLive = require('../agent/run-live');
const { stepLine } = require('../agent/browser-proxy');

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('a step line keeps where and what, never the typed text', () => {
  const typed = stepLine(call('browser_type', { element: 'Email field', ref: 'e3', text: 'secret@example.com', submit: true }));
  assert.strictEqual(typed.name, 'browser_type');
  assert.strictEqual(typed.input.element, 'Email field');
  assert.ok(!JSON.stringify(typed).includes('secret'), 'typed text is not written down');
  const form = stepLine(call('browser_fill_form', { fields: [{ name: 'Card', value: '4111111111111111' }, { name: 'Zip', value: '44101' }] }));
  assert.strictEqual(form.input.fields.length, 2);
  assert.ok(!JSON.stringify(form).includes('4111'), 'form values are not written down');
  assert.strictEqual(stepLine(call('browser_navigate', { url: 'https://evil.example/x' }), 'Refused').blocked, true);
  assert.strictEqual(stepLine({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tail turns the launcher\'s lines into live steps, blocked ones marked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-steps-'));
  const sent = [];
  const live = runLive.start({ dir, tasks: [{ id: 'a', title: 'Bottle' }], send: (ch, p) => sent.push(p), node: null });
  const file = path.join(dir, 'steps', 'browser-steps.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stepLine(call('browser_navigate', { url: 'https://old.example' }))) + '\n'); // a past try's
  live.note('-- Gemini is on it');
  const end = live.tail(file, 50);
  const w = (o) => fs.appendFileSync(file, JSON.stringify(o) + '\n');
  w(stepLine(call('browser_navigate', { url: 'https://www.walmart.com/cart' })));
  fs.appendFileSync(file, '{"name":"browser_cli'); // half a line: read once it is whole
  await new Promise((r) => setTimeout(r, 120));
  fs.appendFileSync(file, 'ck","input":{"element":"Add to cart"}}\n');
  w(stepLine(call('browser_navigate', { url: 'https://evil.example/x' }), 'Refused'));
  w(stepLine(call('browser_tabs', { action: 'list' }))); // not worth a line
  end();
  const did = live.thoughts('a');
  assert.strictEqual(did, '-- Gemini is on it\nOpening walmart.com/cart\nClicking Add to cart\nBlocked: Opening evil.example/x');
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sent.filter((p) => p.id === 'a').pop().text, /Clicking Add to cart/);
  live.stop();
});
