/* Claude usage limit: instead of failing, hold the queue until the reset time Claude reports,
   then start by itself. Survives restarts (config.json agentRunner.blockedUntil). */
let ctx = null; // { readConfig, writeConfig, agentLog, sendToRenderer, scheduleAgentRun }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
const sendToRenderer = (ch, p) => ctx.sendToRenderer(ch, p);
const scheduleAgentRun = () => ctx.scheduleAgentRun();

let usageBlockedUntil = 0, usageTimer = null;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseUsageLimit(text) { // → when to try again (ms) if this is a usage-limit message, else null
  const s = String(text || '');
  if (!/usage limit|limit reached|hit your (usage )?limit|out of (extra )?usage|5-hour limit|weekly limit|session limit/i.test(s)) return null;
  const epoch = s.match(/limit reached\|(\d{10,13})/i);
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n; }
  // "resets 3pm", "resets at 3:30 PM", "resets Oct 5, 3pm" (a time needs am/pm, so "Oct 5" isn't read as 5 o'clock)
  const m = s.match(/resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = Number(m[3]); const min = Number(m[4] || 0); const ap = m[5].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    const d = new Date(); d.setSeconds(0, 0); d.setHours(h, min);
    const mi = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
    if (mi >= 0) { d.setMonth(mi, Number(m[2])); if (d.getTime() < Date.now() - 86400000) d.setFullYear(d.getFullYear() + 1); }
    else if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Date.now() + 30 * 60 * 1000; // limit hit, no time given: look again in 30 min
}
function holdForUsage(ids, resetAt) {
  usageBlockedUntil = Math.max(resetAt, Date.now() + 60 * 1000) + 60 * 1000; // a minute's grace after the reset
  try { const cfg = readConfig(); cfg.agentRunner = Object.assign({}, cfg.agentRunner, { blockedUntil: usageBlockedUntil }); writeConfig(cfg); } catch (e) {}
  agentLog('usage limit: holding ' + ids.length + ' task(s) until ' + new Date(usageBlockedUntil).toLocaleString());
  sendToRenderer('agent:waiting', { ids, until: usageBlockedUntil });
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => {
    usageBlockedUntil = 0;
    try { const cfg = readConfig(); if (cfg.agentRunner) { delete cfg.agentRunner.blockedUntil; writeConfig(cfg); } } catch (e) {}
    agentLog('usage should be back: running the queue');
    scheduleAgentRun();
  }, Math.max(1000, usageBlockedUntil - Date.now()));
}
const blockedUntil = () => usageBlockedUntil;
const isHolding = () => !!usageTimer;

module.exports = { init, parseUsageLimit, holdForUsage, blockedUntil, isHolding };
