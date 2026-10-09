const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  load: () => ipcRenderer.invoke('tasks:load'),
  save: (raw) => ipcRenderer.invoke('tasks:save', raw),

  syncGetCfg: () => ipcRenderer.invoke('sync:get-cfg'),
  syncSaveCfg: (cfg) => ipcRenderer.invoke('sync:save-cfg', cfg),

  gcalStatus: () => ipcRenderer.invoke('gcal:status'),
  gcalGetCfg: () => ipcRenderer.invoke('gcal:get-cfg'),
  gcalSaveCfg: (cfg) => ipcRenderer.invoke('gcal:save-cfg', cfg),
  gcalConnect: () => ipcRenderer.invoke('gcal:connect'),
  gcalDisconnect: () => ipcRenderer.invoke('gcal:disconnect'),
  gcalSyncNow: () => ipcRenderer.invoke('gcal:sync-now'),
  gcalDeleteEvent: (id) => ipcRenderer.invoke('gcal:delete-event', id),
  gcalOpenUrl: (url) => ipcRenderer.invoke('gcal:open-url', url),
  onSyncDone: (cb) => ipcRenderer.on('gcal:sync-done', (_event, tasks) => cb(tasks)),
  onAgentWorking: (cb) => ipcRenderer.on('agent:working', (_event, ids) => cb(ids)),
  onAgentResults: (cb) => ipcRenderer.on('agent:results', (_event, updates) => cb(updates)),
  onAgentWaiting: (cb) => ipcRenderer.on('agent:waiting', (_event, info) => cb(info)),
  // the mini PC lane: what his own model is doing right now on a task, and whether it's reachable
  onAgentLive: (cb) => ipcRenderer.on('agent:live', (_event, info) => cb(info)),
  localStatus: () => ipcRenderer.invoke('local:status'),
  // routing: James's rules changed (reload them), and tasks no rule matched (he picks the lane)
  routingChanged: () => ipcRenderer.invoke('routing:changed'),
  onRouteAsk: (cb) => ipcRenderer.on('agent:route-ask', (_event, ids) => cb(ids)),
  openAgentBrowser: () => ipcRenderer.invoke('agent:open-browser'),
  // RSI: change the app itself from a chat
  rsiStatus: () => ipcRenderer.invoke('rsi:status'),
  rsiAsk: (text) => ipcRenderer.invoke('rsi:ask', text),
  rsiUndo: () => ipcRenderer.invoke('rsi:undo'),
  rsiStop: () => ipcRenderer.invoke('rsi:stop'),
  rsiNewChat: () => ipcRenderer.invoke('rsi:new-chat'),
  rsiSetEnabled: (on) => ipcRenderer.invoke('rsi:set-enabled', on),
  rsiApply: (restart) => ipcRenderer.invoke('rsi:apply', restart),
  onRsiEvent: (cb) => ipcRenderer.on('rsi:event', (_event, m) => cb(m)),
  // Speak on desktop: Windows dictation; partials stream in while listening
  voiceListen: () => ipcRenderer.invoke('voice:listen'),
  voiceStop: () => ipcRenderer.invoke('voice:stop'),
  onVoicePartial: (cb) => { const h = (_event, text) => cb(text); ipcRenderer.on('voice:partial', h); return () => ipcRenderer.removeListener('voice:partial', h); }
});
