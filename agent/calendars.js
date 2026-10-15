/* Calendar accounts: Google, Microsoft (Outlook / 365 / school) and plain calendar links (.ics).
   People sign in with one click: the app's own OAuth clients live in oauth-clients.json (bundled with
   the build, kept out of git); without it, Google falls back to the Client ID/Secret pasted in Settings.
   Sign-in uses the system browser and a one-shot listener on 127.0.0.1 with PKCE, like the old Google flow.

   Each calendar gets two switches, kept in config.calPrefs:
     push: 'acct|calendarId'   the ONE calendar tasks go onto (null = tasks go nowhere)
     pull: { 'acct|calendarId': { skipRepeating, skipWords } }   calendars whose events become to-dos
   Tokens and links stay in this computer's config.json; nothing here is synced or shown to a model. */
const http = require('http');
const crypto = require('crypto');

let io = null; // { readConfig, writeConfig, openExternal, clients }
function init(opts) { io = opts; migrate(); }

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const localTime = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const accounts = (cfg) => (Array.isArray(cfg.calAccounts) ? cfg.calAccounts : []);
const prefs = (cfg) => Object.assign({ push: null, pull: {} }, cfg.calPrefs);
const splitRef = (ref) => { const i = String(ref || '').indexOf('|'); return i < 0 ? null : { acct: ref.slice(0, i), cal: ref.slice(i + 1) }; };

// the old single Google connection (cfg.gcal) becomes the first account, still putting tasks on its main calendar
function migrate() {
  const cfg = io.readConfig();
  const g = cfg.gcal;
  if (!g || !g.tokens || !g.tokens.refresh_token || accounts(cfg).some((a) => a.id === 'g-legacy')) return;
  cfg.calAccounts = accounts(cfg).concat([{ id: 'g-legacy', provider: 'google', email: null, tokens: g.tokens, scope: g.scope || '',
    clientId: g.clientId, clientSecret: g.clientSecret }]);
  const p = prefs(cfg);
  if (!cfg.calPrefs) p.push = 'g-legacy|primary';
  cfg.calPrefs = p;
  delete g.tokens;
  io.writeConfig(cfg);
}

/* ---------- providers ---------- */
function googleClient(acct) {
  const cfg = io.readConfig();
  if (acct && acct.clientId) return { clientId: acct.clientId, clientSecret: acct.clientSecret };
  const c = io.clients().google;
  if (c && c.clientId) return c;
  return cfg.gcal && cfg.gcal.clientId ? { clientId: cfg.gcal.clientId, clientSecret: cfg.gcal.clientSecret } : null;
}
function msClient(acct) {
  if (acct && acct.clientId) return { clientId: acct.clientId };
  const c = io.clients().microsoft;
  if (c && c.clientId) return c;
  const cfg = io.readConfig();
  return cfg.msClientId ? { clientId: cfg.msClientId } : null;
}

