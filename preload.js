const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("translator", {
  translate: (payload) => ipcRenderer.invoke("translate", payload),
  hideWindow: () => ipcRenderer.send("hide-window"),
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  toggleMaximize: () => ipcRenderer.send("toggle-maximize"),
  dragMove: (dx, dy) => ipcRenderer.send("drag-move", dx, dy),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  getHistory: () => ipcRenderer.invoke("history:get"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getQuota: () => ipcRenderer.invoke("quota:get"),
  setHotkey: (combo) => ipcRenderer.invoke("hotkey:set", combo),
  setExternal: (on) => ipcRenderer.invoke("external:set", on),
  onFocusInput: (callback) =>
    ipcRenderer.on("focus-input", () => callback()),
  onOpenOptions: (callback) =>
    ipcRenderer.on("options", () => callback()),
  onHotkeyUpdated: (callback) =>
    ipcRenderer.on("hotkey-updated", (_event, combo) => callback(combo)),
});