/* RSI — Romulus Self Improvement: change the app itself from a chat (agent/rsi.js). This is the
   wiring: where the source folder is, his on/off switch, and the chat's IPC calls. */
const path = require('path');
const os = require('os');
const rsiModule = require('../agent/rsi');

let ctx = null; // { isPackaged, readConfig, writeConfig, agentLog, sendToRenderer, applyRsiChange }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

const rsi = rsiModule.create({
  // the folder the app runs from when started with npm start; the installed app only with rsi.repo set
  repoDir: () => ctx.isPackaged ? (readConfig().rsi || {}).repo || null : path.join(__dirname, '..'),
  isEnabled: () => (readConfig().rsi || {}).enabled === true, // off until he switches it on in Settings
  exe: () => (readConfig().agentRunner || {}).command || path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  log: (m) => ctx.agentLog(m),
  onEvent: (m) => ctx.sendToRenderer('rsi:event', m),
  getSession: () => (readConfig().rsi || {}).session || null,
  setSession: (id) => { const c = readConfig(); c.rsi = Object.assign({}, c.rsi, { session: id || undefined }); writeConfig(c); },
});
handle('rsi:status', () => rsi.status());
handle('rsi:ask', (_e, text) => rsi.ask(String(text || '').slice(0, 4000)));
handle('rsi:undo', () => rsi.undo());
handle('rsi:stop', () => rsi.stop());
handle('rsi:new-chat', () => rsi.newChat());
handle('rsi:set-enabled', (_e, on) => { const c = readConfig(); c.rsi = Object.assign({}, c.rsi, { enabled: !!on }); writeConfig(c); if (!on) rsi.stop(); return rsi.status(); });
handle('rsi:apply', (_e, restart) => { ctx.applyRsiChange(!!restart); return true; });

module.exports = { init, handlers, rsi };
