const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, powerSaveBlocker, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const pageReader = require('./agent/page-reader');
const formMode = require('./agent/form-mode');
const localAnswer = require('./agent/local-answer');
const siteNotes = require('./agent/site-notes');
const rsiModule = require('./agent/rsi');
const calendars = require('./agent/calendars');
const providers = require('./agent/providers');
const supabase = require('./agent/supabase');
const store = require('./main/store');
const win = require('./main/window');
const trayMod = require('./main/tray');
const usage = require('./agent/usage-limit');
const routingMod = require('./agent/routing');
const ai = require('./agent/ai-connections');
const agentBrowser = require('./agent/agent-browser');
const taskContext = require('./agent/task-context');
const qwenBrowser = require('./agent/qwen-browser');
const previews = require('./agent/previews');
const runner = require('./agent/runner');
const memoryTidy = require('./agent/memory-tidy');
const localTools = require('./agent/local-tools');
const localLane = require('./agent/local-lane');
const rsiWiring = require('./main/rsi');
const speak = require('./main/speak');

// Match the installer's shortcut ID so Windows shows our icon on the taskbar
if (process.platform === 'win32') app.setAppUserModelId('com.jartro.tasks');

win.guardIpc(ipcMain);
store.init({ userData: () => app.getPath('userData'), safeStorage: require('electron').safeStorage });
const { dataFile, readConfig, writeConfig, agentLog } = store;
const { showWindow, sendToRenderer } = win;
trayMod.init({ dataFile, showWindow, quit: win.quit, rsiUndo: () => rsiWiring.rsi.undo(), applyRsiChange: win.applyRsiChange, agentLog, icon: win.ICON });
const { refreshTrayStatus } = trayMod;

// what the main-process modules share: handed to each one's init()
const ctx = {
  userData: () => app.getPath('userData'),
  documents: () => app.getPath('documents'),
  isPackaged: app.isPackaged,
  dataFile, readConfig, writeConfig, agentLog, sendToRenderer, showWindow,
  scheduleAgentRun: (raw) => runner.scheduleAgentRun(raw),
  scheduleLocalRun: (raw) => localLane.scheduleLocalRun(raw),
  memoryTidying: () => memoryTidy.isTidying(),
  compactHowtos: (asked) => localLane.compactHowtos(asked),
  newHiddenWindow: win.newHiddenWindow,
  applyRsiChange: win.applyRsiChange,
  powerSaveBlocker, powerMonitor,
};
const modules = [usage, routingMod, ai, agentBrowser, taskContext, qwenBrowser, previews, runner, memoryTidy, localTools, localLane, rsiWiring, speak];
for (const m of modules) {
  m.init(ctx);
  for (const [channel, fn] of Object.entries(m.handlers || {})) ipcMain.handle(channel, fn);
}
const { holdForUsage } = usage;
const { loadRouting, askForRoutes } = routingMod;
const { scheduleAgentRun, queuedAgentTasks } = runner;
const { scheduleLocalRun } = localLane;
const { maybeTidyMemory } = memoryTidy;

global.__agentTest = { parseUsageLimit: usage.parseUsageLimit, holdForUsage, recentReplies: memoryTidy.recentReplies, maybeTidyMemory };

/* ---------- course calendar feeds (agent/calendar-feeds.js) ---------- */
// the private links stay in this computer's config; the renderer gets them back only for Settings
const calendarFeeds = require('./agent/calendar-feeds');
const feedUrls = () => (Array.isArray(readConfig().calendarFeeds) ? readConfig().calendarFeeds : []);
ipcMain.handle('feeds:get', () => feedUrls());
ipcMain.handle('feeds:save', (_event, urls) => {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 10);
  const bad = list.filter((u) => !calendarFeeds.normalUrl(u));
  if (bad.length) return { ok: false, error: 'not an https/webcal link: ' + bad[0].slice(0, 50) };
  const cfg = readConfig(); cfg.calendarFeeds = list; writeConfig(cfg);
  return { ok: true };
});
ipcMain.handle('feeds:fetch', () => calendarFeeds.fetchAll(feedUrls()));

/* ---------- persistence (IPC) ---------- */
ipcMain.handle('tasks:load', async () => {
  try {
    return fs.readFileSync(dataFile(), 'utf8');
  } catch (e) {
    return null; // first run: no file yet
  }
});

