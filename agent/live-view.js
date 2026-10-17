/* Live view: the agent browser shown inside Tasks, so James can watch Claude work and click or type to
   take over (log in, fix a field). The app's page streams it straight over the agent browser's
   localhost-only debugging port (Page.startScreencast + Input.dispatch*). Here we only list its tabs
   and let the page's socket through: Chrome refuses debugging sockets that carry a web page's Origin,
   so the Origin header is dropped for that one localhost port, for the app's own page only. */
const { session } = require('electron');
const { AGENT_BROWSER_PORT, agentBrowserUp, ensureAgentBrowser, closeWindowedAgentBrowser } = require('./agent-browser');

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

// its open tabs (most recently used first, as Chrome lists them), with the socket to watch each
async function pages() {
  if (!(await agentBrowserUp())) return { up: false, pages: [] };
  const list = await fetch(BASE + '/json/list', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => []);
  return { up: true, pages: list.filter((p) => p.type === 'page' && !/^devtools:|^chrome-extension:/.test(p.url) && p.webSocketDebuggerUrl)
    .map((p) => ({ id: p.id, title: p.title || '', url: p.url || '', ws: p.webSocketDebuggerUrl })) };
}
handle('live:pages', () => pages());
// ◉ Watch on a task that needs him: the page its run ended on. The tab if it's still open, or a new one
// (a later run closed it; his logins and cart are in the profile) → its id, for the view to show
async function openPage(url) {
  url = String(url || '');
  if (!/^https:\/\//i.test(url) || !(await ensureAgentBrowser())) return null;
  const same = (a) => { try { const x = new URL(a), y = new URL(url); return x.host === y.host && x.pathname === y.pathname; } catch (e) { return false; } };
  const open = (await pages()).pages.find((p) => same(p.url));
  if (open) { await fetch(BASE + '/json/activate/' + open.id, { signal: AbortSignal.timeout(1500) }).catch(() => {}); return open.id; }
  const made = await fetch(BASE + '/json/new?' + url, { method: 'PUT', signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  return made && made.id ? made.id : null;
}
handle('live:open', (_e, url) => openPage(url));
// "Start it": it starts headless (no window); the view shows it
handle('live:start', async () => ({ ok: await ensureAgentBrowser() }));

module.exports = { init, handlers, pages };
