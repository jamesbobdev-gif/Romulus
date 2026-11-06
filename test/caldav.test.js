const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const caldav = require('../agent/caldav');
const { parseIcs } = require('../agent/calendars');

test('guessServer: known addresses find their server, others ask', () => {
  assert.strictEqual(caldav.guessServer('me@icloud.com'), caldav.KNOWN.icloud);
  assert.strictEqual(caldav.guessServer('Me@Me.com'), caldav.KNOWN.icloud);
  assert.strictEqual(caldav.guessServer('a@fastmail.com'), caldav.KNOWN.fastmail);
  assert.strictEqual(caldav.guessServer('a@yahoo.co.uk'), caldav.KNOWN.yahoo);
  assert.strictEqual(caldav.guessServer('a@example.org'), null);
});

test('normServer: a bare host becomes https with a trailing slash; http is refused', () => {
  assert.strictEqual(caldav.normServer('cloud.example.org/remote.php/dav'), 'https://cloud.example.org/remote.php/dav/');
  assert.strictEqual(caldav.normServer('http://cloud.example.org'), null);
  assert.strictEqual(caldav.normServer(''), null);
});

test('sameSite: iCloud partition hosts count as iCloud, other sites do not', () => {
  assert.ok(caldav.sameSite('https://p52-caldav.icloud.com/1/calendars/', 'https://caldav.icloud.com/'));
  assert.ok(!caldav.sameSite('https://evil.example/', 'https://caldav.icloud.com/'));
  assert.ok(!caldav.sameSite('https://icloud.com.evil.example/', 'https://caldav.icloud.com/'));
});

test('eventIcs: all-day and timed tasks, marked as the app\'s own, read back by parseIcs', () => {
  const day = caldav.eventIcs('u1@x', { summary: 'Pay rent; now, really', allDay: true, date: '2026-11-07', endDate: '2026-11-08', description: 'Tag: home' });
  assert.match(day, /DTSTART;VALUE=DATE:20261107\r\n/);
  assert.match(day, /SUMMARY:Pay rent\\; now\\, really/);
  const back = parseIcs(day)[0];
  assert.strictEqual(back.title, 'Pay rent; now, really');
  assert.strictEqual(back.start, '2026-11-07');
  assert.strictEqual(back.ours, true);
  const timed = caldav.eventIcs('u2@x', { summary: 'Call', allDay: false, start: '2026-11-07T15:30:00', end: '2026-11-07T16:00:00' });
  const t = parseIcs(timed)[0];
  assert.strictEqual(t.start.getTime(), new Date('2026-11-07T15:30:00').getTime());
});

