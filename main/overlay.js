/* The screen helper: a small window that floats over everything, opened with a shortcut (Ctrl+Shift+Space or the next free one,
   or the tray). Opening it takes a picture of the screen the mouse is on; he asks about it and the first AI
   that can read it answers (agent/overlay-ask.js), or Lupa when he picks it, so the picture stays home.
   - Finance on screen: no picture at all (the window would also show black, but on Linux it wouldn't).
   - By default the helper itself is left out of screenshots and screen sharing, like Finance; he can turn that off.
   - Its page (renderer/overlay.html) gets its own few IPC calls on its own webContents, nothing of the app's.
   - "Do it" (Windows): the AI works his PC one step at a time (agent/pc-control.js picks, main/pc-input.js clicks
     and types) until it's done, asks him something, Finance comes on screen, or he presses Stop or the shortcut.
     The helper stays on top without taking focus, so its typing goes to the app underneath. */
const { BrowserWindow, desktopCapturer, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const win = require('./window');
const ai = require('../agent/ai-connections');
const overlayAsk = require('../agent/overlay-ask');
const providers = require('../agent/providers');
const pcControl = require('../agent/pc-control');
const pcInput = require('./pc-input');
const { claudeExe, claudeEnv } = require('../agent/platform');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'renderer', 'overlay.html');
// the first of these no other app holds (Wispr Flow, ChatGPT… take some), unless he set his own in config
const SHORTCUTS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+Enter'];
const SHOT_W = 1920; // wide enough to read code and small print, small enough to send quickly

let ctx = null; // { readConfig, writeConfig, agentLog, userData }
let overlay = null, shot = null, shotNote = '', asking = false, shortcut = null; // shortcut: the one registered
let doing = null; // a "Do it" run: {stop, answer(text|null) while it waits on him}
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
    shortcut: shortcutLabel(), canDo: process.platform === 'win32', doing: !!doing,
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
  handle('overlay:do', (goal) => startDo(goal));
  handle('overlay:stop', () => { stopDo(); return true; });
  handle('overlay:answer', (text) => { if (doing && doing.answer) doing.answer(text == null ? null : String(text).slice(0, 2000)); return true; });
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
function hide() { if (doing) return stopDo(); if (overlay && !overlay.isDestroyed()) overlay.hide(); } // during a run: Stop
function toggle() {
  if (doing) return stopDo(); // the shortcut stops a run
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) hide(); else open().catch((e) => ctx.agentLog('screen helper: ' + e.message));
}

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

