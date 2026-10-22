/* Morning look-ahead (agent/look-ahead.js): the renderer asks every 15 minutes; once a day after
   lookAhead.at (07:00 unless changed) this gathers his calendar, recent mail, memory and open tasks,
   asks Claude in one tool-less call, and hands back the proposals for the renderer to put on the
   Agent list as "needs you". What was suggested is remembered for 60 days so it isn't suggested again. */
const fs = require('fs');
const crypto = require('crypto');
const lookAhead = require('../agent/look-ahead');
const { calendarForAgent, agentRow } = require('../agent/task-context');
const usage = require('../agent/usage-limit');
const gmailDates = require('./gmail-dates');

let ctx = null; // { readConfig, writeConfig, agentLog, dataFile }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
let running = false;

const settings = () => Object.assign({ at: '07:00', recent: [] }, readConfig().lookAhead);
function saveSettings(change) {
  const cfg = readConfig(); cfg.lookAhead = Object.assign({}, cfg.lookAhead, change); writeConfig(cfg);
}
// the task id a proposal gets: the same thing → the same id, so a deleted one isn't brought back
const proposalId = (key) => 'look-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

function allTasks() {
  let data; try { data = JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8')); } catch (e) { return []; }
  return Array.isArray(data.tasks) ? data.tasks : [];
}
// his open tasks, soonest first: titles only, so Claude doesn't suggest what's already there
function openTasks(tasks) {
  return tasks.filter((t) => t && !t.done && t.title)
    .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')))
    .slice(0, 120).map((t) => ({ title: String(t.title).replace(/\s+/g, ' ').slice(0, 100), due: t.due || null, list: t.ws || 'personal' }));
}

handle('lookahead:status', () => {
  const s = settings();
  return { enabled: s.enabled !== false, at: s.at, last: s.last || null, lastCount: s.lastCount != null ? s.lastCount : null, error: s.error || null,
    runner: (readConfig().agentRunner || {}).enabled !== false };
});
handle('lookahead:set-enabled', (_e, on) => { saveSettings({ enabled: !!on }); return true; });

// force = "Run now" in Settings (skips the time of day and once-a-day checks)
handle('lookahead:tick', async (_e, force) => {
  const s = settings();
  if ((readConfig().agentRunner || {}).enabled === false) return { skipped: 'runner off' }; // e.g. a second computer: its main one does this
  if (!lookAhead.isDue(s, new Date(), !!force)) return { skipped: 'not due' };
  if (running) return { skipped: 'busy' };
  if (!force && s.error && Date.now() - (s.last || 0) < 60 * 60 * 1000) return { skipped: 'failed recently' }; // back off an hour
  if (Date.now() < usage.blockedUntil()) return { skipped: 'Claude is out of usage' };
  running = true;
  const now = new Date();
  try {
    const calendar = await calendarForAgent({ back: 0, days: 15 });
    let mails = [];
    if (gmailDates.mailAllowed()) {
      try { mails = await lookAhead.recentMail(gmailDates.gmail); } catch (e) { agentLog('look-ahead: mail skipped: ' + e.message); }
    }
    const prefs = await agentRow(':prefs').catch(() => '');
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const recent = (Array.isArray(s.recent) ? s.recent : []).filter((r) => r && r.at > cutoff);
    if (!(calendar && calendar.events.length) && !mails.length && !String(prefs).trim()) {
      saveSettings({ lastDay: lookAhead.dayOf(now), last: Date.now(), lastCount: 0, error: null });
      return { items: [], skipped: 'nothing to look at (connect a calendar or Gmail)' };
    }
    const tasks = allTasks();
    const groceryNext = lookAhead.nextGroceryDay(tasks);
    const input = lookAhead.buildInput({ calendar, mails, prefs, tasks: openTasks(tasks), recent, groceryNext });
    const raw = await gmailDates.claudeJson([{ role: 'system', content: lookAhead.prompt(now) }, { role: 'user', content: input }],
      lookAhead.SCHEMA, { effort: 'medium' });
    let out; try { out = JSON.parse(raw); } catch (e) { throw new Error('the answer wasn’t JSON'); }
    const items = lookAhead.clean(out && out.proposals, { now, recentKeys: recent.map((r) => r.key), groceryNext })
      .map((p) => Object.assign({ id: proposalId(p.key) }, p));
    agentLog('look-ahead: ' + (calendar ? calendar.events.length : 0) + ' event(s), ' + mails.length + ' email(s) → ' + items.length + ' proposal(s)');
    saveSettings({ lastDay: lookAhead.dayOf(now), last: Date.now(), lastCount: items.length, error: null,
      recent: recent.concat(items.map((p) => ({ key: p.key, title: p.title, at: Date.now() }))).slice(-150) });
    return { items };
  } catch (e) {
    agentLog('look-ahead failed: ' + e.message);
    // a failed morning tries again in an hour (see above), not the next day
    saveSettings({ error: e.message.slice(0, 200), last: Date.now() });
    return { error: e.message.slice(0, 200) };
  } finally { running = false; }
});

module.exports = { init, handlers, proposalId };
