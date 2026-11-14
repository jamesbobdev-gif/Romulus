/* Tasks added from outside the app: agent/tasks-mcp.js (Claude Desktop) drops each one as a file in
   <user data>/outside-adds. This watches that folder and hands what is there to the page ('tasks:outside'),
   which adds each task and reports it done ('outside:done') so the file goes; the page also asks once when it
   has loaded ('outside:pending'), so what came in while the app was closed goes on the list too.
   Also Settings → Agent & AI → Add from Claude Desktop: the entry in Claude Desktop's own config
   (claude_desktop_config.json) that runs the server with this app's Electron as node, put in and taken out.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const os = require('os');

let ctx = null; // { userData, sendToRenderer, agentLog }
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
const SERVER = 'romulus';
const LISTS = ['todo', 'agent', 'work', 'school'];
const dir = () => path.join(ctx.userData(), 'outside-adds');
const script = () => path.join(ctx.userData(), 'mcp', 'tasks-mcp.js');
let timer = null;

function init(c) {
  ctx = c;
  try { fs.mkdirSync(dir(), { recursive: true }); } catch (e) {}
  if (status().on) refreshScript(); // a newer app brings a newer server
  try { fs.watch(dir(), { persistent: false }, () => { clearTimeout(timer); timer = setTimeout(tick, 400); }); } catch (e) {}
  setInterval(tick, 20 * 1000).unref();
}
// one dropped file's contents → what the page gets, or null when it isn't a task
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const title = String(it.title == null ? '' : it.title).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(it.due || '')) ? String(it.due) : null;
  return { title, list: LISTS.includes(it.list) ? it.list : 'todo', due,
    time: due && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(it.time || '')) ? String(it.time) : null,
    notes: String(it.notes == null ? '' : it.notes).trim().slice(0, 2000) || null,
    from: String(it.from || 'another app').replace(/\s+/g, ' ').trim().slice(0, 60) || 'another app' };
}
// what is waiting in the folder: [{file, title, list, due, time, notes, from}], oldest first
function pending(folder = dir()) {
  let names = [];
  try { names = fs.readdirSync(folder).filter((n) => /^[\w-]+\.json$/.test(n)).sort(); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(folder, n);
    let it = null;
    try { it = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; } // half-written: the next look
    const c = cleanItem(it);
    if (c) out.push(Object.assign({ file: n }, c));
    else { try { fs.unlinkSync(file); } catch (e) {} } // not a task: gone
  }
  return out;
}
// what's there goes to the page every look; the page skips files it already took (they go once it says done)
function tick() {
  const p = pending();
  if (p.length) ctx.sendToRenderer('tasks:outside', p);
}
handle('outside:pending', () => pending());
handle('outside:done', (_e, name) => {
  const n = String(name || '');
  if (!/^[\w-]+\.json$/.test(n)) return false;
  try { fs.unlinkSync(path.join(dir(), n)); } catch (e) {}
  return true;
});

/* ---------- Claude Desktop's config ---------- */
function configPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}
// the entry Claude Desktop runs: this app's own Electron as node, the server copied out of the app, the drop folder
const entry = ({ exe, script: s, inbox }) => ({ command: exe, args: [s], env: { ELECTRON_RUN_AS_NODE: '1', ROMULUS_INBOX: inbox } });
// the config's text with the entry put in (ent) or taken out (null); every other server and setting stays as it is
function withEntry(text, ent) {
  let cfg = {};
  if (String(text || '').trim()) cfg = JSON.parse(text);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a settings file');
  const servers = Object.assign({}, cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {});
  if (ent) servers[SERVER] = ent; else delete servers[SERVER];
  return JSON.stringify(Object.assign({}, cfg, { mcpServers: servers }), null, 2) + '\n';
}
function refreshScript() {
  try { fs.mkdirSync(path.dirname(script()), { recursive: true }); fs.copyFileSync(path.join(__dirname, '..', 'agent', 'tasks-mcp.js'), script()); } catch (e) {}
}
function status() {
  const file = configPath();
  let on = false;
  try { const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); on = !!(cfg && cfg.mcpServers && cfg.mcpServers[SERVER]); } catch (e) {}
  return { installed: fs.existsSync(path.dirname(file)), on, file };
}
handle('mcp:status', () => status());
handle('mcp:setup', () => {
  const file = configPath();
  if (!fs.existsSync(path.dirname(file))) return { ok: false, error: 'Claude Desktop isn’t installed on this computer (claude.ai/download)', status: status() };
  refreshScript();
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (e) {}
  let out;
  try { out = withEntry(text, entry({ exe: process.execPath, script: script(), inbox: dir() })); }
  catch (e) { return { ok: false, error: 'couldn’t read Claude Desktop’s settings file (' + e.message + ')', status: status() }; }
  try { fs.writeFileSync(file, out); } catch (e) { return { ok: false, error: 'couldn’t write Claude Desktop’s settings file (' + e.message + ')', status: status() }; }
  ctx.agentLog('claude desktop: the Romulus server is in its settings (' + file + ')');
  return { ok: true, status: status() };
});
handle('mcp:remove', () => {
  const file = configPath();
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: true, status: status() }; }
  try { fs.writeFileSync(file, withEntry(text, null)); }
  catch (e) { return { ok: false, error: 'couldn’t change Claude Desktop’s settings file (' + e.message + ')', status: status() }; }
  ctx.agentLog('claude desktop: the Romulus server is out of its settings');
  return { ok: true, status: status() };
});

module.exports = { init, handlers, cleanItem, pending, configPath, entry, withEntry, SERVER };
