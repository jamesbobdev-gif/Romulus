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
