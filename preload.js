const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  load: () => ipcRenderer.invoke('tasks:load'),
  save: (raw) => ipcRenderer.invoke('tasks:save', raw),

  syncGetCfg: () => ipcRenderer.invoke('sync:get-cfg'),
  syncSaveCfg: (cfg) => ipcRenderer.invoke('sync:save-cfg', cfg),

  gcalGetCfg: () => ipcRenderer.invoke('gcal:get-cfg'),
  gcalSaveCfg: (cfg) => ipcRenderer.invoke('gcal:save-cfg', cfg),
  gcalSyncNow: () => ipcRenderer.invoke('gcal:sync-now'),
  gcalDeleteEvent: (id, calRef) => ipcRenderer.invoke('gcal:delete-event', id, calRef),
  // calendar accounts (Google, Microsoft, calendar links): where tasks go, which calendars become to-dos
  calOverview: (fresh) => ipcRenderer.invoke('cal:overview', fresh),
  calConnect: (provider, own) => ipcRenderer.invoke('cal:connect', provider, own),
  calAddLink: (url, name) => ipcRenderer.invoke('cal:add-link', url, name),
  calRemove: (id) => ipcRenderer.invoke('cal:remove', id),
  calSetPrefs: (change) => ipcRenderer.invoke('cal:set-prefs', change),
  calPull: () => ipcRenderer.invoke('cal:pull'),
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
  // AI connections: Claude / Gemini / OpenRouter for the Agent lane, in his order
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSave: (change) => ipcRenderer.invoke('ai:save', change),
  aiGeminiInstall: () => ipcRenderer.invoke('ai:gemini-install'),
  aiOpenRouterCheck: () => ipcRenderer.invoke('ai:openrouter-check'),
  onRouteAsk: (cb) => ipcRenderer.on('agent:route-ask', (_event, ids) => cb(ids)),
  openAgentBrowser: () => ipcRenderer.invoke('agent:open-browser'),
  // course calendar feeds (Blackboard / D2L iCal links) → School list
  // what worked on earlier Agent tasks, for similar ones (Settings: see and delete)
  howtosList: () => ipcRenderer.invoke('howtos:list'),
  howtosDelete: (id) => ipcRenderer.invoke('howtos:delete', id),
  feedsGet: () => ipcRenderer.invoke('feeds:get'),
  feedsSave: (urls) => ipcRenderer.invoke('feeds:save', urls),
  feedsFetch: () => ipcRenderer.invoke('feeds:fetch'),
  // dates from Gmail → tasks (and so the calendar)
  mailStatus: () => ipcRenderer.invoke('mail:status'),
  mailSetEnabled: (on) => ipcRenderer.invoke('mail:set-enabled', on),
  mailCheck: () => ipcRenderer.invoke('mail:check'),
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
