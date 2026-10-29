/* The browser launcher's guards (agent/browser-proxy.js), loaded as a module: the lock a mini PC run gets,
   buying and submitting without a yes, and uploads of anything but his files for forms. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-guard-'));
const lockFile = path.join(tmp, 'lock.json');
const lock = (approved) => fs.writeFileSync(lockFile, JSON.stringify({ allow: ['https://jobs.example.com/apply'], approved }));
lock(false);
const resume = path.join(tmp, 'resume.pdf'); fs.writeFileSync(resume, 'x');
process.env.TASKS_BROWSER_LOCK = lockFile;
process.env.TASKS_BROWSER_FILES = JSON.stringify([resume]);
process.env.TASKS_BROWSER_MAIL = '';
delete process.env.TASKS_BROWSER_APPROVED;
process.env.TASKS_BROWSER_HOSTS = JSON.stringify(['walmart.com', 'jobs.example.com']); // a shopping run's sites
const proxy = require('../agent/browser-proxy');

const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
const here = 'https://jobs.example.com/apply';
proxy.learnRefs(['- button "Apply now" [ref=e1]', '- button "Submit application" [ref=e2]', '- button "Upload resume" [ref=e3]',
  '- button "Easy Apply" [ref=e4]', '- button "Submit" [ref=e5]', '- button "Place order" [ref=e6]', '- link "Sign out" [ref=e7]'].join('\n'));

test('Apply opens the form; Submit waits for his yes', () => {
  assert.strictEqual(proxy.lockedOut(call('browser_click', { target: 'e1' })), null);
  assert.strictEqual(proxy.lockedOut(call('browser_click', { target: 'e4' })), null);
  assert.strictEqual(proxy.lockedOut(call('browser_click', { target: 'e3' })), null);
  assert.match(proxy.lockedOut(call('browser_click', { target: 'e2' })), /final step/);
  assert.match(proxy.lockedOut(call('browser_click', { target: 'e5' })), /final step/);
  // Claude's lane has no lock file: the buy/submit guard holds Submit back on its own
  assert.match(proxy.buyRefusal(call('browser_click', { target: 'e2' }), here), /Not without a yes: "button Submit application"/);
  assert.match(proxy.buyRefusal(call('browser_click', { target: 'e5' }), here), /Not without a yes/);
  assert.match(proxy.buyRefusal(call('browser_click', { target: 'e6' }), here), /places the order/);
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e1' }), here), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e3' }), here), null);
});

test('after his yes, Submit goes through; signing out never does', () => {
  lock(true);
  assert.strictEqual(proxy.lockedOut(call('browser_click', { target: 'e2' })), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_click', { target: 'e2' }), here), null);
  assert.match(proxy.lockedOut(call('browser_click', { target: 'e7' })), /sign the user out/);
  lock(false);
});

test('only web addresses open, in every mode: no file://, javascript: or chrome://', () => {
  assert.strictEqual(proxy.schemeRefusal(call('browser_navigate', { url: 'https://jobs.example.com/apply' })), null);
  assert.strictEqual(proxy.schemeRefusal(call('browser_navigate', { url: 'about:blank' })), null);
  // nor this computer or its network: the browser's own debugging port, the hub, the mini PC's Ollama, a router
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'http://localhost:9334/json/list' })), /not this computer or its network/);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'http://127.0.0.1:8790/hub/ping' })), /not this computer/);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'http://192.168.1.1/' })), /not this computer/);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'http://lupa:11434/api/tags' })), /not this computer/);
  assert.strictEqual(proxy.schemeRefusal(call('browser_tabs', { action: 'list' })), null);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'file:///C:/Users/x/AppData/Roaming/Tasks/config.json' })), /Only web addresses/);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: ' JavaScript:alert(1)' })), /Only web addresses/);
  assert.match(proxy.schemeRefusal(call('browser_tabs', { action: 'new', url: 'chrome://settings' })), /Only web addresses/);
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: '' })), /Only web addresses/);
});

test('a shopping run stays on its sites, plus links shown on their pages', () => {
  assert.strictEqual(proxy.hostRefusal(call('browser_navigate', { url: 'https://www.walmart.com/search?q=milk' })), null);
  assert.strictEqual(proxy.hostRefusal(call('browser_navigate', { url: 'about:blank' })), null);
  assert.strictEqual(proxy.hostRefusal(call('browser_click', { target: 'e1' })), null); // only addresses are checked here
  assert.match(proxy.hostRefusal(call('browser_navigate', { url: 'https://evil.example.net/deal' })), /stays on the sites of the task/);
  assert.match(proxy.hostRefusal(call('browser_tabs', { action: 'new', url: 'https://www.amazon.com/' })), /stays on the sites/);
  // a page on one of its sites links to a payment host: that one hop is allowed (this file also has the lock on,
  // so the page must be one the lock allows too)
  proxy.learnLinks('- Page URL: https://jobs.example.com/apply/pay\n- link "Pay with PayPal" [ref=e9] /url: https://www.paypal.com/checkoutnow?x=1');
  assert.strictEqual(proxy.hostRefusal(call('browser_navigate', { url: 'https://www.paypal.com/checkoutnow?x=1' })), null);
  // links shown on a page outside its sites teach nothing
  proxy.learnLinks('- Page URL: https://evil.example.net/\n- link "x" [ref=e10] /url: https://also-evil.example.net/');
  assert.match(proxy.hostRefusal(call('browser_navigate', { url: 'https://also-evil.example.net/' })), /stays on the sites/);
});

test('Enter on a checkout or application page waits for his yes like the button does', () => {
  // Claude's lane, no lock file: the buy guard alone
  const enter = call('browser_press_key', { key: 'Enter' });
  assert.match(proxy.buyRefusal(enter, 'https://www.walmart.com/checkout'), /Not without a yes: pressing Enter/);
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: 'Control+Enter' }), 'https://www.amazon.com/gp/buy/spc/handlers/display.html'), /Not without a yes/);
  assert.match(proxy.buyRefusal(call('browser_type', { ref: 'e8', text: 'Smith', submit: true }), here), /Not without a yes/); // …/apply
  // the order button itself, however the page is named
  assert.match(proxy.buyRefusal(call('browser_type', { ref: 'e6', text: '', submit: true }), 'https://shop.example.com/anything'), /Not without a yes/);
  // searching is still Enter as usual
  assert.strictEqual(proxy.buyRefusal(enter, 'https://www.walmart.com/search?q=checkout'), null);
  assert.strictEqual(proxy.buyRefusal(enter, 'https://www.google.com/'), null);
  assert.strictEqual(proxy.buyRefusal(call('browser_type', { ref: 'e8', text: 'milk', submit: true }), 'https://www.walmart.com/'), null);
  // after his yes (the lock file is the local lane's way of saying so) Enter goes through
  lock(true);
  assert.strictEqual(proxy.buyRefusal(enter, 'https://www.walmart.com/checkout'), null);
  lock(false);
});

test('uploads: only his files for forms, by their exact path', () => {
  assert.strictEqual(proxy.fileRefusal(call('browser_file_upload', { paths: [resume] })), null);
  assert.strictEqual(proxy.fileRefusal(call('browser_file_upload', {})), null); // closes the file box
  assert.strictEqual(proxy.fileRefusal(call('browser_click', { target: 'e3' })), null);
  const other = proxy.fileRefusal(call('browser_file_upload', { paths: [path.join(tmp, 'other.pdf')] }));
  assert.match(other, /Only his own files for forms can be uploaded: resume\.pdf/);
  assert.match(other, /no paths/);
  assert.match(proxy.fileRefusal(call('browser_file_upload', { paths: [resume, path.join(tmp, 'notes.txt')] })), /Not .*notes\.txt/);
  assert.match(proxy.fileRefusal(call('browser_file_upload', { paths: 'C:\\Windows\\system.ini' })), /system\.ini/);
});
