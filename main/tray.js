/* The tray icon: its menu, a tooltip with overdue / due-today counts, and on Windows a one-time notice
   saying where the icon went. */
const fs = require('fs');

let ctx = null; // { dataFile, readConfig, writeConfig, showWindow, quit, agentLog, icon }
function init(c) { ctx = c; }

let tray = null;

let update = null; // { label, click }: a new version to update to or restart into (main/updater.js)

function createTray() {
  const { Tray, nativeImage } = require('electron');
  const icon = nativeImage.createFromPath(ctx.icon).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Romulus');
  buildMenu();
  tray.on('click', ctx.showWindow);
  tray.on('balloon-click', ctx.showWindow); // the first-time notice (hiddenToTray) opens the window when clicked
}

function buildMenu() {
  const { app, Menu } = require('electron');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tasks', click: ctx.showWindow },
    ...(ctx.openOverlay ? [{ label: 'Ask about my screen', click: ctx.openOverlay }] : []),
    ...(update ? [{ label: update.label, click: update.click }] : []),
    {
      label: 'Start when I log in',
      type: 'checkbox',
      checked: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
      enabled: app.isPackaged && process.platform !== 'linux',
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Quit Tasks', click: () => ctx.quit() }
  ]));
}

// Settings' setup list: whether the app starts at login (the tray checkbox shows the same thing)
const handlers = {
  'app:login-get': () => { const { app } = require('electron'); return { can: app.isPackaged && process.platform !== 'linux', on: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false }; },
  'app:login-set': (_e, on) => { const { app } = require('electron'); if (!app.isPackaged || process.platform === 'linux') return { ok: false }; app.setLoginItemSettings({ openAtLogin: !!on }); if (tray) buildMenu(); return { ok: true }; }
};

function setUpdate(u) {
  update = u;
  if (tray) buildMenu();
}

// "Romulus — 3 overdue · 1 due today" for these tasks, counted from `today`
function trayTip(tasks, today = new Date()) {
  today = new Date(today); today.setHours(0, 0, 0, 0);
  let overdue = 0, dueToday = 0;
  for (const t of tasks) {
    if (t.done || !t.due || t.ws === 'agent') continue; // agent tasks are Claude's, not yours
    const [y, m, d] = t.due.split('-').map(Number);
    const diff = Math.round((new Date(y, m - 1, d) - today) / 864e5);
    if (diff < 0) overdue++;
    else if (diff === 0) dueToday++;
  }
  const parts = [];
  if (overdue) parts.push(overdue + ' overdue');
  if (dueToday) parts.push(dueToday + ' due today');
  return parts.length ? 'Romulus — ' + parts.join(' · ') : 'Romulus';
}

function refreshTrayStatus(raw) {
  if (!tray) return;
  let data;
  try {
    data = raw != null ? JSON.parse(raw) : JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8'));
  } catch (e) { return; }
  tray.setToolTip(trayTip(Array.isArray(data.tasks) ? data.tasks : []));
}

// Windows keeps a new app's tray icon out of sight, in the overflow behind the ^ by the clock, until its owner
// drags it onto the taskbar. So the first time the window hides there, a notice says where it went and how to
// keep it in sight: once per computer (config.json). macOS shows every menu-bar icon and on Linux the desktop
// decides, so it is Windows only.
function hintDue(cfg, platform = process.platform) {
  return platform === 'win32' && !(cfg && cfg.trayHintShown);
}
function hiddenToTray() {
  if (!tray) return;
  const cfg = ctx.readConfig();
  if (!hintDue(cfg)) return;
  cfg.trayHintShown = true;
  ctx.writeConfig(cfg);
  const { nativeImage } = require('electron');
  try {
    tray.displayBalloon({
      iconType: 'custom', icon: nativeImage.createFromPath(ctx.icon),
      title: 'Romulus is still running',
      content: 'It is under the ^ by the clock. Drag the coin onto the taskbar to keep it in sight; right-click it to quit.'
    });
  } catch (e) {}
}

module.exports = { init, handlers, createTray, refreshTrayStatus, trayTip, setUpdate, hintDue, hiddenToTray };
