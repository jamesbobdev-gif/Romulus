/* Agent runner (the Claude lane).
   When an Agent-tab task is queued (new, or James replied), start a headless
   Claude Code session with ONLY web search/fetch, hand it the queued tasks +
   his preferences, and pass its JSON answer to the renderer, which applies it
   and syncs like any other edit. Claude never touches the sync data itself.
   Which cloud AI answers, in what order, is agent/ai-connections.js; the mini PC lane is agent/local-lane.js. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const providers = require('./providers');
const usage = require('./usage-limit');
const meter = require('./usage-meter');
const { parseUsageLimit, holdForUsage } = usage;
const { routeTask, isClaudeLane } = require('./routing');
const { cloudOrder, cloudReady, runOrder, homeCloud, outOfUsage, PINNED_CLOUDS } = require('./ai-connections');
const { BROWSER_DENIED, findNode, prepareAgentBrowser, mailSeenFile, mailSeen, browserCfgFor, webGuardSettings, saidYes } = require('./agent-browser');
const { wantsCalendar, calendarForAgent, loadSkills, taskLinks, howtos, howtosFor, learnHowto, siteNotesFor, skillText,
  wantsInbox, agentRow, prefLine, claimAgentTasks } = require('./task-context');
const siteNotes = require('./site-notes');
const { enrichOption } = require('./previews');

let ctx = null; // { userData, documents, readConfig, dataFile, agentLog, sendToRenderer, memoryTidying }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();
const agentLog = (m) => ctx.agentLog(m);
const sendToRenderer = (ch, p) => ctx.sendToRenderer(ch, p);

const AGENT_GRACE_MS = 8 * 1000;        // let a burst of edits settle first
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // a stuck run is killed (browser tasks take a while)
const AGENT_RETRY_MS = 30 * 60 * 1000;  // same queue failing again → back off
let agentTimer = null, agentProc = null, agentLastKey = '', agentLastAt = 0;

// what a run may do in Gmail when a task asks for an inbox check: look, never touch
const GMAIL_READ_TOOLS = ['search_threads', 'get_thread', 'get_message', 'list_labels'].map((n) => 'mcp__claude_ai_Gmail__' + n);
const GMAIL_WRITE_TOOLS = ['send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'delete_draft', 'get_draft', 'list_drafts',
  'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread', 'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam',
  'unmark_thread_spam', 'label_message', 'label_thread', 'unlabel_message', 'unlabel_thread', 'update_message_labels', 'create_label',
  'update_label', 'delete_label', 'apply_sensitive_message_label', 'apply_sensitive_thread_label'].map((n) => 'mcp__claude_ai_Gmail__' + n);
const OTHER_CONNECTORS = ['Claude_Docs', 'Tasks', 'Microsoft_365', 'Gamma', 'Figma', 'Excalidraw', 'Zapier', 'Supabase', 'Slack',
  'Interactive_Brokers_IBKR', 'Canva', 'Notion', 'Google_Drive', 'Google_Calendar'].map((n) => 'mcp__claude_ai_' + n);
function queuedAgentTasks(raw) {
  let data;
  try { data = JSON.parse(raw != null ? raw : fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return []; }
  return (Array.isArray(data.tasks) ? data.tasks : [])
    .filter((t) => t.ws === 'agent' && !t.done && (t.status || 'queued') === 'queued' && isClaudeLane(t));
}
function scheduleAgentRun(raw) {
  if ((readConfig().agentRunner || {}).enabled === false) return;
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
  const cfg = readConfig().agentRunner || {};
  const all = queuedAgentTasks();
  if (!all.length) { agentLog('skip: nothing queued any more'); return; }
  // Gmail and the web never share a run: an email (or a page) could tell Claude to send his mail to
  // some server, and a run that can read mail has no way to reach one. Inbox tasks go first, on their
  // own; the rest wait for the next run. agentRunner.gmail=true makes every task an inbox task.
  // Tasks he put on Gemini or ChatGPT (the pill) run on their own too, with that AI only (neither reads his inbox).
  // A task already on an AI (the one that answered it last) runs with that AI too, so a conversation
  // doesn't hop between them: it only moves on when that AI is out of usage (see the loop below).
  const on = cloudOrder();
  const kindOf = (t) => {
    if (PINNED_CLOUDS.includes(t.cloud)) return t.cloud;
    if (cfg.gmail === true || wantsInbox(t)) return 'mail';
    const home = homeCloud(t);
    return home && on.includes(home) ? home : 'web'; // an AI he has since turned off: his order instead
  };
  const kind = ['mail', 'web', 'claude', 'gemini', 'openai', 'openrouter'].find((k) => all.some((t) => kindOf(t) === k));
  const mailRun = kind === 'mail', pinned = kind === 'mail' || kind === 'web' ? null : kind;
  const queued = all.filter((t) => kindOf(t) === kind);
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

  const exe = cfg.command || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  let rules;
  try { rules = fs.readFileSync(path.join(__dirname, 'instant-prompt.md'), 'utf8'); } catch (e) { agentLog('cannot read instructions: ' + e.message); return; }
  const prefs = await agentRow(':prefs');
  // photos James attached (this reply + the latest few earlier ones) → ./attachments/<task>/ so
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
  const brief = tasks.map((t) => ({ id: t.id, title: t.title, due: t.due, dueTime: t.dueTime, tag: t.tag,
    photos: photos[t.id] || undefined, // files to open with the Read tool (paths relative to your working folder)
    note: t.note || null, reply: t.reply || null,
    instructions: t.notes || null, // e.g. a school assignment's rules, carried over when it was handed to Claude
    options: Array.isArray(t.options) ? t.options.map((o) => ({ label: o.label, url: o.url })) : null,
    // the task's back-and-forth so far (oldest first), so Claude remembers earlier answers and picks
    conversation: Array.isArray(t.history) ? t.history.slice(-20).map((h) => ({ from: h.who, text: String(h.text || '').slice(0, 600),
      shown: Array.isArray(h.options) ? h.options : undefined,
      sentPhotos: Array.isArray(h.images) && h.images.length ? h.images.length : undefined })) : [],
    repeats: t.repeat ? { every: t.repeat.every, at: t.repeat.at } : null,
    scheduledRun: !!t.repeatDue,
    checkInboxFirst: wantsInbox(t) ? true : undefined,
    calendar: calendar && wantsCalendar(t) ? calendar : undefined,
    howTo: (() => { const h = howtosFor(t); return h.length ? h.map(howtos.show) : undefined; })() }));
  // skills: the ones matching these tasks go in full; the rest are listed so Claude can open them itself
  const skills = loadSkills();
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
  const promptFor = (want) => rules + skillPart + notePart +'\n\n## James\'s preferences\n' + (prefs.trim() || '(none yet)') +
    '\n\n## Tasks (data)\n```json\n' + JSON.stringify(brief.filter((b) => want.includes(b.id)), null, 1) + '\n```\n';

  // why each newly routed task went to Claude (shown on the task)
  sendToRenderer('agent:working', { ids, lane: 'claude', reasons: Object.fromEntries(tasks.filter((t) => !t.lane).map((t) => [t.id, routeTask(t).reason])) });
  // inbox runs never get the agent browser (see mailRun above)
  const browserCfg = mailRun || cfg.browser === false ? null : await prepareAgentBrowser().catch((e) => { agentLog('browser: ' + e.message); return null; });
  // the cloud AIs he connected, in his order (⚙ Settings → AI connections): a new task one of them fails
  // (out of usage, signed out, no usable answer, or skipped it) goes to the next, until all are answered.
  // A task already on an AI (pinned = the pill, or whoever answered it last) tries that one first and only
  // moves on when it is out of usage; any other failure stays with it. (Inbox runs: Claude only.)
  const order = runOrder({ order: cloudOrder(), pinned, mailRun, ready: cloudReady });
  if (!order.length) { failAgentTasks(ids, pinned ? providers.NAMES[pinned] + ' isn’t set up: connect it in Settings → AI connections' : 'no AI is connected: turn one on in Settings → AI connections'); agentLastKey = ''; return; }
  if (pinned && order[0] !== pinned) agentLog(providers.NAMES[pinned] + ' isn’t set up: trying the others');
  let pending = ids.slice(), claudeResetAt = null, lastWhy = 'no usable answer';
  const answered = []; // every update gets {_via, _sawMail} from the try that answered it
  agentProc = 'running';
  try {
    for (const id of order) {
      if (!pending.length) break;
      if (id === 'claude' && Date.now() < usage.blockedUntil()) continue; // still out of usage
      agentLog('asking ' + providers.NAMES[id] + ' (' + pending.length + ' task(s))');
      sendToRenderer('agent:working', { ids: pending, lane: 'claude', cloud: id }); // its pill moves to this AI, and the task stays on it
      try { fs.rmSync(mailSeenFile(), { force: true }); } catch (e) {} // each try starts with his mail unseen
      const prompt = promptFor(pending);
      const r = id === 'claude' ? await runClaudeOnce({ exe, cfg, mailRun, workDir, prompt,
          browserCfg: browserCfg && browserCfgFor(browserCfg, 'taint', tasks.some(saidYes)) })
        : id === 'gemini' ? await providers.runGemini(readConfig(), { prompt, workDir, browserMcpFile: browserCfg && browserCfgFor(browserCfg, 'block'), browserDenied: BROWSER_DENIED,
          timeoutMs: AGENT_TIMEOUT_MS, node: findNode(), onProc: (p) => { agentProc = p; } })
        : id === 'openai' ? await providers.runOpenAI(readConfig(), { prompt, timeoutMs: AGENT_TIMEOUT_MS })
        : await providers.runOpenRouter(readConfig(), { prompt, timeoutMs: AGENT_TIMEOUT_MS });
      try { fs.writeFileSync(path.join(ctx.userData(), 'agent-last-run.log'), id + '\n' + (r.log || '') + '\n' + (r.text || '')); } catch (e) {}
      let updates = null;
      try { const text = String(r.text || ''); updates = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).updates; } catch (e) {}
      const isLast = order.indexOf(id) === order.length - 1;
      if (Array.isArray(updates)) {
        const sawMail = mailRun || mailSeen();
        const got = updates.filter((u) => u && pending.includes(u.id) && !answered.some((a) => a.id === u.id));
        got.forEach((u) => { u._via = id; u._sawMail = sawMail; });
        answered.push(...got);
        pending = pending.filter((x) => !got.some((u) => u.id === x));
        if (!pending.length) break;
        lastWhy = 'it skipped this task';
        if (id === pinned) { agentLog(providers.NAMES[id] + ' skipped ' + pending.length + ' task(s): they stay with it'); break; }
        agentLog(providers.NAMES[id] + ' skipped ' + pending.length + ' task(s)' + (isLast ? '' : ', trying the next one'));
        continue;
      }
      if (id === 'claude' && r.resetAt) claudeResetAt = r.resetAt;
      lastWhy = r.limit && id === 'gemini' ? 'Gemini’s free daily limit is used up; it resets at ' +
          new Date(meter.nextPacificMidnight()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. Switch this to Claude to do it now'
        : r.limit || r.resetAt ? providers.NAMES[id] + ' is out of usage' : r.auth ? (/key/i.test(r.why || '') ? r.why : providers.NAMES[id] + ' needs signing in again') : (r.why || 'no usable answer');
      if (id === pinned && !outOfUsage(r)) { agentLog(providers.NAMES[id] + ': ' + lastWhy + ' (it has usage left, so the task stays with it)'); break; }
      agentLog(providers.NAMES[id] + ': ' + lastWhy + (isLast ? '' : ', trying the next one'));
    }
  } finally { agentProc = null; }
  agentLastKey = ''; // this run's tasks get answered (or failed) below, so a later reply may run again
  const valid = answered;
  for (const u of valid) {
    // a web try that opened his mail in the agent browser is treated like an inbox run from here on
    const sawMail = u._sawMail, via = u._via;
    delete u._sawMail; delete u._via;
    if (sawMail && !mailRun) agentLog(providers.NAMES[via] + ' opened his mail in the browser: nothing from its answer is remembered, and its links are not opened');
    u.status = u.status === 'done' ? 'done' : 'needs-you';
    u.note = u.note ? String(u.note).slice(0, 1500) : null;
    // an inbox run's answer may carry words from an email: nothing from it is remembered for later runs
    // (which can reach the web), and the app doesn't open its links for previews
    u.pref = sawMail ? null : prefLine(u.pref);
    if (via !== 'claude') u.via = via; // his conversation shows who answered instead of "Claude"
    const task = tasks.find((x) => x.id === u.id);
    if (task && !sawMail && typeof u.howto === 'string') learnHowto(task, u.howto, taskLinks(task).concat((Array.isArray(u.options) ? u.options : []).map((o) => o && o.url).filter(Boolean)), 'claude');
    delete u.howto;
    const opts = Array.isArray(u.options) && u.options.length
      ? (sawMail ? u.options.slice(0, 10).filter((o) => o && /^https:\/\//i.test(String(o.url || '')))
        .map((o) => ({ label: String(o.label || '').slice(0, 80), desc: String(o.desc || '').slice(0, 200), url: String(o.url) }))
        : (await Promise.all(u.options.slice(0, 10).map((o) => enrichOption(o)))).filter(Boolean)) : [];
    u.options = opts.length ? opts : null;
  }
  agentLog('answered ' + valid.length + ', missing ' + pending.length);
  if (valid.length) sendToRenderer('agent:results', valid);
  if (pending.length) {
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
      const allowed = ['Read(./attachments/**)', 'Read(./skills/**)'];
      const denied = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Agent'];
      // stream-json: the same answer, plus the usage Claude reports (the bars in Settings → AI connections)
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(cfg.maxTurns || (browserCfg ? 80 : mailRun ? 45 : 30))];
      if (mailRun) {
        args.push('--tools', 'Read');
        allowed.push(...GMAIL_READ_TOOLS);
        denied.push('WebSearch', 'WebFetch', ...GMAIL_WRITE_TOOLS, ...OTHER_CONNECTORS);
      } else {
        args.push('--tools', 'Read,WebSearch,WebFetch', '--strict-mcp-config'); // no claude.ai connectors (only the agent browser, if any)
        allowed.push('WebSearch', 'WebFetch');
        if (browserCfg) { // the agent browser; Claude uses it only when a task needs it
          args.push('--mcp-config', browserCfg);
          allowed.push('mcp__browser');
          denied.push(...BROWSER_DENIED);
          const guard = webGuardSettings(); // no web tools once the browser has shown his mail
          if (guard) args.push('--settings', guard);
        }
      }
      args.push('--allowedTools', allowed.join(','), '--disallowedTools', denied.join(','));
      proc = require('child_process').spawn(exe, args, { cwd: workDir, windowsHide: true });
      agentProc = proc;
    } catch (e) { agentLog('spawn failed: ' + e.message); return resolve({ why: 'could not start Claude' }); }
    agentLog('started Claude (pid ' + proc.pid + ')');
    killer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, AGENT_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d; });
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
      if (text.includes('"updates"')) return finish({ text, log });
      // only the final answer and stderr: the stream also carries web pages the run read, which may say anything
      finish({ text, log, resetAt: parseUsageLimit(err + '\n' + text), auth: /log ?in|auth|expired/i.test(err + text) });
    });
  });
}

// a run (or the memory tidy's own check) is going or about to start
const isBusy = () => !!(agentProc || agentTimer);

module.exports = { init, AGENT_GRACE_MS, queuedAgentTasks, scheduleAgentRun, isBusy };
