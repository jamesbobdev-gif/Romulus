// The screen helper's page (renderer/overlay.html): only its own calls (main/overlay.js), none of the app's
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helper', {
  state: () => ipcRenderer.invoke('overlay:state'),
  retake: () => ipcRenderer.invoke('overlay:retake'),
  ask: (q) => ipcRenderer.invoke('overlay:ask', q),
  set: (change) => ipcRenderer.invoke('overlay:set', change),
  close: () => ipcRenderer.invoke('overlay:close'),
  openApp: () => ipcRenderer.invoke('overlay:open-app'),
  onOpened: (cb) => ipcRenderer.on('overlay:opened', (_event, s) => cb(s)),
  doIt: (goal) => ipcRenderer.invoke('overlay:do', goal), // "Do it": the AI works his PC (main/overlay.js)
  stop: () => ipcRenderer.invoke('overlay:stop'),
  answer: (text) => ipcRenderer.invoke('overlay:answer', text),
  onStep: (cb) => ipcRenderer.on('overlay:step', (_event, s) => cb(s)),
});
