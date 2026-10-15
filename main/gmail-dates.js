/* Dates from Gmail (agent/mail-events.js).
   The renderer asks every 15 minutes; an unchanged mailbox costs one tiny Gmail call and no model.
   New mail that mentions a date goes to Claude in one short call: the same signed-in claude CLI the
   agent uses, with no tools, no connectors and a bare system prompt, so a call is ~1-2k tokens. */
const path = require('path');
const os = require('os');
const calendars = require('../agent/calendars');
const mailEvents = require('../agent/mail-events');

let ctx = null; // { readConfig, writeConfig, agentLog }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
let mailChecking = false;
const mailAllowed = () => !!calendars.gmailAccount();
// one structured answer from Claude: messages = [system, user], schema = what the answer must look like
function claudeJson(messages, schema) {
  const cfg = readConfig();
  const exe = (cfg.agentRunner && cfg.agentRunner.command) || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  const model = (cfg.mailEvents && cfg.mailEvents.model) || 'claude-opus-5-5';
  const args = ['-p', '--output-format', 'json', '--model', model, '--effort', 'low', '--tools', '', '--strict-mcp-config',
    '--max-turns', '3', '--system-prompt', messages[0].content, '--json-schema', JSON.stringify(schema)];
  return new Promise((resolve, reject) => {
    const p = require('child_process').spawn(exe, args, { cwd: os.tmpdir(), windowsHide: true });
    let out = '', err = '';
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('Claude took over 3 minutes')); }, 3 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); reject(new Error('couldn’t start Claude: ' + e.message)); });
    p.on('close', () => {
      clearTimeout(killer);
      let r; try { r = JSON.parse(out); } catch (e) { return reject(new Error((err || out || 'no answer from Claude').trim().slice(0, 200))); }
      if (r.is_error || !r.structured_output) return reject(new Error(String(r.result || r.subtype || 'Claude gave no answer').slice(0, 200)));
      resolve(JSON.stringify(r.structured_output));
    });
    p.stdin.end(messages[1].content);
  });
}
handle('mail:status', () => {
  const cfg = readConfig();
  return { connected: (cfg.calAccounts || []).some((a) => a.provider === 'google'), allowed: mailAllowed(), enabled: !(cfg.mailEvents && cfg.mailEvents.enabled === false),
    last: (cfg.mailEvents && cfg.mailEvents.last) || null };
});
handle('mail:set-enabled', (_e, on) => {
  const cfg = readConfig(); cfg.mailEvents = Object.assign({}, cfg.mailEvents, { enabled: !!on }); writeConfig(cfg);
  return true;
});
handle('mail:check', async () => {
  const cfg = readConfig();
  if (!mailAllowed() || (cfg.mailEvents && cfg.mailEvents.enabled === false)) return { skipped: 'off' };
  if (mailChecking) return { skipped: 'busy' };
  mailChecking = true;
  const state = Object.assign({ seen: [] }, cfg.mailEvents && cfg.mailEvents.state);
  try {
    const gmail = async (sub) => {
      const acct = calendars.gmailAccount();
      if (!acct) throw new Error('Gmail isn’t connected');
      const token = await calendars.tokenFor(acct.id);
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + sub, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Gmail HTTP ' + res.status);
      return data;
    };
    const r = await mailEvents.check({ gmail, ask: claudeJson, state });
    if (r.asked) agentLog('mail: ' + r.checked + ' new, ' + r.asked + ' to Claude, ' + r.items.length + ' date(s) found');
    const fresh = readConfig();
    fresh.mailEvents = Object.assign({}, fresh.mailEvents, { state, last: Date.now() });
    writeConfig(fresh);
    return { items: r.items, checked: r.checked, asked: r.asked };
  } catch (e) {
    agentLog('mail check failed: ' + e.message);
    return { error: e.message.slice(0, 200) };
  } finally { mailChecking = false; }
});


module.exports = { init, handlers };
