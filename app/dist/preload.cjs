"use strict";

// src/main/preload.ts
var import_electron = require("electron");

// src/shared/display-text.ts
function ipcErrorReason(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "");
}

// src/main/preload.ts
import_electron.contextBridge.exposeInMainWorld("airoom", {
  invoke: (method, params) => import_electron.ipcRenderer.invoke("airoom:invoke", method, params).catch((error) => {
    throw new Error(ipcErrorReason(error));
  }),
  /** Local path of a file dropped onto the window (Electron no longer exposes File.path). */
  pathForFile: (file) => {
    try {
      return import_electron.webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    import_electron.ipcRenderer.on("airoom:event", listener);
    return () => import_electron.ipcRenderer.removeListener("airoom:event", listener);
  }
});
//# sourceMappingURL=preload.cjs.map
