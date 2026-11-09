// sandboxed preload: exposes the desktop bootstrap to the dashboard as window.hlqDesktop and nothing else
const { contextBridge } = require("electron");

// command-line switch main uses to hand over the bootstrap json (base64) through additionalArguments
const FLAG = "--hlq-bootstrap=";

// decodes the bootstrap from process.argv, falling back to plain client mode if it is missing or malformed
function readBootstrap() {
  const fallback = { platform: process.platform, version: "", hostMode: false, serverUrl: null, token: null };
  const arg = process.argv.find((a) => a.startsWith(FLAG));
  if (!arg) return fallback;
  try {
    const bytes = Uint8Array.from(atob(arg.slice(FLAG.length)), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
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
