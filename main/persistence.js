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
handle('tasks:load', async () => {
  try {
    return fs.readFileSync(dataFile(), 'utf8');
  } catch (e) {
    return null; // first run: no file yet
  }
});

let syncDebounce = null;
handle('tasks:save', async (_event, raw) => {
  try {
    const file = dataFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, raw);
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


module.exports = { init, handlers };
