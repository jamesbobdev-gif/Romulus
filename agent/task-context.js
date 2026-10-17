/* What every Agent run is handed, whichever lane works it (this computer's Claude or the mini PC):
   his calendar when the task is about his time, the skills and site notes that match, how earlier
   similar tasks went, his memory rows, and the server claim that makes sure only one worker takes a task. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const supabase = require('./supabase');
const siteNotes = require('./site-notes');
const calendars = require('./calendars');

let ctx = null; // { userData, readConfig, agentLog, compactHowtos }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const agentLog = (m) => ctx.agentLog(m);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

// Inbox check happens in the background, only for internship tasks (the daily internship hunt and
// any agent task about internships) — never for anything else. Read-only.
// Tasks about his schedule get his Google Calendar events (read-only, through the app's own calendar
// connection) handed over with the task, so Claude doesn't need to log in to Google anywhere.
// also questions about his free time ("a gym slot Thursday afternoon", "when am I free"): without his
// calendar the mini PC model went looking for the gym's class times on the web
const CALENDAR_WORDS = new RegExp('\\b(calendar|schedule|class(es)?|lectures?|meetings?|appointments?|events?|today|tonight|tomorrow|yesterday|this week|next week|weekend|' +
  '(mon|tues|wednes|thurs|fri|satur|sun)days?|mornings?|afternoons?|evenings?|free|busy|slots?|availab(le|ility)|fit( [\\w-]+){0,4} in|when (can|could|should) i)\\b', 'i');
function wantsCalendar(t) {
  const lastYou = (Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'you').slice(-1)[0];
  return CALENDAR_WORDS.test([t.title, t.reply, lastYou && lastYou.text].filter(Boolean).join(' '));
}
// yesterday through the next 7 days (the look-ahead asks for today + 14); null if no calendar is connected
async function calendarForAgent({ back = 1, days = 9 } = {}) {
  if (!(readConfig().calAccounts || []).length) return null;
  try {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - back);
    const to = new Date(from); to.setDate(to.getDate() + days);
    const iso = (x) => (x instanceof Date ? x.toISOString() : x);
    // anyone can put an event on his calendar by sending an invitation, and its title, place and
    // description are then their words in a run that can reach the web. Invitations he hasn't said yes
    // (or maybe) to come without them: just the time and who sent it. Declined ones are left out.
    const evs = (await calendars.upcoming(from, to)).filter((e) => !(e.invite && e.invite.answer === 'declined')).slice(0, 150);
    return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, events: evs.map((e) => e.invite && !/^(accepted|tentative)$/.test(e.invite.answer)
      ? { start: iso(e.start), end: iso(e.end), title: '(invitation, not answered yet)', invitedBy: String(e.invite.from).replace(/[^\w.@+-]/g, '').slice(0, 80) || undefined }
      : { start: iso(e.start), end: iso(e.end), title: String(e.title || '').replace(/\s+/g, ' ').slice(0, 150),
        where: e.where ? String(e.where).slice(0, 100) : undefined, details: e.notes ? String(e.notes).slice(0, 200) : undefined,
        invitedBy: e.invite ? String(e.invite.from).replace(/[^\w.@+-]/g, '').slice(0, 80) || undefined : undefined }) };
  } catch (e) { agentLog('calendar for agent failed: ' + e.message); return null; }
}
/* Skills: short how-to files in agent/skills/*.md (frontmatter: name, description, match = a regex
   tested against the task). Matching ones are put in the run's instructions; all of them are copied
   to the work folder so Claude can open others it decides it needs. The mini PC reuses the same files. */
function loadSkills() {
  const dir = path.join(__dirname, 'skills');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch (e) { return []; }
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r/g, '');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = {};
    if (m) m[1].split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    let match = null; try { if (meta.match) match = new RegExp(meta.match, 'i'); } catch (e) { agentLog('skill ' + f + ': bad match pattern'); }
    return { name: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', match, body: m ? m[2] : raw, raw };
  });
}
/* Site notes (agent/site-notes.js): hand-written ones in agent/sites/, tips the mini PC learned in
   <userData>/site-notes/ (the app's own folder can't be written to once it's packaged). */