const google = {
  name: 'Google',
  client: googleClient,
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // calendar events, the list of calendars, and reading (never changing) Gmail for dates (agent/mail-events.js);
  // Google's screen lets people untick Gmail
  scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/gmail.readonly',
  authExtra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  async api(token, method, url, body) {
    const res = await fetch('https://www.googleapis.com/calendar/v3/' + url, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status); e.status = res.status; throw e; }
    return data;
  },
  async calendars(token, acct) {
    try {
      const r = await this.api(token, 'GET', 'users/me/calendarList?minAccessRole=reader');
      return (r.items || []).map((c) => ({ id: c.primary ? 'primary' : c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary,
        canWrite: c.accessRole === 'owner' || c.accessRole === 'writer' }));
    } catch (e) {
      // signed in before the calendar-list permission was asked for: the main calendar still works
      if (e.status === 403 && !/calendarlist|calendar\.readonly/.test(acct.scope || '')) return [{ id: 'primary', name: 'Main calendar', primary: true, canWrite: true, needsReconnect: true }];
      throw e;
    }
  },
  async events(token, cal, from, to) {
    const r = await this.api(token, 'GET', 'calendars/' + encodeURIComponent(cal) + '/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=' +
      encodeURIComponent(from.toISOString()) + '&timeMax=' + encodeURIComponent(to.toISOString()));
    return (r.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
      id: e.id, title: e.summary || '', recurring: !!e.recurringEventId, ours: !!(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.tasksApp),
      allDay: !e.start.dateTime, start: e.start.dateTime ? new Date(e.start.dateTime) : e.start.date, end: e.end && (e.end.dateTime ? new Date(e.end.dateTime) : e.end.date),
      where: e.location || '', notes: e.description || '', invite: googleInvite(e) }));
  },
  async put(token, cal, id, ev) {
    const body = { summary: ev.summary, description: ev.description || undefined, extendedProperties: { private: { tasksApp: '1' } },
      start: ev.allDay ? { date: ev.date } : { dateTime: ev.start, timeZone: ev.tz }, end: ev.allDay ? { date: ev.endDate } : { dateTime: ev.end, timeZone: ev.tz } };
    const path = 'calendars/' + encodeURIComponent(cal) + '/events';
    if (id) {
      try { return (await this.api(token, 'PATCH', path + '/' + encodeURIComponent(id), body)).id; } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    return (await this.api(token, 'POST', path, body)).id;
  },
  async remove(token, cal, id) {
    try { await this.api(token, 'DELETE', 'calendars/' + encodeURIComponent(cal) + '/events/' + encodeURIComponent(id)); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  }
};

/* An event someone else put on his calendar (an invitation; anyone can send one, so its text is
   theirs) → { from, answer: accepted | tentative | needsAction | declined }; his own events → undefined.
   Feeds he subscribed to (.ics) have no organizer and count as his. */
function googleInvite(e) {
  if (!e.organizer || e.organizer.self) return undefined;
  const me = (e.attendees || []).find((x) => x.self);
  return { from: String(e.organizer.email || e.organizer.displayName || ''), answer: me ? me.responseStatus || 'needsAction' : 'needsAction' };
}
function microsoftInvite(e) {
  if (e.isOrganizer !== false) return undefined;
  const r = (e.responseStatus && e.responseStatus.response) || 'none';
  const from = e.organizer && e.organizer.emailAddress ? String(e.organizer.emailAddress.address || e.organizer.emailAddress.name || '') : '';
  return { from, answer: r === 'accepted' ? 'accepted' : r === 'tentativelyAccepted' ? 'tentative' : r === 'declined' ? 'declined' : 'needsAction' };
}

const microsoft = {
  name: 'Microsoft',
  client: msClient,
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scope: 'openid email profile offline_access User.Read Calendars.ReadWrite',
  authExtra: { prompt: 'select_account' },
  // Microsoft allows any port on a localhost redirect, but the host has to be "localhost"
  redirectHost: 'localhost',
  async api(token, method, url, body) {
    const res = await fetch(/^https:/.test(url) ? url : 'https://graph.microsoft.com/v1.0/' + url, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status); e.status = res.status; throw e; }
    return data;
  },
  async calendars(token) {
    const r = await this.api(token, 'GET', 'me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar');
    return (r.value || []).map((c) => ({ id: c.id, name: c.name, primary: !!c.isDefaultCalendar, canWrite: !!c.canEdit }));
  },
  async events(token, cal, from, to) {
    const out = [];
    let url = 'me/calendars/' + encodeURIComponent(cal) + '/calendarView?$top=250&$orderby=start/dateTime&startDateTime=' + encodeURIComponent(from.toISOString()) +
      '&endDateTime=' + encodeURIComponent(to.toISOString()) + '&$select=id,subject,start,end,isAllDay,type,location,bodyPreview,isCancelled,categories,isOrganizer,organizer,responseStatus';
    for (let page = 0; url && page < 4; page++) {
      const r = await this.api(token, 'GET', url);
      for (const e of r.value || []) {
        if (e.isCancelled) continue;
        const utc = (x) => new Date(String(x.dateTime).replace(/(\.\d+)?$/, 'Z'));
        out.push({ id: e.id, title: e.subject || '', recurring: e.type === 'occurrence' || e.type === 'exception', ours: (e.categories || []).includes('Tasks'),
          allDay: !!e.isAllDay, start: e.isAllDay ? String(e.start.dateTime).slice(0, 10) : utc(e.start), end: e.isAllDay ? String(e.end.dateTime).slice(0, 10) : utc(e.end),
          where: (e.location && e.location.displayName) || '', notes: e.bodyPreview || '', invite: microsoftInvite(e) });
      }
      url = r['@odata.nextLink'] || null;
    }
    return out;
  },
  async put(token, cal, id, ev) {
    // times go over as UTC, so Windows/IANA time-zone names never matter
    const body = { subject: ev.summary, categories: ['Tasks'], body: { contentType: 'text', content: ev.description || '' } };
    if (ev.allDay) Object.assign(body, { isAllDay: true, start: { dateTime: ev.date + 'T00:00:00', timeZone: 'UTC' }, end: { dateTime: ev.endDate + 'T00:00:00', timeZone: 'UTC' } });
    else Object.assign(body, { isAllDay: false, start: { dateTime: new Date(ev.start).toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: new Date(ev.end).toISOString().slice(0, 19), timeZone: 'UTC' } });
    if (id) {
      try { return (await this.api(token, 'PATCH', 'me/events/' + encodeURIComponent(id), body)).id; } catch (e) { if (e.status !== 404) throw e; }
    }
    return (await this.api(token, 'POST', 'me/calendars/' + encodeURIComponent(cal) + '/events', body)).id;
  },
  async remove(token, cal, id) {
    try { await this.api(token, 'DELETE', 'me/events/' + encodeURIComponent(id)); } catch (e) { if (e.status !== 404) throw e; }
  }
};

