/* A Claude run, live on its tasks: what it plans and does, and what the user writes meanwhile.
   - Plan + steps: Claude Code streams every tool call (stream-json). Its own checklist (TaskCreate /
     TaskUpdate) becomes the task's plan, and searches, pages and browser clicks become one-line steps.
     Both go to the task as 'agent:live' while it works, and the steps are kept as "What it did" after.
   - Messages mid-run: what the user writes on a task while Claude works on it goes into an inbox folder, one
     file each; agent/run-inbox.js (a Claude Code hook) hands them to Claude after its next tool call, or
     before it finishes. Those Claude took count as heard: his reply then doesn't start another run.
     A yes or photos sent that way still go round again (a yes unlocks final clicks only from the run's
     start, and photos are fetched then).
   Only Claude's runs have this: the other AIs get mid-run messages afterwards, as before.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

const { isYes } = require('./helpers');

const MAX_TEXT = 6000;

const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function where(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? short(x.pathname, 40) : ''); } catch (e) { return short(u, 60); }
}
// one tool call → a line he can read, or null for the ones not worth a line
function describe(name, input) {
  input = input || {};
  const b = String(name).replace(/^mcp__browser__/, '');
  if (name === 'WebSearch') return 'Searching: ' + short(input.query, 100);
  if (name === 'WebFetch') return 'Reading ' + where(input.url);
  if (name === 'Read') {
    const f = String(input.file_path || '').replace(/\\/g, '/');
    if (/attachments\//.test(f)) return 'Looking at your photo';
    if (/skills\//.test(f)) return 'Reading its notes on ' + path.basename(f, '.md').replace(/-/g, ' ');
    return null;
  }
  if (/^TaskCreate$|^TaskUpdate$|^TaskList$|^TaskGet$/.test(name)) return null;
  if (/^mcp__claude_ai_Gmail__/.test(name)) return /search/.test(name) ? 'Searching your mail' + (input.query ? ': ' + short(input.query, 80) : '') : 'Reading an email';
  if (name !== b) { // the agent browser
    if (b === 'browser_navigate') return 'Opening ' + where(input.url);
    if (b === 'browser_navigate_back') return 'Going back';
    if (b === 'browser_click') return 'Clicking ' + short(input.element || 'the page', 60);
    if (b === 'browser_type') return 'Typing into ' + short(input.element || 'a field', 60);
    if (b === 'browser_fill_form') return 'Filling in ' + (Array.isArray(input.fields) ? input.fields.length + ' field(s)' : 'a form');
    if (b === 'browser_select_option') return 'Picking ' + short([].concat(input.values || []).join(', '), 40) + ' in ' + short(input.element || 'a list', 40);
    if (b === 'browser_press_key') return 'Pressing ' + short(input.key, 20);
    if (b === 'browser_snapshot' || b === 'browser_take_screenshot') return 'Looking at the page';
    if (b === 'browser_tabs') return null;
    return short(b.replace(/^browser_/, '').replace(/_/g, ' '), 40).replace(/^./, (c) => c.toUpperCase());
  }
  return null;
}

/* start(opts) for one run → {feed, forward, open, close, heard, thoughts, stop}
   opts: {dir (a folder of its own), tasks [{id, title}] in brief order (n = index + 1), send(channel, payload), node} */
