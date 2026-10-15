// The Tasks agent browser's launcher. Claude Code starts this as its "browser" MCP server; it passes
// everything straight through to Playwright's MCP server, which drives the agent browser over a
// localhost-only debugging port. The agent browser (its own Chrome profile, separate from James's
// everyday Chrome) is opened only when Claude first actually uses a browser tool, and it stays open
// after the run, so James can watch, log in to sites, and a half-filled form is still there when he
// says "yes". main.js copies this file next to the tool (node can't run files from inside app.asar).
// Usage: node browser-proxy.js <playwright cli.js> <chrome.exe> <profile dir> <port>
const { spawn } = require('child_process');
const http = require('http');

const [cli, chrome, profile, port] = process.argv.slice(2);
const endpoint = 'http://127.0.0.1:' + port;

function browserUp() {
  return new Promise((resolve) => {
    const req = http.get(endpoint + '/json/version', { timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function ensureBrowser() {
  if (await browserUp()) return;
  if (chrome === 'remote') return; // the browser lives on another machine (the mini PC): never start one here
  const p = spawn(chrome, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
    // keep drawing while covered by other windows, or clicks wait forever for the page to "settle"
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { detached: true, stdio: 'ignore' });
  p.unref(); // outlives this run
  for (let i = 0; i < 40 && !(await browserUp()); i++) await new Promise((r) => setTimeout(r, 250));
}

// TASKS_BROWSER_ARGS (JSON list) replaces the defaults, e.g. a small model gets no automatic page
// outlines or images: it asks for an outline when it needs one
let extraArgs = ['--image-responses', 'allow'];
try { if (process.env.TASKS_BROWSER_ARGS) extraArgs = JSON.parse(process.env.TASKS_BROWSER_ARGS); } catch (e) {}
const child = spawn(process.execPath, [cli, '--cdp-endpoint', endpoint, ...extraArgs],
  { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('exit', (code) => process.exit(code || 0));
process.on('exit', () => { try { child.kill(); } catch (e) {} });

// Chrome doesn't draw a tab that isn't showing, so clicks there wait forever for the page to "settle"
// (e.g. when James left his own Outlook tab in front). Before every action, bring Claude's current
// tab to the front. These extra calls use "proxy-" ids and their answers never reach Claude.
const ACTIONS = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_hover',
  'browser_drag', 'browser_press_key', 'browser_take_screenshot', 'browser_wait_for', 'browser_handle_dialog']);
let own = 0;
const pending = {};
function ownCall(name, args) {
  return new Promise((resolve) => {
    const id = 'proxy-' + (++own);
    pending[id] = resolve;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    setTimeout(() => { if (pending[id]) { delete pending[id]; resolve(null); } }, 10000);
  });
}
const resultText = (m) => (m && m.result && Array.isArray(m.result.content) ? m.result.content.map((c) => c.text || '').join('\n') : '');
// → the current tab's address (or null)
async function frontCurrentTab() {
  const list = resultText(await ownCall('browser_tabs', { action: 'list' }));
  const idx = (list.match(/- (\d+): \(current\)/) || [])[1];
  if (idx != null) await ownCall('browser_tabs', { action: 'select', index: Number(idx) });
  return currentUrl(list);
}
const currentUrl = (text) => (text.match(/^- \d+: \(current\) \[.*\]\(([^()\s]+)\)(?: \[crashed\])?\s*$/m) || [])[1] || null;

/* Mail guard, for Claude's runs on the desktop (TASKS_BROWSER_MAIL). James is logged in to his mail
   (and Google/Microsoft accounts) in this browser, and the same run reads web pages that anyone can
   write. A page could tell Claude to open his mail and then carry what it read off to some server.
     "taint": once a mail page has been seen in this run (opened, or a tab already on it), the run is
       marked in TASKS_BROWSER_TAINT (written before Claude sees the page). From then on: no opening
       other sites, no typing or clicking on a page outside mail, and no Send (or Enter) unless
       TASKS_BROWSER_APPROVED is set (James's latest reply was a yes). main.js's hook refuses
       WebFetch/WebSearch for the rest of the run, and the app treats its answer like an inbox run's.
     "block": mail is off limits (Gemini, which has its own web tools that no hook can stop). */
const MAIL_MODE = process.env.TASKS_BROWSER_MAIL || '';
const TAINT_FILE = process.env.TASKS_BROWSER_TAINT || '';
const MAIL_APPROVED = process.env.TASKS_BROWSER_APPROVED === '1';
// his private pages: mail, and the account pages that hold the same kind of thing
const PRIVATE = ['mail.google.com', 'calendar.google.com', 'contacts.google.com', 'drive.google.com', 'myaccount.google.com',
  'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft', 'onedrive.live.com',
  'mail.yahoo.com', 'mail.proton.me', 'www.icloud.com'];
const LOGIN = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'login.yahoo.com', 'account.proton.me'];
const isPrivate = (url) => hostAllowed(url, PRIVATE);
const mailSide = (url) => /^(about:blank|chrome-error:)/.test(String(url)) || hostAllowed(url, PRIVATE.concat(LOGIN));
let tainted = false;
function taint(url) {
  if (tainted) return;
  tainted = true;
  try { if (TAINT_FILE) require('fs').writeFileSync(TAINT_FILE, JSON.stringify({ url: String(url).slice(0, 200), at: Date.now() })); } catch (e) {}
}
// what a page answer shows: its address, and the current tab in a tab list
const shownUrls = (text) => [...text.matchAll(/^- Page URL: (\S+)/gm)].map((m) => m[1]).concat(currentUrl(text) || []);
const TYPING = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_drag', 'browser_press_key', 'browser_handle_dialog']);
// → a reason to refuse this tool call, or null. `here` is the current tab's address (actions only).
function mailRefusal(msg, here) {
  if (!MAIL_MODE || !msg.params) return null;
  const name = msg.params.name, a = msg.params.arguments || {};
  const to = name === 'browser_navigate' || (name === 'browser_tabs' && a.url) ? String(a.url || '') : null;
  if (MAIL_MODE === 'block') {
    if ((to && isPrivate(to)) || (here && isPrivate(here))) return 'His mail and account pages are not available in this run. Say in your note what you could not check.';
    return null;
  }
  if (here && isPrivate(here)) taint(here); // e.g. a tab left on his inbox
  if (to && isPrivate(to)) { taint(to); return null; }
  if (!tainted) return null;
  const why = 'This run has opened James\'s mail, so it can no longer use other sites (a page could have asked for his mail to be sent somewhere). ';
  if (to && !mailSide(to)) return why + 'Finish the mail part and say in your note what is left; the rest runs next time.';
  if (TYPING.has(name) && here && !mailSide(here)) return why + 'This page (' + here.slice(0, 80) + ') is outside his mail.';
  if (!MAIL_APPROVED) {
    const label = name === 'browser_click' ? (refLabels[a.target || a.ref] || '') + ' ' + String(a.element || '') : '';
    if (FINAL.test(label)) return 'Not without a yes: "' + label.trim() + '" looks like Send or another final step. List exactly what you will send in your note and ask James to reply yes.';
    if ((name === 'browser_press_key' && /(^|\+)\s*(numpad)?enter\s*$/i.test(String(a.key || ''))) || (name === 'browser_type' && a.submit))
      return 'Not without a yes: Enter can send. Ask James to reply yes first.';
  }
  return null;
}
// Playwright's answer → the line to pass on: marks the run when it shows a mail page, or (block mode) hides it
function mailFilter(line) {
  if (!MAIL_MODE || !/mail|outlook|google|icloud|onedrive|proton/i.test(line)) return line;
  let m = null; try { m = JSON.parse(line); } catch (e) { return line; }
  if (!m || m.id == null || !m.result) return line;
  const hit = shownUrls(resultText(m)).find(isPrivate);
  if (!hit) return line;
  if (MAIL_MODE === 'block') return JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'That tab is on his mail or account pages, which are not available in this run. Open another page.' }], isError: true } }) + '\n';
  taint(hit);
  return line;
}