/* ---- "Do it" ---- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function askDeps(cfg) {
  return {
    fetch, order: ai.cloudOrder(), local: localModel(),
    notReady: providers.settings(cfg).order.filter((o) => o.on && !ai.cloudReady(o.id)).map((o) => o.id),
    claudeCli: overlayAsk.claudeCliRunner({ spawn, exe: claudeExe(cfg), env: claudeEnv(cfg), dir: path.join(ctx.userData(), 'screen-helper'), model: (cfg.ai || {}).claudeModel }),
  };
}
const emit = (kind, text, via) => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:step', { kind, text, via: via || '' }); };

// a picture of display d at most maxW wide → {image, w, h} (w/h: the picture's own pixels) or {note}
async function captureDisplay(d, maxW) {
  if (win.financeShowing()) return { note: 'Finance is open, so I stopped.' };
  try {
    const pw = Math.round(d.size.width * d.scaleFactor), ph = Math.round(d.size.height * d.scaleFactor), k = Math.min(1, maxW / pw);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(pw * k), height: Math.round(ph * k) } });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || (sources.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty()) return { note: 'I couldn’t take a picture of your screen.' };
    const size = src.thumbnail.getSize();
    return { image: { mime: 'image/png', b64: src.thumbnail.toPNG().toString('base64') }, w: size.width, h: size.height };
  } catch (e) {
    ctx.agentLog('do it: capture failed: ' + (e && e.message || e));
    return { note: 'I couldn’t take a picture of your screen.' };
  }
}

// a point in the picture → {dip} (Electron's screen points, for the helper's own bounds) and {px} (physical, for the input)
function toScreen(d, size, x, y) {
  const dip = { x: d.bounds.x + (x + 0.5) * d.bounds.width / size.w, y: d.bounds.y + (y + 0.5) * d.bounds.height / size.h };
  const px = process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip;
  return { dip, px: { x: Math.round(px.x), y: Math.round(px.y) } };
}
function under(dip) {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return false;
  const b = overlay.getBounds();
  return dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height;
}

// the helper on top without focus (what it types goes to the app under it), or back to normal
async function stepAside() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setFocusable(false);
  overlay.hide(); // Windows hands focus back to the app he was in
  await sleep(250);
  overlay.showInactive();
}
function standUp() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setFocusable(true);
  applyHidden();
}

// one action on the screen; the helper steps out of the way when it's under the point
async function act(hands, a, d, size) {
  if (a.do === 'wait') return sleep(a.seconds * 1000);
  if (a.do === 'type') return hands.run({ op: 'type', text: a.text });
  if (a.do === 'key') return hands.run({ op: 'keys', vks: a.combo.map((k) => k.vk), ext: a.combo.map((k) => k.ext) });
  const p = toScreen(d, size, a.x, a.y), p2 = a.do === 'drag' ? toScreen(d, size, a.x2, a.y2) : null;
  const inTheWay = under(p.dip) || (p2 && under(p2.dip));
  if (inTheWay) { overlay.hide(); await sleep(200); }
  try {
    if (a.do === 'click') await hands.run({ op: 'click', x: p.px.x, y: p.px.y, button: a.button, count: a.double ? 2 : 1 });
    else if (a.do === 'scroll') await hands.run({ op: 'scroll', x: p.px.x, y: p.px.y, amount: a.amount });
    else if (a.do === 'drag') await hands.run({ op: 'drag', x: p.px.x, y: p.px.y, x2: p2.px.x, y2: p2.px.y });
  } finally { if (inTheWay && overlay && !overlay.isDestroyed()) overlay.showInactive(); }
}

// his reply to the AI's question; null when he stopped the run
function waitAnswer(question) {
  emit('ask', question);
  return new Promise((resolve) => {
    doing.answer = (text) => { doing.answer = null; resolve(text); };
    if (overlay && !overlay.isDestroyed()) { overlay.setFocusable(true); overlay.focus(); } // so he can type a reply
  });
}

function stopDo() {
  if (!doing) return;
  doing.stop = true;
  if (doing.answer) doing.answer(null);
}

function startDo(goal) {
  goal = String(goal || '').trim().slice(0, 4000);
  if (process.platform !== 'win32') return { why: 'Do it only works on Windows for now.' };
  if (!goal) return { why: 'Say what to do first.' };
  if (doing) return { why: 'Already doing something: Stop it first.' };
  if (asking) return { why: 'Still answering the last question.' };
  doing = { stop: false, answer: null };
  runDo(goal).catch((e) => { ctx.agentLog('do it: ' + (e && e.stack || e)); emit('bad', 'Something went wrong: ' + (e && e.message || e)); })
    .finally(() => { doing = null; standUp(); emit('end', ''); });
  return { ok: true };
}

async function runDo(goal) {
  const cfg = ctx.readConfig(), lane = prefs().lane, deps = askDeps(cfg);
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); // the run stays on this screen
  if (overlay && !overlay.isDestroyed()) { try { overlay.setContentProtection(true); } catch (e) {} } // never in its own pictures
  emit('note', 'Getting the mouse and keyboard ready…');
  let hands;
  try { hands = await pcInput.start(ctx.agentLog); }
  catch (e) { emit('bad', e.message); return; }
  ctx.agentLog('do it: started (' + lane + ')');
  const steps = [];
  let stick = null, misses = 0, ended = false;
  try {
    await stepAside();
    for (let i = 0; i < pcControl.MAX_STEPS && !doing.stop; i++) {
      const shot = await captureDisplay(d, pcControl.SHOT_W);
      if (!shot.image) { emit('done', shot.note); ended = true; break; }
      emit('think', lane === 'local' ? 'Lupa is looking…' : 'Looking…');
      const r = await pcControl.next(cfg, { goal, steps, image: shot.image, w: shot.w, h: shot.h, lane, stick }, deps);
      if (doing.stop) break;
      if (r.why) { emit('bad', r.why); ended = true; break; }
      stick = r.stick;
      if (r.refuse) { emit('done', r.refuse, r.via); ended = true; break; }
      if (r.bad) {
        steps.push('(Your last reply was not used: ' + r.bad + ' Reply with one JSON action.)');
        if (++misses >= 3) { emit('bad', r.via + ' didn’t give a usable step three times, so I stopped.'); ended = true; break; }
        continue;
      }
      const a = r.action;
      if (a.do === 'done') { emit('done', a.say, r.via); ctx.agentLog('do it: done after ' + steps.length + ' steps'); ended = true; break; }
      if (a.do === 'ask') {
        const ans = await waitAnswer(a.question);
        if (ans == null || doing.stop) break;
        steps.push('Asked him: ' + a.question + ' He answered: ' + (ans.trim() || '(nothing)'));
        await stepAside();
        continue;
      }
      try {
        await act(hands, a, d, shot);
        misses = 0;
        steps.push(pcControl.describe(a));
        emit('step', pcControl.describe(a), r.via);
        ctx.agentLog('do it: ' + a.do);
      } catch (e) {
        steps.push('That step failed: ' + e.message);
        emit('bad', 'That step failed: ' + e.message);
        if (++misses >= 3) { ended = true; break; }
      }
      if (a.do !== 'wait') await sleep(900); // for the screen to catch up
    }
    if (doing.stop) { emit('done', 'Stopped.'); ctx.agentLog('do it: stopped by him after ' + steps.length + ' steps'); }
    else if (!ended) emit('done', 'I used all ' + pcControl.MAX_STEPS + ' steps without finishing. Run it again to carry on.');
  } finally { hands.close(); }
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
