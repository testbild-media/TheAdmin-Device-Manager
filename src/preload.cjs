const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceStudio', {
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  restoreLastLibrary: () => ipcRenderer.invoke('library:last'),
  openLibrary: (root) => ipcRenderer.invoke('library:open', root),
  loadDevice: (root, id) => ipcRenderer.invoke('device:load', { root, id }),
  chooseSvg: () => ipcRenderer.invoke('svg:choose'),
  saveDevice: (payload) => ipcRenderer.invoke('device:save', payload),
  setDirty: (dirty) => ipcRenderer.send('editor:dirty', Boolean(dirty)),
  onSaveBeforeClose: (callback) => ipcRenderer.on('app:save-before-close', () => callback()),
  finishCloseAfterSave: (success) => ipcRenderer.send('app:close-after-save', Boolean(success))
});
