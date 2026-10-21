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
  calSetReceipts: (id, on) => ipcRenderer.invoke('cal:set-receipts', id, on),
  calPull: () => ipcRenderer.invoke('cal:pull'),
  gcalOpenUrl: (url) => ipcRenderer.invoke('gcal:open-url', url),
  onSyncDone: (cb) => ipcRenderer.on('gcal:sync-done', (_event, tasks) => cb(tasks)),
  onAgentWorking: (cb) => ipcRenderer.on('agent:working', (_event, ids) => cb(ids)),
  onAgentResults: (cb) => ipcRenderer.on('agent:results', (_event, updates) => cb(updates)),
  onAgentWaiting: (cb) => ipcRenderer.on('agent:waiting', (_event, info) => cb(info)),
  // the mini PC lane: what his own model is doing right now on a task, and whether it's reachable
  onAgentLive: (cb) => ipcRenderer.on('agent:live', (_event, info) => cb(info)),
  // an AI's key expired / sign-in ran out (and when it works again)
  onAgentReconnect: (cb) => ipcRenderer.on('agent:reconnect', (_event, info) => cb(info)),
  onAgentReconnected: (cb) => ipcRenderer.on('agent:reconnected', (_event, info) => cb(info)),
  localStatus: () => ipcRenderer.invoke('local:status'),
  // routing: the user's rules changed (reload them), and tasks no rule matched (he picks the lane)
  routingChanged: () => ipcRenderer.invoke('routing:changed'),
  // AI connections: Claude / Gemini / OpenRouter for the Agent lane, in his order
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSave: (change) => ipcRenderer.invoke('ai:save', change),
  aiGeminiInstall: () => ipcRenderer.invoke('ai:gemini-install'),
  aiCodexInstall: () => ipcRenderer.invoke('ai:codex-install'),
  aiCodexLogin: () => ipcRenderer.invoke('ai:codex-login'),
  aiOpenRouterCheck: () => ipcRenderer.invoke('ai:openrouter-check'),
  aiCompatCheck: (id) => ipcRenderer.invoke('ai:compat-check', id),
  aiModels: (id) => ipcRenderer.invoke('ai:models', id),
  aiUsage: (refresh) => ipcRenderer.invoke('ai:usage', !!refresh),
  agentRetry: (ids) => ipcRenderer.invoke('agent:retry', ids),
  // documents from the Agent tab: an answer as a Word file, and files the mini PC's browser downloaded
  saveDoc: (title, text) => ipcRenderer.invoke('doc:save', title, text),
  lupaFiles: () => ipcRenderer.invoke('lupa:files'),
  lupaFetch: (name) => ipcRenderer.invoke('lupa:fetch', name),
  lupaRemove: (names) => ipcRenderer.invoke('lupa:remove', names),
  // his files for forms (the resume a job site asks for), on this computer: Settings → About you
  formFiles: () => ipcRenderer.invoke('forms:files'),
  formFileAdd: () => ipcRenderer.invoke('forms:add'),
  formFileRemove: (name) => ipcRenderer.invoke('forms:remove', name),
  onRouteAsk: (cb) => ipcRenderer.on('agent:route-ask', (_event, ids) => cb(ids)),
  openAgentBrowser: () => ipcRenderer.invoke('agent:open-browser'),
  // live view: the agent browser's tabs (each with its localhost socket), and starting it
  livePages: () => ipcRenderer.invoke('live:pages'),
  liveOpen: (url) => ipcRenderer.invoke('live:open', url),
  // the hub mini PC (main/hub.js): this computer as its client, over Tailscale
  hubGet: () => ipcRenderer.invoke('hub:get'),
  hubTest: (url, token) => ipcRenderer.invoke('hub:test', url, token),
  hubSave: (change) => ipcRenderer.invoke('hub:save', change),
  hubSendSettings: () => ipcRenderer.invoke('hub:send-settings'),
  hubRestart: () => ipcRenderer.invoke('hub:restart'),
  liveStart: () => ipcRenderer.invoke('live:start'),
  // course calendar feeds (Blackboard / D2L iCal links) → School list
  // what worked on earlier Agent tasks, for similar ones (Settings: see and delete)
  howtosList: () => ipcRenderer.invoke('howtos:list'),
  howtosDelete: (id) => ipcRenderer.invoke('howtos:delete', id),
  howtosCompact: () => ipcRenderer.invoke('howtos:compact'),
  feedsGet: () => ipcRenderer.invoke('feeds:get'),
  feedsSave: (urls) => ipcRenderer.invoke('feeds:save', urls),
  feedsFetch: () => ipcRenderer.invoke('feeds:fetch'),
  // dates from Gmail → tasks (and so the calendar)
  mailStatus: () => ipcRenderer.invoke('mail:status'),
  mailSetEnabled: (on) => ipcRenderer.invoke('mail:set-enabled', on),
  mailCheck: () => ipcRenderer.invoke('mail:check'),
  // morning look-ahead: what's coming up that needs doing → Agent tasks waiting on him
  lookAheadStatus: () => ipcRenderer.invoke('lookahead:status'),
  lookAheadSetEnabled: (on) => ipcRenderer.invoke('lookahead:set-enabled', on),
  lookAheadTick: (force) => ipcRenderer.invoke('lookahead:tick', force),
  // Finance tab (main/finance.js): his bank data through SimpleFIN, read-only, locked behind his passphrase
  financeStatus: () => ipcRenderer.invoke('finance:status'),
  financeSetup: (token, passphrase) => ipcRenderer.invoke('finance:setup', token, passphrase),
  financeUnlock: (passphrase) => ipcRenderer.invoke('finance:unlock', passphrase),
  financeHelloUnlock: () => ipcRenderer.invoke('finance:helloUnlock'),
  financeSetHello: (on) => ipcRenderer.invoke('finance:setHello', on),
  financeLock: () => ipcRenderer.invoke('finance:lock'),
  financeData: () => ipcRenderer.invoke('finance:data'),
  financeRefresh: () => ipcRenderer.invoke('finance:refresh'),
  financeForget: () => ipcRenderer.invoke('finance:forget'),
  financeSetKind: (payee, kind) => ipcRenderer.invoke('finance:setKind', payee, kind),
  financeStocks: (force) => ipcRenderer.invoke('finance:stocks', force),
  financePairCode: () => ipcRenderer.invoke('finance:pairCode'),
  onFinanceLocked: (cb) => ipcRenderer.on('finance:locked', (_event, why) => cb(why)),
  onFinanceUpdated: (cb) => ipcRenderer.on('finance:updated', (_event, what) => cb(what)),
  // Speak on desktop: Windows dictation; partials stream in while listening
  voiceListen: () => ipcRenderer.invoke('voice:listen'),
  voiceStop: () => ipcRenderer.invoke('voice:stop'),
  onVoicePartial: (cb) => { const h = (_event, text) => cb(text); ipcRenderer.on('voice:partial', h); return () => ipcRenderer.removeListener('voice:partial', h); }
});
