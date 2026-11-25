/* The local model's browser: a visible Chromium on its own computer (minipc/qwen-browser.service), its remote
   control listening on 127.0.0.1 only. The app on that computer (the worker, agent/worker.js) drives it with the
   same launcher + Playwright tools as Claude's browser, in locked mode: only the task's links and the sites he
   allows (Settings), and final clicks (submit, send, apply…) refused until his latest reply is a yes to exactly
   that. His other computers never reach it: they watch it over Supabase (renderer/js/live-relay.js) and get what
   it downloaded the same way (agent/worker-files.js). Config: localModel.browser {port: 9334}. */
const path = require('path');
const fs = require('fs');
const { prepareAgentBrowser, agentBrowserDir, findNode, formFiles } = require('./agent-browser');

let ctx = null; // { readConfig, agentLog }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const agentLog = (m) => ctx.agentLog(m);

const QWEN_BROWSER_LOCAL_PORT = 9336;
const qwenBrowserUp = () => fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/version', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
/* After each task: one blank tab left, every other tab closed. Tabs piled up between tasks (Blackboard,
   D2L…) and kept their memory on a mini PC that froze when memory ran out. Logins stay (cookies).
   A run that stopped waiting on him (a sign-in, a code, a form for his yes) keeps its tabs: the next task's
   tidy-up used to close them too, so he opened the view and found about:blank where the sign-in had been.
   Held for a day, or until that task runs again. */
const HOLD_MS = 24 * 60 * 60 * 1000;
const holds = new Map(); // task id → {ids: [page ids], at}
function heldIds(now = Date.now()) {
  const out = new Set();
  for (const [k, h] of holds) { if (now - h.at > HOLD_MS) holds.delete(k); else h.ids.forEach((i) => out.add(i)); }
  return out;
}
const tabList = () => fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/list', { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json()).then((l) => (Array.isArray(l) ? l : []).filter((p) => p.type === 'page'));
// the pages that go: everything but the held ones (pure, for tests)
const looseTabs = (pages, keep) => pages.filter((p) => !keep.has(p.id));
async function tidyAgentTabs() {
  const base = 'http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json';
  try {
    const pages = await tabList(), loose = looseTabs(pages, heldIds());
    if (loose.length === 1 && loose[0].url === 'about:blank') return;
    await fetch(base + '/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(3000) });
    for (const p of loose) await fetch(base + '/close/' + p.id, { method: 'PUT', signal: AbortSignal.timeout(3000) }).catch(() => {});
    agentLog('local: closed ' + loose.length + ' browser tab(s) on the mini PC' + (pages.length > loose.length ? ', kept ' + (pages.length - loose.length) + ' waiting on him' : ''));
  } catch (e) {} // the browser may be gone already: nothing to tidy
}
/* Which of a stopped run's pages stay (pure, for tests; Chrome lists the most recently used first): the one it
   stopped on, then its other pages, leaving out older sign-in steps and repeats of the same address, KEEP_HELD
   at most. A class task that kept stopping held every page of every run: twenty-odd D2L and Microsoft
   sign-in tabs, all live, on the mini PC that runs out of memory. */
const KEEP_HELD = 3;
const { signInPage } = require('./task-tabs');
const signInTab = (p) => signInPage(p.url) || /^sign in to your account$/i.test(String(p.title || '').trim());
function heldPick(pages) {
  const seen = new Set(), keep = [];
  pages.forEach((p, i) => {
    const addr = String(p.url || '').replace(/#.*$/, '');
    if (keep.length >= KEEP_HELD || seen.has(addr) || (i > 0 && signInTab(p))) return;
    keep.push(p); seen.add(addr);
  });
  return keep;
}
// a run that's waiting on him: a few of its web pages stay open, the rest close (another task's held tabs
// aren't taken over or closed)
async function holdTabs(taskId) {
  try {
    const others = heldIds(), mine = (await tabList()).filter((p) => /^https?:/i.test(p.url) && !others.has(p.id));
    const ids = heldPick(mine).map((p) => p.id);
    const shut = mine.filter((p) => !ids.includes(p.id));
    for (const p of shut) await fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/close/' + p.id, { method: 'PUT', signal: AbortSignal.timeout(3000) }).catch(() => {});
    if (ids.length) { holds.set(String(taskId), { ids, at: Date.now() }); agentLog('local: keeping ' + ids.length + ' tab(s) open for him' + (shut.length ? ', closed ' + shut.length : '')); }
  } catch (e) {}
}
/* Where the next run starts (TASKS_BROWSER_TAB, agent/browser-proxy.js): the task's own held tab when it
   runs again (its hold ends: tidied like any other once it's done), else a blank tab of its own while other
   tasks hold theirs, so it never works in his sign-in page. '' = wherever Playwright starts */
async function startTab(taskId) {
  try {
    const h = holds.get(String(taskId)); holds.delete(String(taskId));
    const pages = await tabList();
    const mine = h && pages.find((p) => h.ids.includes(p.id));
    if (mine) return mine.url;
    const keep = heldIds();
    if (!keep.size) return '';
    if (!looseTabs(pages, keep).some((p) => p.url === 'about:blank'))
      await fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(3000) });
    return 'about:blank';
  } catch (e) { return ''; }
}
const isHeld = (id) => heldIds().has(id);
/* GNOME on the mini PC switched its displays to power-save (even with blanking set to "never"), and with no
   screen on it stops drawing Chromium: every click timed out ("the screen appears locked"). So the displays are
   woken before each browser run. Never fails a task. A plain local relay puts the browser's port where the tools
   expect it (QWEN_BROWSER_LOCAL_PORT). */