function start({ dir, tasks, send, node }) {
  const ids = tasks.map((t) => t.id);
  const inbox = path.join(dir, 'inbox'), heardDir = path.join(dir, 'heard');
  for (const d of [inbox, heardDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(d, { recursive: true }); }
  const script = path.join(dir, 'run-inbox.js');
  try { fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'run-inbox.js'), 'utf8')); } catch (e) {}
  const runStart = Date.now();
  const steps = {}; ids.forEach((id) => { steps[id] = ''; });
  const plan = new Map(); // Claude's checklist number → {text, status, task}
  const creating = {}; // TaskCreate call id → its subject, until its result gives the number
  const sent = new Map(); // inbox file name → {id, at, again}
  const heard = new Map(); // task id → [{at, again}]
  let buf = '', isOpen = false, poll = null, lastRaw = null, timer = null, lastSent = 0;
  const dirty = new Set();

  // "[2] Compare prices" → task 2's; no number (or one task) → every task in the run
  function owner(subject) {
    const m = /^\s*\[(\d+)\]\s*/.exec(subject);
    const t = m && tasks[Number(m[1]) - 1];
    return { task: t ? t.id : null, text: short(m ? subject.slice(m[0].length) : subject, 120) };
  }
  const planFor = (id) => [...plan.values()].filter((p) => !p.task || p.task === id).map((p) => ({ text: p.text, status: p.status }));
  function flush() {
    timer = null; lastSent = Date.now();
    for (const id of dirty) send('agent:live', { id, text: steps[id], plan: planFor(id), heard: (heard.get(id) || []).map((h) => h.at) });
    dirty.clear();
  }
  function changed(id) {
    (id ? [id] : ids).forEach((x) => dirty.add(x));
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, 300 - (Date.now() - lastSent)));
  }
  function step(line, id) {
    (id ? [id] : ids).forEach((x) => { steps[x] = (steps[x] + line + '\n').slice(-MAX_TEXT); });
    changed(id);
  }

  function onEvent(j) {
    if (!j || j.parent_tool_use_id) return;
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    if (j.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text') {
          const t = String(c.text || '').trim();
          if (t && !/"updates"/.test(t) && !/^[{`]/.test(t)) step('· ' + short(t, 240));
        } else if (c.type === 'tool_use') {
          const inp = c.input || {};
          if (c.name === 'TaskCreate') creating[c.id] = String(inp.subject || inp.description || '');
          else if (c.name === 'TaskUpdate') {
            const p = plan.get(String(inp.taskId));
            if (!p) continue;
            if (inp.status === 'deleted') plan.delete(String(inp.taskId));
            else {
              if (inp.status) p.status = inp.status;
              if (inp.subject) Object.assign(p, owner(String(inp.subject)));
            }
            changed(p.task);
          } else {
            const line = describe(c.name, inp);
            if (line) step(line);
          }
        }
      }
    } else if (j.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result' || !(c.tool_use_id in creating)) continue;
        const subject = creating[c.tool_use_id]; delete creating[c.tool_use_id];
        const txt = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map((x) => x && x.text || '').join(' ') : '');
        const m = /#(\d+)/.exec(txt);
        if (!m || c.is_error) continue;
        const o = owner(subject);
        plan.set(m[1], { text: o.text, status: 'pending', task: o.task });
        changed(o.task);
      }
    }
  }
  // stdout as it comes: one JSON event a line
  function feed(chunk) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { onEvent(JSON.parse(line)); } catch (e) {}
    }
  }

  // the app saved its data (his reply came in, here or from his phone): his new messages on this run's tasks → the inbox
  function forward(raw) {
    if (raw != null) lastRaw = raw;
    if (!isOpen || lastRaw == null) return;
    let data; try { data = JSON.parse(lastRaw); } catch (e) { return; }
    for (const t of Array.isArray(data.tasks) ? data.tasks : []) {
      if (!ids.includes(t.id) || t.done) continue;
      const from = Number(t.runFrom) || runStart;
      for (const h of Array.isArray(t.history) ? t.history : []) {
        if (!h || h.who !== 'you' || !(Number(h.at) > from) || h.heard) continue;
        const name = h.at + '-' + ids.indexOf(t.id) + '.json';
        if (sent.has(name)) continue;
        const photos = Array.isArray(h.images) ? h.images.length : 0;
        const text = short(h.text, 2000);
        sent.set(name, { id: t.id, at: h.at, again: !!photos || isYes(text) });
        try {
          const tmp = path.join(dir, name + '.tmp');
          fs.writeFileSync(tmp, JSON.stringify({ id: tasks.length > 1 ? String(ids.indexOf(t.id) + 1) : t.id, title: short(t.title, 80), text, at: h.at, photos: photos || undefined }));
          fs.renameSync(tmp, path.join(inbox, name)); // whole, or not there: the hook never reads half a file
        } catch (e) { sent.delete(name); }
      }
    }
  }
  // the ones Claude has taken: moved to heard/ by the hook
  function check() {
    let names = []; try { names = fs.readdirSync(heardDir); } catch (e) { return; }
    for (const n of names) {
      const s = sent.get(n);
      if (!s || s.taken) continue;
      s.taken = true;
      if (!heard.has(s.id)) heard.set(s.id, []);
      heard.get(s.id).push({ at: s.at, again: s.again });
      step('✓ Got your message', s.id);
    }
  }
  // a Claude try is starting: its --settings hooks (with the web guard's, if any), and messages flow from now
  function open(extraHooks) {
    isOpen = true;
    forward();
    clearInterval(poll); poll = setInterval(check, 1000);
    if (!node) return extraHooks || null;
    const q = (x) => '"' + String(x).replace(/\\/g, '/') + '"';
    const cmd = (ev) => [node, script, inbox, heardDir].map(q).join(' ') + ' ' + ev;
    return Object.assign({}, extraHooks || {}, {
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: cmd('PostToolUse'), timeout: 15 }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('Stop'), timeout: 15 }] }],
    });
  }
  // the try ended: messages it never took stay unheard (the app runs his reply next), and may go to a later Claude try
  function close() {
    isOpen = false; clearInterval(poll); poll = null;
    check();
    for (const [n, s] of sent) if (!s.taken) { sent.delete(n); try { fs.rmSync(path.join(inbox, n), { force: true }); } catch (e) {} }
  }
  return {
    feed, forward, open, close,
    // times of his messages on this task that Claude took and that don't need another round
    heard: (id) => (heard.get(id) || []).filter((h) => !h.again).map((h) => h.at),
    // what it did, kept on its answer: the plan as it ended, then the steps
    thoughts(id) {
      const p = planFor(id);
      const head = p.length ? 'Plan:\n' + p.map((x) => (x.status === 'completed' ? '☑ ' : '☐ ') + x.text).join('\n') + '\n\n' : '';
      return (head + steps[id]).trim().slice(-MAX_TEXT);
    },
    stop() { close(); clearTimeout(timer); timer = null; },
  };
}

module.exports = { start, describe };
