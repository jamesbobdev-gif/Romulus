/* The screen helper: a small window that floats over everything, opened with a shortcut (Ctrl+Shift+Space or the next free one,
   or the tray). Opening it takes a picture of the screen the mouse is on; he asks about it and the first AI
   that can read it answers (agent/overlay-ask.js), or Lupa when he picks it, so the picture stays home.
   - Finance on screen: no picture at all (the window would also show black, but on Linux it wouldn't).
   - By default the helper itself is left out of screenshots and screen sharing, like Finance; he can turn that off.
   - Its page (renderer/overlay.html) gets its own few IPC calls on its own webContents, nothing of the app's. */
const { BrowserWindow, desktopCapturer, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const win = require('./window');
const ai = require('../agent/ai-connections');
const overlayAsk = require('../agent/overlay-ask');
const providers = require('../agent/providers');
const { claudeExe, claudeEnv } = require('../agent/platform');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'renderer', 'overlay.html');
// the first of these no other app holds (Wispr Flow, ChatGPT… take some), unless he set his own in config
const SHORTCUTS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+Enter'];
const SHOT_W = 1920; // wide enough to read code and small print, small enough to send quickly

let ctx = null; // { readConfig, writeConfig, agentLog, userData }
let overlay = null, shot = null, shotNote = '', asking = false, shortcut = null; // shortcut: the one registered
function init(c) { ctx = c; }

// config.json → overlay: {lane: 'cloud'|'local', hidden: true (left out of captures), shortcut}
function prefs() {
  const o = ctx.readConfig().overlay || {};
  return { lane: o.lane === 'local' ? 'local' : 'cloud', hidden: o.hidden !== false, shortcut: o.shortcut ? String(o.shortcut) : null };
}
function localModel() {
  const c = ctx.readConfig().localModel || {};
  return c.url && c.model && c.enabled !== false ? { url: String(c.url).replace(/\/+$/, ''), model: String(c.model) } : null;
}

// a picture of the screen the mouse is on → {image} or {note} saying why there's none
async function capture() {
  if (win.financeShowing()) return { note: 'Finance is open, so I didn’t look at your screen.' };
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const w = Math.round(d.size.width * d.scaleFactor), h = Math.round(d.size.height * d.scaleFactor), k = Math.min(1, SHOT_W / w);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) } });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return { note: 'I couldn’t take a picture of your screen.' };
    return { image: { mime: 'image/jpeg', b64: src.thumbnail.toJPEG(80).toString('base64') } };
  } catch (e) {
    ctx.agentLog('screen helper: capture failed: ' + (e && e.message || e));
    return { note: 'I couldn’t take a picture of your screen.' };
  }
}

