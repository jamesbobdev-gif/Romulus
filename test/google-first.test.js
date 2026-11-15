// The first-launch card (renderer/js/google-first.js): what its Gmail and Google Calendar tiles show
const test = require('node:test');
const assert = require('node:assert');
const { googleFirstState } = require('../renderer/js/google-first');

const google = (extra) => Object.assign({ id: 'g-1', provider: 'google', label: 'alex@example.com', broken: false, gmail: false, calendars: [] }, extra || {});

test('a new install: both tiles ask to sign in, and nothing else is connected', () => {
  const st = googleFirstState({ accounts: [] }, true);
  assert.deepStrictEqual(st, { calendar: 'todo', gmail: 'todo', email: '', any: false });
  // no overview at all (the bridge failed) reads the same way
  assert.strictEqual(googleFirstState(null, true).any, false);
});

test('the phone has no mail: the Gmail tile is off', () => {
  assert.strictEqual(googleFirstState({ accounts: [] }, false).gmail, 'off');
  assert.strictEqual(googleFirstState({ accounts: [google({ gmail: true })] }, false).gmail, 'off');
});

test('one Google sign-in with Gmail ticked covers both tiles, named by the address', () => {
  const st = googleFirstState({ accounts: [google({ gmail: true })] }, true);
  assert.strictEqual(st.calendar, 'done');
  assert.strictEqual(st.gmail, 'done');
  assert.strictEqual(st.email, 'alex@example.com');
  assert.strictEqual(st.any, true);
});

test('calendar only: Gmail is still to add; a sign-in that ran out counts as not connected', () => {
  const st = googleFirstState({ accounts: [google()] }, true);
  assert.strictEqual(st.calendar, 'done');
  assert.strictEqual(st.gmail, 'todo');
  const out = googleFirstState({ accounts: [google({ gmail: true, broken: true })] }, true);
  assert.strictEqual(out.calendar, 'todo');
  assert.strictEqual(out.gmail, 'todo');
  assert.strictEqual(out.email, '');
  assert.strictEqual(out.any, true); // but the install has been through Settings: the card stays away
});

test('an Outlook or link account means Settings has been visited, with Google still to do', () => {
  const st = googleFirstState({ accounts: [{ id: 'm-1', provider: 'microsoft', label: 'alex@outlook.com', calendars: [] }] }, true);
  assert.strictEqual(st.any, true);
  assert.strictEqual(st.calendar, 'todo');
});
