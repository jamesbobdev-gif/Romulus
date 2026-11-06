/* Pay with Link (Settings → Agent): his Stripe Link account, connected once, so the Agent can pay at any
   store's card form with a one-time virtual card he approves on his phone (agent/link-pay.js does the paying).
   - Connect: Link's device sign-in. The app opens login.link.com; he signs in there and checks the phrase.
   - The tokens live in config.json under `link` (access_token / refresh_token: sealed like every other key).
   - Before a Claude run the app refreshes the token if it's close to running out and hands the run's "wallet"
     tool a fresh one (agent/agent-browser.js browserCfgFor). The refresh token never leaves the app.
   - Test mode: Link hands out test cards (nothing is charged), for trying it on a store's checkout.
   - Limit: his own cap for one order (Link's is $500). */
const os = require('os');
const path = require('path');
const fs = require('fs');
const link = require('./link-api');

let ctx = null; // { readConfig, writeConfig, agentLog, openExternal, sendToRenderer, userData }
function init(c) { ctx = c; }
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const DEFAULT_CAP = 200; // dollars
const linkCfg = () => (ctx.readConfig().link || {});
function saveLink(change) {
  const c = ctx.readConfig();
  c.link = Object.assign({}, c.link || {}, change);
  for (const k of Object.keys(c.link)) if (c.link[k] === undefined) delete c.link[k];
  ctx.writeConfig(c);
}
const capDollars = (l) => Math.min(500, Math.max(1, Math.round(Number(l.capDollars) || DEFAULT_CAP)));

let login = null; // the sign-in under way: { userCode, url, until }
function status() {
  const l = linkCfg();
  return { connected: !!(l.refresh_token || l.access_token), email: l.email || '', test: !!l.test, capDollars: capDollars(l),
    login: login && Date.now() < login.until ? { userCode: login.userCode, url: login.url } : null };
}
handle('link:status', () => status());

handle('link:connect', async () => {
  let start;
  try { start = await link.startLogin('Romulus', os.hostname()); }
  catch (e) { return Object.assign(status(), { ok: false, error: e.message }); }
  login = { userCode: start.userCode, url: start.url, until: Date.now() + start.expiresIn * 1000 };
  ctx.agentLog('link: sign-in started');
  try { ctx.openExternal(start.url); } catch (e) {}
  (async () => { // waits for him in the background; Settings hears 'link:changed'
    const mine = login;
    while (login === mine && Date.now() < mine.until) {
      await new Promise((r) => setTimeout(r, start.interval * 1000));
      let t = null;
      try { t = await link.pollLogin(start.deviceCode); }
      catch (e) { if (login === mine) login = null; ctx.agentLog('link: ' + e.message); ctx.sendToRenderer('link:changed', Object.assign(status(), { error: e.message })); return; }
      if (!t) continue;
      let email = ''; try { email = ((await link.userInfo(t.access_token)) || {}).email || ''; } catch (e) {}
      saveLink(Object.assign({}, t, { email }));
      if (login === mine) login = null;
      ctx.agentLog('link: connected');
      ctx.sendToRenderer('link:changed', status());
      return;
    }
  })().catch((e) => ctx.agentLog('link: ' + e.message));
  return Object.assign(status(), { ok: true });
});

// "Open Link ↗" again: only the sign-in page Link itself gave (the page never names a URL to open)
handle('link:open', () => { if (login && Date.now() < login.until) { try { ctx.openExternal(login.url); } catch (e) {} } });

handle('link:disconnect', async () => {
  const l = linkCfg();
  login = null;
  if (l.refresh_token) await link.revoke(l.refresh_token);
  saveLink({ access_token: undefined, refresh_token: undefined, expires_at: undefined, email: undefined });
  ctx.agentLog('link: disconnected');
  return status();
});

handle('link:save', (_e, change) => {
  const c = change || {};
  const next = {};
  if (c.test != null) next.test = !!c.test;
  if (c.capDollars != null) next.capDollars = Math.min(500, Math.max(1, Math.round(Number(c.capDollars) || DEFAULT_CAP)));
  saveLink(next);
  return status();
});

// → an access token good for a whole run (refreshed when under 50 minutes are left), or null (not connected / sign-in ran out)
async function tokenForRun() {
  const l = linkCfg();
  if (!l.refresh_token && !l.access_token) return null;
  if (l.access_token && (!l.expires_at || l.expires_at - Date.now() > 50 * 60 * 1000)) return l.access_token;
  if (!l.refresh_token) return null;
  try {
    const t = await link.refresh(l.refresh_token);
    saveLink(t);
    return t.access_token;
  } catch (e) {
    ctx.agentLog('link: ' + e.message);
    if (e.status === 400 || e.status === 401) { saveLink({ access_token: undefined, refresh_token: undefined, expires_at: undefined }); ctx.sendToRenderer('link:changed', status()); }
    return null;
  }
}

// the run's "wallet" MCP server (agent/link-pay.js), started with the same node as the browser launcher.
// Its files are copied next to the launcher: node can't run files from inside app.asar.
function serverFor({ node, dir, token, approved, approvedHosts, cdpPort, cardFlag, mailSeenFile, actionsFile, task }) {
  for (const f of ['link-pay.js', 'link-api.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8'), to = path.join(dir, f);
    try { if (fs.readFileSync(to, 'utf8') !== src) fs.writeFileSync(to, src); } catch (e) { fs.writeFileSync(to, src); }
  }
  const l = linkCfg();
  const env = { LINK_TOKEN: token, LINK_TEST: l.test ? '1' : '0', LINK_CAP_CENTS: String(capDollars(l) * 100), TASKS_CDP_PORT: String(cdpPort),
    TASKS_BROWSER_APPROVED: approved ? '1' : '0', TASKS_CARD_FLAG: cardFlag, TASKS_BROWSER_TAINT: mailSeenFile, TASKS_BROWSER_ACTIONS: actionsFile, TASKS_BROWSER_TASK: String(task || '').slice(0, 120) };
  if (approved && Array.isArray(approvedHosts) && approvedHosts.length) env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(approvedHosts);
  return { command: node, args: [path.join(dir, 'link-pay.js')], env };
}

module.exports = { init, handlers, tokenForRun, serverFor, status };