/* a calendar link: read-only. Repeating events (RRULE) aren't expanded, so only their first date is seen;
   they're marked repeating and skipped by default, which is what's wanted for classes anyway */
const ics = {
  name: 'Calendar link',
  async calendars(_token, acct) { return [{ id: 'feed', name: acct.name || acct.email || 'Calendar link', primary: true, canWrite: false }]; },
  async events(_token, _cal, from, to, acct) {
    const r = await fetch(acct.url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'text/calendar' } });
    const text = await r.text();
    if (!r.ok || !/BEGIN:VCALENDAR/.test(text)) throw new Error(r.ok ? 'not a calendar' : 'HTTP ' + r.status);
    return parseIcs(text).filter((e) => {
      const s = e.allDay ? new Date(e.start + 'T12:00:00') : e.start;
      return s >= from && s < to;
    });
  }
};
function parseIcs(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const un = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') {
      const st = ev && when(ev.DTSTART);
      if (ev && ev.UID && st && !(ev.STATUS && /CANCELLED/i.test(ev.STATUS.value))) {
        out.push({ id: un(ev.UID.value) + (ev['RECURRENCE-ID'] ? '@' + ev['RECURRENCE-ID'].value : ''), title: un(ev.SUMMARY && ev.SUMMARY.value),
          recurring: !!(ev.RRULE || ev['RECURRENCE-ID']), ours: false, allDay: typeof st === 'string', start: st, end: when(ev.DTEND),
          where: un(ev.LOCATION && ev.LOCATION.value), notes: un(ev.DESCRIPTION && ev.DESCRIPTION.value).slice(0, 1000) });
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (m && !(m[1] in ev)) ev[m[1]] = { params: m[2], value: m[3] };
  }
  return out;
}
// all-day → 'YYYY-MM-DD'; timed → Date ("…Z" is UTC; a zoned or floating time is taken as this computer's)
function when(p) {
  if (!p) return null;
  const v = p.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  return m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const PROVIDERS = { google, microsoft, ics };

/* ---------- tokens ---------- */
async function tokenFor(acctId) {
  const cfg = io.readConfig();
  const a = accounts(cfg).find((x) => x.id === acctId);
  if (!a) throw new Error('That account is no longer connected');
  if (a.provider === 'ics') return null;
  const t = a.tokens || {};
  if (t.access_token && t.expiry_date > Date.now() + 60000) return t.access_token;
  if (!t.refresh_token) throw new Error('Sign in again');
  const p = PROVIDERS[a.provider];
  const c = p.client(a);
  if (!c) throw new Error(p.name + ' sign-in isn’t set up in this build');
  const params = new URLSearchParams({ client_id: c.clientId, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  if (c.clientSecret) params.set('client_secret', c.clientSecret);
  if (a.provider === 'microsoft') params.set('scope', p.scope);
  const res = await fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fresh = io.readConfig();
    const fa = accounts(fresh).find((x) => x.id === acctId);
    if (fa && data.error === 'invalid_grant') { fa.broken = true; io.writeConfig(fresh); }
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }
  const fresh = io.readConfig();
  const fa = accounts(fresh).find((x) => x.id === acctId);
  if (fa) {
    fa.tokens = Object.assign({}, fa.tokens, { access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 },
      data.refresh_token ? { refresh_token: data.refresh_token } : {});
    delete fa.broken;
    io.writeConfig(fresh);
  }
  return data.access_token;
}

/* ---------- sign-in ---------- */
function idTokenEmail(idToken) {
  try { const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64').toString('utf8')); return p.email || p.preferred_username || null; } catch (e) { return null; }
}

function connect(provider, opts = {}) {
  const p = PROVIDERS[provider];
  if (!p || provider === 'ics') return Promise.resolve({ ok: false, error: 'Unknown provider' });
  const c = opts.clientId ? { clientId: opts.clientId, clientSecret: opts.clientSecret } : p.client();
  if (!c) return Promise.resolve({ ok: false, needsClient: true, error: p.name + ' sign-in isn’t set up in this build.' });
  const host = p.redirectHost || '127.0.0.1';
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    let settled = false, port = null;
    const finish = (r) => { if (settled) return; settled = true; try { server.close(); } catch (e) {} resolve(r); };
    const page = (title, msg) => `<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>${title}</h2><p>${String(msg).replace(/</g, '&lt;')}</p></body></html>`;
    const server = http.createServer(async (req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { res.writeHead(400); res.end(); return; }
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const say = (title, msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(title, msg)); };
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (err) { say('Sign-in failed', err); finish({ ok: false, error: err }); return; }
      if (!u.searchParams.get('code') || u.searchParams.get('state') !== state) { say('Sign-in failed', 'Invalid response.'); finish({ ok: false, error: 'Invalid response from ' + p.name + '.' }); return; }
      try {
        const params = new URLSearchParams({ code: u.searchParams.get('code'), client_id: c.clientId, redirect_uri: `http://${host}:${port}/oauth2callback`,
          grant_type: 'authorization_code', code_verifier: verifier });
        if (c.clientSecret) params.set('client_secret', c.clientSecret);
        const tr = await fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
        const td = await tr.json().catch(() => ({}));
        if (!tr.ok) { say('Sign-in failed', td.error_description || 'Token exchange failed.'); finish({ ok: false, error: td.error_description || 'Token exchange failed.' }); return; }
        if (!td.refresh_token) { say('Sign-in failed', 'No refresh token.'); finish({ ok: false, error: p.name + ' did not return a refresh token. Remove the app’s access in your account settings and try again.' }); return; }
        const email = idTokenEmail(td.id_token);
        const cfg = io.readConfig();
        // signing in again with the same account refreshes it instead of adding a copy
        const list = accounts(cfg);
        let a = list.find((x) => x.provider === provider && ((email && x.email === email) || (!x.email && x.id === 'g-legacy' && provider === 'google')));
        if (!a) { a = { id: provider[0] + '-' + crypto.randomBytes(4).toString('hex'), provider }; list.push(a); }
        Object.assign(a, { email: email || a.email || null, scope: td.scope || '',
          tokens: { access_token: td.access_token, refresh_token: td.refresh_token, expiry_date: Date.now() + td.expires_in * 1000 } });
        if (opts.clientId) { a.clientId = c.clientId; a.clientSecret = c.clientSecret; }
        delete a.broken;
        // nothing goes onto or comes off it until a calendar is switched on in Settings
        cfg.calAccounts = list;
        io.writeConfig(cfg);
        say('Connected.', 'You can close this window and go back to Tasks.');
        finish({ ok: true, id: a.id, email });
      } catch (e) { say('Sign-in failed', e.message); finish({ ok: false, error: e.message }); }
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const url = p.authUrl + '?' + new URLSearchParams(Object.assign({ client_id: c.clientId, redirect_uri: `http://${host}:${port}/oauth2callback`,
        response_type: 'code', scope: p.scope, state, code_challenge: challenge, code_challenge_method: 'S256' }, p.authExtra));
      io.openExternal(url).catch((e) => finish({ ok: false, error: 'Could not open the browser: ' + e.message }));
    });
    server.on('error', (e) => finish({ ok: false, error: 'Could not start sign-in listener: ' + e.message }));
    // a blocked sign-in (e.g. an unverified app) never comes back, so don't leave the button hanging
    setTimeout(() => finish({ ok: false, error: 'Timed out. Finish signing in within 3 minutes and try again.' }), 3 * 60 * 1000);
  });
}

