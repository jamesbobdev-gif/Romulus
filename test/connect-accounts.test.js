const test = require('node:test');
const assert = require('node:assert');
const { linkKind } = require('../renderer/js/connect-accounts');
const calendars = require('../agent/calendars');

test('linkKind: nothing pasted is nothing to say', () => {
  assert.strictEqual(linkKind(''), null);
  assert.strictEqual(linkKind('   '), null);
});

test('linkKind: webcal and http become https, words around the link are dropped', () => {
  const r = linkKind('Here it is: webcal://p52-caldav.icloud.com/published/2/MTIzNDU2 thanks');
  assert.deepStrictEqual(r, { url: 'https://p52-caldav.icloud.com/published/2/MTIzNDU2', name: 'iCloud', kind: 'icloud' });
  assert.strictEqual(linkKind('http://example.org/cal.ics').url, 'https://example.org/cal.ics');
});

test('linkKind: half a link or not a link says so', () => {
  assert.ok(linkKind('my calendar').warn);
  assert.ok(linkKind('ftp://example.org/a.ics').warn);
});

test('linkKind: Google page vs Google secret address', () => {
  assert.ok(linkKind('https://calendar.google.com/calendar/u/0/r').warn);
  const r = linkKind('https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics');
  assert.strictEqual(r.kind, 'google');
  assert.ok(!r.warn);
});

test('linkKind: an Outlook HTML link is swapped for its ICS link', () => {
  const live = linkKind('https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/abc-def/cid-1234/calendar.html');
  assert.strictEqual(live.url, 'https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/abc-def/cid-1234/calendar.ics');
  assert.strictEqual(live.name, 'Outlook');
  const work = linkKind('https://outlook.office365.com/owa/calendar/abc@school.edu/xyz123/reachcalendar.html');
  assert.strictEqual(work.url, 'https://outlook.office365.com/owa/calendar/abc@school.edu/xyz123/calendar.ics');
  assert.ok(linkKind('https://outlook.live.com/calendar/0/view/month').warn);
});

test('linkKind: an iCloud.com page is not a shared link', () => {
  assert.ok(linkKind('https://www.icloud.com/calendar/').warn);
});

test('linkKind: school sites are recognised', () => {
  assert.strictEqual(linkKind('https://myschool.instructure.com/feeds/calendars/user_abc.ics').name, 'Canvas');
  assert.strictEqual(linkKind('https://learn.uni.edu/d2l/le/calendar/feed/user/feed.ics?token=x').name, 'D2L');
  assert.strictEqual(linkKind('https://uni.blackboard.com/webapps/calendar/calendarFeed/abc/learn.ics').name, 'Blackboard');
  assert.strictEqual(linkKind('https://uni.blackboard.com/x.ics').kind, 'school');
});

test('linkKind: any other link is named after its site', () => {
  assert.deepStrictEqual(linkKind('https://www.teamsnap.com/feed/abc.ics'), { url: 'https://www.teamsnap.com/feed/abc.ics', name: 'teamsnap', kind: 'link' });
});

test('scopeFor: unticking email leaves only calendar permissions', () => {
  const g = { scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' };
  assert.strictEqual(calendars.scopeFor(g, { noMail: true }), 'openid email https://www.googleapis.com/auth/calendar.events');
  assert.strictEqual(calendars.scopeFor(g, {}), g.scope);
  const ms = { scope: 'openid email profile offline_access User.Read Calendars.ReadWrite Mail.Send' };
  assert.strictEqual(calendars.scopeFor(ms, { noMail: true }), 'openid email profile offline_access User.Read Calendars.ReadWrite');
});
