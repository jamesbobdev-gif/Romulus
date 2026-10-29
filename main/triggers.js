/* Triggers (agent/triggers.js): the window asks every few minutes; this looks, on the computer that runs
   the Agent, for what the armed tasks wait for, and hands back the ones that fired. The window then
   queues each with t.triggered, and the run starts like a repeat's scheduled round.
   - mail: Gmail's historyId first (unchanged = nothing to do, no model); new mail sharing words with a
     trigger goes to Claude in ONE tool-less call (like the dates check), which says which really match.
   - calendar: no model; an event with the trigger's words, once its "hours before" window opens.
   - page: the page is fetched every 6 hours (public hosts only, 1 MB, 20 s) and Claude, tool-less, says
     whether the condition shows on it. It fires once, then not again until the page stops saying so.
   What fired is remembered in config.triggers so an email or an event starts a task once. */
const triggers = require('../agent/triggers');
const calendars = require('../agent/calendars');
const mailEvents = require('../agent/mail-events');
const usage = require('../agent/usage-limit');
const gmailDates = require('./gmail-dates');
const fs = require('fs');

const MAIL_QUERY = 'newer_than:3d -category:promotions -category:social -category:forums -in:chats -in:sent -in:drafts';
const MAIL_MAX = 15;
const PAGE_BYTES = 1024 * 1024;

let ctx = null; // { readConfig, writeConfig, agentLog, dataFile, serverWork }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
let running = false;

