/* Health on the phone: window.phoneHealth, backed by the HealthData plugin, which reads Apple Health on an
   iPhone (HealthDataPlugin.swift) or Health Connect on Android (HealthDataPlugin.kt): the same four calls either
   way. prepare-www.js puts this in www/index.html ahead of the app; renderer/js/health.js uses it to check off
   goal to-dos ("Walk 8,000 steps", "Sleep 7 hours", "Work out 30 min").
   The numbers stay in this page's memory: nothing here saves or syncs them. */
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== 'function' || !cap.isPluginAvailable || !cap.isPluginAvailable('HealthData')) return;
  var call = function (method) { return cap.nativePromise('HealthData', method, {}); };
  var num = function (x) { return typeof x === 'number' && isFinite(x) ? x : null; };
  var ios = typeof cap.getPlatform === 'function' && cap.getPlatform() === 'ios';

  window.phoneHealth = {
    app: ios ? 'Apple Health' : 'Health Connect', // what the Health tab calls it
    ios: ios,
    // {sdk: 'ready' | 'install' | 'none', granted: {steps, sleep, exercise}} ('install' is Android only: Health
    // Connect is a separate app there; on an iPhone "granted" only means the permission sheet has been shown)
    status: function () { return call('status'); },
    // the permission sheet: Apple Health's, or Health Connect's (or its Play Store page, when it needs installing first)
    connect: function () { return call('connect'); },
    // {date, steps, sleepMin, exerciseMin}: null where it isn't allowed or nothing is logged yet
    today: async function () {
      var r = await call('today');
      return { date: String(r.date || ''), steps: num(r.steps), sleepMin: num(r.sleepMin), exerciseMin: num(r.exerciseMin) };
    },
    // where to change or take back what it may read: the Health app, or Health Connect's settings
    manage: function () { return call('manage'); }
  };
})();
