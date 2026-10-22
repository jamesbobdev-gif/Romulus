/* Agent runner (the Claude lane).
   When an Agent-tab task is queued (new, or the user replied), start a headless
   Claude Code session with ONLY web search/fetch, hand it the queued tasks +
   his preferences, and pass its JSON answer to the renderer, which applies it
   and syncs like any other edit. Claude never touches the sync data itself.
   Which cloud AI answers, in what order, is agent/ai-connections.js; the mini PC lane is agent/local-lane.js. */
const path = require('path');
const fs = require('fs');
const { claudeExe, claudeEnv } = require('./platform');
const os = require('os');
const providers = require('./providers');
const usage = require('./usage-limit');
const meter = require('./usage-meter');
const { parseUsageLimit, holdForUsage } = usage;
const { routeTask, isClaudeLane, decided } = require('./routing');
const { cloudOrder, cloudReady, runOrder, homeCloud, claudeLast, couldntDo, PINNED_CLOUDS } = require('./ai-connections');
const { BROWSER_DENIED, findNode, prepareAgentBrowser, mailSeenFile, mailSeen, browserCfgFor, webGuardHooks, saidYes, closeStoreTabs, SHOPS, SHOPS_DENIED, shopAgents, formFiles } = require('./agent-browser');
const agentFiles = require('./agent-files');
const runLive = require('./run-live');
const taskTabs = require('./task-tabs');
const { reconnectTitle, CLAUDE_AUTH_RE } = require('./reconnect');
const { wantsCalendar, calendarForAgent, loadSkills, wantsNearby, taskLinks, howtos, howtosFor, learnHowto, siteNotesFor, skillText,
  wantsInbox, agentRow, prefLine, cleanAsk, cleanCart, claimAgentTasks } = require('./task-context');
const { cleanSeats, cleanShowtimes, cleanTheaters, placeTheaters } = require('./seats');
const where = require('./where');
const siteNotes = require('./site-notes');
const { enrichOption, pagePreviewImage } = require('./previews');

// Claude comes after the AI being asked: what it can't do goes to Claude, rather than back to him as needs-you
const CLAUDE_AFTER_NOTE = '\n\n## Handing over\nClaude (with a full browser, his inbox and his photos) comes after you in this run. If a ' +
  'task needs a tool you don\'t have here (a browser to shop, order or check live prices, his inbox, a photo), leave that task out of ' +
  '`updates` entirely and Claude will take it. This replaces the needs-you advice below for those tasks; everything you can do, do.\n';
// the same for an AI that has the agent browser this run: shopping and prices are its to do, only his inbox or a photo goes to Claude
const CLAUDE_AFTER_BROWSER_NOTE = '\n\n## Handing over\nClaude (with his inbox and his photos) comes after you in this run. If a ' +
  'task needs his inbox or a photo, leave that task out of `updates` entirely and Claude will take it. You have the browser_* tools: ' +
  'shopping, live prices and orders are yours to do, not to hand over. This replaces the needs-you advice below for those tasks; ' +
  'everything you can do, do.\n';

let ctx = null; // { userData, documents, readConfig, dataFile, agentLog, sendToRenderer, memoryTidying }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();
const agentLog = (m) => ctx.agentLog(m);
const sendToRenderer = (ch, p) => ctx.sendToRenderer(ch, p);

const AGENT_GRACE_MS = 8 * 1000;        // let a burst of edits settle first
const { groceryBrief, groceryChanges, groceryListFor, lastOrderFor } = require('./grocery');
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // a stuck run is killed (browser tasks take a while)
const GROCERY_TIMEOUT_MS = 40 * 60 * 1000; // a grocery order fills a whole cart and compares sizes: it gets longer
let runTimeoutMs = AGENT_TIMEOUT_MS; // this run's limit
const AGENT_RETRY_MS = 30 * 60 * 1000;  // same queue failing again → back off
const FROZE_MS = 60 * 1000;              // the clock jumped this far between beats: the computer slept and the run froze
let agentTimer = null, agentProc = null, agentLastKey = '', agentLastAt = 0;
let runIds = [], runRetried = false; // the tasks the current run has, and whether he pressed Retry on one
let live = null; // the current run's plan, steps and his mid-run messages (agent/run-live.js)

// what a run may do in Gmail when a task asks for an inbox check: look, never touch
const GMAIL_READ_TOOLS = ['search_threads', 'get_thread', 'get_message', 'list_labels'].map((n) => 'mcp__claude_ai_Gmail__' + n);
const GMAIL_WRITE_TOOLS = ['send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'delete_draft', 'get_draft', 'list_drafts',
  'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread', 'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam',
  'unmark_thread_spam', 'label_message', 'label_thread', 'unlabel_message', 'unlabel_thread', 'update_message_labels', 'create_label',
  'update_label', 'delete_label', 'apply_sensitive_message_label', 'apply_sensitive_thread_label'].map((n) => 'mcp__claude_ai_Gmail__' + n);
