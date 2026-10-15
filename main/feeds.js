/* Course calendar feeds (agent/calendar-feeds.js): the links saved in Settings, and fetching them. */
const calendarFeeds = require('../agent/calendar-feeds');

let ctx = null; // { readConfig, writeConfig }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

// the private links stay in this computer's config; the renderer gets them back only for Settings
const feedUrls = () => (Array.isArray(readConfig().calendarFeeds) ? readConfig().calendarFeeds : []);
handle('feeds:get', () => feedUrls());
handle('feeds:save', (_event, urls) => {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 10);
  const bad = list.filter((u) => !calendarFeeds.normalUrl(u));
  if (bad.length) return { ok: false, error: 'not an https/webcal link: ' + bad[0].slice(0, 50) };
  const cfg = readConfig(); cfg.calendarFeeds = list; writeConfig(cfg);
  return { ok: true };
});
handle('feeds:fetch', () => calendarFeeds.fetchAll(feedUrls()));


module.exports = { init, handlers };
