/* Agent browser: the Tasks app's own Chrome window (own profile in %APPDATA%\Tasks\agent-browser,
   separate from the user's everyday Chrome). Claude drives it through Playwright's MCP server — it
   decides by itself when a task needs it — and it opens only on first use, then stays open. */
const path = require('path');
const fs = require('fs');
const platform = require('./platform');
const { findChrome, findNode } = platform;
const { isYes } = require('./helpers');

let ctx = null; // { userData, readConfig, agentLog }
function init(c) { ctx = c; }
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const AGENT_BROWSER_PORT = 9334;
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';
// things a page could abuse: running its own code, closing the window under him. Uploads go through, but
// the launcher lets only his files for forms (agent/agent-files.js: his resume) past, never another path
const RISKY = ['browser_run_code_unsafe', 'browser_evaluate', 'browser_drop', 'browser_close', 'browser_network_request'];
const BROWSER_DENIED = RISKY.map((n) => 'mcp__browser__' + n);
const agentFiles = require('./agent-files');
const formFilesDir = () => agentFiles.dirFor(ctx.userData());
const formFiles = () => agentFiles.list(formFilesDir()); // [{name, path, size}]

/* Store checkers: Claude's runs can hand the store comparison (prices, fees, deals) to three helpers
   that work at the same time. Each gets its own connection to the agent browser ("shop1".."shop3": the
   same launcher and guards as "browser", so the same logins), works in a tab of its own, and closes it
   when done. They only look: no orders, no account changes, nothing secret typed. */
const SHOPS = ['shop1', 'shop2', 'shop3'];
const SHOP_TOOLS = ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type',
  'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_wait_for', 'browser_tabs', 'browser_take_screenshot', 'browser_handle_dialog'];
const SHOPS_DENIED = SHOPS.flatMap((s) => RISKY.concat('browser_file_upload').map((n) => 'mcp__' + s + '__' + n)); // checkers never upload
function shopAgents() { // → the --agents definitions for a Claude run
  const agents = {};
  SHOPS.forEach((s, i) => {
    agents['store-checker-' + (i + 1)] = {
      description: 'Checks grocery stores in the user\'s agent browser (prices, sizes, delivery and service fees, minimum order, '
        + 'membership deals) and reports back. Give it the stores to check, his ZIP code, how he pays (e.g. EBT) and the items with sizes. Three exist; send them at '
        + 'the same time, each with different stores.',
      tools: SHOP_TOOLS.map((n) => 'mcp__' + s + '__' + n),
      prompt: 'You check grocery stores for the user. The message you get says where he lives (ZIP code) and how he pays; '
        + 'EBT/SNAP, if he uses it, cannot pay fees or tips. You have your own connection to his agent browser, signed in where he is.\n'
        + '- First open a NEW tab (browser_tabs, action "new") and work only in it. Never touch, select or close any other tab. '
        + 'When you are done, close your tab (browser_tabs, action "close"): that always closes your own tab.\n'
        + '- Only look. Never place an order, start a trial or membership, change his account, address or payment, or type a card '
        + 'number, PIN or security code. If a fee only shows in the cart, you may add the items, read the fees, then remove '
        + 'everything you added so the cart is as you found it.\n'
        + '- For each store you were given: does it deliver to his ZIP code (and take EBT online, if he pays with it); delivery fee, service fee, minimum '
        + 'order, any free-delivery or member deal shown while signed in (say if "free" is really a paid trial and its price); and '
        + 'for each item, the best-value option for one person with its size, price and unit price, plus up to 3 other options. '
        + 'If you hit a sign-in page or a captcha, say so and move on.\n'
        + '- Answer in plain lines, one block per store, with the product page link for each item. Say what you could not check.',
    };
  });
  return agents;
}
function agentBrowserDir() { return path.join(ctx.userData(), 'agent-browser'); }
// how the agent browser is started (here, and by browser-proxy.js, which gets these as an argument). It has
// no window of its own: it runs headless and the user watches or takes over inside Tasks (◉ Watch). Headless
// Chrome calls itself "HeadlessChrome" in its user agent; it says plain Chrome instead, so shops treat
// it like his normal browser.
const chromeUA = (chrome) => platform.chromeUA(platform.chromeMajor(chrome));
function chromeArgs(chrome) {
  return ['--user-data-dir=' + path.join(agentBrowserDir(), 'profile'), '--remote-debugging-port=' + AGENT_BROWSER_PORT,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--headless=new', '--window-size=1280,900', '--user-agent=' + chromeUA(chrome),
    // keep drawing in the background, or clicks wait forever for the page to "settle"
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
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
    args: [proxy, cli, chrome, path.join(dir, 'profile'), String(AGENT_BROWSER_PORT), JSON.stringify(chromeArgs(chrome))] } } }));
  return cfgFile;
}
/* His mail is open in the agent browser, and web runs read pages anyone can write: see the mail
   guard in agent/browser-proxy.js. Claude's runs: once a mail page has been seen, the proxy writes
   mailSeenFile(), the browser stays on his mail, and the web-guard hook refuses WebFetch/WebSearch.
   Gemini's runs: mail is off limits (its own web tools can't be stopped mid-run). */
