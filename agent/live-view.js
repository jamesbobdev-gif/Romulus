/* Live view: the agent browser shown inside Tasks, so the user can watch Claude work and click or type to
   take over (log in, fix a field). The app's page streams it straight over the agent browser's
   localhost-only debugging port (Page.startScreencast + Input.dispatch*). Here we only list its tabs
   and let the page's socket through: Chrome refuses debugging sockets that carry a web page's Origin,
   so the Origin header is dropped for that one localhost port, for the app's own page only. */
const { session } = require('electron');
const { AGENT_BROWSER_PORT, agentBrowserUp, ensureAgentBrowser, closeWindowedAgentBrowser } = require('./agent-browser');
const taskTabs = require('./task-tabs');

let ctx = null;
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
const BASE = 'http://127.0.0.1:' + AGENT_BROWSER_PORT;

function init(c) {
  ctx = c;
  const allow = () => session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://127.0.0.1:' + AGENT_BROWSER_PORT + '/*'] },
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
handle('live:pages', (_e, taskId) => pages(taskId));
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
handle('live:start', async () => ({ ok: await ensureAgentBrowser() }));

module.exports = { init, handlers, pages };
