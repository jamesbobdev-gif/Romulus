/* CalDAV: a calendar the app can read AND write without a sign-in page of its own. iCloud (Apple Calendar),
   Fastmail, Nextcloud, Yahoo, mailbox.org and most others speak it. The person gives their address and an
   app-specific password (iCloud: appleid.apple.com → Sign-In and Security → App-Specific Passwords), and
   the app finds their calendars from the server's address:
     server (or its /.well-known/caldav) → current-user-principal → calendar-home-set → each calendar
   An account here is { provider: 'caldav', server, username, appPassword, name }; appPassword is sealed in
   config.json like the other secrets (main/store.js SECRET_KEYS). Tasks go on as one .ics file each,
   named after the event's UID, and are marked X-TASKS-APP so they're never pulled back in as to-dos.
   The password only ever goes to the server he typed in, or another host under the same domain (iCloud's
   calendars live on pNN-caldav.icloud.com). */
const crypto = require('crypto');

const KNOWN = {
  icloud: 'https://caldav.icloud.com/',
  fastmail: 'https://caldav.fastmail.com/',
  yahoo: 'https://caldav.calendar.yahoo.com/',
  gmx: 'https://caldav.gmx.net/',
  mailbox: 'https://dav.mailbox.org/'
};
// an address → the server that probably holds its calendar (he can always type one)
function guessServer(username) {
  const d = String(username || '').toLowerCase().split('@')[1] || '';
  if (/^(icloud|me|mac)\.com$/.test(d)) return KNOWN.icloud;
  if (/^(fastmail\.(com|fm)|messagingengine\.com)$/.test(d)) return KNOWN.fastmail;
  if (/^(yahoo|ymail|rocketmail)\./.test(d)) return KNOWN.yahoo;
  if (/^gmx\./.test(d)) return KNOWN.gmx;
  if (d === 'mailbox.org') return KNOWN.mailbox;
  return null;
}
// "cloud.example.org" / "https://cloud.example.org/remote.php/dav" → an https URL ending in /
function normServer(s) {
  let v = String(s || '').trim();
  if (!v) return null;
  if (!/^[a-z]+:\/\//i.test(v)) v = 'https://' + v;
  let u; try { u = new URL(v); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
// the registrable-ish part of a host: the last two labels (icloud.com), three for co.uk-style ones
function siteOf(host) {
  const p = String(host).toLowerCase().split('.');
  return p.slice(/^(co|com|org|net|ac|gov)$/.test(p[p.length - 2] || '') && p.length > 2 ? -3 : -2).join('.');
}
function sameSite(a, b) { try { return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname); } catch (e) { return false; } }
function sameScheme(a, b) { try { return new URL(a).protocol === new URL(b).protocol; } catch (e) { return false; } }

/* ---------- XML, just enough for multistatus replies (prefixes vary: d:, D:, none) ---------- */
const unXml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
function tags(xml, name) {
  const re = new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '\\s*>)', 'gi');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1] == null ? '' : m[1]);
  return out;
}
const first = (xml, name) => { const t = tags(xml, name); return t.length ? t[0] : null; };
const has = (xml, name) => new RegExp('<(?:[\\w-]+:)?' + name + '[\\s/>]', 'i').test(xml || '');
// <response> blocks → [{ href, props (the 200 propstat's inner xml) }]
function responses(xml) {
  return tags(xml, 'response').map((r) => {
    const ok = tags(r, 'propstat').filter((ps) => /\s200\s/.test(first(ps, 'status') || ' 200 '));
    return { href: unXml((first(r, 'href') || '').trim()), props: ok.map((ps) => first(ps, 'prop') || '').join('') };
  });
}

/* ---------- requests ---------- */
function auth(acct) { return 'Basic ' + Buffer.from(acct.username + ':' + acct.appPassword, 'utf8').toString('base64'); }
// one request; redirects are followed by hand, and only within the server's own site, so the password never leaves it
async function dav(acct, method, url, body, headers) {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    // the same site, over the same scheme as his server (https: serverUrl takes no other): a redirect to plain http would carry the password in the clear
    if (!sameSite(at, acct.server) || !sameScheme(at, acct.server)) throw new Error('The calendar server sent us to another site');
    const res = await fetch(at, { method, redirect: 'manual', signal: AbortSignal.timeout(20000), body,
      headers: Object.assign({ Authorization: auth(acct), 'User-Agent': 'Romulus-Tasks' }, body ? { 'Content-Type': /^BEGIN:/.test(body) ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}, headers) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { at = new URL(res.headers.get('location'), at).href; continue; }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) { const e = new Error(/icloud/.test(acct.server) ? 'iCloud didn’t take that address and app-specific password' : 'The server didn’t take that user name and password'); e.status = res.status; throw e; }
    if (!res.ok && res.status !== 207) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return { status: res.status, text, url: at };
  }
  throw new Error('Too many redirects');
}
const PROPFIND = (props) => '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>' + props + '</d:prop></d:propfind>';

