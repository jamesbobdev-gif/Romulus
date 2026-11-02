/* Live view: the agent browser shown inside Tasks, so the user can watch Claude work and click or type to
   take over (log in, fix a field). The app's page streams it straight over the agent browser's
   localhost-only debugging port (Page.startScreencast + Input.dispatch*). Here we only list its tabs
   and let the page's socket through: Chrome refuses debugging sockets that carry a web page's Origin,
   so the Origin header is dropped for that one localhost port, for the app's own page only. */
const { session } = require('electron');
const { AGENT_BROWSER_PORT, agentBrowserUp, ensureAgentBrowser, closeWindowedAgentBrowser } = require('./agent-browser');
const taskTabs = require('./task-tabs');
const { QWEN_BROWSER_LOCAL_PORT, qwenBrowserUp, ensureQwenBrowser } = require('./qwen-browser');

let ctx = null;
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
const BASE = 'http://127.0.0.1:' + AGENT_BROWSER_PORT;

function init(c) {
  ctx = c;
  const allow = () => session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://127.0.0.1:' + AGENT_BROWSER_PORT + '/*', 'ws://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/*'] },
    (d, cb) => {
      const fromApp = d.webContents && !d.webContents.isDestroyed() && d.webContents.getType() === 'window' && /^file:/i.test(d.webContents.getURL());
      if (fromApp) { const h = Object.assign({}, d.requestHeaders); delete h.Origin; delete h.origin; return cb({ requestHeaders: h }); }
      cb({ cancel: true }); // anything else trying to reach the agent browser's controls: no
    });
  const { app } = require('electron');
  if (app.isReady()) allow(); else app.whenReady().then(allow);
  // the agent browser has no window now (headless): one still open with a window from before is closed at start
  // (runs begin later), and the next use starts it headless
  setTimeout(() => closeWindowedAgentBrowser().catch(() => {}), 3000);
}

// its open tabs (most recently used first, as Chrome lists them), with the socket to watch each.
// taskId: only that task's tabs (agent/task-tabs.js), so watching one task never shows another's
const view = (p) => ({ id: p.id, title: p.title || '', url: p.url || '', ws: p.webSocketDebuggerUrl });
async function pages(taskId) {
  if (!(await agentBrowserUp())) return { up: false, pages: [] };
  const list = taskId ? await taskTabs.pagesFor(String(taskId)) : await fetch(BASE + '/json/list', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => []);
  return { up: true, pages: (list || []).filter((p) => p.type === 'page' && !/^devtools:|^chrome-extension:/.test(p.url) && p.webSocketDebuggerUrl).map(view) };
}
/* where = 'lupa': the local model's browser on the mini PC, through the SSH tunnel (agent/qwen-browser.js),
   for the stuck task at the top of the Agent tab. Polled every 2 s, so the tunnel (an ssh that also wakes its
   screen) is opened at most once a minute; it has no per-task tabs, so all of its tabs */
let lupaTried = 0;
async function lupaPages() {
  if (!(await qwenBrowserUp())) {
    if (Date.now() - lupaTried < 60 * 1000) return { up: false, pages: [] };
    lupaTried = Date.now();
    if (!(await ensureQwenBrowser().catch(() => false))) return { up: false, pages: [] };
  }
  const list = await fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/list', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => []);
  return { up: true, pages: (list || []).filter((p) => p.type === 'page' && !/^devtools:|^chrome-extension:/.test(p.url) && p.webSocketDebuggerUrl)
    .map((p) => Object.assign(view(p), { ws: 'ws://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/devtools/page/' + p.id })) }; // this end of the tunnel, whatever port it names
}
// not over the hub (main/hub.js relays Watch to its own agent browser's port only)
handle('live:pages', (e, taskId, where) => where === 'lupa' ? (e && e.hub ? { up: false, pages: [] } : lupaPages()) : pages(taskId));
// ◉ Watch on a task that needs him: its own tab, as the run left it (nothing reloaded). If that tab is gone
// (the browser was closed), the page its run ended on, in a new tab of its own: never a sign-in step
// (those only work once, and opening one again just shows an error) → the tab's id, for the view to show
async function openPage(url, taskId) {
  url = String(url || '');
  if (taskId) {
    const mine = await taskTabs.pagesFor(String(taskId)).catch(() => null);
    const p = mine && (mine.find((x) => /^https?:/i.test(x.url)) || mine[0]);
    if (p) { await fetch(BASE + '/json/activate/' + p.id, { signal: AbortSignal.timeout(1500) }).catch(() => {}); return p.id; }
  }
  if (!/^https:\/\//i.test(url) || taskTabs.signInPage(url) || !(await ensureAgentBrowser())) return null;
  const made = await fetch(BASE + '/json/new?' + url, { method: 'PUT', signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  if (!made || !made.id) return null;
  if (taskId) taskTabs.give(made.id, String(taskId));
  return made.id;
}
handle('live:open', (_e, url, taskId) => openPage(url, taskId));
// "Start it": it starts headless (no window); the view shows it
handle('live:start', async (_e, where) => ({ ok: where === 'lupa' ? (lupaTried = 0, await ensureQwenBrowser().catch(() => false)) : await ensureAgentBrowser() }));

/* The mini PC's browser over Supabase (renderer/js/live-relay.js), so no device has to reach it: the mini PC
   (the worker) sends its screen on a Realtime channel while someone watches, and the clicks come back the
   same way. The channel's name is a hash of the agent list's sync key and every message is sealed with a key
   made from it (AES-GCM), so only his devices can watch or click. → {role: 'publish' | 'watch', url, key,
   topic, secret (hex)}, or {role: null}: no worker, so the SSH way above (or nothing). */
const relayKeys = (syncKey) => ({
  topic: 'live:' + require('crypto').createHash('sha256').update(String(syncKey) + ':live').digest('hex').slice(0, 40),
  secret: require('crypto').createHash('sha256').update('romulus-live-v1|' + String(syncKey)).digest('hex'),
});
handle('live:relay', async (e) => {
  if (e && e.hub) return { role: null };
  const cfg = ctx.readConfig(), a = require('./supabase').channel(cfg);
  if (!a) return { role: null };
  const worker = require('./worker');
  const role = worker.isWorker(cfg) ? 'publish' : (await worker.present(a).catch(() => null)) ? 'watch' : null;
  return role ? Object.assign({ role, url: String(a.url).replace(/\/+$/, ''), key: a.key }, relayKeys(a.syncKey)) : { role: null };
});

module.exports = { init, handlers, pages, relayKeys };
