/* Tasks: the Electron main process. This file only wires the pieces together:
   main/   the window, tray, persistence, calendars, mail and other desktop plumbing
   agent/  the Agent tab: routing, the Claude runner, the mini PC (local) lane, and their helpers
   Each module gets what it shares with the others (config, the log, the window…) through init(ctx)
   and lists its IPC calls in `handlers`, which are registered here behind the trusted-page guard. */
const { app, ipcMain, powerMonitor, powerSaveBlocker, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const calendars = require('./agent/calendars');
const store = require('./main/store');
const win = require('./main/window');
const trayMod = require('./main/tray');
const rsiWiring = require('./main/rsi');
const speak = require('./main/speak');
const feeds = require('./main/feeds');
const persistence = require('./main/persistence');
const gcalSync = require('./main/gcal-sync');
const buyEmails = require('./main/buy-emails');
const deviceSync = require('./main/device-sync');
const calendarAccounts = require('./main/calendar-accounts');
const gmailDates = require('./main/gmail-dates');
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

// Match the installer's shortcut ID so Windows shows our icon on the taskbar
if (process.platform === 'win32') app.setAppUserModelId('com.jartro.tasks');

win.guardIpc(ipcMain);
store.init({ userData: () => app.getPath('userData'), safeStorage });
const { readConfig, writeConfig } = store;
const { showWindow } = win;
const { refreshTrayStatus } = trayMod;

// what the main-process modules share: handed to each one's init()
const ctx = {
  userData: () => app.getPath('userData'),
  documents: () => app.getPath('documents'),
  isPackaged: app.isPackaged,
  dataFile: store.dataFile, readConfig, writeConfig, agentLog: store.agentLog,
  sendToRenderer: win.sendToRenderer, showWindow, newHiddenWindow: win.newHiddenWindow, applyRsiChange: win.applyRsiChange,
  quit: win.quit, icon: win.ICON, rsiUndo: () => rsiWiring.rsi.undo(), refreshTrayStatus,
  openExternal: (u) => shell.openExternal(u),
  powerSaveBlocker, powerMonitor,
  scheduleAgentRun: (raw) => runner.scheduleAgentRun(raw),
  scheduleLocalRun: (raw) => localLane.scheduleLocalRun(raw),
  memoryTidying: () => memoryTidy.isTidying(),
  compactHowtos: (asked) => localLane.compactHowtos(asked),
};
const modules = [trayMod, rsiWiring, speak, feeds, persistence, gcalSync, buyEmails, deviceSync, calendarAccounts, gmailDates,
  usage, routingMod, ai, agentBrowser, taskContext, qwenBrowser, previews, runner, memoryTidy, localTools, localLane];
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
