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
   a disk hiccup) is retried, then thrown: the page then shows the problem and refuses to save, instead of
   starting with an empty list and writing that over the real one on the first edit. */
const LOAD_TRIES = 5;
handle('tasks:load', async () => {
  const file = dataFile();
  for (let i = 1; ; i++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i >= LOAD_TRIES) throw new Error('could not read ' + path.basename(file) + ' (' + (e.code || e.message) + ')');
      await new Promise((r) => setTimeout(r, 300 * i));
    }
  }
});

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


module.exports = { init, handlers, wipesTasks, LOAD_TRIES };
