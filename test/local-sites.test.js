const test = require('node:test');
const assert = require('node:assert');
const ls = require('../agent/local-sites');

test('newHosts: what a run reached that the list lacks, subdomains folded, nothing local', () => {
  const sites = ['joinhandshake.com', 'LinkedIn.com', 'https://mail.google.com/'];
  assert.deepStrictEqual(ls.newHosts(['app.joinhandshake.com', 'www.linkedin.com', 'mail.google.com', 'indeed.com', 'www.indeed.com', 'lupa', '192.168.1.5', 'x.local', 'jobs.lever.co'], sites),
    ['indeed.com', 'jobs.lever.co']);
  assert.deepStrictEqual(ls.merge(sites, ['indeed.com']), ['joinhandshake.com', 'linkedin.com', 'mail.google.com', 'indeed.com']);
  assert.deepStrictEqual(ls.merge('', []), []);
});

test('refusedHost reads the lock refusal', () => {
  assert.strictEqual(ls.refusedHost('Refused or failed: This browser is locked to the links in the task (x.com) and links shown on their pages. https://www.linkedin.com/jobs/view/1 is not one of them.'), 'linkedin.com');
  assert.strictEqual(ls.refusedHost('Locked: "Submit" looks like a final step'), null);
  assert.strictEqual(ls.refusedHost(''), null);
});

test('the Human to-do: title and the host back out of it', () => {
  const title = ls.askTitle('linkedin.com', 'Apply to the  Acme internship');
  assert.strictEqual(title, 'Allow the local model on linkedin.com? Check this off to let it open that site (for “Apply to the Acme internship”)');
  assert.strictEqual(ls.askHost(title), 'linkedin.com');
  assert.strictEqual(ls.askHost('Reconnect Gemini: …'), null);
  assert.strictEqual(ls.askHost(ls.askTitle('x.com')), 'x.com');
});