const siteNoteDirs = () => [path.join(__dirname, 'sites'), path.join(ctx.userData(), 'site-notes')];
const taskLinks = (t) => (JSON.stringify([t.title, t.notes, t.reply, t.history, t.options]).match(/https?:\/\/[^\s"'<>)\\]+/g) || []).slice(0, 40);
// how-tos: what worked on earlier, similar tasks (agent/howtos.js), kept on this computer
const howtos = require('./howtos');
const howtoFile = () => path.join(ctx.userData(), 'task-howtos.json');
function howtosFor(t) { try { return howtos.forTask(howtos.load(howtoFile()), skillText(t), taskLinks(t)); } catch (e) { return []; } }
function learnHowto(t, text, urls, lane) {
  if (!text) return;
  try {
    const r = howtos.learn(howtos.load(howtoFile()), { task: t.title, text, urls, lane, today: new Date().toISOString().slice(0, 10) });
    if (!r) return;
    howtos.save(howtoFile(), r.list);
    agentLog((lane === 'local' ? 'local: ' : '') + 'learned a how-to for "' + String(t.title).slice(0, 50) + '"' + (r.replaced ? ' (replaced ' + r.replaced + ' older)' : ''));
    if (howtos.groups(r.list).length) setTimeout(() => ctx.compactHowtos(false).catch(() => {}), 30 * 1000);
  } catch (e) { agentLog('how-to not saved: ' + e.message); }
}
handle('howtos:list', () => howtos.load(howtoFile()).slice().reverse());
handle('howtos:delete', (_event, id) => {
  const list = howtos.load(howtoFile()), rest = list.filter((h) => h.id !== id);
  if (rest.length !== list.length) howtos.save(howtoFile(), rest);
  return rest.length !== list.length;
});
function siteNotesFor(urls, max = 3) { try { return siteNotes.forUrls(siteNotes.load(siteNoteDirs()), urls).slice(0, max); } catch (e) { return []; } }
// what a skill's pattern is tested against: only his words (title, replies, instructions), since
// Claude's own notes mention all sorts of things
function skillText(t) {
  const mine = (Array.isArray(t.history) ? t.history : []).filter((h) => h.who === 'you').slice(-2).map((h) => h.text || '');
  return [t.title, t.reply, t.notes, ...mine].filter(Boolean).join('\n');
}
function wantsInbox(t) { return !!t.useInbox || /\bintern(ship)?s?\b/i.test(String(t.title || '')); }
async function agentRow(suffix) { // a doc next to the agent list ({v, text}): ':prefs' or ':locked'
  const a = supabase.channel(readConfig());
  return a ? supabase.readText(a, suffix) : '';
}
// a preference an agent wants saved: {section, text} → "Section|text" (the renderer files it under that
// heading); a plain string still works. A list (e.g. a setup's answers) → a list of lines, up to 8
function prefLine(p) {
  if (!p) return null;
  if (Array.isArray(p)) { const l = p.slice(0, 8).map(prefLine).filter((x) => typeof x === 'string' && x); return l.length ? l : null; }
  if (typeof p === 'object') return p.text ? String(p.section || 'Other').replace(/[|\n]/g, ' ').slice(0, 40) + '|' + String(p.text).replace(/\n/g, ' ').slice(0, 200) : null;
  return String(p).replace(/\n/g, ' ').slice(0, 200);
}
// questions it wants him to tap through, one at a time (renderer/js/agent-ask.js):
// [{q, choices:[...], pick:'one'|'many', default, other}] → cleaned, or undefined
function cleanAsk(a) {
  if (!Array.isArray(a)) return undefined;
  const txt = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const out = a.slice(0, 10).map((x) => {
    if (!x || typeof x !== 'object') return null;
    const q = txt(x.q || x.question, 200);
    const choices = (Array.isArray(x.choices) ? x.choices : []).map((c) => txt(c && typeof c === 'object' ? c.label : c, 80)).filter(Boolean).slice(0, 8);
    if (!q) return null;
    const many = x.pick === 'many';
    let def = (Array.isArray(x.default) ? x.default : x.default != null ? [x.default] : []).map((d) => txt(d, 80)).filter((d) => choices.includes(d));
    if (!many) def = def.slice(0, 1);
    return { q, choices, pick: many ? 'many' : 'one', default: def, other: x.other !== false || !choices.length };
  }).filter(Boolean);
  return out.length ? out : undefined;
}
// the order it built, shown as cards he can deselect (renderer/js/grocery-list.js): [{name, qty, price, unit, image,
// swap, suggested, why, options: [{name, qty, price, unit, image, url}]}] — suggested = something new that goes with the rest, in the cart but unselected until he taps it
function cleanCart(c) {
  if (!Array.isArray(c)) return undefined;
  const txt = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const out = c.slice(0, 100).map((x) => {
    if (!x || typeof x !== 'object' || !txt(x.name, 120)) return null;
    const it = { name: txt(x.name, 120) };
    const q = Math.round(Number(x.qty)); if (q > 1 && q < 100) it.qty = q;
    if (txt(x.price, 20)) it.price = txt(x.price, 20);
    if (/^https:\/\//i.test(String(x.image || ''))) it.image = String(x.image).slice(0, 500);
    if (/^https:\/\//i.test(String(x.url || ''))) it.url = String(x.url).slice(0, 500); // its product page: where the app finds a picture if it has none
    if (txt(x.unit, 20)) it.unit = txt(x.unit, 20); // unit price ("$0.12/oz"), so he sees it's the best deal
    if (txt(x.swap, 120)) it.swap = txt(x.swap, 120);
    if (x.suggested) it.suggested = true; // an idea for the week: starts unselected
    if (txt(x.why, 100)) it.why = txt(x.why, 100); // what an idea goes with, or why this size/brand was picked
    // the other sizes/brands it found for this item: he can switch to one on the card before checkout
    const opts = (Array.isArray(x.options) ? x.options : []).slice(0, 6).map((o) => {
      if (!o || typeof o !== 'object' || !txt(o.name, 120) || txt(o.name, 120) === it.name) return null;
      const op = { name: txt(o.name, 120) };
      const oq = Math.round(Number(o.qty)); if (oq > 1 && oq < 100) op.qty = oq; // its own count (one 18 ct vs two dozen)
      if (txt(o.price, 20)) op.price = txt(o.price, 20);
      if (txt(o.unit, 20)) op.unit = txt(o.unit, 20);
      if (/^https:\/\//i.test(String(o.image || ''))) op.image = String(o.image).slice(0, 500);
      if (/^https:\/\//i.test(String(o.url || ''))) op.url = String(o.url).slice(0, 500);
      return op;
    }).filter(Boolean);
    if (opts.length) it.options = opts;
    return it;
  }).filter(Boolean);
  return out.length ? out : undefined;
}
// claim on the server first (atomic: only one worker can win a queued task) → the tasks we may run
async function claimAgentTasks(tasks, lane = 'claude') {
  const a = supabase.channel(readConfig());
  if (!a) return tasks;
  const worker = (lane === 'local' ? 'relay@' : 'claude@') + os.hostname();
  const won = [];
  for (const t of tasks) {
    let ok = null;
    for (let i = 0; i < 3 && ok !== true; i++) { // our own reply may still be uploading: try a few times
      if (i) await new Promise((r) => setTimeout(r, 4000));
      try {
        const r = await fetch(supabase.base(a) + '/rpc/agent_claim_task', {
          method: 'POST', headers: supabase.headers(a, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ p_sync_key: a.syncKey, p_task_id: t.id, p_worker: worker, p_lane: lane }), signal: AbortSignal.timeout(10000) });
        ok = r.ok ? (await r.json()) === true : null;
      } catch (e) { ok = null; }
      if (ok === null) break; // server unreachable: nobody else can claim it either — go ahead
    }
    if (ok === false) agentLog('claim: ' + t.id.slice(0, 8) + ' is taken or changed, skipping');
    else won.push(t);
  }
  return won;
}

module.exports = { init, handlers, wantsCalendar, calendarForAgent, loadSkills, siteNoteDirs, taskLinks, howtos, howtoFile, howtosFor, learnHowto,
  siteNotesFor, skillText, wantsInbox, agentRow, prefLine, cleanAsk, cleanCart, claimAgentTasks };