// its own checklist: the plan shown on the task while it works (agent/run-live.js)
const PLAN_TOOLS = 'TaskCreate,TaskUpdate';
const OTHER_CONNECTORS = ['Claude_Docs', 'Tasks', 'Microsoft_365', 'Gamma', 'Figma', 'Excalidraw', 'Zapier', 'Supabase', 'Slack',
  'Interactive_Brokers_IBKR', 'Canva', 'Notion', 'Google_Drive', 'Google_Calendar'].map((n) => 'mcp__claude_ai_' + n);
function queuedAgentTasks(raw) {
  let data;
  try { data = JSON.parse(raw != null ? raw : fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return []; }
  return (Array.isArray(data.tasks) ? data.tasks : [])
    .filter((t) => t.ws === 'agent' && !t.done && (t.status || 'queued') === 'queued' && isClaudeLane(t));
}
// a grocery task newly checked off (by him, or done after the order went through): this save already holds
// its notes (how-to, preferences, list.bought), so its store tabs close now, or when the run going ends
let doneSeen = null, closeTabsAfterRun = false;
function groceryDone(raw) {
  let list; try { list = JSON.parse(raw).tasks || []; } catch (e) { return; }
  const done = new Set(list.filter((t) => t.done || t.status === 'done').map((t) => t.id));
  const seen = doneSeen; doneSeen = done;
  if (!seen) return; // the first save since the app opened: nothing to compare with
  const fresh = list.filter((t) => t.ws === 'agent' && done.has(t.id) && !seen.has(t.id));
  if (!fresh.length) return;
  const g = loadSkills().find((s) => s.name === 'groceries');
  if (g && g.match && fresh.some((t) => g.match.test(skillText(t)))) closeTabsAfterRun = true;
}
function scheduleAgentRun(raw) {
  if (raw != null) groceryDone(raw);
  if (closeTabsAfterRun && !isBusy()) {
    closeTabsAfterRun = false;
    closeStoreTabs().then((n) => { if (n) agentLog('grocery order done: closed ' + n + ' store tab(s)'); }).catch(() => {});
  }
  if (live && raw != null) live.forward(raw); // he wrote on a task Claude is working on: it hears it now
  if ((readConfig().agentRunner || {}).enabled === false) return;
  if (!decided(raw)) return; // d1 is looking at new tasks first: this runs again when it's done
  const queued = queuedAgentTasks(raw);
  const n = queued.length;
  if (!n) return;
  // Claude out of usage and no other AI connected: mark new ones as waiting, the timer starts them
  if (Date.now() < usage.blockedUntil() && !cloudOrder().some((id) => id !== 'claude')) {
    sendToRenderer('agent:waiting', { ids: queued.map((t) => t.id), until: usage.blockedUntil() });
    if (!usage.isHolding()) holdForUsage(queued.map((t) => t.id), usage.blockedUntil() - 60 * 1000);
    return;
  }
  if (!agentTimer) agentLog('queued: ' + n + ' task(s), starting in ' + (AGENT_GRACE_MS / 1000) + 's');
  clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    agentTimer = null;
    startAgentRun().catch((e) => { agentProc = null; agentLog('run crashed: ' + (e && e.stack || e)); });
  }, AGENT_GRACE_MS);
}
function failAgentTasks(ids, why) {
  sendToRenderer('agent:results', ids.map((id) => ({ id, status: 'needs-you',
    note: 'Couldn’t finish this one (' + why + '). Reply to try again.', options: undefined, pref: null })));
}
async function startAgentRun() {
  if (agentProc || ctx.memoryTidying()) { agentLog('skip: a run is already going'); return; } // it re-checks the queue when it exits
  if (!decided()) return; // a task came in after the timer started: d1 looks first, then this is scheduled again
  const cfg = readConfig().agentRunner || {};
  const all = queuedAgentTasks();
  if (!all.length) { agentLog('skip: nothing queued any more'); return; }
  // Gmail and the web never share a run: an email (or a page) could tell Claude to send his mail to
  // some server, and a run that can read mail has no way to reach one. Inbox tasks go first, on their
  // own; the rest wait for the next run. agentRunner.gmail=true makes every task an inbox task.
  // Tasks he put on Gemini or ChatGPT (the pill) run on their own too, with that AI only (neither reads his inbox).
  // A task already on an AI (the one that answered it last) runs with that AI too, so a conversation
  // doesn't hop between them: it only moves on when that AI is out of usage (see the loop below).
  const on = cloudOrder(), saveClaude = claudeLast();
  const kindOf = (t) => {
    if (PINNED_CLOUDS.includes(t.cloud)) return t.cloud;
    if (cfg.gmail === true || wantsInbox(t)) return 'mail';
    const home = homeCloud(t, saveClaude);
    return home && on.includes(home) ? home : 'web'; // an AI he has since turned off: his order instead
  };
  const kind = ['mail', 'web', 'claude', ...PINNED_CLOUDS].find((k) => all.some((t) => kindOf(t) === k));
  const mailRun = kind === 'mail', pinned = kind === 'mail' || kind === 'web' ? null : kind;
  let queued = all.filter((t) => kindOf(t) === kind);
  // a yes unlocks final clicks (placing an order) for the whole run, so a task he said yes to runs on
  // its own: his yes on one task never lets the browser buy or send for another. The rest go next run.
  const yesTask = queued.find(saidYes);
  if (yesTask && queued.length > 1) queued = [yesTask];
  // same queue as the last run and nothing moved: that run failed — don't hammer it. Checked before
  // claiming: a claimed task we then skip would sit as "working" on the server with nobody on it
  const queuedKey = queued.map((t) => t.id).sort().join(',');
  if (queuedKey === agentLastKey && Date.now() - agentLastAt < AGENT_RETRY_MS) { agentLog('skip: same queue failed recently'); return; }
  agentProc = 'claiming'; // hold the lock while we talk to the server
  let tasks;
  try { tasks = await claimAgentTasks(queued); } finally { agentProc = null; }
  if (!tasks.length) { agentLog('skip: every queued task was taken by another worker'); return; }
  const ids = tasks.map((t) => t.id).sort();
  agentLastKey = ids.join(','); agentLastAt = Date.now();

  const exe = claudeExe({ agentRunner: cfg });
  let rules;
  try { rules = fs.readFileSync(path.join(__dirname, 'instant-prompt.md'), 'utf8'); } catch (e) { agentLog('cannot read instructions: ' + e.message); return; }
  const prefs = await agentRow(':prefs');
  // photos the user attached (this reply + the latest few earlier ones) → ./attachments/<task>/ so
  // Claude can open them with its Read tool; only files from his own attachments bucket
  const workDir = path.join(ctx.documents(), 'Claude Agent');
  const attDir = path.join(workDir, 'attachments');
  try { fs.rmSync(attDir, { recursive: true, force: true }); } catch (e) {}
  const a = ((readConfig().sync) || {}).agent || {};
  const allowedPrefix = a.url ? a.url.replace(/\/+$/, '') + '/storage/v1/object/public/agent-attachments/' : null;
  const photos = {};
  for (const t of tasks) {
    const urls = [];
    (Array.isArray(t.replyImages) ? t.replyImages : []).forEach((u) => urls.push(u));
    (Array.isArray(t.history) ? t.history : []).slice().reverse().forEach((h) => (Array.isArray(h.images) ? h.images : []).forEach((u) => urls.push(u)));
    const keep = [...new Set(urls)].filter((u) => allowedPrefix && String(u).startsWith(allowedPrefix)).slice(0, 6);
    const files = [];
    for (let i = 0; i < keep.length; i++) {
      try {
        const r = await fetch(keep[i], { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 6 * 1024 * 1024) continue;
        const dir = path.join(attDir, t.id); fs.mkdirSync(dir, { recursive: true });
        const name = (i + 1) + '.jpg'; fs.writeFileSync(path.join(dir, name), buf);
        files.push({ file: 'attachments/' + t.id + '/' + name, latestReply: (t.replyImages || []).includes(keep[i]) });
      } catch (e) {}
    }
    if (files.length) photos[t.id] = files;
  }
  if (Object.keys(photos).length) agentLog('photos for Claude: ' + Object.values(photos).reduce((n, f) => n + f.length, 0));
  const calendar = tasks.some(wantsCalendar) ? await calendarForAgent() : null;
  if (calendar) agentLog('calendar: ' + calendar.events.length + ' event(s) handed over');
  let allTasks = [];
  try { allTasks = JSON.parse(fs.readFileSync(dataFile(), 'utf8')).tasks || []; } catch (e) {}
  // where he is now, for near-me tasks (theaters, stores, restaurants, groceries): closest first
  const allSkills = loadSkills();
  const nearMe = tasks.filter((t) => wantsNearby(t, allSkills)).map((t) => t.id);
  const here = nearMe.length ? await where.hereNow().catch(() => null) : null;
  if (nearMe.length) agentLog(here ? 'location: handed over (±' + (here.accuracyM || '?') + ' m)' : 'location: unavailable (Windows location off?)');
  const brief = tasks.map((t, i) => ({ id: t.id, n: tasks.length > 1 ? i + 1 : undefined, title: t.title, due: t.due, dueTime: t.dueTime, tag: t.tag,
    photos: photos[t.id] || undefined, // files to open with the Read tool (paths relative to your working folder)
    note: t.note || null, reply: t.reply || null,
    instructions: t.notes || null, // e.g. a school assignment's rules, carried over when it was handed to Claude
    options: Array.isArray(t.options) ? t.options.map((o) => ({ label: o.label, url: o.url })) : null,
    groceryList: groceryBrief(groceryListFor(t, allTasks)), // his usual groceries; `due` = goes on the next order
    lastOrder: groceryListFor(t, allTasks) ? lastOrderFor(allTasks) : undefined, // what he got last time, with pictures
    // the task's back-and-forth so far (oldest first), so Claude remembers earlier answers and picks
    conversation: Array.isArray(t.history) ? t.history.slice(-20).map((h) => ({ from: h.who, text: String(h.text || '').slice(0, 600),
      shown: Array.isArray(h.options) ? h.options : undefined,
      sentPhotos: Array.isArray(h.images) && h.images.length ? h.images.length : undefined })) : [],
    repeats: t.repeat ? { every: t.repeat.every, at: t.repeat.at } : null,
    scheduledRun: !!t.repeatDue,
    checkInboxFirst: wantsInbox(t) ? true : undefined,
    calendar: calendar && wantsCalendar(t) ? calendar : undefined,
    whereHeIsNow: here && nearMe.includes(t.id) ? here : undefined, // from this computer's location, for "near me"
    howTo: (() => { const h = howtosFor(t); return h.length ? h.map(howtos.show) : undefined; })() }));
  // skills: the ones matching these tasks go in full; the rest are listed so Claude can open them itself
  const skills = loadSkills();
  // tasks a `browser: yes` skill matches (seat maps, carts, forms): Gemini won't hand those to Flash-Lite
  const needsBrowsing = (ids) => tasks.some((t) => ids.includes(t.id) && skills.some((s) => s.browser && s.match && s.match.test(skillText(t))));
  const loaded = skills.filter((s) => tasks.some((t) => s.match && s.match.test(skillText(t)))).slice(0, 4);
  if (loaded.length) agentLog('skills: ' + loaded.map((s) => s.name).join(', '));
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const sd = path.join(workDir, 'skills');
    fs.rmSync(sd, { recursive: true, force: true }); fs.mkdirSync(sd, { recursive: true });
    for (const s of skills) fs.writeFileSync(path.join(sd, s.name + '.md'), s.raw);
  } catch (e) { agentLog('skills copy failed: ' + e.message); }
  const skillPart = !skills.length ? '' : '\n\n## Skills\nIndex (open any with the Read tool: skills/<name>.md):\n' +
    skills.map((s) => '- ' + s.name + ': ' + s.description).join('\n') +
    (loaded.length ? '\n\nLoaded for these tasks:\n\n' + loaded.map((s) => s.body.trim()).join('\n\n') : '');
  // notes on the sites these tasks link to
  const notes = siteNotesFor(tasks.flatMap(taskLinks), 4);
  const notePart = notes.length ? '\n\n## Site notes\n' + notes.map(siteNotes.show).join('\n\n') : '';
  // only the tasks still unanswered: a later AI in the order gets just the ones the earlier ones failed or skipped
  // the checklist and mid-run messages are Claude's only (agent/run-live.js): the others don't get that part
  const promptFor = (want, id) => (id === 'claude' ? rules : rules.replace(/## Show your plan[\s\S]*?(?=## How to handle)/, '')) + skillPart + notePart +'\n\n## The user\'s preferences\n' + (prefs.trim() || '(none yet)') +
    (browses(id) ? filesPart : '') +
    '\n\n## Tasks (data)\n```json\n' + JSON.stringify(brief.filter((b) => want.includes(b.id)), null, 1) + '\n```\n' +
    (id !== 'claude' && order.indexOf('claude') > order.indexOf(id) ? (browses(id) ? CLAUDE_AFTER_BROWSER_NOTE : CLAUDE_AFTER_NOTE) : '');
  // his files for forms (the resume), for a run with the browser: name and the full path the upload tool takes
  const filesPart = (() => { const f = formFiles(); return f.length ? '\n\n## His files for forms\nHis own documents, for a site that asks for a resume or the like (the agent browser rules say how). ' +
    'Give browser_file_upload the full path as written here; no other file can be sent:\n' + agentFiles.brief(f) : ''; })();
  // which AIs get the agent browser this run (see the calls below): all of them, but the free ones only when he turned it on for that one
  const browses = (id) => !!browserCfg && (!providers.COMPAT[id] || providers.settings(readConfig())[id + 'Browser']);

  // why each newly routed task went to Claude (shown on the task)
  sendToRenderer('agent:working', { ids, lane: 'claude', reasons: Object.fromEntries(tasks.filter((t) => !t.lane).map((t) => [t.id, routeTask(t).reason])) });
  // inbox runs never get the agent browser (see mailRun above)
  const browserCfg = mailRun || cfg.browser === false ? null : await prepareAgentBrowser().catch((e) => { agentLog('browser: ' + e.message); return null; });
  const grocer = loadSkills().find((s) => s.name === 'groceries');
  runTimeoutMs = grocer && grocer.match && tasks.some((t) => grocer.match.test(skillText(t))) ? GROCERY_TIMEOUT_MS : AGENT_TIMEOUT_MS;
  // the cloud AIs he connected, in his order (⚙ Settings → AI connections): a task one of them fails
  // (out of usage, signed out, crashed, no usable answer, or skipped it) goes to the next, until all are
  // answered. A task already on an AI (pinned = the pill, or whoever answered it last) tries that one
  // first; its pill follows whichever AI takes over. (Inbox runs: Claude only.)
  const order = runOrder({ order: cloudOrder(), pinned, mailRun, ready: cloudReady });
  if (!order.length) { failAgentTasks(ids, pinned ? providers.NAMES[pinned] + ' isn’t set up: connect it in Settings → AI connections' : 'no AI is connected: turn one on in Settings → AI connections'); agentLastKey = ''; return; }
  if (pinned && order[0] !== pinned) agentLog(providers.NAMES[pinned] + ' isn’t set up: trying the others');
  let pending = ids.slice(), claudeResetAt = null, lastWhy = 'no usable answer';
  const answered = []; // every update gets {_via, _sawMail} from the try that answered it
  // an answer saying it couldn't do the task waits here while the next AI tries; it's what he gets if none can
  const held = {}, gaveUp = {};
  // its own tabs (agent/task-tabs.js): tabs of tasks he hasn't finished stay open for ◉ Watch
  const openIds = allTasks.filter((t) => t.ws === 'agent' && !t.done && t.status !== 'done').map((t) => t.id);
  const startTab = browserCfg ? await taskTabs.startRun(ids, openIds).catch(() => null) : null;
  let endPageP = null;
  agentProc = 'running'; runIds = ids; runRetried = false;
  // a run must not be cut off by this computer idling to sleep. A closed lid (or Modern Standby with the screen
  // off) still freezes it: a beat that comes late tells us, and then the run starts over once it's awake, with
  // the same AI, instead of each AI in turn "failing" on a dead connection (they used to, after hours asleep)
  const awake = ctx.powerSaveBlocker.start('prevent-app-suspension');
  let beat = Date.now(), slept = false;
  const froze = () => {
    if (slept) return;
    slept = true; agentLog('this computer went to sleep mid-run: starting it over');
    if (agentProc && typeof agentProc.kill === 'function') { try { agentProc.kill(); } catch (e) {} }
  };
  const beats = setInterval(() => { if (Date.now() - beat > FROZE_MS) froze(); beat = Date.now(); }, 5000);
  live = runLive.start({ dir: path.join(ctx.userData(), 'agent-run'), tasks: brief.map((b) => ({ id: b.id, title: b.title })), send: sendToRenderer, node: findNode() });
  try {
    for (const id of order) {
      if (!pending.length || runRetried || slept) break;
      if (id === 'claude' && Date.now() < usage.blockedUntil()) continue; // still out of usage
      agentLog('asking ' + providers.NAMES[id] + ' (' + pending.length + ' task(s))');
      // its pill moves to this AI, and the task stays on it; limitMs = when this try gets killed (the app's watchdog waits that long)
      sendToRenderer('agent:working', { ids: pending, lane: 'claude', cloud: id, limitMs: runTimeoutMs });
      try { fs.rmSync(mailSeenFile(), { force: true }); } catch (e) {} // each try starts with his mail unseen
      const prompt = promptFor(pending, id);
      const r = id === 'claude' ? await runClaudeOnce({ exe, cfg, mailRun, workDir, prompt,
          browserCfg: browserCfg && browserCfgFor(browserCfg, 'taint', tasks.length === 1 && saidYes(tasks[0]), startTab) }).finally(() => live.close())
        : id === 'gemini' ? await providers.runGemini(readConfig(), { prompt, workDir, browserMcpFile: browserCfg && browserCfgFor(browserCfg, 'block', false, startTab), browserDenied: BROWSER_DENIED,
          timeoutMs: runTimeoutMs, node: findNode(), onProc: (p) => { agentProc = p; }, noLite: !!browserCfg && needsBrowsing(pending) })
        : id === 'openai' ? await providers.runOpenAI(readConfig(), { prompt, timeoutMs: runTimeoutMs, node: findNode(),
          browserMcpFile: browserCfg && browserCfgFor(browserCfg, 'block', false, startTab), browserDenied: BROWSER_DENIED, onProc: (p) => { agentProc = p; } })
        // the ones answering one request at a time get the browser through the app's tool loop (agent/tool-loop.js);
        // the free ones only when he turned it on for that one (<id>Browser)
        : providers.COMPAT[id] ? await providers.runCompat(id, readConfig(), { prompt, timeoutMs: runTimeoutMs,
          browserMcpFile: browserCfg && browserCfgFor(browserCfg, 'block', false, startTab), browserDenied: BROWSER_DENIED, onProc: (p) => { agentProc = p; } })
        : await providers.runOpenRouter(readConfig(), { prompt, timeoutMs: runTimeoutMs,
          browserMcpFile: browserCfg && browserCfgFor(browserCfg, 'block', false, startTab), browserDenied: BROWSER_DENIED, onProc: (p) => { agentProc = p; } });
      if (Date.now() - beat > FROZE_MS) froze(); // it came back before the next beat
      if (slept) break; // whatever it answered (or didn't) came from a frozen run: start over
      // the last run overall, and each AI's own last run (agent-last-run-gemini.log…), so one AI's try isn't lost to the next
      const runLog = id + '\n' + (r.log || '') + '\n' + (r.text || '');
      try { fs.writeFileSync(path.join(ctx.userData(), 'agent-last-run.log'), runLog); fs.writeFileSync(path.join(ctx.userData(), 'agent-last-run-' + id + '.log'), runLog); } catch (e) {}
      let updates = null;
      try { const text = String(r.text || ''); updates = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).updates; } catch (e) {}
      const isLast = order.indexOf(id) === order.length - 1;
      // its key expired or its sign-in ran out: a to-do on his Human list says to reconnect it
      // (and once it answers again, that to-do gets checked off)
      if (Array.isArray(updates)) sendToRenderer('agent:reconnected', { id, prefix: 'Reconnect ' + providers.NAMES[id] + ':' });
      else if (r.auth && !r.limit) sendToRenderer('agent:reconnect', { id, title: reconnectTitle(id, r.why) });
      if (Array.isArray(updates)) {
        const sawMail = mailRun || mailSeen();
        const got = updates.filter((u) => u && pending.includes(u.id) && !answered.some((a) => a.id === u.id));
        got.forEach((u) => { u._via = id; u._model = r.model || null; u._sawMail = sawMail; if (id === 'claude') { u.heard = live.heard(u.id); u.thoughts = live.thoughts(u.id); } });
        const cant = isLast ? [] : got.filter(couldntDo);
        cant.forEach((u) => { held[u.id] = u; (gaveUp[u.id] = gaveUp[u.id] || []).push(providers.NAMES[id]); });
        const ok = got.filter((u) => !cant.includes(u));
        answered.push(...ok);
        pending = pending.filter((x) => !ok.some((u) => u.id === x));
        if (!pending.length) break;
        if (cant.length) agentLog(providers.NAMES[id] + ' couldn’t do ' + cant.length + ' task(s), trying the next one');
        // what it said, so a later look at the log shows why it was passed on (its own run log gets overwritten)
        cant.forEach((u) => agentLog('  ' + providers.NAMES[id] + ' said: ' + String(u.cant || u.note || '').replace(/\s+/g, ' ').slice(0, 400)));
        if (pending.length === cant.length) continue;
        lastWhy = 'it skipped this task';
        agentLog(providers.NAMES[id] + ' skipped ' + (pending.length - cant.length) + ' task(s)' + (isLast ? '' : ', trying the next one'));
        continue;
      }
      if (id === 'claude' && r.resetAt) claudeResetAt = r.resetAt;
      lastWhy = r.limit && id === 'gemini' ? 'Gemini’s free daily limit is used up; it resets at ' +
          new Date(meter.nextPacificMidnight()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. Switch this to Claude to do it now'
        : r.limit || r.resetAt ? providers.NAMES[id] + ' is out of usage' : r.auth ? (/key/i.test(r.why || '') ? r.why : providers.NAMES[id] + ' needs signing in again') : (r.why || 'no usable answer');
      if (runRetried) { agentLog(providers.NAMES[id] + ' stopped: he pressed Retry'); break; }
      agentLog(providers.NAMES[id] + ': ' + lastWhy + (isLast ? '' : ', trying the next one'));
    }
  } finally {
    agentProc = null; runIds = []; if (live) live.stop(); live = null;
    endPageP = browserCfg ? taskTabs.endRun().catch(() => null) : null; // the page its tasks ended on
    clearInterval(beats); ctx.powerSaveBlocker.stop(awake);
  }
  agentLastKey = ''; // this run's tasks get answered (or failed) below, so a later reply may run again
  // none of the later AIs could do it either: the last one's "couldn't" answer goes to him
  if (!slept && !runRetried) {
    const last = pending.filter((x) => held[x]).map((x) => held[x]);
    answered.push(...last);
    pending = pending.filter((x) => !held[x]);
  }
  // a later AI took over: the note says who tried before it
  for (const u of answered) {
    const before = (gaveUp[u.id] || []).filter((n) => n !== providers.NAMES[u._via]);
    if (before.length) u.note = String(u.note || '') + '\n\n(' + (held[u.id] === u ? 'Also tried: ' + before.join(', ') + '.'
      : before.join(' and ') + ' couldn’t do this, so ' + providers.NAMES[u._via] + ' took over.') + ')';
  }
  const valid = answered;
  const endPage = await endPageP;
  for (const u of valid) {
    // a web try that opened his mail in the agent browser is treated like an inbox run from here on
    const sawMail = u._sawMail, via = u._via;
    if (u._model) u.model = String(u._model).slice(0, 80); // which model wrote it, shown beside the AI's name
    delete u._sawMail; delete u._via; delete u._model;
    if (sawMail && !mailRun) agentLog(providers.NAMES[via] + ' opened his mail in the browser: nothing from its answer is remembered, and its links are not opened');
    u.status = u.status === 'done' ? 'done' : 'needs-you';
    u.page = !sawMail && u.status === 'needs-you' ? endPage : null; // ◉ Watch opens this page for him
    u.note =u.note ? String(u.note).slice(0, 1500) : null;
    // an inbox run's answer may carry words from an email: nothing from it is remembered for later runs
    // (which can reach the web), and the app doesn't open its links for previews
    u.pref = sawMail ? null : prefLine(u.pref);
    if (via !== 'claude') u.via = via; // his conversation shows who answered instead of "Claude"
    const task = tasks.find((x) => x.id === u.id);
    if (task && !sawMail && typeof u.howto === 'string') learnHowto(task, u.howto, taskLinks(task).concat((Array.isArray(u.options) ? u.options : []).map((o) => o && o.url).filter(Boolean)), 'claude');
    delete u.howto;
    delete u.cant;
    // changes to his grocery list: short plain names only, and never from a run that saw his mail
    u.list = sawMail ? undefined : groceryChanges(u.list);
    u.ask = cleanAsk(u.ask) || null; // questions he taps through, one at a time
    u.cart = sawMail ? null : (cleanCart(u.cart) || null); // the order, as cards he can deselect
    u.seats = sawMail ? null : (cleanSeats(u.seats) || null); // a seat map with its pick, he can tap other seats
    u.showtimes = sawMail ? null : (cleanShowtimes(u.showtimes) || null); // days and times he taps to pick one
    u.theaters = sawMail ? null : (cleanTheaters(u.theaters) || null); // a map of the theaters, he taps one
    if (u.theaters) await placeTheaters(u.theaters, here, where);
    // things to look at, as small picture cards (e.g. his grocery list): nothing to pick, no order
    u.cards = sawMail ? null : ((cleanCart(u.cards) || []).map((it) => ({ name: it.name, qty: it.qty, price: it.price, image: it.image, url: it.url })).slice(0, 40));
    if (!u.cards || !u.cards.length) u.cards = null;
    const opts = Array.isArray(u.options) && u.options.length
      ? (sawMail ? u.options.slice(0, 10).filter((o) => o && /^https:\/\//i.test(String(o.url || '')))
        .map((o) => ({ label: String(o.label || '').slice(0, 80), desc: String(o.desc || '').slice(0, 200), url: String(o.url) }))
        : (await Promise.all(u.options.slice(0, 10).map((o) => enrichOption(o)))).filter(Boolean)) : [];
    u.options = opts.length ? opts : null;
    // every card in the order gets a real product photo: one it didn't send comes from the item's page
    // (and so does each other size/brand on its menu)
    if (u.cart || u.cards) await Promise.all((u.cart || []).concat(...(u.cart || []).map((it) => it.options || []), u.cards || []).filter((it) => !it.image && it.url).slice(0, 80).map(async (it) => {
      const img = await pagePreviewImage(it.url).catch(() => null); if (img) it.image = img; }));
  }
  agentLog('answered ' + valid.length + ', missing ' + pending.length);
  if (valid.length) sendToRenderer('agent:results', valid);
  if (pending.length && slept) sendToRenderer('agent:waiting', { ids: pending, until: Date.now(), slept: true }); // back in the queue: runs again now it's awake
  else if (pending.length && !runRetried) { // Retry already put his back in the queue
    if (claudeResetAt) holdForUsage(pending, claudeResetAt); // not a failure: try again when usage is back
    else failAgentTasks(pending, lastWhy);
  }
  if (!claudeResetAt || !pending.length) scheduleAgentRun(); // anything queued while this run was going
}
// one Claude Code run → {text, log, resetAt, auth, why}
function runClaudeOnce({ exe, cfg, mailRun, workDir, prompt, browserCfg }) {
  return new Promise((resolve) => {
    let out = '', err = '', proc, killer = null, settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(killer); resolve(r); } };
    try {
      // Inbox run: Gmail READ-ONLY and nothing that reaches the internet. The account's connectors load,
      // so every Gmail tool that could change anything is blocked by name, every other connected service
      // is blocked outright, and in -p mode anything not on the allowed list is refused anyway. --tools
      // takes the web tools out entirely, whatever his Claude settings allow.
      // Web run: search, page reading and the agent browser, but no connectors at all.
      const allowed = ['Read(./attachments/**)', 'Read(./skills/**)', PLAN_TOOLS];
      // Finance's files, named outright too (encrypted, and outside what Read is allowed anyway)
      const denied = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Read(**/finance.vault*)', 'Read(**/finance.hello)'];
      // stream-json: the same answer, plus the usage Claude reports (the bars in Settings → AI connections)
      let guard = null;
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(cfg.maxTurns || (browserCfg ? 80 : mailRun ? 45 : 30))];
      const claudeModel = providers.settings(readConfig()).claudeModel; // none: Claude Code's own default for his plan
      if (claudeModel) args.push('--model', claudeModel);
      if (mailRun) {
        args.push('--tools', 'Read,' + PLAN_TOOLS);
        allowed.push(...GMAIL_READ_TOOLS);
        denied.push('WebSearch', 'WebFetch', ...GMAIL_WRITE_TOOLS, ...OTHER_CONNECTORS);
      } else {
        args.push('--tools', 'Read,WebSearch,WebFetch,' + PLAN_TOOLS, '--strict-mcp-config'); // no claude.ai connectors (only the agent browser, if any)
        allowed.push('WebSearch', 'WebFetch');
        if (browserCfg) { // the agent browser; Claude uses it only when a task needs it
          args.push('--mcp-config', browserCfg);
          allowed.push('mcp__browser');
          denied.push(...BROWSER_DENIED);
          // three store checkers, for comparing stores at the same time (agent/agent-browser.js)
          if (/"shop1"/.test(fs.readFileSync(browserCfg, 'utf8'))) {
            denied.splice(denied.indexOf('Agent'), 1);
            allowed.push('Agent', ...SHOPS.map((s) => 'mcp__' + s));
            denied.push(...SHOPS_DENIED);
            args.push('--agents', JSON.stringify(shopAgents()));
            const ti = args.indexOf('--tools'); args[ti + 1] += ',Agent';
          }
          guard = webGuardHooks(); // no web tools once the browser has shown his mail
        }
      }
      // the hooks: the web guard's, and his mid-run messages (agent/run-live.js)
      const hooks = live ? live.open(guard) : guard;
      if (hooks) {
        const f = path.join(ctx.userData(), 'agent-run', 'settings.json');
        try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ hooks })); args.push('--settings', f); }
        catch (e) { agentLog('hooks: ' + e.message); }
      }
      args.push('--allowedTools', allowed.join(','), '--disallowedTools', denied.join(','));
      proc = require('child_process').spawn(exe, args, { cwd: workDir, windowsHide: true, env: claudeEnv(readConfig()) });
      agentProc = proc;
    } catch (e) { agentLog('spawn failed: ' + e.message); return resolve({ why: 'could not start Claude' }); }
    agentLog('started Claude (pid ' + proc.pid + ')');
    killer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, runTimeoutMs);
    proc.stdout.on('data', (d) => { out += d; if (live) live.feed(String(d)); }); // its plan and steps, live on the task
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => {
      err += String(e.message); agentLog('Claude process error: ' + e.message);
      if (!proc.pid) finish({ why: 'could not start Claude' }); // never launched: no 'close' coming
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    proc.on('close', (code) => {
      agentLog('Claude exited (code ' + code + ')' + (code ? ': ' + String(err || out).replace(/\s+/g, ' ').slice(0, 300) : ''));
      let text = '';
      text = meter.readClaudeStream(out);
      const log = 'exit ' + code + '\n' + err + '\n' + out;
      // the stream's first line (system init) names the model that ran
      const model = (out.match(/"type":"system"[^\n]*?"model":"([^"]+)"/) || [])[1] || null;
      if (text.includes('"updates"')) return finish({ text, log, model });
      // only the final answer and stderr: the stream also carries web pages the run read, which may say anything
      finish({ text, log, resetAt: parseUsageLimit(err + '\n' + text), auth: CLAUDE_AUTH_RE.test(err + text) });
    });
  });
}

/* Retry on a task: the app has put it back in the queue. If this run has it, stop the run (the late
   answer would be ignored anyway) so it starts over now instead of after a 15-minute timeout */
const handlers = {
  'agent:retry': (_e, ids) => {
    ids = Array.isArray(ids) ? ids.map(String) : [];
    agentLastKey = ''; // never "same queue failed recently" after he asked for it
    if (ids.some((id) => runIds.includes(id))) {
      runRetried = true;
      agentLog('retry: stopping the current run');
      if (agentProc && typeof agentProc.kill === 'function') { try { agentProc.kill(); } catch (e) {} }
    }
    scheduleAgentRun();
    return true;
  },
};
// a run (or the memory tidy's own check) is going or about to start
const isBusy = () => !!(agentProc || agentTimer);

module.exports = { init, handlers, AGENT_GRACE_MS, queuedAgentTasks, scheduleAgentRun, isBusy };
