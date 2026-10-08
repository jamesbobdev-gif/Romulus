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
  openAgentBrowser: () => ipcRenderer.invoke('agent:open-browser'),
  // Speak on desktop: Windows dictation; partials stream in while listening
  voiceListen: () => ipcRenderer.invoke('voice:listen'),
  voiceStop: () => ipcRenderer.invoke('voice:stop'),
  onVoicePartial: (cb) => { const h = (_event, text) => cb(text); ipcRenderer.on('voice:partial', h); return () => ipcRenderer.removeListener('voice:partial', h); }
});
