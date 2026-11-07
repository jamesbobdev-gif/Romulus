/* The iPhone's home-screen widgets (ios/App/RomulusWidgets): the page hands them their rows through the
   WidgetData plugin, because only the page can read the synced lists (they are end-to-end encrypted). Android's
   widgets fetch the rows themselves instead (SyncStore.java), so on Android this does nothing.

   Sent: the open personal, work and school to-dos (the widget works out Today, Tasks and School from them, so
   "today" and "overdue" stay right after midnight), plus the two Agent lists worded the same way as
   ListWidgetService.java. A task checked off on a widget comes back through takePending() and is checked off
   here like any other. prepare-www.js puts this in www/index.html ahead of the app; it starts once the app has. */
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== 'function' || !cap.isPluginAvailable || !cap.isPluginAvailable('WidgetData')) return;
  var call = function (method, opts) { return cap.nativePromise('WidgetData', method, opts || {}); };
  var last = '';
  var timer = null;

  function clock(ms) {
    var d = new Date(ms), now = new Date();
    var t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + t;
  }
  function worker(t) { return t.lane === 'local' ? 'Lupa Au Palatine' : 'Claude'; }
  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function row(t, sub, label, tone, sort, checkable) {
    return { id: t.id, title: oneLine(t.title).slice(0, 120), sub: oneLine(sub).slice(0, 120), label: label, tone: tone, checkable: !!checkable, sort: sort };
  }
  function finish(rows) {
    return rows.sort(function (a, b) { return a.sort - b.sort; }).slice(0, 25).map(function (r) { delete r.sort; return r; });
  }

  function agentLists(open) {
    var needs = 0, waiting = 0, rows = [];
    var sw = 0, sq = 0, sd = 0, sn = 0, srows = [], now = Date.now(), BIG = 1e15;
    open.forEach(function (t) {
      var st = t.status || 'queued', updated = t.updatedAt || 0;
      // Claude needs you (mode "agent")
      if (st === 'needs-you' && t.parked) rows.push(row(t, 'Parked', 'parked', 'muted', BIG / 2 - updated));
      else if (st === 'needs-you') { needs++; rows.push(row(t, t.note, 'needs you', 'warn', -updated)); }
      else if (st === 'working' || st === 'queued') {
        waiting++;
        rows.push(row(t, st === 'working' ? 'Claude is on it…' : 'Waiting for Claude…', st === 'working' ? 'working' : 'waiting', 'muted', BIG / 2 - updated));
      }
      // Agent status (mode "status")
      if (st === 'needs-you') { if (!t.parked) sn++; return; }
      if (st === 'working') {
        sw++;
        var since = t.claimedAt || updated;
        srows.push(row(t, worker(t) + (since ? ' · since ' + clock(since) : ''), 'working', 'accent', -since));
      } else if (st === 'queued') {
        sq++;
        var wait = t.waitUntil || 0;
        srows.push(row(t, wait > now ? 'Held until ' + clock(wait) + ' (usage limit)' : t.lane ? 'Next up for ' + worker(t) : 'Waiting to be routed',
          'queued', 'muted', BIG / 4 + updated));
      } else if (st === 'done') {
        sd++;
        srows.push(row(t, worker(t) + (t.note ? ' · ' + t.note : ''), updated ? 'done ' + clock(updated) : 'done', 'ok', BIG / 2 - updated, true));
      }
    });
    var parts = [];
    if (sw) parts.push(sw + ' working');
    if (sq) parts.push(sq + ' queued');
    if (sd) parts.push(sd + ' done');
    if (sn) parts.push(sn + ' need' + (sn === 1 ? 's' : '') + ' you');
    return {
      agent: { header: needs ? needs + ' need' + (needs === 1 ? 's' : '') + ' you' : waiting ? waiting + ' in progress' : 'all clear', tone: needs ? 'warn' : 'muted', rows: finish(rows) },
      status: { header: parts.length ? parts.join(' · ') : 'idle', tone: sw ? 'accent' : 'muted', rows: finish(srows) }
    };
  }

  function snapshot() {
    var open = state.tasks.filter(function (t) { return !t.done; });
    var lists = open.filter(function (t) { return taskWs(t) !== 'agent'; }).slice(0, 300).map(function (t) {
      var o = { id: t.id, title: oneLine(t.title).slice(0, 120), ch: taskWs(t) };
      if (t.due) o.due = t.due;
      if (t.dueTime) o.time = t.dueTime;
      if (t.tag) o.tag = String(t.tag).slice(0, 40);
      if (t.kind) o.kind = t.kind;
      return o;
    });
    var snap = { at: Date.now(), open: lists, school: schoolConfigured() };
    if (agentAvailable()) {
      var a = agentLists(open.filter(function (t) { return taskWs(t) === 'agent'; }));
      snap.agent = a.agent;
      snap.status = a.status;
    }
    return snap;
  }

  function push() {
    try {
      var text = JSON.stringify(snapshot());
      // only when something shown changed (the timestamp aside)
      var key = text.replace(/^\{"at":\d+,/, '{');
      if (key === last) return;
      last = key;
      call('set', { data: text }).catch(function () { last = ''; });
    } catch (e) {}
  }
  function soon() { clearTimeout(timer); timer = setTimeout(push, 800); }

  // tasks checked off on a widget while the app was closed: done here, then saved and synced as usual
  function takePending() {
    call('takePending').then(function (r) {
      var ids = (r && r.ids) || [];
      var changed = false;
      ids.forEach(function (id) {
        var t = state.tasks.find(function (x) { return x.id === id; });
        if (t && !t.done) { setDone(t, true); changed = true; }
      });
      if (changed) touch(); else soon();
    }).catch(function () {});
  }

  function start() {
    // every save redraws the widgets (persist is the page's one save path: core.js)
    var save = window.persist;
    if (typeof save === 'function') window.persist = function () { var r = save.apply(this, arguments); soon(); return r; };
    document.addEventListener('visibilitychange', function () { if (document.hidden) push(); else takePending(); });
    takePending();
    // synced changes from other devices land without a local save
    setInterval(soon, 60000);
  }
  // after the app's own scripts (state, taskWs, setDone... are theirs)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1500); });
  else setTimeout(start, 1500);
})();