let syncDebounce = null;
ipcMain.handle('tasks:save', async (_event, raw) => {
  try {
    const file = dataFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, file); // atomic-ish: never leaves a half-written file
    refreshTrayStatus(raw);
    scheduleAgentRun(raw);
    scheduleLocalRun(raw);
    askForRoutes(raw);
    processBuyEmails(raw).catch((e) => console.error('buy email error:', e.message));
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => { performSync().catch((e) => console.error('gcal sync failed:', e.message)); }, 3000);
    return true;
  } catch (e) {
    console.error('Failed to save tasks:', e);
    return false;
  }
});

/* ---------- Google Calendar sync ---------- */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function addMinutesIso(dateStr, timeStr, mins) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const dt = new Date(y, m - 1, d, h, mi + mins);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
}

/* ---------- "Buy this" emails ----------
   When James chooses one of Claude's product options, the renderer stamps the
   task with `buyEmail` {label,url,price,rating,image,at}. Here we hand that to
   the `buy-email` Supabase edge function, which sends it through Resend (from a
   neutral address, to James's inbox). No Google/Gmail permission is involved,
   and the Resend key lives only on the server. It emails the link; never buys.
   Dedup is by task+url+click-time, remembered in config.buyEmailsSent, so a
   given choice is emailed exactly once even across restarts and re-saves. */
// where to send it and the function's address (with its secret token) live in config.json
// (buyEmailTo, buyEmailUrl), not in the code
const buyFailed = new Set(); // keys that failed this session (don't retry every save until restart)
const buySending = new Set(); // keys being sent right now (a second save meanwhile must not send it again)

async function processBuyEmails(raw) {
  let saved; try { saved = JSON.parse(raw); } catch (e) { return; }
  const tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  const pending = tasks.filter((t) => t && t.ws === 'agent' && t.buyEmail && t.buyEmail.url);
  if (!pending.length) return;
  const cfg = readConfig();
  const to = cfg.buyEmailTo, fnUrl = cfg.buyEmailUrl;
  if (!to || !fnUrl) return; // not set up on this computer
  const sent = new Set(Array.isArray(cfg.buyEmailsSent) ? cfg.buyEmailsSent : []);
  let changed = false;
  for (const t of pending) {
    const b = t.buyEmail;
    const key = t.id + '|' + (b.url || '') + '|' + (b.at || '');
    if (sent.has(key) || buyFailed.has(key) || buySending.has(key)) continue;
    buySending.add(key);
    try {
      const res = await fetch(fnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, kind: b.kind === 'print' || b.kind === 'link' ? b.kind : 'buy', label: b.label, url: b.url, price: b.price, rating: b.rating, image: b.image }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      sent.add(key); changed = true;
      agentLog('buy email sent: ' + b.label);
    } catch (e) {
      buyFailed.add(key);
      agentLog('buy email failed: ' + e.message);
    } finally { buySending.delete(key); }
  }
  if (changed) { // re-read: other settings may have been saved while the emails went out
    const fresh = readConfig();
    fresh.buyEmailsSent = Array.from(new Set([...(Array.isArray(fresh.buyEmailsSent) ? fresh.buyEmailsSent : []), ...sent])).slice(-500);
    writeConfig(fresh);
  }
}

