/* Qwen's browser: a visible Chromium on the mini PC (minipc/qwen-browser.service), its remote control
   listening on the mini PC's 127.0.0.1 only. This computer reaches it through an SSH tunnel and drives
   it with the same launcher + Playwright tools as Claude's browser, in locked mode: only the task's
   links and the sites he allows (Settings), and final clicks (submit, send, apply…) refused until his
   latest reply is a yes to exactly that. Config: localModel.browser {ssh: 'user@host', port: 9334}. */
const path = require('path');
const fs = require('fs');
const { prepareAgentBrowser, agentBrowserDir, findNode, formFiles } = require('./agent-browser');

let ctx = null; // { readConfig, agentLog }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const agentLog = (m) => ctx.agentLog(m);

const QWEN_BROWSER_LOCAL_PORT = 9336;
let qwenTunnel = null;
const qwenBrowserUp = () => fetch('http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json/version', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
/* After each task: one blank tab left, every other tab closed. Tabs piled up between tasks (Blackboard,
   D2L…) and kept their memory on a mini PC that froze when memory ran out. Logins stay (cookies). */
async function tidyAgentTabs() {
  const base = 'http://127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + '/json';
  try {
    const pages = (await fetch(base + '/list', { signal: AbortSignal.timeout(3000) }).then((r) => r.json())).filter((p) => p.type === 'page');
    if (pages.length === 1 && pages[0].url === 'about:blank') return;
    await fetch(base + '/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(3000) });
    for (const p of pages) await fetch(base + '/close/' + p.id, { method: 'PUT', signal: AbortSignal.timeout(3000) }).catch(() => {});
    agentLog('local: closed ' + pages.length + ' browser tab(s) on the mini PC');
  } catch (e) {} // the browser may be gone already: nothing to tidy
}
/* GNOME on the mini PC switched its displays to power-save (even with blanking set to "never"), and
   with no screen on it stops drawing Chromium: every click timed out ("the screen appears locked").
   Waking the displays before each browser run costs one quick ssh. Never fails a task. */
function wakeMiniPcDisplay(ssh) {
  return new Promise((resolve) => {
    const cmd = 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; ' +
      'gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig ' +
      '--method org.freedesktop.DBus.Properties.Set org.gnome.Mutter.DisplayConfig PowerSaveMode "<0>"';
    const p = require('child_process').spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, cmd], { windowsHide: true, stdio: 'ignore' });
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(); }, 15000);
    p.on('exit', done); p.on('error', done);
  });
}
async function ensureQwenBrowser() {
  const b = (readConfig().localModel || {}).browser;
  if (!b || !b.ssh) return false;
  await wakeMiniPcDisplay(b.ssh);
  if (await qwenBrowserUp()) return true;
  if (qwenTunnel) { try { qwenTunnel.kill(); } catch (e) {} qwenTunnel = null; }
  qwenTunnel = require('child_process').spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
    '-N', '-L', '127.0.0.1:' + QWEN_BROWSER_LOCAL_PORT + ':127.0.0.1:' + (b.port || 9334), b.ssh], { windowsHide: true });
  qwenTunnel.on('exit', () => { qwenTunnel = null; });
  qwenTunnel.on('error', (e) => { agentLog('local: ssh tunnel failed to start: ' + e.message); qwenTunnel = null; }); // e.g. no ssh installed: unhandled, this would crash the app
  for (let i = 0; i < 20; i++) { if (await qwenBrowserUp()) return true; await new Promise((r) => setTimeout(r, 500)); }
  agentLog('local: Qwen\'s browser on the mini PC isn\'t reachable (is someone logged in there?)');
  return false;
}
// tools may save their output to a file on this computer when asked to: the model never needs that
function noFileArgs(schema) {
  const s = JSON.parse(JSON.stringify(schema || { type: 'object', properties: {} }));
  if (s.properties) delete s.properties.filename;
  if (Array.isArray(s.required)) s.required = s.required.filter((r) => r !== 'filename');
  return s;
}
// a small MCP client for the browser launcher (newline-delimited JSON-RPC over stdio)
async function startBrowserTools(lockFile) {
  if (!(await prepareAgentBrowser())) return null; // installs the tool + copies the launcher if needed
  const dir = agentBrowserDir(), node = findNode();
  const cli = path.join(dir, 'tool', 'node_modules', '@playwright', 'mcp', 'cli.js');
  const p = require('child_process').spawn(node, [path.join(dir, 'browser-proxy.js'), cli, 'remote', 'unused', String(QWEN_BROWSER_LOCAL_PORT)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: Object.assign({}, process.env, { TASKS_BROWSER_LOCK: lockFile, TASKS_BROWSER_ARGS: JSON.stringify(['--snapshot-mode', 'none', '--image-responses', 'omit']),
      TASKS_BROWSER_FILES: JSON.stringify(formFiles().map((f) => f.path)) }) }); // his resume and the like: the only uploads allowed (sent from this computer over CDP)
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
/* When a mini PC run stops for something in its way, the user gets why, what to do, and a picture of
   what its browser showed. The screenshot goes to his attachments bucket like the photos he adds. */
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
  const base = a.url.replace(/\/+$/, ''), file = a.syncKey + '/stuck-' + Date.now().toString(36) + '.jpg';
  try {
    const r = await fetch(base + '/storage/v1/object/agent-attachments/' + file, { method: 'POST', body: Buffer.from(out.jpeg, 'base64'),
      headers: { apikey: a.key, Authorization: 'Bearer ' + a.key, 'Content-Type': 'image/jpeg' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { agentLog('local: screenshot upload failed (' + r.status + ')'); return null; }
  } catch (e) { agentLog('local: screenshot upload failed: ' + e.message); return null; }
  return base + '/storage/v1/object/public/agent-attachments/' + file;
}

module.exports = { init, QWEN_BROWSER_LOCAL_PORT, qwenBrowserUp, tidyAgentTabs, ensureQwenBrowser, noFileArgs, startBrowserTools, miniPcScreenshot };
