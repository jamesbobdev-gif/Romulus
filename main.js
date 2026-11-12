/* Tasks: the Electron main process. This file only wires the pieces together:
   main/   the window, tray, persistence, calendars, mail and other desktop plumbing
   agent/  the Agent tab: routing, the Claude runner, the mini PC (local) lane, and their helpers
   Each module gets what it shares with the others (config, the log, the window…) through init(ctx)
   and lists its IPC calls in `handlers`, which are registered here behind the trusted-page guard. */
const { app, ipcMain, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const calendars = require('./agent/calendars');
const store = require('./main/store');
const win = require('./main/window');
const trayMod = require('./main/tray');
const speak = require('./main/speak');
const buyEmails = require('./main/buy-emails');
const feeds = require('./main/feeds');
const persistence = require('./main/persistence');
const gcalSync = require('./main/gcal-sync');
const deviceSync = require('./main/device-sync');
const calendarAccounts = require('./main/calendar-accounts');
const gmailDates = require('./main/gmail-dates');
const lookAheadMod = require('./main/look-ahead');
const triggersMod = require('./main/triggers');
const agentLogMod = require('./main/agent-log');
const usage = require('./agent/usage-limit');
const routingMod = require('./agent/routing');
const ai = require('./agent/ai-connections');
const agentBrowser = require('./agent/agent-browser');
const linkWallet = require('./agent/link-wallet');
const taskContext = require('./agent/task-context');
const qwenBrowser = require('./agent/qwen-browser');
const previews = require('./agent/previews');
const runner = require('./agent/runner');
const memoryTidy = require('./agent/memory-tidy');
const localTools = require('./agent/local-tools');
const localLane = require('./agent/local-lane');
const ollamaSetup = require('./agent/ollama-setup'); // Settings → Local model → Set it up for me
const liveView = require('./agent/live-view');
const finance = require('./main/finance');
const downloads = require('./main/downloads');
const updater = require('./main/updater');
const overlay = require('./main/overlay');

// Match the installer's shortcut ID so Windows shows our icon on the taskbar
if (process.platform === 'win32') app.setAppUserModelId('com.jartro.tasks');

// The app used to be called Tasks: bring an existing user-data folder over to Romulus's (main/migrate-data.js)
try { require('./main/migrate-data').migrateUserData(path.join(app.getPath('appData'), 'Tasks'), app.getPath('userData')); } catch (e) { console.error('user-data migration failed', e); }

win.guardIpc(ipcMain);
store.init({ userData: () => app.getPath('userData'), safeStorage });
const { readConfig, writeConfig, agentLog } = store;
const { showWindow } = win;
const { refreshTrayStatus } = trayMod;

// what the main-process modules share: handed to each one's init()
const ctx = {
  userData: () => app.getPath('userData'),
  documents: () => app.getPath('documents'),
  isPackaged: app.isPackaged,
  dataFile: store.dataFile, readConfig, writeConfig, agentLog: store.agentLog,
  sendToRenderer: win.sendToRenderer, showWindow, newHiddenWindow: win.newHiddenWindow,
  reloadWindow: win.reloadWindow, version: app.getVersion(),
  quit: win.quit, icon: win.ICON, refreshTrayStatus,
  openExternal: (u) => shell.openExternal(u),
  powerSaveBlocker, powerMonitor,
  scheduleAgentRun: (raw) => runner.scheduleAgentRun(raw),
  scheduleLocalRun: (raw) => localLane.scheduleLocalRun(raw),
  memoryTidying: () => memoryTidy.isTidying(),
  compactHowtos: (asked) => localLane.compactHowtos(asked),
  // Windows' own encryption for a whole file's text (main/finance.js wraps its vault in it)
  seal: store.sealAsync, unseal: store.openAsync,
  windowHandle: win.windowHandle, // Windows Hello's prompt opens on the Tasks window
  protectWindow: win.protect, // no screen capture while Finance is showing
  // The local model’s money questions (agent/local-lane.js): read-only, only while Finance is unlocked here
  finance: { forAgent: (a) => finance.forAgent(a), unlocked: () => finance.isUnlocked(),
    ebtNow: () => finance.ebtNow() }, // the EBT wallet's settings, for grocery runs (agent/grocery.js ebtBrief), locked or not
  readPicture: (q, image) => overlay.readPicture(q, image), // an EBT receipt photo (main/finance.js finance:ebtReceipt): Lupa first, then the cloud
  // the updater waits for these before restarting into a new version
  busy: () => runner.isBusy() || localLane.isBusy() || memoryTidy.isTidying(),
  onUpdate: (u) => trayMod.setUpdate(u),
  sendToWindow: win.sendToRenderer,
  openOverlay: () => overlay.toggle(), // the screen helper (main/overlay.js), from the tray
};
const modules = [trayMod, speak, feeds, persistence, gcalSync, buyEmails, deviceSync, calendarAccounts, gmailDates, lookAheadMod, triggersMod, agentLogMod,
  usage, routingMod, ai, agentBrowser, linkWallet, taskContext, qwenBrowser, previews, runner, memoryTidy, localTools, localLane, ollamaSetup, liveView, finance, downloads, updater, overlay];
const allHandlers = {};
for (const m of modules) {
  m.init(ctx);
  Object.assign(allHandlers, m.handlers || {});
}
for (const [channel, fn] of Object.entries(allHandlers)) ipcMain.handle(channel, fn);
// the Kitchen tab's Suggest meals (main/kitchen-ai.js)
const kitchenAi = require('./main/kitchen-ai');
kitchenAi.init(ctx);
for (const [channel, fn] of Object.entries(kitchenAi.handlers)) ipcMain.handle(channel, fn);
const { holdForUsage } = usage;
const { loadRouting, askForRoutes } = routingMod;
const { scheduleAgentRun, queuedAgentTasks } = runner;
const { scheduleLocalRun } = localLane;
let situationNow = null;
let workerWas = null; // the local model's computer as last seen from here: 'none' | 'up' | 'quiet'
async function refreshSituation() {
  const was = JSON.stringify(situationNow);
  const local = await localLane.localStatus().catch(() => ({ online: false }));
  // the local model's own computer (agent/worker.js) routes as if the cloud lane is up: his other computer runs
  // it, and the two must send the same tasks to the local model, or a task could wait for a lane nobody runs here
  const workerMod = require('./agent/worker');
  const here = workerMod.isWorker(readConfig());
  // it went quiet or came back: say so once, rather than tasks just waiting (the first look only sets where it stands)
  if (!here) {
    const n = workerMod.stateNotice(workerWas, workerMod.lastDoc());
    if (workerWas !== null && n.title && Notification.isSupported()) new Notification({ title: n.title, body: n.body }).show();
    workerWas = n.is;
  }
  // how much usage the connected cloud AIs have left (the local model's own computer doesn't run them, so never tight there)
  const room = here ? { left: null, tight: false, out: false } : ai.cloudRoomNow();
  situationNow = { localUp: !!(local.configured && local.online), cloudUp: here || ai.cloudOrder().length > 0,
    cloudTight: room.tight, cloudOut: room.out, cloudLeft: room.left == null ? null : Math.round(room.left * 100) / 100 };
  routingMod.noteSituation(situationNow);
  if (was !== JSON.stringify(situationNow)) { scheduleAgentRun(); scheduleLocalRun(); } // a waiting task may have a new home
}
const { maybeTidyMemory } = memoryTidy;

global.__agentTest = { parseUsageLimit: usage.parseUsageLimit, holdForUsage, recentReplies: memoryTidy.recentReplies, maybeTidyMemory };

/* ---------- lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another copy is already running (e.g. launched at login) — hand over and exit.
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // every secret in config.json opened (and any still in plain text encrypted) before anything reads them
    await store.load();
    // Setting up another computer: drop seed-config.json (sync links, runner off) into its user-data
    // folder (%APPDATA%/tasks) before first launch. It fills in a fresh install that has no sync yet, so
    // every list shows up without setup; it never overrides. It is never bundled into the installer —
    // the sync keys in it are the password to the lists.
    try {
      const seed = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'seed-config.json'), 'utf8'));
      const cfg = readConfig();
      if (!cfg.sync && seed.sync) writeConfig(Object.assign({}, seed, cfg));
    } catch (e) {}
    // calendar accounts; the app's own sign-in clients (oauth-clients.json, not in git) are copied into each
    // computer's user-data folder (%APPDATA%/tasks), like seed-config.json: the installer is public, so it
    // doesn't carry them. A dev run reads the project's copy.
    let oauthClients = {};
    for (const dir of [app.getPath('userData'), __dirname]) {
      try { oauthClients = JSON.parse(fs.readFileSync(path.join(dir, 'oauth-clients.json'), 'utf8')); break; } catch (e) {}
    }
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
    win.onHiddenToTray(trayMod.hiddenToTray); // Windows: the first time, a notice says the icon is under the ^ by the clock
    updater.start();
    overlay.start(); // the screen helper's shortcut (Ctrl+Shift+Space, or the next free one)
    refreshTrayStatus();
    setInterval(() => refreshTrayStatus(), 60 * 60 * 1000);
    // tasks left waiting while the app was closed get picked up shortly after start
    const savedHold = (readConfig().agentRunner || {}).blockedUntil;
    if (savedHold && savedHold > Date.now()) { holdForUsage(queuedAgentTasks().map((t) => t.id), savedHold - 60 * 1000); }
    setTimeout(() => scheduleAgentRun(), 15 * 1000);
    // his routing rules (edited in Settings, synced): load now, refresh now and then
    loadRouting().then(() => { scheduleAgentRun(); scheduleLocalRun(); askForRoutes(); });
    setInterval(() => loadRouting(), 5 * 60 * 1000);
    // what auto routing knows: is the mini PC answering, is a cloud AI connected, is Claude near its limit
    refreshSituation();
    setInterval(() => refreshSituation(), 2 * 60 * 1000);
    setTimeout(() => scheduleLocalRun(), 20 * 1000);
    // the local model's own computer says it's there, for his other devices (agent/worker.js), and what its
    // browser downloaded goes up for them (agent/worker-files.js)
    // One that doesn't go out is tried again within seconds, not at the next two-minute mark, and the log says
    // why once (and when it's back), so "it went quiet" has a reason to read afterwards.
    const workerMod = require('./agent/worker');
    let beatFails = 0, beatTimer = null;
    const beat = async () => {
      clearTimeout(beatTimer);
      if (!workerMod.isWorker(readConfig())) { beatFails = 0; beatTimer = setTimeout(beat, workerMod.BEAT_MS); return; }
      const ok = await localLane.workerBeat().catch(() => false);
      if (ok && beatFails) agentLog('worker heartbeat: back after ' + beatFails + ' missed');
      if (!ok && !beatFails) agentLog('worker heartbeat failed: ' + (workerMod.lastBeatError() || 'no reason given') + ' (trying again shortly)');
      beatFails = ok ? 0 : beatFails + 1;
      beatTimer = setTimeout(beat, workerMod.nextBeatIn(ok, beatFails));
    };
    setTimeout(beat, 5 * 1000);
    // waking from sleep: say it's there now (the local model's computer), or look for it now (the others),
    // rather than up to two minutes later
    powerMonitor.on('resume', () => { setTimeout(() => { beat(); workerMod.lookAgain(); refreshSituation(); }, 3000); });
    // weekly memory tidy: looked at a few minutes after start and every 6 hours; it runs only when due and idle
    setTimeout(() => maybeTidyMemory().catch(() => {}), 5 * 60 * 1000);
    setInterval(() => maybeTidyMemory().catch(() => {}), 6 * 60 * 60 * 1000);
    // agent photos and screenshots older than 30 days come out of the public bucket: asked once a day
    const sb = require('./agent/supabase');
    const cleanAttachments = () => sb.cleanupAttachments(sb.channel(readConfig())).then((n) => { if (n) agentLog('attachments cleanup: removed ' + n + ' old file(s)'); });
    setTimeout(cleanAttachments, 10 * 60 * 1000);
    setInterval(cleanAttachments, 24 * 60 * 60 * 1000);
    // still signed in to his school sites on the mini PC? Looked at every 30 min; it runs once a day, when the local model is idle
    setInterval(() => localLane.checkSignins().catch((e) => agentLog('sign-in check crashed: ' + (e && e.message || e))), 30 * 60 * 1000);

    // Bring the window back whenever the screen turns on.
    powerMonitor.on('resume', () => { refreshTrayStatus(); showWindow(); });
    if (process.platform === 'win32') {
      powerMonitor.on('unlock-screen', showWindow);
    }

    app.on('activate', showWindow); // macOS dock click
  });

  app.on('before-quit', () => win.setQuitting());
  app.on('will-quit', (e) => {
    overlay.stop();
    // config.json is written in the background (main/store.js): a change made just now lands before the app goes
    if (store.writing()) { e.preventDefault(); store.flush().finally(() => app.quit()); }
  });

  // Window closed -> keep running in the tray (don't quit).
  app.on('window-all-closed', () => {});
}
