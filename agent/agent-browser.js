/* Agent browser: the Tasks app's own Chrome window (own profile in %APPDATA%\Tasks\agent-browser,
   separate from James's everyday Chrome). Claude drives it through Playwright's MCP server — it
   decides by itself when a task needs it — and it opens only on first use, then stays open. */
const path = require('path');
const fs = require('fs');

let ctx = null; // { userData, readConfig, agentLog }
function init(c) { ctx = c; }
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const AGENT_BROWSER_PORT = 9334;
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';
// things a page could abuse: running its own code, sending his files, closing the window under him
const BROWSER_DENIED = ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_drop', 'browser_close',
  'browser_network_request'].map((n) => 'mcp__browser__' + n);
function agentBrowserDir() { return path.join(ctx.userData(), 'agent-browser'); }
function findChrome() {
  const env = process.env;
  return [path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    .find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
function findNode() {
  try { return require('child_process').execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null; }
  catch (e) { return null; }
}
let browserToolInstall = null;
// → path of the MCP config to hand Claude, or null (no Chrome/Node, or the install failed: the run goes on without a browser)
async function prepareAgentBrowser() {
  const dir = agentBrowserDir(), toolDir = path.join(dir, 'tool');
  const cli = path.join(toolDir, 'node_modules', '@playwright', 'mcp', 'cli.js');
  const chrome = findChrome(), node = findNode();
  if (!chrome || !node) { agentLog('browser: not available (' + (!chrome ? 'no Chrome' : 'no Node') + ')'); return null; }
  if (!fs.existsSync(cli)) {
    browserToolInstall = browserToolInstall || new Promise((resolve) => {
      fs.mkdirSync(toolDir, { recursive: true });
      if (!fs.existsSync(path.join(toolDir, 'package.json'))) fs.writeFileSync(path.join(toolDir, 'package.json'), '{"private":true}');
      agentLog('browser: installing ' + PLAYWRIGHT_MCP);
      const p = require('child_process').spawn('npm', ['install', '--no-audit', '--no-fund', PLAYWRIGHT_MCP], { cwd: toolDir, shell: true, windowsHide: true });
      p.on('error', () => resolve()); p.on('close', () => resolve());
    }).finally(() => { browserToolInstall = null; });
    await browserToolInstall;
    if (!fs.existsSync(cli)) { agentLog('browser: install failed'); return null; }
  }
  const proxy = path.join(dir, 'browser-proxy.js');
  const src = fs.readFileSync(path.join(__dirname, 'browser-proxy.js'), 'utf8');
  try { if (fs.readFileSync(proxy, 'utf8') !== src) fs.writeFileSync(proxy, src); } catch (e) { fs.writeFileSync(proxy, src); }
  const guard = path.join(dir, 'web-guard.js');
  const guardSrc = fs.readFileSync(path.join(__dirname, 'web-guard.js'), 'utf8');
  try { if (fs.readFileSync(guard, 'utf8') !== guardSrc) fs.writeFileSync(guard, guardSrc); } catch (e) { fs.writeFileSync(guard, guardSrc); }
  const cfgFile = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { browser: { command: node,
    args: [proxy, cli, chrome, path.join(dir, 'profile'), String(AGENT_BROWSER_PORT)] } } }));
  return cfgFile;
}
/* His mail is open in the agent browser, and web runs read pages anyone can write: see the mail
   guard in agent/browser-proxy.js. Claude's runs: once a mail page has been seen, the proxy writes
   mailSeenFile(), the browser stays on his mail, and the web-guard hook refuses WebFetch/WebSearch.
   Gemini's runs: mail is off limits (its own web tools can't be stopped mid-run). */
const mailSeenFile = () => path.join(agentBrowserDir(), 'mail-seen.json');
const mailSeen = () => fs.existsSync(mailSeenFile());
function browserCfgFor(baseCfg, mode, approved) { // → this run's MCP config
  const j = JSON.parse(fs.readFileSync(baseCfg, 'utf8'));
  j.mcpServers.browser.env = { TASKS_BROWSER_MAIL: mode, TASKS_BROWSER_TAINT: mailSeenFile(), TASKS_BROWSER_APPROVED: approved ? '1' : '0' };
  const f = path.join(agentBrowserDir(), 'mcp-' + mode + '.json');
  fs.writeFileSync(f, JSON.stringify(j));
  return f;
}
function webGuardSettings() { // → a --settings file with the hook, or null
  const node = findNode();
  if (!node) return null;
  const q = (x) => '"' + String(x).replace(/\\/g, '/') + '"'; // forward slashes: fine for node, and for whichever shell runs hooks
  const f = path.join(agentBrowserDir(), 'web-guard-settings.json');
  fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'WebFetch|WebSearch',
    hooks: [{ type: 'command', command: q(node) + ' ' + q(path.join(agentBrowserDir(), 'web-guard.js')) + ' ' + q(mailSeenFile()), timeout: 15 }] }] } }));
  return f;
}
// his latest reply is a yes to something Claude asked him to say yes to
function saidYes(t) {
  const hist = Array.isArray(t.history) ? t.history : [];
  const lastYou = String(t.reply || (hist.filter((h) => h.who === 'you').slice(-1)[0] || {}).text || '');
  const asked = (hist.filter((h) => h.who === 'claude').slice(-1)[0] || {}).text || '';
  return /^\s*(yes|yep|yeah|yup|y)\b|^\s*(go ahead and )?(submit|send|apply)( it)?\b/i.test(lastYou) && /reply\s*\**\s*yes/i.test(asked);
}
// ⚙ "Open agent browser": so James can watch it or log in to sites he wants Claude to use
async function openAgentBrowser() {
  const chrome = findChrome();
  if (!chrome) return { ok: false, error: 'Chrome isn’t installed' };
  const up = await fetch('http://127.0.0.1:' + AGENT_BROWSER_PORT + '/json/version', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
  const args = up ? ['--user-data-dir=' + path.join(agentBrowserDir(), 'profile'), 'about:blank'] // already open: new tab in it
    : ['--user-data-dir=' + path.join(agentBrowserDir(), 'profile'), '--remote-debugging-port=' + AGENT_BROWSER_PORT,
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', // same as agent/browser-proxy.js
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  fs.mkdirSync(path.join(agentBrowserDir(), 'profile'), { recursive: true });
  require('child_process').spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}
handle('agent:open-browser', () => openAgentBrowser());


// is it running? (its remote control answers on the port)
const agentBrowserUp = () => fetch('http://127.0.0.1:' + AGENT_BROWSER_PORT + '/json/version', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
async function ensureAgentBrowser() {
  if (await agentBrowserUp()) return true;
  const chrome = findChrome();
  if (!chrome) return false;
  fs.mkdirSync(path.join(agentBrowserDir(), 'profile'), { recursive: true });
  require('child_process').spawn(chrome, ['--user-data-dir=' + path.join(agentBrowserDir(), 'profile'), '--remote-debugging-port=' + AGENT_BROWSER_PORT,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--start-minimized',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) { if (await agentBrowserUp()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

module.exports = { init, handlers, AGENT_BROWSER_PORT, BROWSER_DENIED, agentBrowserDir, findChrome, findNode, prepareAgentBrowser,
  mailSeenFile, mailSeen, browserCfgFor, webGuardSettings, saidYes, openAgentBrowser, agentBrowserUp, ensureAgentBrowser };