// server → the calendar home's URL (kept on the account after the first look)
async function findHome(acct) {
  if (acct.home) return acct.home;
  let principal = null;
  for (const start of [acct.server, new URL('/.well-known/caldav', acct.server).href]) {
    try {
      const r = await dav(acct, 'PROPFIND', start, PROPFIND('<d:current-user-principal/>'), { Depth: '0' });
      const p = first(r.text, 'current-user-principal');
      const h = p && first(p, 'href');
      if (h) { principal = new URL(unXml(h.trim()), r.url).href; break; }
    } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
  }
  if (!principal) throw new Error('No calendars found at that server address');
  const r = await dav(acct, 'PROPFIND', principal, PROPFIND('<c:calendar-home-set/>'), { Depth: '0' });
  const hs = first(r.text, 'calendar-home-set');
  const h = hs && first(hs, 'href');
  if (!h) throw new Error('No calendars found for that account');
  return new URL(unXml(h.trim()), r.url).href;
}

async function calendars(acct) {
  const home = await findHome(acct);
  const r = await dav(acct, 'PROPFIND', home, PROPFIND('<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>'), { Depth: '1' });
  const out = [];
  for (const x of responses(r.text)) {
    if (!has(first(x.props, 'resourcetype'), 'calendar')) continue;
    const comps = first(x.props, 'supported-calendar-component-set');
    if (comps && !/name=["']VEVENT["']/i.test(comps)) continue; // a reminders-only list
    const priv = first(x.props, 'current-user-privilege-set');
    const canWrite = priv == null ? true : has(priv, 'write') || has(priv, 'write-content') || has(priv, 'all');
    out.push({ id: new URL(x.href, r.url).href, name: unXml((first(x.props, 'displayname') || '').trim()) || 'Calendar', primary: false, canWrite });
  }
  if (!out.length) throw new Error('That account has no calendars');
  // the first one he can write to is "main" (iCloud lists Home first, Nextcloud Personal)
  (out.find((c) => c.canWrite) || out[0]).primary = true;
  return { home, list: out };
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
async function events(acct, calUrl, from, to, parseIcs) {
  const body = '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>' +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="' + stamp(from) + '" end="' + stamp(to) + '"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const r = await dav(acct, 'REPORT', calUrl, body, { Depth: '1' });
  const out = [];
  for (const x of responses(r.text)) {
    const data = first(x.props, 'calendar-data');
    if (data) out.push(...parseIcs(unXml(data)));
  }
  return out.filter((e) => { const s = e.allDay ? new Date(e.start + 'T12:00:00') : e.start; return s >= from && s < to; });
}

// a task as an .ics file; timed events go over in UTC so time-zone names never matter
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { const out = []; let s = line; while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); } out.push(s); return out.join('\r\n'); }
function eventIcs(uid, ev, now) {
  const dateOnly = (d) => String(d).replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Romulus//Tasks//EN', 'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(now || new Date()),
    ev.allDay ? 'DTSTART;VALUE=DATE:' + dateOnly(ev.date) : 'DTSTART:' + stamp(new Date(ev.start)),
    ev.allDay ? 'DTEND;VALUE=DATE:' + dateOnly(ev.endDate) : 'DTEND:' + stamp(new Date(ev.end)),
    'SUMMARY:' + icsText(ev.summary)];
  if (ev.description) lines.push('DESCRIPTION:' + icsText(ev.description));
  lines.push('CATEGORIES:Tasks', 'X-TASKS-APP:1', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
const fileUrl = (calUrl, uid) => new URL(encodeURIComponent(uid) + '.ics', calUrl.endsWith('/') ? calUrl : calUrl + '/').href;
async function put(acct, calUrl, id, ev) {
  const uid = id || crypto.randomUUID() + '@romulus-tasks';
  await dav(acct, 'PUT', fileUrl(calUrl, uid), eventIcs(uid, ev));
  return uid;
}
async function remove(acct, calUrl, id) {
  try { await dav(acct, 'DELETE', fileUrl(calUrl, id)); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
}

module.exports = { KNOWN, guessServer, normServer, sameSite, responses, tags, unXml, findHome, calendars, events, put, remove, eventIcs };