/* a small CalDAV server shaped like iCloud: principal on one path, calendars under another */
function fakeServer() {
  const files = new Map(), seen = [];
  const ms = (body) => '<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' + body + '</multistatus>';
  const ok = (href, prop) => '<response><href>' + href + '</href><propstat><prop>' + prop + '</prop><status>HTTP/1.1 200 OK</status></propstat></response>';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Basic ' + Buffer.from('me@icloud.com:abcd-efgh').toString('base64')) { res.writeHead(401); res.end(); return; }
      const base = 'http://127.0.0.1:' + srv.address().port;
      const send = (x) => { res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end(ms(x)); };
      if (req.method === 'PROPFIND' && req.url === '/') return send(ok('/', '<current-user-principal><href>/123/principal/</href></current-user-principal>'));
      if (req.method === 'PROPFIND' && req.url === '/123/principal/') return send(ok('/123/principal/', '<C:calendar-home-set><href>' + base + '/123/calendars/</href></C:calendar-home-set>'));
      if (req.method === 'PROPFIND' && req.url === '/123/calendars/') return send(
        ok('/123/calendars/', '<resourcetype><collection/></resourcetype>') +
        ok('/123/calendars/home/', '<resourcetype><collection/><C:calendar/></resourcetype><displayname>Home</displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set><current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>') +
        ok('/123/calendars/tasks/', '<resourcetype><collection/><C:calendar/></resourcetype><displayname>Reminders</displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>') +
        ok('/123/calendars/shared/', '<resourcetype><collection/><C:calendar/></resourcetype><displayname>Family &amp; friends</displayname><current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>'));
      if (req.method === 'REPORT' && req.url === '/123/calendars/home/') {
        const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
        const theirs = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:dentist\r\nDTSTART;VALUE=DATE:' + soon + '\r\nSUMMARY:Dentist & checkup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
        const ours = caldav.eventIcs('t1', { summary: 'Mine', allDay: true, date: soon.slice(0, 4) + '-' + soon.slice(4, 6) + '-' + soon.slice(6), endDate: '2099-01-01' });
        const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return send(ok('/123/calendars/home/dentist.ics', '<C:calendar-data>' + enc(theirs) + '</C:calendar-data>') + ok('/123/calendars/home/t1.ics', '<C:calendar-data><![CDATA[' + ours + ']]></C:calendar-data>'));
      }
      if (req.method === 'PUT') { files.set(req.url, body); res.writeHead(201); res.end(); return; }
      if (req.method === 'DELETE') { const had = files.delete(req.url); res.writeHead(had ? 204 : 404); res.end(); return; }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, files, seen, base: 'http://127.0.0.1:' + srv.address().port })));
}

test('calendars: principal → home → the event calendars, with which ones can be written', async () => {
  const f = await fakeServer();
  try {
    const acct = { server: f.base + '/', username: 'me@icloud.com', appPassword: 'abcd-efgh' };
    const r = await caldav.calendars(acct);
    assert.strictEqual(r.home, f.base + '/123/calendars/');
    assert.deepStrictEqual(r.list.map((c) => [c.name, c.canWrite, c.primary]), [['Home', true, true], ['Family & friends', false, false]]);
    acct.home = r.home;
    const evs = await caldav.events(acct, r.list[0].id, new Date(), new Date(Date.now() + 14 * 864e5), parseIcs);
    assert.deepStrictEqual(evs.map((e) => [e.title, e.ours]), [['Dentist & checkup', false], ['Mine', true]]);
  } finally { f.srv.close(); }
});

test('put and remove: one .ics per task, named after its UID; a gone one is fine', async () => {
  const f = await fakeServer();
  try {
    const acct = { server: f.base + '/', username: 'me@icloud.com', appPassword: 'abcd-efgh' };
    const cal = f.base + '/123/calendars/home/';
    const uid = await caldav.put(acct, cal, null, { summary: 'Buy milk', allDay: true, date: '2026-11-07', endDate: '2026-11-08' });
    assert.match(uid, /@romulus-tasks$/);
    const path = '/123/calendars/home/' + encodeURIComponent(uid) + '.ics';
    assert.match(f.files.get(path), /SUMMARY:Buy milk/);
    assert.strictEqual(await caldav.put(acct, cal, uid, { summary: 'Buy oat milk', allDay: true, date: '2026-11-07', endDate: '2026-11-08' }), uid);
    assert.match(f.files.get(path), /SUMMARY:Buy oat milk/);
    await caldav.remove(acct, cal, uid);
    assert.ok(!f.files.has(path));
    await caldav.remove(acct, cal, uid); // already gone
  } finally { f.srv.close(); }
});

test('a wrong password says so; the password never goes to another site', async () => {
  const f = await fakeServer();
  try {
    await assert.rejects(caldav.calendars({ server: f.base + '/', username: 'me@icloud.com', appPassword: 'nope' }), /didn’t take/);
    const acct = { server: f.base + '/', username: 'me@icloud.com', appPassword: 'abcd-efgh', home: 'https://evil.example/cal/' };
    const before = f.seen.length;
    await assert.rejects(caldav.calendars(acct), /another site/);
    assert.strictEqual(f.seen.length, before);
  } finally { f.srv.close(); }
});
