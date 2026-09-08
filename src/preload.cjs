const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceStudio', {
  startupLibrary: () => ipcRenderer.invoke('library:startup'),
  createLibrary: (metadata) => ipcRenderer.invoke('library:create', metadata),
  openUserLibrary: () => ipcRenderer.invoke('library:open-user'),
  openExternalLibrary: () => ipcRenderer.invoke('library:open-external'),
  editLibrary: (metadata) => ipcRenderer.invoke('library:edit', metadata),
  exportLibrary: () => ipcRenderer.invoke('library:export'),
  showLibrary: () => ipcRenderer.invoke('library:show'),
  prepareMerge: () => ipcRenderer.invoke('library:merge-prepare'),
  commitMerge: (payload) => ipcRenderer.invoke('library:merge-commit', payload),
  cancelMerge: (token) => ipcRenderer.invoke('library:merge-cancel', token),
  loadDevice: (root, id) => ipcRenderer.invoke('device:load', { root, id }),
  chooseSvg: () => ipcRenderer.invoke('svg:choose'),
  saveDevice: (payload) => ipcRenderer.invoke('device:save', payload),
  deleteDevice: (id) => ipcRenderer.invoke('device:delete', id),
  setDirty: (dirty) => ipcRenderer.send('editor:dirty', Boolean(dirty)),
  onSaveBeforeClose: (callback) => ipcRenderer.on('app:save-before-close', () => callback()),
  finishCloseAfterSave: (success) => ipcRenderer.send('app:close-after-save', Boolean(success))
});