const mailSeenFile = () => path.join(agentBrowserDir(), 'mail-seen.json');
const mailSeen = () => fs.existsSync(mailSeenFile());
/* What the agent did that matters (an order placed, an application sent, mail opened, a file uploaded):
   one JSON line each in <userData>/agent-actions.log, written by the browser launcher as it lets the
   action through, and shown in Settings → What the Agent did. */
const actionsLogFile = () => path.join(ctx.userData(), 'agent-actions.log');
function readActions(max = 200) {
  let text = ''; try { text = fs.readFileSync(actionsLogFile(), 'utf8'); } catch (e) { return []; }
  return text.split('\n').filter(Boolean).slice(-max).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
}
handle('agent:actions', () => readActions());

/* opts (all optional):
   approvedHosts: his yes was to an order or application on these sites, so the order button is unlocked
     there only (another site's "Place order" in the same run still waits)
   hosts: a shopping run is kept to these sites (and links shown on their pages): the stores and the task's own links
   task: the task's title, for the actions log */
function browserCfgFor(baseCfg, mode, approved, startTab, opts = {}) { // → this run's MCP config (startTab: see agent/task-tabs.js)
  const j = JSON.parse(fs.readFileSync(baseCfg, 'utf8'));
  j.mcpServers.browser.env = { TASKS_BROWSER_MAIL: mode, TASKS_BROWSER_TAINT: mailSeenFile(), TASKS_BROWSER_APPROVED: approved ? '1' : '0',
    TASKS_BROWSER_FILES: JSON.stringify(formFiles().map((f) => f.path)), // the only things an upload may send
    TASKS_BROWSER_ACTIONS: actionsLogFile(), TASKS_BROWSER_TASK: String(opts.task || '').slice(0, 120) };
  if (approved && Array.isArray(opts.approvedHosts) && opts.approvedHosts.length) j.mcpServers.browser.env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(opts.approvedHosts);
  if (Array.isArray(opts.hosts) && opts.hosts.length) j.mcpServers.browser.env.TASKS_BROWSER_HOSTS = JSON.stringify(opts.hosts);
  if (startTab) j.mcpServers.browser.env.TASKS_BROWSER_TAB = startTab;
  // Claude's runs (taint mode) also get the store checkers' connections: same launcher, same guards, but
  // never a yes (they only look) and never a file
  if (mode === 'taint') for (const s of SHOPS) j.mcpServers[s] = Object.assign({}, j.mcpServers.browser, { env: Object.assign({}, j.mcpServers.browser.env, { TASKS_BROWSER_APPROVED: '0', TASKS_BROWSER_SHOP: '1', TASKS_BROWSER_FILES: '[]' }) });
  const f = path.join(agentBrowserDir(), 'mcp-' + mode + '.json');
  fs.writeFileSync(f, JSON.stringify(j));
  return f;
}
const hookArg = (x) => '"' + String(x).replace(/\\/g, '/') + '"'; // forward slashes: fine for node, and for whichever shell runs hooks
function webGuardHooks() { // → the hook, for a run's --settings (agent/runner.js), or null
  const node = findNode();
  if (!node) return null;
  return { PreToolUse: [{ matcher: 'WebFetch|WebSearch',
    hooks: [{ type: 'command', command: hookArg(node) + ' ' + hookArg(path.join(agentBrowserDir(), 'web-guard.js')) + ' ' + hookArg(mailSeenFile()), timeout: 15 }] }] };
}
// his latest reply is a yes to something Claude asked him to say yes to
function saidYes(t) {
  const hist = Array.isArray(t.history) ? t.history : [];
  const lastYou = String(t.reply || (hist.filter((h) => h.who === 'you').slice(-1)[0] || {}).text || '');
  const asked = (hist.filter((h) => h.who === 'claude').slice(-1)[0] || {}).text || '';
  return isYes(lastYou) && /reply\s*\**\s*yes/i.test(asked);
}
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return ''; } };
// the sites his yes was about: where the run stopped to ask, the links in the ask, and the cart's or options' links.
// Empty when none is known (then the yes unlocks the order button anywhere, as before).
function approvedHostsFor(t) {
  const hist = Array.isArray(t.history) ? t.history : [];
  const asked = (hist.filter((h) => h.who === 'claude').slice(-1)[0] || {}).text || '';
  const urls = [t.page].concat(asked.match(/https?:\/\/[^\s"'<>)\]]+/g) || [],
    (Array.isArray(t.cart) ? t.cart : []).map((it) => it && it.url), (Array.isArray(t.options) ? t.options : []).map((o) => o && o.url));
  return [...new Set(urls.map(hostOf).filter(Boolean))];
}
// the stores a shopping run may use (agent/runner.js keeps such a run to these plus the task's own links)
const STORE_HOSTS = ['instacart.com', 'walmart.com', 'amazon.com', 'aldi.us', 'kroger.com', 'gianteagle.com', 'marcs.com', 'wholefoodsmarket.com',
  'target.com', 'costco.com', 'doordash.com', 'ubereats.com', 'samsclub.com', 'meijer.com', 'shipt.com'];
// ⚙ "Open the Agent’s browser": make sure it's running; the page then shows it in the live view
async function openAgentBrowser() {
  if (!findChrome()) return { ok: false, error: 'Chrome isn’t installed' };
  return { ok: await ensureAgentBrowser() };
}
handle('agent:open-browser', () => openAgentBrowser());


// is it running? (its remote control answers on the port)
const agentBrowserUp = () => fetch('http://127.0.0.1:' + AGENT_BROWSER_PORT + '/json/version', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
async function ensureAgentBrowser() {
  if (await agentBrowserUp()) return true;
  const chrome = findChrome();
  if (!chrome) return false;
  fs.mkdirSync(path.join(agentBrowserDir(), 'profile'), { recursive: true });
  require('child_process').spawn(chrome, chromeArgs(chrome), { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) { if (await agentBrowserUp()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
// a grocery order he checked off: its store pages (and the store checkers' tabs) are closed. Logins and
// the store's own cart stay, they're in the profile and on the store's side
const STORE_PAGE = /^https?:\/\/([^/]+\.)?(instacart|walmart|amazon|aldi|kroger|gianteagle|marcs|wholefoodsmarket|target|costco|doordash|ubereats)\.[a-z.]+(\/|$)/i;
async function closeStoreTabs() { // → how many it closed
  if (!(await agentBrowserUp())) return 0;
  const base = 'http://127.0.0.1:' + AGENT_BROWSER_PORT;
  const list = await fetch(base + '/json/list', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => []);
  const pages = list.filter((p) => p.type === 'page' && !/^(devtools|chrome-extension):/.test(p.url));
  const shut = pages.filter((p) => STORE_PAGE.test(p.url));
  if (!shut.length) return 0;
  if (shut.length === pages.length) { // never close the last tab: that would quit the browser
    const made = await fetch(base + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (!made) return 0;
  }
  for (const p of shut) await fetch(base + '/json/close/' + p.id, { signal: AbortSignal.timeout(1500) }).catch(() => {});
  return shut.length;
}
// an agent browser left open from before (with a window): close it, so the next one starts without
async function closeWindowedAgentBrowser() {
  if (process.platform !== 'win32') return;
  const prof = path.join(agentBrowserDir(), 'profile').replace(/'/g, "''");
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + prof + "') -and -not $_.CommandLine.Contains('--headless') -and -not $_.CommandLine.Contains('--type=') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  await new Promise((r) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, () => r()));
}

module.exports = { init, handlers, AGENT_BROWSER_PORT, BROWSER_DENIED, SHOPS, SHOPS_DENIED, shopAgents, agentBrowserDir, formFilesDir, formFiles, findChrome, findNode, prepareAgentBrowser,
  mailSeenFile, mailSeen, browserCfgFor, webGuardHooks, hookArg, saidYes, approvedHostsFor, STORE_HOSTS, actionsLogFile, readActions, openAgentBrowser, agentBrowserUp, ensureAgentBrowser, closeStoreTabs, STORE_PAGE, chromeArgs, closeWindowedAgentBrowser };
