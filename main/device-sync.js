/* Settings kept in config.json: the device-sync links and the old Google client; and opening web
   links in the real browser. */
let ctx = null; // { readConfig, writeConfig, openExternal }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

/* device-sync config lives in config.json so it survives reinstalls and can
   seed the renderer on first run */
handle('sync:get-cfg', async () => {
  const cfg = readConfig();
  return cfg.sync || null;
});
handle('sync:save-cfg', async (_e, sync) => {
  const cfg = readConfig();
  cfg.sync = sync;
  writeConfig(cfg);
  return true;
});

/* the sync code as a QR code, for the phone to scan (Settings → Device sync). It holds the sync key, so
   it's drawn here and shown only on this screen, never sent anywhere */
handle('sync:qr', async (_e, text) => {
  text = String(text || '');
  if (!text.startsWith('tasks-sync:') || text.length > 2000) return { ok: false, error: 'not a sync code' };
  return { ok: true, svg: await require('qrcode').toString(text, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 }) };
});

handle('gcal:save-cfg', async (_e, { clientId, clientSecret }) => {
  const cfg = readConfig();
  cfg.gcal = Object.assign({}, cfg.gcal, { clientId, clientSecret });
  writeConfig(cfg);
  return true;
});

handle('gcal:get-cfg', async () => {
  const cfg = readConfig();
  return { clientId: (cfg.gcal && cfg.gcal.clientId) || '', clientSecret: (cfg.gcal && cfg.gcal.clientSecret) || '' };
});

// web pages only: the renderer shows text from Claude and web pages, so never hand the OS a file: or other scheme
handle('gcal:open-url', async (_e, url) => { if (/^https?:\/\//i.test(String(url))) await ctx.openExternal(String(url)); });


module.exports = { init, handlers };