// one sync at a time: two overlapping runs would both create an event for the same new task
let gcalSyncing = null, gcalSyncAgain = false;
function performSync() {
  if (gcalSyncing) { gcalSyncAgain = true; return gcalSyncing; }
  gcalSyncing = performSyncOnce().finally(() => {
    gcalSyncing = null;
    if (gcalSyncAgain) { gcalSyncAgain = false; performSync().catch((e) => console.error('gcal sync failed:', e.message)); }
  });
  return gcalSyncing;
}
async function performSyncOnce() {
  const cfg = readConfig();
  if (!(cfg.calAccounts || []).length) return [];
  const target = calendars.pushTarget(); // 'acct|calendar' tasks go onto, or null (then the app's events come off)
  let saved;
  try { saved = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return []; }
  const tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changed = [];
  // events made before calendars could be picked live on the old Google account's main calendar
  const refOf = (t) => t.calRef || (t.googleEventId ? 'g-legacy|primary' : null);

  for (const t of tasks) {
    // personal tasks, plus school tests and projects, go on the calendar; work, Claude's agent tasks
    // and regular homework stay off it (a school task switched to "regular" has its event removed).
    // To-dos that came from a calendar are already on one.
    const onCalendar = !t.fromCal && (!t.ws || t.ws === 'personal' || (t.ws === 'school' && (t.kind === 'exam' || t.kind === 'project')));
    const want = target && onCalendar && !t.done && t.due ? target : null;
    try {
      if (t.googleEventId && refOf(t) !== want) {
        try { await calendars.deleteEvent(refOf(t), t.googleEventId); } catch (e) {}
        t.googleEventId = null; t.calRef = null;
        changed.push(t);
      }
      if (!want) continue;
      // school events say which class and what kind ("Astronomy test: Test 2")
      let summary = t.title;
      if (t.ws === 'school') {
        const kindWord = t.kind === 'exam' && !/\b(test|exam|midterm|final)\b/i.test(t.title) ? 'test'
          : t.kind === 'project' && !/project|deliverable|assignment/i.test(t.title) ? 'project' : '';
        const showClass = t.tag && !t.title.toLowerCase().includes(String(t.tag).toLowerCase());
        if (showClass) summary = t.tag + (kindWord ? ' ' + kindWord + ': ' : ' — ') + t.title;
        else if (kindWord) summary = kindWord[0].toUpperCase() + kindWord.slice(1) + ': ' + t.title;
      }
      const ev = t.dueTime
        ? { summary, allDay: false, start: `${t.due}T${t.dueTime}:00`, end: addMinutesIso(t.due, t.dueTime, 30), tz }
        : { summary, allDay: true, date: t.due, endDate: addDays(t.due, 1) };
      if (t.tag) ev.description = 'Tag: ' + t.tag;
      if (t.ws === 'school' && t.notes) ev.description = (t.tag ? 'Class: ' + t.tag + '\n\n' : '') + String(t.notes).slice(0, 4000);
      const id = await calendars.putEvent(want, t.googleEventId, ev);
      if (id !== t.googleEventId || t.calRef !== want) { t.googleEventId = id; t.calRef = want; if (!changed.includes(t)) changed.push(t); }
    } catch (e) {
      console.error('calendar sync error for task', t.id, e.message);
    }
  }

  if (changed.length) {
    // the calendar calls take a while and the app may have saved meanwhile: write the event ids into
    // the file as it is now, instead of putting back the copy read at the start
    try {
      const file = dataFile();
      const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = new Map(changed.map((t) => [t.id, t]));
      for (const t of Array.isArray(latest.tasks) ? latest.tasks : []) if (ids.has(t.id)) { t.googleEventId = ids.get(t.id).googleEventId; t.calRef = ids.get(t.id).calRef; }
      fs.writeFileSync(file + '.tmp', JSON.stringify(latest));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('calendar sync: could not save event ids:', e.message); }
  }
  sendToRenderer('gcal:sync-done', changed.map((t) => ({ id: t.id, googleEventId: t.googleEventId, calRef: t.calRef || null })));
  return changed;
}

/* device-sync config lives in config.json so it survives reinstalls and can
   seed the renderer on first run */
ipcMain.handle('sync:get-cfg', async () => {
  const cfg = readConfig();
  return cfg.sync || null;
});
ipcMain.handle('sync:save-cfg', async (_e, sync) => {
  const cfg = readConfig();
  cfg.sync = sync;
  writeConfig(cfg);
  return true;
});

ipcMain.handle('gcal:save-cfg', async (_e, { clientId, clientSecret }) => {
  const cfg = readConfig();
  cfg.gcal = Object.assign({}, cfg.gcal, { clientId, clientSecret });
  writeConfig(cfg);
  return true;
});

ipcMain.handle('gcal:get-cfg', async () => {
  const cfg = readConfig();
  return { clientId: (cfg.gcal && cfg.gcal.clientId) || '', clientSecret: (cfg.gcal && cfg.gcal.clientSecret) || '' };
});

// web pages only: the renderer shows text from Claude and web pages, so never hand the OS a file: or other scheme
ipcMain.handle('gcal:open-url', async (_e, url) => { if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url)); });

