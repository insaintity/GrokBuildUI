const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokDesktop", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  isDesktop: true,
});
