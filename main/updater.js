/* Updates for the installed app. New versions come from the public releases repo on GitHub
   (jamesbobdev-gif/romulus-releases, see "publish" in package.json; `npm run release` puts them there).
   By default the app asks first: when a new version is out, the window shows "Romulus 1.0.9 is out" with
   Update / Not now (renderer/js/update-desktop.js) and the tray menu offers it too. Update downloads it,
   then the window offers "Restart now". Not now skips that version until the next one comes out.
   The answer is shared through sync (renderer/js/update-sync.js): Update on one device updates the others
   without asking (they download it and install on quit or when idle), and Not now holds for all of them.
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

// 1.0.10 is newer than 1.0.9 (the same as renderer/js/update-sync.js)
function versionNewer(candidate, current) {
  const a = String(candidate || '').replace(/^v/i, '').split('.').map(Number);
  const b = String(current || '').replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (isNaN(x) || isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

// what to do with a version that just turned up: download it (automatic, or he said Update to it here or on
// another device), offer it, or nothing (he said Not now to it)
function onAvailable(version, cfg) {
  if (mode(cfg) === 'auto') return 'download';
  if (cfg && cfg.updateYes && !versionNewer(version, cfg.updateYes)) return 'download';
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
  started = true;
  setTimeout(checkNow, 60 * 1000);
  setInterval(checkNow, CHECK_EVERY_MS);
}

let started = false;
// early access (the $5 plan, Settings → Device sync): versions published as pre-releases are offered too
function earlyAccess(cfg) { return !!(cfg && cfg.earlyAccess); }
function checkNow() {
  if (!started) return;
  const u = updater();
  u.allowPrerelease = earlyAccess(ctx.readConfig());
  u.checkForUpdates().catch(() => {}); // offline: try again next time
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
  const cfg = ctx.readConfig();
  if (!cfg.updateYes || versionNewer(offered, cfg.updateYes)) { cfg.updateYes = offered; ctx.writeConfig(cfg); }
  download(offered);
  return state();
}

// the answer he gave on any device, from sync ({ yes, no }: renderer/js/update-sync.js)
function shared(doc) {
  if (!doc) return state();
  const cfg = ctx.readConfig();
  let changed = false;
  if (doc.yes && (!cfg.updateYes || versionNewer(doc.yes, cfg.updateYes))) { cfg.updateYes = String(doc.yes); changed = true; }
  if (doc.no && doc.no !== cfg.updateSkip) { cfg.updateSkip = String(doc.no); changed = true; }
  if (changed) ctx.writeConfig(cfg);
  if (offered && !downloading && !ready) {
    const what = onAvailable(offered, cfg);
    if (what === 'download') { ctx.agentLog('update: ' + offered + ' approved on another device'); download(offered); }
    else if (what === 'skip') { offered = null; tell(); }
  } else if (!offered && !downloading && !ready && cfg.updateYes && versionNewer(cfg.updateYes, ctx.version)) {
    checkNow(); // a newer version he said yes to that this computer hasn't seen yet: look now, not in 4 hours
  }
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
  'update:shared': (_e, doc) => shared(doc && typeof doc === 'object' ? { yes: doc.yes, no: doc.no } : null),
  'update:install': () => { installNow(); return state(); },
  'update:get-mode': () => mode(ctx.readConfig()),
  'update:get-early': () => earlyAccess(ctx.readConfig()),
  'update:set-early': (_e, on) => {
    const cfg = ctx.readConfig();
    cfg.earlyAccess = !!on;
    ctx.writeConfig(cfg);
    checkNow(); // look now, so a pre-release that's out shows up without waiting 4 hours
    return cfg.earlyAccess;
  },
  'update:set-mode': (_e, m) => {
    const cfg = ctx.readConfig();
    cfg.updates = m === 'auto' ? 'auto' : 'ask';
    ctx.writeConfig(cfg);
    if (cfg.updates === 'auto' && offered && !downloading && !ready) download(offered); // the one he was asked about goes ahead
    return cfg.updates;
  },
};

module.exports = { init, start, installNow, shouldInstallNow, mode, onAvailable, versionNewer, shared, handlers };
