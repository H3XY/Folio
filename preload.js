const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('folio', {
  takePending: () => ipcRenderer.invoke('take-pending'),
  openDialog: (opts) => ipcRenderer.invoke('open-dialog', opts),
  saveDialog: (name, data, dir) => ipcRenderer.invoke('save-dialog', { name, data, dir }),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  // fonts
  fontList: (files) => ipcRenderer.invoke('font-list', files),
  fontRead: (file) => ipcRenderer.invoke('font-read', file),
  // digital IDs and signing
  idList: () => ipcRenderer.invoke('id-list'),
  idCreate: (info) => ipcRenderer.invoke('id-create', info),
  idImport: (password) => ipcRenderer.invoke('id-import', password),
  idRemove: (id) => ipcRenderer.invoke('id-remove', id),
  signPdf: (req) => ipcRenderer.invoke('sign-pdf', req),
  verifyPdf: (data) => ipcRenderer.invoke('verify-pdf', data),
  // conversion
  officeToPdf: (file) => ipcRenderer.invoke('office-to-pdf', file),
  htmlToPdf: (req) => ipcRenderer.invoke('html-to-pdf', req),
  exportDoc: (kind, model, name, dir) => ipcRenderer.invoke('export-doc', { kind, model, name, dir }),
  saveImages: (images, base, dir) => ipcRenderer.invoke('save-images', { images, base, dir }),
  saveText: (text, name, dir) => ipcRenderer.invoke('save-text', { text, name, dir }),
  converterInfo: () => ipcRenderer.invoke('converter-info'),
});