/* calendar accounts (agent/calendars.js): sign in, pick where tasks go and which calendars become to-dos */
ipcMain.handle('cal:overview', (_e, fresh) => calendars.overview(!!fresh));
ipcMain.handle('cal:connect', async (_e, provider, own) => {
  const r = await calendars.connect(String(provider), own && own.clientId ? { clientId: String(own.clientId), clientSecret: String(own.clientSecret || '') } : {});
  if (r.ok) performSync().catch((e) => console.error('calendar sync failed:', e.message));
  return r;
});
ipcMain.handle('cal:add-link', (_e, url, name) => calendars.addLink(url, name));
ipcMain.handle('cal:remove', async (_e, id) => {
  // its task events come off the calendar first, while the account can still be reached
  const t = calendars.pushTarget();
  if (t && t.startsWith(id + '|')) { calendars.setPrefs({ push: null }); await performSync().catch(() => {}); }
  return calendars.removeAccount(String(id));
});
ipcMain.handle('cal:set-prefs', (_e, change) => {
  const before = calendars.pushTarget();
  const p = calendars.setPrefs(change || {});
  if (calendars.pushTarget() !== before) performSync().catch((e) => console.error('calendar sync failed:', e.message));
  return p;
});
// events from the calendars switched on, as to-dos; the app's own task events are left out
ipcMain.handle('cal:pull', async () => {
  let own = [];
  try { own = (JSON.parse(fs.readFileSync(dataFile(), 'utf8')).tasks || []).map((t) => t.googleEventId).filter(Boolean); } catch (e) {}
  return calendars.pull(own);
});
ipcMain.handle('gcal:sync-now', async () => performSync());

/* ---------- dates from Gmail (agent/mail-events.js) ----------
   The renderer asks every 15 minutes; an unchanged mailbox costs one tiny Gmail call and no model.
   New mail that mentions a date goes to Claude in one short call: the same signed-in claude CLI the
   agent uses, with no tools, no connectors and a bare system prompt, so a call is ~1-2k tokens. */
const mailEvents = require('./agent/mail-events');
let mailChecking = false;
const mailAllowed = () => !!calendars.gmailAccount();
// one structured answer from Claude: messages = [system, user], schema = what the answer must look like
function claudeJson(messages, schema) {
  const cfg = readConfig();
  const exe = (cfg.agentRunner && cfg.agentRunner.command) || path.join(require('os').homedir(), '.local', 'bin', 'claude.exe');
  const model = (cfg.mailEvents && cfg.mailEvents.model) || 'claude-opus-5-5';
  const args = ['-p', '--output-format', 'json', '--model', model, '--effort', 'low', '--tools', '', '--strict-mcp-config',
    '--max-turns', '3', '--system-prompt', messages[0].content, '--json-schema', JSON.stringify(schema)];
  return new Promise((resolve, reject) => {
    const p = require('child_process').spawn(exe, args, { cwd: require('os').tmpdir(), windowsHide: true });
    let out = '', err = '';
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('Claude took over 3 minutes')); }, 3 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(new Error('couldn’t start Claude: ' + e.message)); });
    p.on('close', () => {
      clearTimeout(killer);
      let r; try { r = JSON.parse(out); } catch (e) { return reject(new Error((err || out || 'no answer from Claude').trim().slice(0, 200))); }
      if (r.is_error || !r.structured_output) return reject(new Error(String(r.result || r.subtype || 'Claude gave no answer').slice(0, 200)));
      resolve(JSON.stringify(r.structured_output));
    });
    p.stdin.end(messages[1].content);
  });
}
ipcMain.handle('mail:status', () => {
  const cfg = readConfig();
  return { connected: (cfg.calAccounts || []).some((a) => a.provider === 'google'), allowed: mailAllowed(), enabled: !(cfg.mailEvents && cfg.mailEvents.enabled === false),
    last: (cfg.mailEvents && cfg.mailEvents.last) || null };
});
ipcMain.handle('mail:set-enabled', (_e, on) => {
  const cfg = readConfig(); cfg.mailEvents = Object.assign({}, cfg.mailEvents, { enabled: !!on }); writeConfig(cfg);
  return true;
});
ipcMain.handle('mail:check', async () => {
  const cfg = readConfig();
  if (!mailAllowed() || (cfg.mailEvents && cfg.mailEvents.enabled === false)) return { skipped: 'off' };
  if (mailChecking) return { skipped: 'busy' };
  mailChecking = true;
  const state = Object.assign({ seen: [] }, cfg.mailEvents && cfg.mailEvents.state);
  try {
    const gmail = async (sub) => {
      const acct = calendars.gmailAccount();
      if (!acct) throw new Error('Gmail isn’t connected');
      const token = await calendars.tokenFor(acct.id);
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + sub, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Gmail HTTP ' + res.status);
      return data;
    };
    const r = await mailEvents.check({ gmail, ask: claudeJson, state });
    if (r.asked) agentLog('mail: ' + r.checked + ' new, ' + r.asked + ' to Claude, ' + r.items.length + ' date(s) found');
    const fresh = readConfig();
    fresh.mailEvents = Object.assign({}, fresh.mailEvents, { state, last: Date.now() });
    writeConfig(fresh);
    return { items: r.items, checked: r.checked, asked: r.asked };
  } catch (e) {
    agentLog('mail check failed: ' + e.message);
    return { error: e.message.slice(0, 200) };
  } finally { mailChecking = false; }
});

