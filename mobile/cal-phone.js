/* Calendar accounts on the phone: the same Settings → Calendars panel as the desktop, backed by the
   CalAccounts plugin (CalAccountsPlugin.java) instead of the desktop's main process. prepare-www.js puts
   this in www/index.html ahead of the app, as window.phoneCal with the desktop bridge's cal* calls.

   The phone only pulls: calendars switched on become to-dos with the same 'cal-' ids the desktop gives
   them (sha1 of the account's address, calendar and event), so the two never add one event twice.
   Putting tasks on a calendar stays with the desktop app, which already does it for tasks added here.
   Sign-in tokens and calendar links stay in the plugin; the switches live in this phone's localStorage. */
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== 'function' || !cap.isPluginAvailable || !cap.isPluginAvailable('CalAccounts')) return;
  var call = function (method, opts) { return cap.nativePromise('CalAccounts', method, opts || {}); };

  var PREFS_KEY = 'tasks.calPrefs.v1';
  var prefs = function () { var p = {}; try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) {} return { pull: p.pull || {} }; };
  var savePrefs = function (p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ pull: p.pull })); } catch (e) {} };
  var splitRef = function (ref) { var i = String(ref || '').indexOf('|'); return i < 0 ? null : { acct: ref.slice(0, i), cal: ref.slice(i + 1) }; };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var localDate = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var localTime = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  async function api(acct, path) {
    var r = await call('api', { id: acct.id, path: path });
    var data = null; try { data = JSON.parse(r.body); } catch (e) {}
    if (r.status < 200 || r.status >= 300) { var e = new Error((data && data.error && data.error.message) || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return data || {};
  }

  /* ---------- providers (read-only versions of agent/calendars.js) ---------- */
  var google = {
    calendars: async function (a) {
      var r = await api(a, 'users/me/calendarList?minAccessRole=reader');
      return (r.items || []).map(function (c) { return { id: c.primary ? 'primary' : c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }; });
    },
    events: async function (a, cal, from, to) {
      var r = await api(a, 'calendars/' + encodeURIComponent(cal) + '/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=' +
        encodeURIComponent(from.toISOString()) + '&timeMax=' + encodeURIComponent(to.toISOString()));
      return (r.items || []).filter(function (e) { return e.status !== 'cancelled'; }).map(function (e) {
        return { id: e.id, title: e.summary || '', recurring: !!e.recurringEventId, ours: !!(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.tasksApp),
          allDay: !e.start.dateTime, start: e.start.dateTime ? new Date(e.start.dateTime) : e.start.date, where: e.location || '', notes: e.description || '' };
      });
    }
  };
  var microsoft = {
    calendars: async function (a) {
      var r = await api(a, 'me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar');
      return (r.value || []).map(function (c) { return { id: c.id, name: c.name, primary: !!c.isDefaultCalendar }; });
    },
    events: async function (a, cal, from, to) {
      var out = [];
      var url = 'me/calendars/' + encodeURIComponent(cal) + '/calendarView?$top=250&$orderby=start/dateTime&startDateTime=' + encodeURIComponent(from.toISOString()) +
        '&endDateTime=' + encodeURIComponent(to.toISOString()) + '&$select=id,subject,start,end,isAllDay,type,location,bodyPreview,isCancelled,categories';
      var utc = function (x) { return new Date(String(x.dateTime).replace(/(\.\d+)?$/, 'Z')); };
      for (var page = 0; url && page < 4; page++) {
        var r = await api(a, url);
        (r.value || []).forEach(function (e) {
          if (e.isCancelled) return;
          out.push({ id: e.id, title: e.subject || '', recurring: e.type === 'occurrence' || e.type === 'exception', ours: (e.categories || []).indexOf('Tasks') >= 0,
            allDay: !!e.isAllDay, start: e.isAllDay ? String(e.start.dateTime).slice(0, 10) : utc(e.start),
            where: (e.location && e.location.displayName) || '', notes: e.bodyPreview || '' });
        });
        url = r['@odata.nextLink'] || null;
      }
      return out;
    }
  };
  var ics = {
    calendars: async function (a) { return [{ id: 'feed', name: a.name || 'Calendar link', primary: true }]; },
    events: async function (a, _cal, from, to) {
      var r = await call('feed', { id: a.id });
      if (r.status !== 200 || !/BEGIN:VCALENDAR/.test(r.body)) throw new Error(r.status === 200 ? 'not a calendar' : 'HTTP ' + r.status);
      return parseIcs(r.body).filter(function (e) { var s = e.allDay ? new Date(e.start + 'T12:00:00') : e.start; return s >= from && s < to; });
    }
  };
  var PROVIDERS = { google: google, microsoft: microsoft, ics: ics };

  function parseIcs(text) {
    var lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    var un = function (s) { return String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim(); };
    var out = [], ev = null;
    lines.forEach(function (line) {
      if (line === 'BEGIN:VEVENT') { ev = {}; return; }
      if (line === 'END:VEVENT') {
        var st = ev && when(ev.DTSTART);
        if (ev && ev.UID && st && !(ev.STATUS && /CANCELLED/i.test(ev.STATUS.value))) {
          out.push({ id: un(ev.UID.value) + (ev['RECURRENCE-ID'] ? '@' + ev['RECURRENCE-ID'].value : ''), title: un(ev.SUMMARY && ev.SUMMARY.value),
            recurring: !!(ev.RRULE || ev['RECURRENCE-ID']), ours: false, allDay: typeof st === 'string', start: st,
            where: un(ev.LOCATION && ev.LOCATION.value), notes: un(ev.DESCRIPTION && ev.DESCRIPTION.value).slice(0, 1000) });
        }
        ev = null; return;
      }
      if (!ev) return;
      var m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
      if (m && !(m[1] in ev)) ev[m[1]] = { params: m[2], value: m[3] };
    });
    return out;
  }
  function when(p) {
    if (!p) return null;
    var v = p.value.trim();
    var m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return null;
    return m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  function tagFor(name) {
    var s = String(name || '').replace(/\bcalendar\b/gi, '').trim();
    if (!s || /@/.test(s)) return 'calendar';
    return s.toLowerCase().replace(/\s+/g, ' ').slice(0, 20);
  }
  async function sha1hex(s) {
    var buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* ---------- the desktop bridge's cal* calls ---------- */
  var calCache = {}; // acct id → {at, list}
  async function accounts() { return (await call('list')).accounts || []; }
  async function calendarsOf(a, fresh) {
    var hit = calCache[a.id];
    if (hit && !fresh && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
    var list = await PROVIDERS[a.provider].calendars(a);
    calCache[a.id] = { at: Date.now(), list: list };
    return list;
  }

  async function calOverview(fresh) {
    var r = await call('list'), p = prefs(), out = [];
    for (var i = 0; i < (r.accounts || []).length; i++) {
      var a = r.accounts[i];
      var row = { id: a.id, provider: a.provider, label: a.email || a.name || (a.provider === 'google' ? 'Google account' : a.provider), broken: !!a.broken, calendars: [], error: null };
      try {
        row.calendars = (await calendarsOf(a, fresh)).map(function (c) {
          var ref = a.id + '|' + c.id;
          // canWrite false: no "Tasks go here" switch on the phone (the desktop puts tasks on a calendar)
          return Object.assign({}, c, { ref: ref, canWrite: false, push: false, pull: p.pull[ref] || null });
        });
      } catch (e) { row.error = String(e.message || e).slice(0, 160); }
      out.push(row);
    }
    return { accounts: out, builtIn: r.builtIn || {}, phone: true };
  }

  async function calConnect(provider) {
    try { return await call('connect', { provider: provider }); } catch (e) { return { ok: false, error: e.message }; }
  }

  async function calAddLink(url, name) {
    var u = String(url || '').trim().replace(/^webcals?:\/\//i, 'https://');
    // the same spelling as the desktop's, so the link hashes to the same to-do ids
    try { u = new URL(u).href; } catch (e) { return { ok: false, error: 'That isn’t a link.' }; }
    try { return await call('addLink', { url: u, name: name || '' }); } catch (e) { return { ok: false, error: e.message }; }
  }

  async function calRemove(id) {
    await call('remove', { id: id });
    var p = prefs();
    Object.keys(p.pull).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete p.pull[k]; });
    savePrefs(p);
    delete calCache[id];
    return true;
  }

  async function calSetPrefs(change) {
    var p = prefs();
    if (change && change.pull) Object.keys(change.pull).forEach(function (ref) {
      var v = change.pull[ref];
      if (v) p.pull[ref] = { skipRepeating: v.skipRepeating !== false, skipWords: String(v.skipWords || '').slice(0, 300) };
      else delete p.pull[ref];
    });
    savePrefs(p);
    return p;
  }

  /* events in the next two weeks from every calendar switched on, minus the app's own task events,
     repeating ones (classes) unless allowed, and ones with a skipped word: as agent/calendars.js pull() */
  var PULL_DAYS = 14;
  async function calPull(ownEventIds) {
    var p = prefs(), items = [], errors = [];
    var from = new Date(); from.setHours(0, 0, 0, 0);
    var to = new Date(from); to.setDate(to.getDate() + PULL_DAYS);
    var own = {}; (ownEventIds || []).forEach(function (id) { own[id] = 1; });
    var list = await accounts();
    for (var ref in p.pull) {
      var opt = p.pull[ref], r = splitRef(ref);
      var a = r && list.find(function (x) { return x.id === r.acct; });
      if (!a) continue;
      try {
        var cals = await calendarsOf(a).catch(function () { return []; });
        var cal = cals.find(function (c) { return c.id === r.cal; }) || {};
        var calName = cal.primary && a.provider !== 'ics' ? '' : cal.name || a.name || '';
        var words = String(opt.skipWords || '').split(/[,\n]/).map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
        var evs = await PROVIDERS[a.provider].events(a, r.cal, from, to);
        for (var i = 0; i < evs.length; i++) {
          var e = evs[i], title = String(e.title || '').replace(/\s+/g, ' ').trim();
          if (e.ours || own[e.id] || !title) continue;
          if (opt.skipRepeating !== false && e.recurring) continue;
          if (words.some(function (w) { return title.toLowerCase().indexOf(w) >= 0; })) continue;
          items.push({ id: 'cal-' + (await sha1hex(a.key + '|' + r.cal + '|' + e.id)).slice(0, 20), title: title.slice(0, 200),
            due: e.allDay ? e.start : localDate(e.start), dueTime: e.allDay ? null : localTime(e.start),
            notes: [e.where, String(e.notes || '').slice(0, 1000)].filter(Boolean).join('\n\n') || null, tag: tagFor(calName), cal: ref });
        }
      } catch (e) { errors.push((a.email || a.name || a.provider) + ': ' + String(e.message || e).slice(0, 120)); }
    }
    return { items: items, errors: errors };
  }

  // a sign-in that finished after Android had closed the app (the plugin tells the page once it's back)
  function onConnected(cb) { try { cap.addListener('CalAccounts', 'connected', cb); } catch (e) {} }

  window.phoneCal = { calOverview: calOverview, calConnect: calConnect, calAddLink: calAddLink, calRemove: calRemove,
    calSetPrefs: calSetPrefs, calPull: calPull, onConnected: onConnected };
})();
