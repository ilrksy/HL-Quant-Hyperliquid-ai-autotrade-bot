// sandboxed preload: exposes the desktop bootstrap to the dashboard as window.hlqDesktop and nothing else
const { contextBridge, ipcRenderer } = require("electron");

// ipc channel main answers with the bootstrap; must equal BOOTSTRAP_CHANNEL in main.js
const CHANNEL = "hlq:bootstrap";

// asks main for the bootstrap once per page load, falling back to plain client mode if it is missing or malformed
function readBootstrap() {
  const fallback = { platform: process.platform, version: "", hostMode: false, serverUrl: null, token: null };
  try {
    const data = ipcRenderer.sendSync(CHANNEL);
    if (!data || typeof data !== "object") return fallback;
    return {
      platform: typeof data.platform === "string" ? data.platform : fallback.platform,
      version: typeof data.version === "string" ? data.version : "",
      hostMode: data.hostMode === true,
      serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : null,
      token: typeof data.token === "string" ? data.token : null,
    };
  } catch {
    return fallback;
  }
}

contextBridge.exposeInMainWorld("hlqDesktop", readBootstrap());
