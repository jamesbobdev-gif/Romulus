/* Calendar accounts (agent/calendars.js): sign in, pick where tasks go and which calendars become to-dos. */
const fs = require('fs');
const calendars = require('../agent/calendars');
const { performSync } = require('./gcal-sync');

let ctx = null; // { readConfig, dataFile }
function init(c) { ctx = c; }
const dataFile = () => ctx.dataFile();
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

handle('cal:overview', (_e, fresh) => calendars.overview(!!fresh));
handle('cal:connect', async (_e, provider, own) => {
  const r = await calendars.connect(String(provider), Object.assign(own && own.clientId ? { clientId: String(own.clientId), clientSecret: String(own.clientSecret || '') } : {},
    own && own.loginHint ? { loginHint: String(own.loginHint) } : {}, own && own.noMail ? { noMail: true } : {}));
  if (r.ok) performSync().catch((e) => console.error('calendar sync failed:', e.message));
  return r;
});
// Finance reads purchase emails from this Gmail account, or not
handle('cal:set-receipts', (_e, id, on) => calendars.setReceipts(String(id), !!on));
handle('cal:add-link', (_e, url, name) => calendars.addLink(url, name));
// iCloud / Fastmail / Nextcloud…: address + app password, so tasks can go on it too
handle('cal:add-caldav', async (_e, opts) => {
  const o = opts || {};
  const r = await calendars.addCaldav({ username: String(o.username || ''), password: String(o.password || ''), server: String(o.server || ''), name: String(o.name || '') });
  if (r.ok) performSync().catch((e) => console.error('calendar sync failed:', e.message));
  return r;
});
handle('cal:remove', async (_e, id) => {
  // its task events come off the calendar first, while the account can still be reached
  const t = calendars.pushTarget();
  if (t && t.startsWith(id + '|')) { calendars.setPrefs({ push: null }); await performSync().catch(() => {}); }
  return calendars.removeAccount(String(id));
});
handle('cal:set-prefs', (_e, change) => {
  const before = calendars.pushTarget();
  const p = calendars.setPrefs(change || {});
  if (calendars.pushTarget() !== before) performSync().catch((e) => console.error('calendar sync failed:', e.message));
  return p;
});
// events from the calendars switched on, as to-dos; the app's own task events are left out
handle('cal:pull', async () => {
  let own = [];
  try { own = (JSON.parse(fs.readFileSync(dataFile(), 'utf8')).tasks || []).map((t) => t.googleEventId).filter(Boolean); } catch (e) {}
  return calendars.pull(own);
});
handle('gcal:sync-now', async () => performSync());


handle('gcal:delete-event', async (_e, eventId, calRef) => {
  if (!eventId) return false;
  try { await calendars.deleteEvent(calRef || 'g-legacy|primary', eventId); } catch (e) {}
  return true;
});


module.exports = { init, handlers };
