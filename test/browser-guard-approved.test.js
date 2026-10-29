/* The browser launcher after his yes (agent/browser-proxy.js with TASKS_BROWSER_APPROVED): the order button is
   unlocked only on the sites the yes was about, and what goes through is written to the actions log. A module
   of its own, because the launcher reads its settings once, when it loads. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-guard-yes-'));
const actions = path.join(tmp, 'actions.log');
delete process.env.TASKS_BROWSER_LOCK;
delete process.env.TASKS_BROWSER_HOSTS;
process.env.TASKS_BROWSER_MAIL = '';
process.env.TASKS_BROWSER_APPROVED = '1';
process.env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(['walmart.com']);
process.env.TASKS_BROWSER_ACTIONS = actions;
process.env.TASKS_BROWSER_TASK = 'Order groceries';
process.env.TASKS_BROWSER_FILES = '[]';
delete require.cache[require.resolve('../agent/browser-proxy')];
const proxy = require('../agent/browser-proxy');

const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
proxy.learnRefs(['- button "Place order" [ref=e6]', '- button "Continue" [ref=e2]'].join('\n'));

test('his yes unlocks the order button on the store he said yes to, not elsewhere', () => {
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e6' }), 'https://www.walmart.com/checkout'), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_press_key', { key: 'Enter' }), 'https://www.walmart.com/checkout'), null);
  assert.match(proxy.buyRefusal(call('browser_click', { target: 'e6' }), 'https://www.amazon.com/gp/buy/spc'), /Not without a yes/);
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: 'Enter' }), 'https://www.amazon.com/checkout'), /Not without a yes/);
  // a PIN is his to type, yes or not
  assert.match(proxy.buyRefusal(call('browser_type', { ref: 'e7', element: 'EBT PIN', text: '1234' }), 'https://www.walmart.com/checkout'), /Never type a PIN/);
});

test('what went through is in the actions log; ordinary clicks are not', () => {
  proxy.noteAction(call('browser_click', { target: 'e2' }), 'https://www.walmart.com/cart');
  proxy.noteAction(call('browser_click', { target: 'e6' }), 'https://www.walmart.com/checkout');
  proxy.noteAction(call('browser_press_key', { key: 'Enter' }), 'https://www.walmart.com/checkout');
  proxy.noteAction(call('browser_file_upload', { paths: ['C:\\Users\\x\\resume.pdf'] }), 'https://jobs.example.com/apply');
  const lines = fs.readFileSync(actions, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.what), ['clicked', 'pressed Enter', 'uploaded']);
  assert.strictEqual(lines[0].label, 'button Place order');
  assert.strictEqual(lines[0].task, 'Order groceries');
  assert.match(lines[0].url, /walmart\.com\/checkout/);
  assert.deepStrictEqual(lines[2].files, ['resume.pdf']);
  assert.ok(lines.every((l) => typeof l.at === 'number'));
});
