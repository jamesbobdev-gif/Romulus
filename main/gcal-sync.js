/* Calendar sync: tasks with a due date go onto the calendar he picked in Settings (agent/calendars.js),
   and come off it when they're done, undated, or moved to a list that stays off the calendar. */
const fs = require('fs');
const calendars = require('../agent/calendars');

let ctx = null; // { readConfig, dataFile, sendToRenderer }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function addMinutesIso(dateStr, timeStr, mins) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const dt = new Date(y, m - 1, d, h, mi + mins);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
}

// the calendar event for a task that goes on one
function eventFor(t, tz) {
  // school events say which class and what kind ("Astronomy test: Test 2")
  let summary = t.title;
  if (t.ws === 'school') {
    const kindWord = t.kind === 'exam' && !/\b(test|exam|midterm|final)\b/i.test(t.title) ? 'test'
      : t.kind === 'project' && !/project|deliverable|assignment/i.test(t.title) ? 'project' : '';
    const showClass = t.tag && !t.title.toLowerCase().includes(String(t.tag).toLowerCase());
    if (showClass) summary = t.tag + (kindWord ? ' ' + kindWord + ': ' : ' — ') + t.title;
    else if (kindWord) summary = kindWord[0].toUpperCase() + kindWord.slice(1) + ': ' + t.title;
  }
  const ev = t.dueTime
    ? { summary, allDay: false, start: `${t.due}T${t.dueTime}:00`, end: addMinutesIso(t.due, t.dueTime, 30), tz }
    : { summary, allDay: true, date: t.due, endDate: addDays(t.due, 1) };
  if (t.tag) ev.description = 'Tag: ' + t.tag;
  if (t.ws === 'school' && t.notes) ev.description = (t.tag ? 'Class: ' + t.tag + '\n\n' : '') + String(t.notes).slice(0, 4000);
  return ev;
}

// one sync at a time: two overlapping runs would both create an event for the same new task
let gcalSyncing = null, gcalSyncAgain = false;
function performSync() {
  if (gcalSyncing) { gcalSyncAgain = true; return gcalSyncing; }
  gcalSyncing = performSyncOnce().finally(() => {
    gcalSyncing = null;
    if (gcalSyncAgain) { gcalSyncAgain = false; performSync().catch((e) => console.error('gcal sync failed:', e.message)); }
  });
  return gcalSyncing;
}
async function performSyncOnce() {
  const cfg = readConfig();
  if (!(cfg.calAccounts || []).length) return [];
  const target = calendars.pushTarget(); // 'acct|calendar' tasks go onto, or null (then the app's events come off)
  let saved;
  try { saved = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch (e) { return []; }
  const tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changed = [];
  // events made before calendars could be picked live on the old Google account's main calendar
  const refOf = (t) => t.calRef || (t.googleEventId ? 'g-legacy|primary' : null);

  for (const t of tasks) {
    // personal tasks, plus school tests and projects, go on the calendar; work, Claude's agent tasks
    // and regular homework stay off it (a school task switched to "regular" has its event removed).
    // To-dos that came from a calendar are already on one.
    const onCalendar = !t.fromCal && (!t.ws || t.ws === 'personal' || (t.ws === 'school' && (t.kind === 'exam' || t.kind === 'project')));
    const want = target && onCalendar && !t.done && t.due ? target : null;
    try {
      if (t.googleEventId && refOf(t) !== want) {
        try { await calendars.deleteEvent(refOf(t), t.googleEventId); } catch (e) {}
        t.googleEventId = null; t.calRef = null;
        changed.push(t);
      }
      if (!want) continue;
      const ev = eventFor(t, tz);
      const id = await calendars.putEvent(want, t.googleEventId, ev);
      if (id !== t.googleEventId || t.calRef !== want) { t.googleEventId = id; t.calRef = want; if (!changed.includes(t)) changed.push(t); }
    } catch (e) {
      console.error('calendar sync error for task', t.id, e.message);
    }
  }

  if (changed.length) {
    // the calendar calls take a while and the app may have saved meanwhile: write the event ids into
    // the file as it is now, instead of putting back the copy read at the start
    try {
      const file = dataFile();
      const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = new Map(changed.map((t) => [t.id, t]));
      for (const t of Array.isArray(latest.tasks) ? latest.tasks : []) if (ids.has(t.id)) { t.googleEventId = ids.get(t.id).googleEventId; t.calRef = ids.get(t.id).calRef; }
      fs.writeFileSync(file + '.tmp', JSON.stringify(latest));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('calendar sync: could not save event ids:', e.message); }
  }
  ctx.sendToRenderer('gcal:sync-done', changed.map((t) => ({ id: t.id, googleEventId: t.googleEventId, calRef: t.calRef || null })));
  return changed;
}


module.exports = { init, performSync, eventFor, addDays, addMinutesIso };
