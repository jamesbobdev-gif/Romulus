/* The iPhone's home-screen widgets (ios/App/RomulusWidgets): the page hands them their rows through the
   WidgetData plugin, because only the page can read the synced lists (they are end-to-end encrypted). Android's
   widgets fetch the rows themselves instead (SyncStore.java), so on Android this does nothing.

   Sent: the open personal, work and school to-dos (the widget works out Today, Personal and School from them,
   so "today" and "overdue" stay right after midnight), plus the Agent board and the next grocery order, worded
   the same way as ListWidgetService.java. A task checked off on a widget comes back through takePending() and is checked off
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

  // the Agent widget: one board, as ListWidgetService.java "agent": what needs you, then running, queued,
  // just finished (checkable, to clear it off), parked last
  function agentBoard(open) {
    var needs = 0, working = 0, queued = 0, finished = 0, rows = [], now = Date.now();
    var TIER = 1e13, LATE = 5e12;
    open.forEach(function (t) {
      var st = t.status || 'queued', updated = t.updatedAt || 0;
      if (st === 'needs-you' && t.parked) rows.push(row(t, 'Parked', 'parked', 'muted', 4 * TIER + (LATE - updated)));
      else if (st === 'needs-you') { needs++; rows.push(row(t, t.note, 'needs you', 'warn', LATE - updated)); }
      else if (st === 'working') {
        working++;
        var since = t.claimedAt || updated;
        rows.push(row(t, worker(t) + (since ? ' · since ' + clock(since) : ''), 'working', 'accent', TIER + (LATE - since)));
      } else if (st === 'queued') {
        queued++;
        var wait = t.waitUntil || 0;
        rows.push(row(t, wait > now ? 'Held until ' + clock(wait) + ' (usage limit)' : t.lane ? 'Next up for ' + worker(t) : 'Waiting to be routed',
          'queued', 'muted', 2 * TIER + updated)); // oldest first: the order they run
      } else if (st === 'done') {
        finished++;
        rows.push(row(t, worker(t) + (t.note ? ' · ' + t.note : ''), updated ? 'done ' + clock(updated) : 'done', 'ok', 3 * TIER + (LATE - updated), true));
      }
    });
    var parts = [];
    if (needs) parts.push(needs + ' need' + (needs === 1 ? 's' : '') + ' you');
    if (working) parts.push(working + ' working');
    if (queued) parts.push(queued + ' queued');
    if (finished) parts.push(finished + ' done');
    return { header: parts.length ? parts.join(' · ') : 'all clear', tone: needs ? 'warn' : working ? 'accent' : 'muted', rows: finish(rows) };
  }

  // the List widget's Groceries choice: what's on the next order, from his grocery task (grocery-list.js);
  // a tap opens that task
  function groceries() {
    var task = typeof groceryTask === 'function' ? groceryTask() : null;
    if (!task) return { header: 'no list yet', tone: 'muted', rows: [] };
    var out = 0, now = Date.now(), rows = [];
    normList(task.list).forEach(function (it, i) {
      if (!itemDue(it, now)) return;
      if (it.out) out++;
      rows.push({ id: task.id + ':' + it.name.toLowerCase(), openId: task.id, title: it.name, sub: it.every === 1 ? '' : 'every ' + it.every + ' weeks',
        label: it.out ? 'out' : '', tone: it.out ? 'late' : 'muted', checkable: false, sort: (it.out ? 0 : 1e6) + i });
    });
    var n = rows.length;
    return { header: n ? n + ' for the next order' + (out ? ' · ' + out + ' out' : '') : 'nothing due', tone: out ? 'late' : 'muted', rows: finish(rows) };
  }

  function snapshot() {
    var open = state.tasks.filter(function (t) { return !t.done; });
    var lists = open.filter(function (t) { return taskWs(t) !== 'agent'; }).slice(0, 300).map(function (t, i) {
      var o = { id: t.id, title: oneLine(t.title).slice(0, 120), ch: taskWs(t), ord: i };
      if (t.due) o.due = t.due;
      if (t.dueTime) o.time = t.dueTime;
      if (t.tag) o.tag = String(t.tag).slice(0, 40);
      if (t.kind) o.kind = t.kind;
      return o;
    });
    var snap = { at: Date.now(), open: lists, school: schoolConfigured() };
    if (agentAvailable()) {
      snap.agent = agentBoard(open.filter(function (t) { return taskWs(t) === 'agent'; }));
      snap.groceries = groceries();
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
