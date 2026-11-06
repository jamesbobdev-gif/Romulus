/* The app's one window: what it may show, the IPC guard that only answers the app's own page, and
   hiding to the tray instead of closing. This module is Electron by nature; the rest of main/ talks
   to the window through sendToRenderer / showWindow handed out in main.js. */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let isQuitting = false;
let onHidden = null; // runs once the window has hidden to the tray (main.js hands in the tray's first-time notice)

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const APP_PAGE = path.join(ROOT, 'renderer', 'index.html');
const LINUX = process.platform === 'linux';
// Windows and Linux: no system title bar (a strip in the system's colors above the app's own header);
// Electron draws the window buttons top-right instead, in the page's colors. Mac keeps its own.
const OWN_TITLE_BAR = LINUX || process.platform === 'win32';
const TITLE_H = 32; // the hidden title bar's strip: window buttons on the right, drag area across
// Opened for a look on a computer where a background service normally runs the app (the mini PC's app-menu
// launcher pauses the service and passes this): closing the window quits, so the service can come back.
// GNOME shows no tray, so a copy that hid itself there could never be quit.
const QUIT_ON_CLOSE = process.argv.includes('--quit-on-close');

// True only for the app's own bundled page — never a website the window was
// somehow pointed at.
function isAppPage(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol !== 'file:') return false;
    return path.normalize(require('url').fileURLToPath(parsed)).toLowerCase() === path.normalize(APP_PAGE).toLowerCase();
  } catch (e) { return false; }
}

// Every desktop function (tasks, mail, calendars…) is an IPC
// handler. Only answer calls coming from the app's own page in its top frame,
// so a stray page or iframe can never reach them.
function trustedSender(event) {
  const f = event && event.senderFrame;
  return !!(f && !f.parent && isAppPage(f.url));
}
function guardIpc(ipcMain) {
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => rawHandle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Blocked: untrusted sender');
    return fn(event, ...args);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    title: 'Romulus',
    icon: ICON,
    backgroundColor: '#FBFBFA',
    autoHideMenuBar: true,
    ...(OWN_TITLE_BAR ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#FBFBFA', symbolColor: '#71716C', height: TITLE_H } } : {}),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // The window only ever shows the app itself: no navigating away, no pop-ups.
  // Web links go to the real browser instead.
  const toBrowser = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {}); };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { toBrowser(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isAppPage(url)) return;
    e.preventDefault();
    toBrowser(url);
  });
  mainWindow.webContents.on('will-redirect', (e, url) => { if (!isAppPage(url)) e.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  const loadApp = () => mainWindow.loadFile(APP_PAGE);
  // A failed load (e.g. antivirus briefly locking the asar at login) otherwise
  // leaves a blank window forever — retry until it sticks.
  loadApp().catch(() => setTimeout(loadApp, 1500));
  mainWindow.webContents.on('did-fail-load', () => setTimeout(loadApp, 1500));
  // a fresh page starts off Finance: drop the capture block it may have left (it sets it again if it opens there)
  mainWindow.webContents.on('did-start-loading', () => protect(false));
  if (OWN_TITLE_BAR) mainWindow.webContents.on('did-finish-load', titleBarFollowsPage);

  // Closing the window hides it to the tray; the app keeps running
  // so it can reappear when the screen wakes. Quit from the tray menu.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    if (QUIT_ON_CLOSE) { quit(); return; }
    e.preventDefault();
    mainWindow.hide();
    if (onHidden) onHidden();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Without a system title bar: the top strip of the page drags the window, and the window buttons take
// the page's background and muted ink, again whenever light/dark or a custom theme changes them.
// The page answers once straight away, then each time its colors change (a waiting promise, so
// nothing in the page or preload has to know about it).
const TITLE_COLORS = `new Promise((done) => {
  const read = () => { const s = getComputedStyle(document.documentElement);
    return { color: s.getPropertyValue('--bg').trim(), symbolColor: s.getPropertyValue('--muted').trim() }; };
  if (!document.getElementById('winDrag')) {
    const d = document.createElement('div'); d.id = 'winDrag'; document.body.prepend(d);
    return done(read());
  }
  const was = JSON.stringify(read());
  const mo = new MutationObserver(() => check()), mq = matchMedia('(prefers-color-scheme: dark)');
  const check = () => { const now = read(); if (JSON.stringify(now) === was) return;
    mo.disconnect(); mq.removeEventListener('change', check); done(now); };
  mo.observe(document.documentElement, { attributes: true });
  mo.observe(document.head, { childList: true, subtree: true, characterData: true });
  mq.addEventListener('change', check);
})`;
let titleRun = 0;
function titleBarFollowsPage() {
  const wc = mainWindow.webContents, run = ++titleRun;
  // the strip can't be clicked through, and the window buttons sit on its right: pop-ups that reach the top start below it
  wc.insertCSS(`#winDrag{position:fixed;top:0;left:0;right:0;height:${TITLE_H}px;-webkit-app-region:drag}
    .lb-close{top:${TITLE_H + 14}px} .live-view{top:${TITLE_H + 8}px} .swipe{padding-top:${TITLE_H + 10}px}`).catch(() => {});
  const follow = () => wc.executeJavaScript(TITLE_COLORS).then((c) => {
    if (run !== titleRun || !mainWindow || mainWindow.isDestroyed()) return;
    if (c && c.color && c.symbolColor) { try { mainWindow.setTitleBarOverlay({ ...c, height: TITLE_H }); } catch (e) {} }
    follow();
  }).catch(() => {});
  follow();
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendToRenderer(ch, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
}

// a hidden, sandboxed window for reading pages behind a bot check (link preview pictures)
function newHiddenWindow(opts) { return new BrowserWindow(opts); }

// the page loads again (settings arrived from elsewhere)
function reloadWindow() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); }

// what to do once the window has hidden to the tray
function onHiddenToTray(fn) { onHidden = fn; }

function quit() { isQuitting = true; app.quit(); }
function setQuitting() { isQuitting = true; }

// while Finance is on screen: Windows leaves the window out of every capture (screenshots, screen sharing,
// Recall / Copilot, an AI assistant's screenshot tools); it shows as black there
let protectedNow = false;
function protect(on) {
  protectedNow = !!on;
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.setContentProtection(!!on); } catch (e) {} }
}
// Finance is on screen right now (protected, and the window can be seen): the screen helper won't take a picture
function financeShowing() {
  return protectedNow && !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
}
// the main window's handle as a number (Windows Hello attaches its prompt to it), or null
function windowHandle() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const b = mainWindow.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

module.exports = { ICON, guardIpc, createWindow, showWindow, sendToRenderer, newHiddenWindow, reloadWindow, onHiddenToTray, quit, setQuitting, windowHandle, protect, financeShowing };