const state = () => Object.assign({ mail: { seen: [] }, fired: {}, pageAt: {}, pageYes: {} }, readConfig().triggers);
function saveState(s) {
  const cfg = readConfig();
  // only tasks that still exist keep their memory
  cfg.triggers = { mail: { historyId: s.mail.historyId, seen: (s.mail.seen || []).slice(-500) }, fired: s.fired, pageAt: s.pageAt, pageYes: s.pageYes, last: Date.now() };
  ctx.writeConfig(cfg);
}
function armedTasks() {
  let data; try { data = JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8')); } catch (e) { return []; }
  return (Array.isArray(data.tasks) ? data.tasks : []).filter(triggers.armed);
}
const header = (m, name) => ((m.payload && m.payload.headers) || []).find((h) => h.name.toLowerCase() === name)?.value || '';

async function checkMail(tasks, s) {
  if (!tasks.some((t) => t.trigger.kind === 'mail') || !gmailDates.mailAllowed()) return [];
  const profile = await gmailDates.gmail('profile');
  if (s.mail.historyId && String(profile.historyId) === String(s.mail.historyId)) return [];
  const list = await gmailDates.gmail('messages?maxResults=' + MAIL_MAX + '&q=' + encodeURIComponent(MAIL_QUERY));
  const seen = new Set(s.mail.seen || []);
  const fresh = ((list && list.messages) || []).filter((m) => !seen.has(m.id));
  const mails = [];
  for (const { id } of fresh) {
    const m = await gmailDates.gmail('messages/' + id + '?format=full');
    mails.push({ id, threadId: m.threadId, subject: header(m, 'subject'), from: header(m, 'from').replace(/\s*<[^>]+>/, '').replace(/"/g, ''),
      text: mailEvents.bodyText(m).slice(0, 900), date: Number(m.internalDate) || Date.now() });
  }
  const pairs = triggers.mailCandidates(tasks, mails);
  let fired = [];
  if (pairs.length) {
    if (Date.now() < usage.blockedUntil()) return []; // out of usage: nothing is marked seen, so it's asked next time
    const raw = await gmailDates.claudeJson([{ role: 'system', content: triggers.mailPrompt() }, { role: 'user', content: triggers.mailInput(pairs) }], triggers.MAIL_SCHEMA);
    let out; try { out = JSON.parse(raw); } catch (e) { throw new Error('the answer wasn’t JSON'); }
    fired = triggers.cleanMail(out, pairs);
    agentLog('triggers: ' + pairs.length + ' email(s) looked like a trigger, ' + fired.length + ' matched');
  }
  s.mail.historyId = String(profile.historyId);
  s.mail.seen = [...(s.mail.seen || []), ...fresh.map((m) => m.id)];
  return fired;
}
async function checkCalendar(tasks, s) {
  const span = triggers.calendarSpanMs(tasks);
  if (!span || !(readConfig().calAccounts || []).length) return [];
  const from = new Date(Date.now() - 2 * 3600 * 1000), to = new Date(Date.now() + span);
  const events = (await calendars.upcoming(from, to)).filter((e) => !(e.invite && e.invite.answer === 'declined'));
  return triggers.calendarHits(tasks, events, { fired: s.fired });
}
async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,*/*' } });
  if (!triggers.safeUrl(res.url || url)) throw new Error('redirected somewhere private');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; if (n > PAGE_BYTES) { reader.cancel().catch(() => {}); break; } }
  return triggers.stripHtml(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
}
async function checkPages(tasks, s) {
  const out = [];
  for (const t of tasks) {
    if (t.trigger.kind !== 'page' || !triggers.pageDue(t, s.pageAt)) continue;
    if (Date.now() < usage.blockedUntil()) break;
    s.pageAt[t.id] = Date.now();
    try {
      const text = await fetchPage(t.trigger.url);
      const raw = await gmailDates.claudeJson([{ role: 'system', content: triggers.pagePrompt() }, { role: 'user', content: triggers.pageInput(triggers.clean(t.trigger), text) }], triggers.PAGE_SCHEMA);
      let a; try { a = JSON.parse(raw); } catch (e) { throw new Error('the answer wasn’t JSON'); }
      const hit = triggers.cleanPage(a, t);
      agentLog('triggers: ' + t.trigger.url.slice(0, 60) + ' → ' + (hit ? 'yes' : 'no') + (a && a.evidence ? ' (' + String(a.evidence).slice(0, 80) + ')' : ''));
      // it stays true for days (a sale): the task runs once, and again only after the page stopped saying so
      if (hit && !s.pageYes[t.id]) { s.pageYes[t.id] = true; out.push(hit); }
      else if (!hit) delete s.pageYes[t.id];
    } catch (e) { agentLog('triggers: ' + t.trigger.url.slice(0, 60) + ' failed: ' + e.message); }
  }
  return out;
}

handle('triggers:tick', async () => {
  if (ctx.serverWork && !ctx.serverWork()) return { skipped: 'hub client' };
  if ((readConfig().agentRunner || {}).enabled === false) return { skipped: 'runner off' };
  if (running) return { skipped: 'busy' };
  const tasks = armedTasks();
  if (!tasks.length) return { fired: [] };
  running = true;
  const s = state();
  const fired = [], errors = [];
  try {
    for (const [name, fn] of [['mail', checkMail], ['calendar', checkCalendar], ['page', checkPages]]) {
      try { fired.push(...await fn(tasks, s)); } catch (e) { errors.push(name + ': ' + e.message.slice(0, 120)); agentLog('triggers: ' + name + ' check failed: ' + e.message); }
    }
    for (const f of fired) (s.fired[f.id] = (s.fired[f.id] || []).concat([f.key]).slice(-50));
    const ids = new Set(tasks.map((t) => t.id));
    for (const k of Object.keys(s.fired)) if (!ids.has(k)) delete s.fired[k];
    for (const k of Object.keys(s.pageAt)) if (!ids.has(k)) { delete s.pageAt[k]; delete s.pageYes[k]; }
    saveState(s);
    if (fired.length) agentLog('triggers: ' + fired.length + ' task(s) set off: ' + fired.map((f) => f.what.slice(0, 60)).join(' | '));
    return { fired, errors, checked: Date.now(), watching: tasks.length };
  } finally { running = false; }
});

module.exports = { init, handlers };