async function addLink(url, name) {
  const u = String(url || '').trim().replace(/^webcals?:\/\//i, 'https://');
  let x; try { x = new URL(u); } catch (e) { return { ok: false, error: 'That isn’t a link.' }; }
  if (x.protocol !== 'https:') return { ok: false, error: 'Use an https:// or webcal:// link.' };
  try { await ics.events(null, 'feed', new Date(0), new Date(), { url: x.href }); } catch (e) { return { ok: false, error: 'Couldn’t read it: ' + e.message }; }
  const cfg = io.readConfig();
  if (accounts(cfg).some((a) => a.url === x.href)) return { ok: false, error: 'Already added.' };
  const id = 'i-' + crypto.randomBytes(4).toString('hex');
  cfg.calAccounts = accounts(cfg).concat([{ id, provider: 'ics', url: x.href, name: String(name || '').trim().slice(0, 40) || x.hostname }]);
  io.writeConfig(cfg);
  return { ok: true, id };
}

function removeAccount(id) {
  const cfg = io.readConfig();
  cfg.calAccounts = accounts(cfg).filter((a) => a.id !== id);
  const p = prefs(cfg);
  if (p.push && p.push.startsWith(id + '|')) p.push = null;
  for (const k of Object.keys(p.pull)) if (k.startsWith(id + '|')) delete p.pull[k];
  cfg.calPrefs = p;
  io.writeConfig(cfg);
  return true;
}

/* ---------- what Settings shows ---------- */
const calCache = new Map(); // acct id → {at, list}
async function calendarsOf(a, fresh) {
  const hit = calCache.get(a.id);
  if (hit && !fresh && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const list = await PROVIDERS[a.provider].calendars(await tokenFor(a.id), a);
  calCache.set(a.id, { at: Date.now(), list });
  return list;
}
async function overview(fresh) {
  const cfg = io.readConfig();
  const p = prefs(cfg);
  const out = [];
  for (const a of accounts(cfg)) {
    const row = { id: a.id, provider: a.provider, label: a.email || a.name || (a.provider === 'google' ? 'Google account' : a.provider), broken: !!a.broken, calendars: [], error: null,
      gmail: a.provider === 'google' && /gmail\.readonly/.test(a.scope || '') };
    try {
      const cals = await calendarsOf(a, fresh);
      row.calendars = cals.map((c) => { const ref = a.id + '|' + c.id; return Object.assign({}, c, { ref, push: p.push === ref, pull: p.pull[ref] || null }); });
    } catch (e) { row.error = e.message.slice(0, 160); }
    out.push(row);
  }
  const cl = io.clients();
  return { accounts: out, builtIn: { google: !!(cl.google && cl.google.clientId), microsoft: !!(cl.microsoft && cl.microsoft.clientId) } };
}

function setPrefs(change) {
  const cfg = io.readConfig();
  const p = prefs(cfg);
  if ('push' in change) p.push = change.push || null;
  if (change.pull) for (const [ref, v] of Object.entries(change.pull)) {
    if (v) p.pull[ref] = { skipRepeating: v.skipRepeating !== false, skipWords: String(v.skipWords || '').slice(0, 300) };
    else delete p.pull[ref];
  }
  cfg.calPrefs = p;
  io.writeConfig(cfg);
  return p;
}

/* ---------- tasks → the chosen calendar ---------- */
function pushTarget() { const r = prefs(io.readConfig()).push; return r && splitRef(r) ? r : null; }
async function putEvent(ref, eventId, ev) {
  const { acct, cal } = splitRef(ref);
  const a = accounts(io.readConfig()).find((x) => x.id === acct);
  if (!a || a.provider === 'ics') throw new Error('Calendar not connected');
  return PROVIDERS[a.provider].put(await tokenFor(acct), cal, eventId, ev);
}
async function deleteEvent(ref, eventId) {
  const r = splitRef(ref);
  if (!r || !eventId) return;
  const a = accounts(io.readConfig()).find((x) => x.id === r.acct);
  if (!a || a.provider === 'ics') return; // the account is gone: nothing we can reach
  await PROVIDERS[a.provider].remove(await tokenFor(r.acct), r.cal, eventId);
}

/* ---------- calendars → to-dos ----------
   Events in the next two weeks from every calendar switched on, minus the app's own task events,
   repeating ones (classes, standing meetings) unless allowed, and ones with a skipped word in the title.
   Each comes back with a stable id, so the renderer adds it once and follows it if it moves. */
const PULL_DAYS = 14;
// to-do ids hash the account's address (or the link), not its id here, so the phone (mobile/cal-phone.js)
// gives the same event the same id and the two never add it twice
const pullKey = (a) => (a.provider === 'ics' ? 'ics:' + a.url : a.email ? a.provider + ':' + String(a.email).toLowerCase() : a.id);
async function pull(ownEventIds) {
  const cfg = io.readConfig();
  const p = prefs(cfg);
  const items = [], errors = [];
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + PULL_DAYS);
  const own = new Set(ownEventIds || []);
  for (const [ref, opt] of Object.entries(p.pull)) {
    const r = splitRef(ref);
    const a = r && accounts(cfg).find((x) => x.id === r.acct);
    if (!a) continue;
    try {
      const cals = await calendarsOf(a).catch(() => []);
      const cal = cals.find((c) => c.id === r.cal) || {};
      const calName = cal.primary && a.provider !== 'ics' ? '' : cal.name || a.name || '';
      const words = String(opt.skipWords || '').split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
      const evs = await PROVIDERS[a.provider].events(await tokenFor(a.id), r.cal, from, to, a);
      for (const e of evs) {
        const title = String(e.title || '').replace(/\s+/g, ' ').trim();
        if (e.ours || own.has(e.id) || !title) continue;
        if (opt.skipRepeating !== false && e.recurring) continue;
        if (words.some((w) => title.toLowerCase().includes(w))) continue;
        const due = e.allDay ? e.start : localDate(e.start);
        items.push({ id: 'cal-' + crypto.createHash('sha1').update(pullKey(a) + '|' + r.cal + '|' + e.id).digest('hex').slice(0, 20), title: title.slice(0, 200),
          due, dueTime: e.allDay ? null : localTime(e.start), notes: [e.where, String(e.notes || '').slice(0, 1000)].filter(Boolean).join('\n\n') || null,
          tag: tagFor(calName), cal: ref });
      }
    } catch (e) { errors.push((a.email || a.name || a.provider) + ': ' + e.message.slice(0, 120)); }
  }
  return { items, errors };
}
// "james@gmail.com" / "Work Calendar" → "work"; a calendar named after the address gets no tag of its own
function tagFor(name) {
  const s = String(name || '').replace(/\bcalendar\b/gi, '').trim();
  if (!s || /@/.test(s)) return 'calendar';
  return s.toLowerCase().replace(/\s+/g, ' ').slice(0, 20);
}

/* ---------- for the agent: what's on every connected calendar this week ---------- */
async function upcoming(from, to) {
  const cfg = io.readConfig();
  const p = prefs(cfg);
  const refs = new Set(Object.keys(p.pull));
  if (p.push) refs.add(p.push);
  for (const a of accounts(cfg)) if (a.provider === 'google') refs.add(a.id + '|primary');
  const all = [];
  for (const ref of refs) {
    const r = splitRef(ref);
    const a = r && r.cal && accounts(cfg).find((x) => x.id === r.acct);
    if (!a) continue;
    try { all.push(...await PROVIDERS[a.provider].events(await tokenFor(a.id), r.cal, from, to, a)); } catch (e) {}
  }
  const seen = new Set();
  return all.filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((x, y) => new Date(x.start) - new Date(y.start));
}

// a Google account that let the app read Gmail (for agent/mail-events.js)
function gmailAccount() {
  return accounts(io.readConfig()).find((a) => a.provider === 'google' && /gmail\.readonly/.test(a.scope || '') && a.tokens && a.tokens.refresh_token) || null;
}

module.exports = { init, connect, addLink, removeAccount, overview, setPrefs, pushTarget, putEvent, deleteEvent, pull, upcoming, gmailAccount, tokenFor, parseIcs, tagFor };