let localRelay = null;
function wakeLocalDisplay() {
  return new Promise((resolve) => {
    const p = require('child_process').spawn('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.DisplayConfig', '--object-path', '/org/gnome/Mutter/DisplayConfig',
      '--method', 'org.freedesktop.DBus.Properties.Set', 'org.gnome.Mutter.DisplayConfig', 'PowerSaveMode', '<0>'],
    { stdio: 'ignore', env: Object.assign({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + (process.getuid ? process.getuid() : 0) + '/bus' }, process.env) });
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(); }, 5000);
    p.on('exit', () => { clearTimeout(t); resolve(); }); p.on('error', () => { clearTimeout(t); resolve(); });
  });
}
async function ensureLocalBrowser(port) {
  await wakeLocalDisplay();
  if (await qwenBrowserUp()) return true;
  if (!localRelay) {
    const net = require('net');
    localRelay = net.createServer((c) => {
      const up = net.connect(port, '127.0.0.1');
      c.pipe(up).pipe(c);
      c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
    });
    const relay = localRelay;
    await new Promise((r) => {
      relay.once('error', (e) => { agentLog('local: browser relay failed: ' + e.message); if (localRelay === relay) localRelay = null; r(); });
      relay.listen(QWEN_BROWSER_LOCAL_PORT, '127.0.0.1', r);
    });
  }
  for (let i = 0; i < 10; i++) { if (await qwenBrowserUp()) return true; await new Promise((r) => setTimeout(r, 500)); }
  agentLog('local: this computer\'s browser isn\'t answering on port ' + port + ' (is qwen-browser.service running?)');
  return false;
}
// the browser is only ever driven from its own computer: the worker. Anywhere else there is none to drive
async function ensureQwenBrowser() {
  const cfg = readConfig(), b = (cfg.localModel || {}).browser;
  if (!require('./worker').isWorker(cfg)) return false;
  return ensureLocalBrowser((b && b.port) || 9334);
}
// tools may save their output to a file on this computer when asked to: the model never needs that
function noFileArgs(schema) {
  const s = JSON.parse(JSON.stringify(schema || { type: 'object', properties: {} }));
  if (s.properties) delete s.properties.filename;
  if (Array.isArray(s.required)) s.required = s.required.filter((r) => r !== 'filename');
  return s;
}
// a small MCP client for the browser launcher (newline-delimited JSON-RPC over stdio)
async function startBrowserTools(lockFile, taskTitle, tab) {
  if (!(await prepareAgentBrowser())) return null; // installs the tool + copies the launcher if needed
  const dir = agentBrowserDir(), node = findNode();
  const cli = path.join(dir, 'tool', 'node_modules', '@playwright', 'mcp', 'cli.js');
  const p = require('child_process').spawn(node, [path.join(dir, 'browser-proxy.js'), cli, 'remote', 'unused', String(QWEN_BROWSER_LOCAL_PORT)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: Object.assign({}, process.env, { TASKS_BROWSER_LOCK: lockFile, TASKS_BROWSER_ARGS: JSON.stringify(['--snapshot-mode', 'none', '--image-responses', 'omit']),
      TASKS_BROWSER_DOWNLOADS: require('./worker-files').downloadsDir(), // its own folder: that is what the worker publishes, not ~/Downloads
      TASKS_BROWSER_FILES: JSON.stringify(formFiles().map((f) => f.path)), // his resume and the like: the only uploads allowed (sent from this computer over CDP)
      TASKS_BROWSER_ACTIONS: require('./agent-browser').actionsLogFile(), TASKS_BROWSER_TASK: String(taskTitle || '').slice(0, 120), TASKS_BROWSER_TAB: String(tab || '') }) }); // what it did, for Settings → What the Agent did
  let buf = '', id = 0; const pending = {};
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id != null && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } } catch (e) {} }
  });
  const rpc = (method, params, ms = 60000) => new Promise((resolve) => {
    const n = ++id; pending[n] = resolve;
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    setTimeout(() => { if (pending[n]) { delete pending[n]; resolve({ error: { message: 'timed out' } }); } }, ms);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tasks-local', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  // only what working a page needs, in words a small model gets right (every description is re-read on
  // each step); after each action it's shown the page again by agent/page-reader.js
  const KEEP = {
    browser_navigate: 'Open a web address.',
    browser_snapshot: 'Look at the current page again (you already see it after every action).',
    browser_click: 'Click a button, link, tab or choice. target = its ref from the page, like f1e15.',
    browser_type: 'Type text into one field. target = the field\'s ref.',
    browser_fill_form: 'Fill several fields at once: fields = [{target: ref, name: label, type: textbox|checkbox|radio|combobox, value}]. Checkbox/radio value is "true".',
    browser_select_option: 'Pick a choice in a dropdown. target = the dropdown\'s ref, values = [the choice text].',
    browser_find: 'Find a word on a long page (the part that was cut off). text = the word.',
    browser_press_key: 'Press one key, e.g. Escape (closes popups), Tab, ArrowDown.',
    browser_navigate_back: 'Go back to the previous page.',
  };
  const tools = ((list.result && list.result.tools) || []).filter((t) => KEEP[t.name]).map((t) => ({ type: 'function',
    function: { name: t.name, description: KEEP[t.name], parameters: noFileArgs(t.inputSchema) } }));
  return {
    tools,
    async call(name, args) {
      const m = await rpc('tools/call', { name, arguments: args || {} }, 90000);
      if (m.error) return 'Browser error: ' + m.error.message;
      const text = ((m.result && m.result.content) || []).map((c) => c.text || '').join('\n');
      return (m.result && m.result.isError ? 'Refused or failed: ' : '') + text;
    },
    close() { try { p.kill(); } catch (e) {} },
  };
}
/* When a local run stops for something in its way, the user gets why, what to do, and a picture of what
   its browser showed. The screenshot goes to his attachments bucket like the photos he adds. */
async function miniPcScreenshot() {
  const node = findNode();
  if (!node || !(await qwenBrowserUp())) return null;
  const script = path.join(agentBrowserDir(), 'browser-shot.js');
  try {
    const src = fs.readFileSync(path.join(__dirname, 'browser-shot.js'), 'utf8');
    try { if (fs.readFileSync(script, 'utf8') !== src) fs.writeFileSync(script, src); } catch (e) { fs.writeFileSync(script, src); }
  } catch (e) { return null; }
  const out = await new Promise((resolve) => {
    let buf = '';
    const p = require('child_process').spawn(node, [script, String(QWEN_BROWSER_LOCAL_PORT)], { windowsHide: true });
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 30 * 1000);
    p.stdout.on('data', (d) => { buf += d; });
    p.on('error', () => { clearTimeout(killer); resolve({}); });
    p.on('close', () => { clearTimeout(killer); try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); } });
  });
  if (!out.jpeg) { agentLog('local: no screenshot (the mini PC\'s browser didn\'t draw one)'); return null; }
  const a = ((readConfig().sync) || {}).agent || {};
  if (!a.url || !a.key || !a.syncKey) return null;
  // the bucket is public: the folder is a hash of the agent key, never the key (same formula as renderer/js/agent-chat.js attachFolder)
  const folder = 'tk_agent_att_' + require('crypto').createHash('sha256').update(String(a.syncKey)).digest('hex').slice(0, 40);
  const base = a.url.replace(/\/+$/, ''), file = folder + '/stuck-' + Date.now().toString(36) + '.jpg';
  try {
    const r = await fetch(base + '/storage/v1/object/agent-attachments/' + file, { method: 'POST', body: Buffer.from(out.jpeg, 'base64'),
      headers: { apikey: a.key, Authorization: 'Bearer ' + a.key, 'Content-Type': 'image/jpeg' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { agentLog('local: screenshot upload failed (' + r.status + ')'); return null; }
  } catch (e) { agentLog('local: screenshot upload failed: ' + e.message); return null; }
  return base + '/storage/v1/object/public/agent-attachments/' + file;
}

module.exports = { init, QWEN_BROWSER_LOCAL_PORT, qwenBrowserUp, tidyAgentTabs, holdTabs, heldPick, startTab, isHeld, looseTabs, ensureQwenBrowser, noFileArgs, startBrowserTools, miniPcScreenshot };
