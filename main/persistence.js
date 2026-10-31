/* The tasks file: loading it, and saving it, which also wakes everything that follows an edit
   (tray counts, the Agent lanes, "Buy this" emails, calendar sync). */
const fs = require('fs');
const path = require('path');
const { askForRoutes } = require('../agent/routing');
const { processBuyEmails } = require('./buy-emails');
const { performSync } = require('./gcal-sync');

let ctx = null; // { dataFile, refreshTrayStatus, scheduleAgentRun, scheduleLocalRun }
function init(c) { ctx = c; }
const dataFile = () => ctx.dataFile();
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
/* null = first run (no file yet). Any other read error (antivirus or a backup tool holding the file at login,
   a disk hiccup) is retried; a file that still can't be read, or isn't a tasks document any more, falls back to
   the last good copy (.bak, then the newest daily copy). Only when none of those reads is it thrown: the page
   then shows the problem and refuses to save, instead of starting with an empty list and writing that over the
   real one on the first edit. */
const LOAD_TRIES = 5;
let restoredFrom = null; // the copy the last load fell back to, for the page to say so (tasks:restored)
handle('tasks:load', async () => {
  const file = dataFile();
  restoredFrom = null;
  let problem = null;
  for (let i = 1; ; i++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (taskCount(raw) != null) return raw;
      problem = 'damaged'; break;
    } catch (e) {
      if (e.code === 'ENOENT') { problem = 'missing'; break; }
      if (i >= LOAD_TRIES) { problem = e.code || e.message; break; }
      await new Promise((r) => setTimeout(r, 300 * i));
    }
  }
  for (const copy of backupCopies(file)) {
    let raw = null; try { raw = fs.readFileSync(copy, 'utf8'); } catch (e) { continue; }
    if (taskCount(raw) == null) continue;
    restoredFrom = path.basename(copy);
    console.error(path.basename(file) + ' was ' + problem + '; loaded ' + restoredFrom);
    return raw;
  }
  if (problem === 'missing') return null; // a real first run: no file and no copies
  throw new Error('could not read ' + path.basename(file) + ' (' + problem + ')');
});
handle('tasks:restored', async () => restoredFrom);

/* The copies: tasks.json.bak (the file before the last save) and one dated copy a day in backups/, the
   last DAILY_KEEP days of them. A few small files, nothing to set up. */
const DAILY_KEEP = 7;
const backupDir = (file) => path.join(path.dirname(file), 'backups');
// newest first: .bak, then the daily copies by date
function backupCopies(file) {
  let daily = [];
  try { daily = fs.readdirSync(backupDir(file)).filter((n) => /^tasks-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse(); } catch (e) {}
  return [file + '.bak'].concat(daily.map((n) => path.join(backupDir(file), n)));
}
function dailyCopy(file, raw, now = new Date()) {
  const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const dir = backupDir(file), name = 'tasks-' + day + '.json';
  try {
    if (fs.existsSync(path.join(dir, name))) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), raw);
    fs.readdirSync(dir).filter((n) => /^tasks-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse()
      .slice(DAILY_KEEP).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) {} });
  } catch (e) { console.error('daily copy failed:', e.message); }
}

// the number of tasks in a document's text, or null when it isn't one
function taskCount(raw) {
  try { const d = JSON.parse(raw); return Array.isArray(d.tasks) ? d.tasks.length : null; } catch (e) { return null; }
}
function tombstoneCount(raw) {
  try { const d = JSON.parse(raw); return Array.isArray(d.tombstones) ? d.tombstones.length : 0; } catch (e) { return 0; }
}
// a save that would turn a list of tasks into nothing, with no deletions behind it, is a page that never
// loaded the file (or lost it): keep the file as it is
function wipesTasks(oldRaw, newRaw) {
  const before = taskCount(oldRaw);
  return before > 0 && taskCount(newRaw) === 0 && tombstoneCount(newRaw) === 0;
}

let syncDebounce = null;
handle('tasks:save', async (_event, raw) => {
  try {
    const file = dataFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let oldRaw = null; try { oldRaw = fs.readFileSync(file, 'utf8'); } catch (e) {}
    if (oldRaw != null && wipesTasks(oldRaw, raw)) { console.error('Refused to save: it would empty ' + path.basename(file)); return false; }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, raw);
    if (oldRaw != null && taskCount(oldRaw) != null) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) {} } // the last good copy, like config.json's
    fs.renameSync(tmp, file); // atomic-ish: never leaves a half-written file
    if (taskCount(raw) > 0) dailyCopy(file, raw);
    ctx.refreshTrayStatus(raw);
    ctx.scheduleAgentRun(raw);
    ctx.scheduleLocalRun(raw);
    if (ctx.serverWork && !ctx.serverWork()) return true; // a hub client: the mini PC does the rest when the edit syncs there
    askForRoutes(raw);
    processBuyEmails(raw).catch((e) => console.error('buy email error:', e.message));
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => { performSync().catch((e) => console.error('gcal sync failed:', e.message)); }, 3000);
    return true;
  } catch (e) {
    console.error('Failed to save tasks:', e);
    return false;
  }
});


module.exports = { init, handlers, wipesTasks, dailyCopy, LOAD_TRIES, DAILY_KEEP };
