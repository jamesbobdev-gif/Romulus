/* Task tabs: every Agent task gets its own tabs in the agent browser, so ◉ Watch on a task shows that
   task's pages and never jumps to another task's. They share one Chrome profile, so logins, cookies
   and carts carry over between tasks (related tasks can use what another one signed in to or found).
   Which task owns which tab is kept in task-tabs.json (Chrome's tab id → task ids; a run that worked
   several tasks at once gives its tabs to all of them). A tab nobody owns that shows up while a run is
   going belongs to that run. */
const path = require('path');
const fs = require('fs');
const { AGENT_BROWSER_PORT, agentBrowserUp, agentBrowserDir } = require('./agent-browser');

const BASE = 'http://127.0.0.1:' + AGENT_BROWSER_PORT;
const file = () => path.join(agentBrowserDir(), 'task-tabs.json');
let owners = null;   // tab id → [task ids]
let running = null;  // the task ids of the run going now
let runTab = null;   // { id, url } the tab that run started on

function load() {
  if (owners) return owners;
  try { owners = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (e) { owners = {}; }
  return owners;
}
function save() { try { fs.writeFileSync(file(), JSON.stringify(owners)); } catch (e) {} }

async function list() {
  if (!(await agentBrowserUp())) return null;
  const all = await fetch(BASE + '/json/list', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
  return all && all.filter((p) => p.type === 'page' && !/^(devtools|chrome-extension):/.test(p.url));
}
// forget closed tabs; a tab nobody owns that's open while a run is going is that run's
function claim(pages) {
  load();
  const open = new Set(pages.map((p) => p.id));
  let changed = false;
  for (const id of Object.keys(owners)) if (!open.has(id)) { delete owners[id]; changed = true; }
  if (running) for (const p of pages) if (!owners[p.id]) { owners[p.id] = running.slice(); changed = true; }
  if (changed) save();
}
const owns = (tabId, taskId) => (load()[tabId] || []).includes(taskId);

/* Before a run: tabs of finished tasks (and nobody's) are closed; tabs of tasks still open stay, for
   Watch and for when he answers. The run starts on its task's most recent tab (where it left off), or
   on a new blank one of its own. → the tab's address, for the browser launcher to start on (TASKS_BROWSER_TAB) */
async function startRun(ids, openTaskIds) {
  running = ids.slice(); runTab = null;
  const pages = await list();
  if (!pages) return null;
  load();
  const open = new Set(pages.map((p) => p.id));
  for (const id of Object.keys(owners)) if (!open.has(id)) delete owners[id];
  const keep = new Set(openTaskIds.concat(ids));
  const shut = pages.filter((p) => !(owners[p.id] || []).some((t) => keep.has(t)));
  // Chrome lists the most recently used tab first
  const mine = pages.filter((p) => (owners[p.id] || []).some((t) => ids.includes(t)) && /^https?:/i.test(p.url));
  let start = mine.find((p) => !signInPage(p.url)) || mine[0] || null;
  if (!start) {
    const mark = 'about:blank#task-' + String(ids[0]).replace(/[^\w-]/g, '').slice(0, 40);
    start = await fetch(BASE + '/json/new?' + mark, { method: 'PUT', signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
    if (!start || !start.id) start = null;
  }
  // never close the last tab: that would quit the browser
  for (const p of shut) if (!start || p.id !== start.id) await fetch(BASE + '/json/close/' + p.id, { signal: AbortSignal.timeout(1500) }).catch(() => {});
  for (const p of shut) delete owners[p.id];
  if (start) {
    owners[start.id] = Array.from(new Set((owners[start.id] || []).concat(ids)));
    await fetch(BASE + '/json/activate/' + start.id, { signal: AbortSignal.timeout(1500) }).catch(() => {});
    runTab = { id: start.id, url: start.url || 'about:blank' };
  }
  save();
  return runTab && runTab.url;
}
// a sign-in step (SSO hand-offs carry one-time data): reopening its address later only shows an error
const SIGN_IN = /^https:\/\/(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|accounts\.google\.com|login\.yahoo\.com|account\.proton\.me|[^/]*\.okta\.com|[^/]*auth0\.com)(\/|$)|\/(saml2?|sso|oauth2?|signin-oidc)(\/|\?|$)/i;
const signInPage = (url) => SIGN_IN.test(String(url || ''));
// after a run: its new tabs are its tasks'; → the page it ended on (its most recently used https tab, a
// real page rather than a sign-in step when it has one)
async function endRun() {
  const pages = await list().catch(() => null);
  const ids = running;
  if (pages) claim(pages);
  running = null; runTab = null;
  if (!pages || !ids) return null;
  const theirs = pages.filter((x) => (owners[x.id] || []).some((t) => ids.includes(t)) && /^https:\/\//i.test(x.url));
  const p = theirs.find((x) => !signInPage(x.url)) || theirs[0];
  return p ? String(p.url).slice(0, 2000) : null;
}
// the tabs Watch shows for a task (most recently used first)
async function pagesFor(taskId) {
  const pages = await list();
  if (!pages) return null;
  claim(pages);
  return pages.filter((p) => owns(p.id, taskId));
}
// a tab Watch opened again for a task (a page from before this was kept): it's that task's
function give(tabId, taskId) {
  load();
  owners[tabId] = Array.from(new Set((owners[tabId] || []).concat(taskId)));
  save();
}

module.exports = { startRun, endRun, pagesFor, give, signInPage, isRunning: () => !!running };
