/* Updates for the installed app. New versions come from the public releases repo on GitHub
   (jamesbobdev-gif/tasks-releases, see "publish" in package.json; `npm run release` puts them there).
   A new version downloads quietly in the background. Since the app lives in the tray and is rarely
   quit, it installs itself once the computer has sat idle a while and no agent work is running —
   or right away from the tray's "Restart to update". */

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 10 * 60 * 1000;
const IDLE_ENOUGH_SEC = 15 * 60;

let ctx = null; // { isPackaged, agentLog, powerMonitor, busy, onUpdateReady }
function init(c) { ctx = c; }

let ready = null; // the version waiting to install

// install only when nobody is using the computer and the agent isn't mid-task
function shouldInstallNow({ idleSec, busy }) {
  return idleSec >= IDLE_ENOUGH_SEC && !busy;
}

function start() {
  if (!ctx.isPackaged || process.platform !== 'win32') return; // dev runs and other systems update by hand
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }; // errors arrive once, below
  autoUpdater.on('update-available', (info) => ctx.agentLog('update: downloading ' + info.version));
  autoUpdater.on('update-downloaded', (info) => {
    if (ready) return;
    ready = info.version;
    ctx.agentLog('update: ' + info.version + ' ready; installs when the computer is idle');
    ctx.onUpdateReady(info.version);
    setInterval(() => {
      if (shouldInstallNow({ idleSec: ctx.powerMonitor.getSystemIdleTime(), busy: ctx.busy() })) installNow();
    }, IDLE_CHECK_MS);
  });
  autoUpdater.on('error', (e) => ctx.agentLog('update: ' + (e && e.message || e)));
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // offline: try again next time
  setTimeout(check, 60 * 1000);
  setInterval(check, CHECK_EVERY_MS);
}

function installNow() {
  if (!ready) return;
  ctx.agentLog('update: installing ' + ready);
  // silent install, then the new version opens on its own
  require('electron-updater').autoUpdater.quitAndInstall(true, true);
}

module.exports = { init, start, installNow, shouldInstallNow };