ipcMain.handle('gcal:delete-event', async (_e, eventId, calRef) => {
  if (!eventId) return false;
  try { await calendars.deleteEvent(calRef || 'g-legacy|primary', eventId); } catch (e) {}
  return true;
});

/* ---------- lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another copy is already running (e.g. launched at login) — hand over and exit.
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    store.sealPlainSecrets(); // secrets still in config.json as plain text get encrypted
    // Setting up another computer: drop seed-config.json (sync links, runner off) into its user-data
    // folder (%APPDATA%/tasks) before first launch. It fills in a fresh install that has no sync yet, so
    // every list shows up without setup; it never overrides. It is never bundled into the installer —
    // the sync keys in it are the password to the lists.
    try {
      const seed = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'seed-config.json'), 'utf8'));
      const cfg = readConfig();
      if (!cfg.sync && seed.sync) writeConfig(Object.assign({}, seed, cfg));
    } catch (e) {}
    // calendar accounts; the app's own sign-in clients come with the build (oauth-clients.json, not in git)
    let oauthClients = {};
    try { oauthClients = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth-clients.json'), 'utf8')); } catch (e) {}
    calendars.init({ readConfig, writeConfig, openExternal: (u) => shell.openExternal(u), clients: () => oauthClients });
    // Register "open at login" once on first run of the installed app.
    // After that, the tray checkbox is the source of truth.
    if (app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')) {
      const cfg = readConfig();
      if (!cfg.loginInit) {
        app.setLoginItemSettings({ openAtLogin: true });
        cfg.loginInit = true;
        writeConfig(cfg);
      }
    }

    win.createWindow();
    trayMod.createTray();
    refreshTrayStatus();
    setInterval(() => refreshTrayStatus(), 60 * 60 * 1000);
    // tasks left waiting while the app was closed get picked up shortly after start
    const savedHold = (readConfig().agentRunner || {}).blockedUntil;
    if (savedHold && savedHold > Date.now()) { holdForUsage(queuedAgentTasks().map((t) => t.id), savedHold - 60 * 1000); }
    setTimeout(() => scheduleAgentRun(), 15 * 1000);
    // his routing rules (edited in Settings, synced): load now, refresh now and then
    loadRouting().then(() => { scheduleAgentRun(); scheduleLocalRun(); askForRoutes(); });
    setInterval(() => loadRouting(), 5 * 60 * 1000);
    setTimeout(() => scheduleLocalRun(), 20 * 1000);
    // weekly memory tidy: looked at a few minutes after start and every 6 hours; it runs only when due and idle
    setTimeout(() => maybeTidyMemory().catch(() => {}), 5 * 60 * 1000);
    setInterval(() => maybeTidyMemory().catch(() => {}), 6 * 60 * 60 * 1000);

    // Bring the window back whenever the screen turns on.
    powerMonitor.on('resume', () => { refreshTrayStatus(); showWindow(); });
    if (process.platform === 'win32') {
      powerMonitor.on('unlock-screen', showWindow);
    }

    app.on('activate', showWindow); // macOS dock click
  });

  app.on('before-quit', () => win.setQuitting());

  // Window closed -> keep running in the tray (don't quit).
  app.on('window-all-closed', () => {});
}
