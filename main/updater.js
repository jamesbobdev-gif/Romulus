/* Updates for the installed app. New versions come from the public releases repo on GitHub
   (jamesbobdev-gif/romulus-releases, see "publish" in package.json; `npm run release` puts them there).
   By default the app asks first: when a new version is out, the window shows "Romulus 1.0.9 is out" with
   Update / Not now (renderer/js/update-desktop.js) and the tray menu offers it too. Update downloads it,
   then the window offers "Restart now". Not now skips that version until the next one comes out.
   Settings → Updates can switch to "Automatically": the old way, downloading quietly in the background.
   Either way, a downloaded version installs on the next quit, or once the computer has sat idle a while
   and no agent work is running (the app lives in the tray and is rarely quit), or right away from
   "Restart now" / the tray's "Restart to update".
   Runs on Windows, Linux (AppImage) and macOS alike. On a Mac the update only installs once the app is
   code-signed (the release workflow builds it unsigned until an Apple certificate is added); until then
   the check fails quietly and is logged. The phone updates itself through mobile/update-phone.js. */

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 10 * 60 * 1000;
const IDLE_ENOUGH_SEC = 15 * 60;

let ctx = null; // { isPackaged, agentLog, powerMonitor, busy, onUpdate, sendToWindow, readConfig, writeConfig }
function init(c) { ctx = c; }

let offered = null; // a version that's out and waiting for his yes
let downloading = null; // the version downloading now
let ready = null; // the version waiting to install

// install only when nobody is using the computer and the agent isn't mid-task
function shouldInstallNow({ idleSec, busy }) {
  return idleSec >= IDLE_ENOUGH_SEC && !busy;
}

// 'ask' (the default) or 'auto'
function mode(cfg) { return cfg && cfg.updates === 'auto' ? 'auto' : 'ask'; }

// what to do with a version that just turned up: download it, offer it, or nothing (he said Not now to it)
function onAvailable(version, cfg) {
  if (mode(cfg) === 'auto') return 'download';
  return cfg && cfg.updateSkip === version ? 'skip' : 'offer';
}

// what the window shows: { state: 'none' | 'offered' | 'downloading' | 'ready', version, percent? }
let percent = 0;
function state() {
  if (ready) return { state: 'ready', version: ready };
  if (downloading) return { state: 'downloading', version: downloading, percent };
  if (offered) return { state: 'offered', version: offered };
  return { state: 'none' };
}
function tell() {
  ctx.sendToWindow('update:state', state());
  ctx.onUpdate(ready ? { label: 'Restart to update (' + ready + ')', click: installNow }
    : offered && !downloading ? { label: 'Update to ' + offered + '…', click: accept }
    : null);
}

function updater() { return require('electron-updater').autoUpdater; }

function start() {
  if (!ctx.isPackaged) return; // dev runs update by hand
  const autoUpdater = updater();
  autoUpdater.autoDownload = false; // downloads after his yes, or right away in automatic mode
  autoUpdater.autoInstallOnAppQuit = true; // only matters once something has downloaded
  autoUpdater.logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }; // errors arrive once, below
  autoUpdater.on('update-available', (info) => {
    if (ready || downloading) return;
    const what = onAvailable(info.version, ctx.readConfig());
    if (what === 'skip') return;
    if (what === 'download') { download(info.version); return; }
    if (offered === info.version) return;
    offered = info.version;
    ctx.agentLog('update: ' + info.version + ' is out; asking');
    tell();
  });
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round((p && p.percent) || 0);
    if (pct === percent) return;
    percent = pct;
    ctx.sendToWindow('update:state', state());
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (ready) return;
    ready = info.version;
    downloading = null; offered = null;
    ctx.agentLog('update: ' + info.version + ' ready; installs on quit or when the computer is idle');
    tell();
    setInterval(() => {
      if (shouldInstallNow({ idleSec: ctx.powerMonitor.getSystemIdleTime(), busy: ctx.busy() })) installNow();
    }, IDLE_CHECK_MS);
  });
  autoUpdater.on('error', (e) => {
    ctx.agentLog('update: ' + (e && e.message || e));
    if (downloading) { offered = downloading; downloading = null; tell(); } // the download broke: offer it again
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // offline: try again next time
  setTimeout(check, 60 * 1000);
  setInterval(check, CHECK_EVERY_MS);
}

function download(version) {
  downloading = version; percent = 0;
  ctx.agentLog('update: downloading ' + version);
  tell();
  updater().downloadUpdate().catch(() => {}); // a failure arrives on 'error'
}

// he said Update
function accept() {
  if (!offered || downloading || ready) return state();
  download(offered);
  return state();
}

// he said Not now: that version isn't offered again; the next one is
function skip() {
  if (!offered) return state();
  const cfg = ctx.readConfig();
  cfg.updateSkip = offered;
  ctx.writeConfig(cfg);
  ctx.agentLog('update: skipping ' + offered);
  offered = null;
  tell();
  return state();
}

function installNow() {
  if (!ready) return;
  ctx.agentLog('update: installing ' + ready);
  // silent install, then the new version opens on its own
  updater().quitAndInstall(true, true);
}

const handlers = {
  'update:state': () => state(),
  'update:accept': () => accept(),
  'update:skip': () => skip(),
  'update:install': () => { installNow(); return state(); },
  'update:get-mode': () => mode(ctx.readConfig()),
  'update:set-mode': (_e, m) => {
    const cfg = ctx.readConfig();
    cfg.updates = m === 'auto' ? 'auto' : 'ask';
    ctx.writeConfig(cfg);
    if (cfg.updates === 'auto' && offered && !downloading && !ready) download(offered); // the one he was asked about goes ahead
    return cfg.updates;
  },
};

module.exports = { init, start, installNow, shouldInstallNow, mode, onAvailable, handlers };