/* Locked mode, for the mini PC's local lane (James's own model, which also holds his private profile).
   Off unless TASKS_BROWSER_LOCK names a JSON file the dispatcher writes for the task being worked:
     { "allow": ["https://…links from the note…"], "approved": false }
   - only pages on the hosts of those links can be opened (typed addresses; links clicked inside a
     site can still lead elsewhere, so the model is also told to stay put)
   - "final" clicks (submit, send, buy, pay, book, apply, delete…) and pressing Enter are refused
     until "approved" is true, which the dispatcher sets only when James's latest reply is a yes */
const LOCK_FILE = process.env.TASKS_BROWSER_LOCK || '';
const FINAL = /\b(submit|send|place (your )?order|buy|purchase|pay|check ?out|confirm|book|reserve|apply|sign ?up|register|enroll|delete|remove|unsubscribe|cancel|post|publish|transfer|donate)\b/i;
// signing out is never part of a task, even after a yes: it ends the logins James made on the mini PC
// (Blackboard, D2L…), and only he can sign back in
const SIGN_OUT = /\b(sign|log) ?(out|off)\b|logout|signout|logoff/i;
function lockState() {
  if (!LOCK_FILE) return null;
  try {
    const j = JSON.parse(require('fs').readFileSync(LOCK_FILE, 'utf8'));
    const hosts = (Array.isArray(j.allow) ? j.allow : []).map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return null; } }).filter(Boolean);
    return { hosts, approved: j.approved === true };
  } catch (e) { return { hosts: [], approved: false }; } // unreadable lock file: lock everything
}
const hostAllowed = (url, hosts) => {
  try { const h = new URL(url).hostname.toLowerCase(); return hosts.some((a) => h === a || h.endsWith('.' + a)); } catch (e) { return false; }
};
const refLabels = {}; // ref → accessible name, learned from every page snapshot Playwright sends back
function learnRefs(text) {
  for (const m of text.matchAll(/- (\w+) "([^"\n]*)"[^\n]*\[ref=(\w+)\]/g)) refLabels[m[3]] = m[1] + ' ' + m[2];
  for (const m of text.matchAll(/- (\w+)[^\n"]*\[ref=(\w+)\][^\n:]*: ([^\n]+)/g)) if (!refLabels[m[2]]) refLabels[m[2]] = m[1] + ' ' + m[3];
}
// → a reason to refuse this tool call, or null
function lockedOut(msg) {
  const lock = lockState();
  if (!lock || !msg.params) return null;
  const name = msg.params.name, a = msg.params.arguments || {};
  if (name === 'browser_navigate' || (name === 'browser_tabs' && a.url)) {
    if (!hostAllowed(String(a.url || ''), lock.hosts)) return 'This browser is locked to the links in the task (' + (lock.hosts.join(', ') || 'none') + '). ' + a.url + ' is not one of them.';
    if (SIGN_OUT.test(String(a.url || ''))) return 'Locked: never sign out. James stays logged in to his sites on this browser.';
  }
  const label = name === 'browser_click' ? (refLabels[a.target || a.ref] || '') + ' ' + String(a.element || '') : '';
  if (SIGN_OUT.test(label)) return 'Locked: "' + label.trim() + '" would sign James out. Never sign out; carry on with the task.';
  if (lock.approved) return null;
  if (name === 'browser_click') {
    if (FINAL.test(label)) return 'Locked: "' + label.trim() + '" looks like a final step (submit, send, buy, book…). Stop here and ask James to reply yes.';
  }
  // any Enter: "Enter", "NumpadEnter", "Shift+Enter", "Control+Enter"… all submit a form
  if ((name === 'browser_press_key' && /(^|\+)\s*(numpad)?enter\s*$/i.test(String(a.key || ''))) || (name === 'browser_type' && a.submit))
    return 'Locked: pressing Enter can submit a form. Click the field-by-field controls instead, and ask James to reply yes before submitting.';
  return null;
}

// Playwright → Claude: pass everything through except the answers to our own calls
let outBuf = '';
child.stdout.on('data', (d) => {
  outBuf += d;
  let i;
  while ((i = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, i + 1); outBuf = outBuf.slice(i + 1);
    if ((LOCK_FILE || MAIL_MODE) && line.includes('[ref=')) { try { learnRefs(resultText(JSON.parse(line))); } catch (e) {} }
    if (line.includes('"proxy-')) {
      let m = null; try { m = JSON.parse(line); } catch (e) {}
      if (m && typeof m.id === 'string' && m.id.startsWith('proxy-')) {
        if (pending[m.id]) { const r = pending[m.id]; delete pending[m.id]; r(m); }
        continue; // ours (or a late answer to one of ours)
      }
    }
    process.stdout.write(mailFilter(line));
  }
});

// Claude → Playwright: newline-delimited JSON-RPC, forwarded in order; the browser is opened before
// the first tool call, and Claude's tab is brought to the front before each action
let buf = '', started = false, chain = Promise.resolve();
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i + 1); buf = buf.slice(i + 1);
    chain = chain.then(async () => {
      if (/"method"\s*:\s*"tools\/call"/.test(line)) {
        if (!started) { started = true; await ensureBrowser(); }
        let msg = null; try { msg = JSON.parse(line); } catch (e) {}
        const here = msg && msg.params && ACTIONS.has(msg.params.name) ? await frontCurrentTab() : null;
        const refused = msg && (lockedOut(msg) || mailRefusal(msg, here));
        if (refused) { // answer it ourselves; Playwright never sees the call
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: refused }], isError: true } }) + '\n');
          return;
        }
      }
      child.stdin.write(line);
    });
  }
});
process.stdin.on('end', () => { chain.then(() => child.stdin.end()); });