function state() {
  const p = prefs();
  return { shot: shot ? 'data:' + shot.mime + ';base64,' + shot.b64 : null, shotNote, lane: p.lane, hidden: p.hidden,
    shortcut: shortcutLabel(),
    cloud: ai.cloudOrder().length > 0, local: !!localModel() };
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 560, height: 460, minWidth: 380, minHeight: 240, show: false, frame: false, resizable: true,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, maximizable: false, minimizable: false,
    title: 'Romulus screen helper', backgroundColor: '#1B1B1F', icon: win.ICON,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  try { overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  // it only ever shows its own page; links go to the real browser
  const wc = overlay.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // its calls answer its own page in its top frame only
  const own = (e) => !!(e.senderFrame && !e.senderFrame.parent && e.senderFrame.url && path.normalize(require('url').fileURLToPath(e.senderFrame.url)).toLowerCase() === PAGE.toLowerCase());
  const handle = (ch, fn) => wc.ipc.handle(ch, (e, ...a) => { if (!own(e)) throw new Error('Blocked: untrusted sender'); return fn(...a); });
  handle('overlay:state', () => state());
  handle('overlay:retake', () => retake());
  handle('overlay:ask', (q) => askNow(q));
  handle('overlay:set', (change) => setPrefs(change));
  handle('overlay:close', () => hide());
  handle('overlay:open-app', () => { hide(); win.showWindow(); });
  overlay.on('close', (e) => { e.preventDefault(); hide(); }); // Alt+F4 hides it; the app keeps it for next time
  overlay.loadFile(PAGE).catch((e) => ctx.agentLog('screen helper: page failed to load: ' + e.message));
  applyHidden();
}
function applyHidden() { if (overlay && !overlay.isDestroyed()) { try { overlay.setContentProtection(prefs().hidden); } catch (e) {} } }

// top middle of the screen the mouse is on
function place() {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, [w] = overlay.getSize();
  overlay.setPosition(Math.round(a.x + (a.width - w) / 2), Math.round(a.y + 24));
}

async function open() {
  if (!overlay || overlay.isDestroyed()) createOverlay();
  const r = await capture(); // taken while the helper is hidden, so it isn't in the picture
  shot = r.image || null; shotNote = r.note || '';
  place();
  overlay.show(); overlay.focus();
  overlay.webContents.send('overlay:opened', state());
}
function hide() { if (overlay && !overlay.isDestroyed()) overlay.hide(); }
function toggle() { if (overlay && !overlay.isDestroyed() && overlay.isVisible()) hide(); else open().catch((e) => ctx.agentLog('screen helper: ' + e.message)); }

async function retake() {
  const wasShown = overlay.isVisible();
  overlay.hide();
  await new Promise((r) => setTimeout(r, 250)); // the window's gone from the screen before the picture
  const r = await capture();
  shot = r.image || null; shotNote = r.note || '';
  if (wasShown) { overlay.show(); overlay.focus(); }
  return state();
}

function setPrefs(change) {
  const c = ctx.readConfig(), o = Object.assign({}, c.overlay);
  if (change && (change.lane === 'cloud' || change.lane === 'local')) o.lane = change.lane;
  if (change && typeof change.hidden === 'boolean') o.hidden = change.hidden;
  c.overlay = o; ctx.writeConfig(c);
  applyHidden();
  return state();
}

// {question, withShot, history} → {text, via} or {why}
async function askNow(q) {
  if (asking) return { why: 'Still answering the last one.' };
  q = q || {};
  // Finance may have opened since the picture was taken: it doesn't go anywhere then
  const image = q.withShot && shot && !win.financeShowing() ? shot : null;
  const cfg = ctx.readConfig(), p = prefs();
  asking = true;
  try {
    const r = await overlayAsk.ask(cfg, { question: String(q.question || '').slice(0, 4000), image, history: q.history, lane: p.lane }, {
      fetch, order: ai.cloudOrder(), local: localModel(),
      notReady: providers.settings(cfg).order.filter((o) => o.on && !ai.cloudReady(o.id)).map((o) => o.id),
      claudeCli: overlayAsk.claudeCliRunner({ spawn, exe: claudeExe(cfg), env: claudeEnv(cfg), dir: path.join(ctx.userData(), 'screen-helper'), model: (cfg.ai || {}).claudeModel }),
    });
    ctx.agentLog('screen helper: ' + (r.text ? 'answered by ' + r.via + (image ? ' (with the screen)' : '') : r.why));
    return r;
  } finally { asking = false; }
}

const shortcutLabel = () => shortcut ? shortcut.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl') : 'no shortcut: open it from the tray';
function start() {
  const own = prefs().shortcut, tries = own ? [own] : SHORTCUTS;
  shortcut = tries.find((key) => { try { return globalShortcut.register(key, toggle); } catch (e) { return false; } }) || null;
  ctx.agentLog('screen helper: ' + (shortcut ? 'opens with ' + shortcutLabel() : tries.join(', ') + ' are all taken by other apps; open it from the tray'));
}
function stop() { try { globalShortcut.unregisterAll(); } catch (e) {} if (overlay && !overlay.isDestroyed()) overlay.destroy(); }

/* a picture he picked (an EBT receipt for main/finance.js finance:ebtReceipt) and one question about it: Lupa first
   when it's set up, so the picture stays home, then his cloud AIs in his order. → {text, via} or {why} */
async function readPicture(question, image) {
  const cfg = ctx.readConfig(), local = localModel();
  const deps = {
    fetch, order: ai.cloudOrder(), local,
    notReady: providers.settings(cfg).order.filter((o) => o.on && !ai.cloudReady(o.id)).map((o) => o.id),
    claudeCli: overlayAsk.claudeCliRunner({ spawn, exe: claudeExe(cfg), env: claudeEnv(cfg), dir: path.join(ctx.userData(), 'screen-helper'), model: (cfg.ai || {}).claudeModel }),
  };
  let r = local ? await overlayAsk.ask(cfg, { question, image, lane: 'local' }, deps) : null;
  if (!r || !r.text) r = await overlayAsk.ask(cfg, { question, image, lane: 'cloud' }, deps);
  return r;
}

module.exports = { init, start, stop, toggle, shortcutLabel, readPicture };
