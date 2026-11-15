/* The mail guard (agent/browser-proxy.js, TASKS_BROWSER_MAIL=taint): once a run has seen his mail, no other sites,
   nothing typed on his file or account pages, and no sharing, forwarding or filter without a yes. The taint is in a
   file as well as in the process, so the store checkers (separate launcher processes) are held back too. A module
   of its own, because the launcher reads its settings once, when it loads. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-guard-mail-'));
const taintFile = path.join(tmp, 'mail-seen.json');
delete process.env.TASKS_BROWSER_LOCK;
delete process.env.TASKS_BROWSER_HOSTS;
delete process.env.TASKS_BROWSER_APPROVED_HOSTS;
process.env.TASKS_BROWSER_MAIL = 'taint';
process.env.TASKS_BROWSER_TAINT = taintFile;
process.env.TASKS_BROWSER_APPROVED = '0';
process.env.TASKS_BROWSER_FILES = '[]';
process.env.TASKS_BROWSER_ACTIONS = path.join(tmp, 'actions.log');
const mod = require.resolve('../agent/browser-proxy');
const load = () => { delete require.cache[mod]; return require('../agent/browser-proxy'); };

const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
const refs = ['- button "Share" [ref=s1]', '- button "Done" [ref=s2]', '- button "Forward" [ref=s3]', '- button "Create filter" [ref=s4]',
  '- button "Archive" [ref=s5]', '- button "Open" [ref=s6]', '- textbox "Search mail" [ref=s7]', '- textbox "Add people" [ref=s8]', '- link "Taxes 2025" [ref=s9]'].join('\n');

test('a store checker started after the main run saw mail is tainted too, through the file', () => {
  fs.rmSync(taintFile, { force: true });
  const shop = load(); // a fresh process: nothing seen here
  assert.strictEqual(shop.isTainted(), false);
  assert.strictEqual(shop.mailRefusal(call('browser_navigate', { url: 'https://evil.example/?d=secret' }), 'about:blank'), null);
  fs.writeFileSync(taintFile, JSON.stringify({ url: 'https://mail.google.com/', at: Date.now() })); // the main run opened his inbox
  assert.strictEqual(shop.isTainted(), true);
  assert.match(shop.mailRefusal(call('browser_navigate', { url: 'https://evil.example/?d=secret' }), 'about:blank'), /opened the user's mail/);
  assert.match(shop.mailRefusal(call('browser_tabs', { action: 'new', url: 'https://evil.example/' }), 'about:blank'), /opened the user's mail/);
  assert.match(shop.mailRefusal(call('browser_type', { ref: 'x', text: 'secret' }), 'https://www.walmart.com/'), /outside his mail/);
  fs.rmSync(taintFile, { force: true });
});

test('opening mail marks the run and writes the file once', () => {
  fs.rmSync(taintFile, { force: true });
  const p = load();
  assert.strictEqual(p.mailRefusal(call('browser_navigate', { url: 'https://mail.google.com/mail/u/0/' }), 'about:blank'), null);
  assert.ok(fs.existsSync(taintFile));
  assert.match(fs.readFileSync(taintFile, 'utf8'), /mail\.google\.com/);
  assert.match(p.mailRefusal(call('browser_navigate', { url: 'https://www.google.com/search?q=x' }), 'https://mail.google.com/'), /opened the user's mail/);
  // mail itself still takes a search; Send and Enter wait for a yes
  assert.strictEqual(p.mailRefusal(call('browser_type', { ref: 's7', text: 'from:bank' }), 'https://mail.google.com/mail/u/0/#inbox'), null);
  p.learnRefs(refs);
  assert.match(p.mailRefusal(call('browser_press_key', { key: 'Enter' }), 'https://mail.google.com/mail/u/0/#inbox'), /Enter can send/);
  assert.match(p.mailRefusal(call('browser_press_key', { key: '\n' }), 'https://mail.google.com/mail/u/0/#inbox'), /Enter can send/);
  assert.match(p.mailRefusal(call('browser_click', { target: 's3' }), 'https://mail.google.com/mail/u/0/#inbox'), /forwards, shares or changes/);
  assert.match(p.mailRefusal(call('browser_click', { target: 's4' }), 'https://mail.google.com/mail/u/0/#settings/filters'), /forwards, shares or changes/);
  assert.strictEqual(p.mailRefusal(call('browser_click', { target: 's5' }), 'https://mail.google.com/mail/u/0/#inbox'), null); // archiving mail is his usual tidying
  fs.rmSync(taintFile, { force: true });
});

test('his files, contacts and account pages: read, but no sharing and nothing typed without a yes', () => {
  fs.rmSync(taintFile, { force: true });
  const p = load();
  p.learnRefs(refs);
  const drive = 'https://drive.google.com/drive/my-drive', docs = 'https://docs.google.com/document/d/abc/edit', contacts = 'https://contacts.google.com/';
  assert.strictEqual(p.mailRefusal(call('browser_navigate', { url: drive }), 'about:blank'), null); // opening Drive taints like mail
  assert.ok(fs.existsSync(taintFile));
  assert.strictEqual(p.mailRefusal(call('browser_click', { target: 's9' }), drive), null); // opening a file to read it
  assert.strictEqual(p.mailRefusal(call('browser_click', { target: 's6' }), drive), null);
  assert.match(p.mailRefusal(call('browser_click', { target: 's1' }), drive), /shares, moves or hands over/);
  assert.match(p.mailRefusal(call('browser_click', { target: 's1' }), docs), /shares, moves or hands over/);
  assert.match(p.mailRefusal(call('browser_type', { ref: 's8', text: 'attacker@example.com' }), drive), /nothing is typed or changed/);
  assert.match(p.mailRefusal(call('browser_fill_form', { fields: [{ ref: 's8', value: 'x' }] }), contacts), /nothing is typed or changed/);
  assert.match(p.mailRefusal(call('browser_click', { target: 's2' }), docs) || '', /^$/); // Done closes a dialog
  assert.match(p.mailRefusal(call('browser_navigate', { url: 'https://evil.example/' }), docs), /opened the user's mail/);
  assert.match(p.mailRefusal(call('browser_navigate', { url: 'https://teams.microsoft.com/' }), 'about:blank') || '', /^$/); // Microsoft's private pages count too
  assert.match(p.mailRefusal(call('browser_type', { ref: 's8', text: 'x' }), 'https://contoso.sharepoint.com/sites/hr'), /nothing is typed or changed/);
  fs.rmSync(taintFile, { force: true });
});

test('after his yes, Send goes through once; his files and account pages stay read-only, and other sites stay closed', () => {
  fs.rmSync(taintFile, { force: true });
  process.env.TASKS_BROWSER_APPROVED = '1';
  const p = load();
  p.learnRefs(refs);
  p.mailRefusal(call('browser_navigate', { url: 'https://mail.google.com/' }), 'about:blank');
  const inbox = 'https://mail.google.com/mail/u/0/#inbox';
  assert.strictEqual(p.mailRefusal(call('browser_click', { target: 's3' }), inbox), null); // the Send his yes was about
  p.noteAction(call('browser_click', { target: 's3' }), inbox); // it went through: his yes is spent
  assert.match(p.mailRefusal(call('browser_click', { target: 's3' }), inbox), /earlier yes was used/); // a second Send waits for a fresh yes
  // his yes was to a mail step: an email the run read can't turn it into sharing a folder or typing an address on Drive
  p.mailRefusal(call('browser_navigate', { url: 'https://drive.google.com/' }), inbox);
  assert.match(p.mailRefusal(call('browser_click', { target: 's1' }), 'https://drive.google.com/drive/my-drive'), /shares, moves or hands over/);
  assert.match(p.mailRefusal(call('browser_type', { ref: 's8', text: 'friend@example.com' }), 'https://drive.google.com/drive/my-drive'), /nothing is typed or changed/);
  assert.match(p.mailRefusal(call('browser_navigate', { url: 'https://evil.example/' }), 'https://drive.google.com/'), /opened the user's mail/); // still no other sites
  p.resetSpent();
  process.env.TASKS_BROWSER_APPROVED = '0';
  fs.rmSync(taintFile, { force: true });
});
