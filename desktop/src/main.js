// electron main process: owns the dashboard window, the tray and the optional built-in host server
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HostServer } from "./host.js";

// window background matching the dashboard so nothing flashes white while it loads
const BACKGROUND = "#0a1419";
// default port of every self-hosted install (docker, systemd, desktop host mode)
const DEFAULT_PORT = 8787;
// windows taskbar and notification identity; must equal the installer appId
const APP_ID = "com.hlquant.terminal";
// packaged builds keep web, server and tray assets as extraResources; `npm start` reads the staged build/ folder
const RESOURCES = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
// bundled dashboard entry, loaded with loadFile
const WEB_INDEX = join(RESOURCES, "web", "index.html");
// file:// prefix of the bundled dashboard, the only place the window may navigate to
const WEB_ROOT_URL = `${pathToFileURL(join(RESOURCES, "web")).href}/`;
// browser permissions the dashboard may use; everything else (camera, mic, location...) is denied
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen"]);
// ipc channel the preload asks for the bootstrap on; must equal CHANNEL in preload.cjs
const BOOTSTRAP_CHANNEL = "hlq:bootstrap";

// persisted desktop choices (host.json) and the host token
let cfg;
// controller of the embedded server child
let host;
// the single dashboard window, null while closed
let win = null;
// tray icon that keeps a hosting app reachable with the window hidden
let tray = null;
// set once quitting starts so window close stops hiding to the tray
let quitting = false;
// true while a host toggle is in flight so menu clicks cannot overlap
let busy = false;
// last window bounds, reused when the window is recreated
let lastBounds = null;
// the hide-to-tray hint is shown once per session
let trayHintShown = false;

// location of the desktop-only settings file, separate from the server data so either can be reset alone
function hostConfigPath() {
  return join(app.getPath("userData"), "host.json");
}

// writes host.json atomically with owner-only permissions because it contains the api token
function saveHostConfig() {
  const file = hostConfigPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// reads host.json, filling defaults; host mode is on by default so a fresh install works without another server
function loadHostConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(hostConfigPath(), "utf8"));
  } catch {
    saved = {};
  }
  cfg = {
    hostMode: typeof saved.hostMode === "boolean" ? saved.hostMode : true,
    allowLan: saved.allowLan === true,
    port: Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536 ? saved.port : DEFAULT_PORT,
    token: typeof saved.token === "string" && saved.token.length >= 24 ? saved.token : randomBytes(24).toString("base64url"),
  };
  saveHostConfig();
}

// the object the sandboxed preload exposes as window.hlqDesktop
function bootstrap() {
  const running = host.running;
  return {
    platform: process.platform,
    version: app.getVersion(),
    hostMode: running,
    serverUrl: running ? host.localUrl : null,
    token: running ? cfg.token : null,
  };
}

// hands the bootstrap over ipc instead of process arguments, which other local users can read in process listings
function answerBootstrap(event) {
  try {
    const own = BrowserWindow.fromWebContents(event.sender) !== null && Boolean(event.senderFrame?.url.startsWith(WEB_ROOT_URL));
    event.returnValue = own ? bootstrap() : null;
  } catch {
    event.returnValue = null;
  }
}

// only web and mail links leave the app, and they open in the system browser
function openExternal(url) {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
}

// keeps the window on the bundled dashboard: new windows and outside navigation go to the os browser instead
function guardNavigation(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(WEB_ROOT_URL)) return;
    event.preventDefault();
    openExternal(url);
  });
  w.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

// tells the user once that closing the window keeps the server (and the bot) running
function showTrayHint() {
  if (trayHintShown || !Notification.isSupported()) return;
  trayHintShown = true;
  new Notification({ title: "HL Quant is still running", body: "The server keeps running in the tray. Use Quit in the tray menu to stop it." }).show();
}

// creates the dashboard window; its preload reads the bootstrap once per page load, so a changed bootstrap needs a new window
function createWindow() {
  const w = new BrowserWindow({
    ...(lastBounds ?? { width: 1440, height: 900, center: true }),
    minWidth: 1024,
    minHeight: 640,
    title: "HL Quant",
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    icon: process.platform === "linux" ? join(RESOURCES, "tray", "app.png") : undefined,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  guardNavigation(w);
  w.once("ready-to-show", () => w.show());
  w.on("close", (event) => {
    lastBounds = w.getNormalBounds();
    if (quitting || !host.wanted) return;
    event.preventDefault();
    w.hide();
    showTrayHint();
  });
  w.on("closed", () => {
    if (win === w) win = null;
  });
  w.loadFile(WEB_INDEX);
  win = w;
}

// swaps in a fresh window carrying the current bootstrap, keeping its size and position
function recreateWindow() {
  const old = win;
  if (old) lastBounds = old.getNormalBounds();
  createWindow();
  old?.destroy();
}

// brings the dashboard back from the tray, or recreates it after it was closed
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// starts the embedded server; on failure explains why (with the log tail) and returns false so the app falls back to client mode
async function startHost() {
  try {
    await host.start({ host: cfg.allowLan ? "0.0.0.0" : "127.0.0.1", port: cfg.port, token: cfg.token });
    return true;
  } catch (error) {
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "HL Quant",
      message: "The built-in server could not start, so HL Quant will run as a client.",
      detail: `${error.message}\n\n${host.tail()}`.trim(),
      buttons: ["OK", "Open log folder"],
      defaultId: 0,
      noLink: true,
    });
    if (response === 1) shell.openPath(join(app.getPath("userData"), "logs"));
    return false;
  }
}

// every reachable non-loopback ipv4 address, for the connection info other devices need
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

// copies the server url(s) and token so a phone or another pc can connect to this host
function copyConnectionInfo() {
  const lan = cfg.allowLan ? lanAddresses().map((ip) => `URL: http://${ip}:${host.port}`) : [];
  const urls = lan.length ? lan : [`URL: ${host.localUrl}  (this PC only; enable "Allow LAN devices" for other devices)`];
  clipboard.writeText(["HL Quant server", ...urls, `Token: ${cfg.token}`].join("\n"));
  if (Notification.isSupported()) new Notification({ title: "HL Quant", body: "Connection info copied to the clipboard." }).show();
}

// turns host mode on or off, persists the choice and reloads the dashboard with the matching bootstrap
async function setHostMode(on) {
  if (busy) return;
  busy = true;
  refreshMenus();
  if (on) cfg.hostMode = await startHost();
  else {
    cfg.hostMode = false;
    await host.stop();
  }
  saveHostConfig();
  busy = false;
  refreshMenus();
  recreateWindow();
}

// rebinds a running server between loopback only and every interface (LAN devices)
async function setAllowLan(on) {
  if (busy) return;
  busy = true;
  cfg.allowLan = on;
  saveHostConfig();
  refreshMenus();
  if (host.wanted) {
    const before = host.localUrl;
    await host.stop();
    cfg.hostMode = await startHost();
    saveHostConfig();
    if (!host.running || host.localUrl !== before) recreateWindow();
  }
  busy = false;
  refreshMenus();
}

// server controls shared by the tray menu and the app menu, so they stay reachable where trays are hidden
function serverMenuItems() {
  const status = host.running
    ? `Server running on ${cfg.allowLan ? "LAN" : "this PC"} · port ${host.port}`
    : host.wanted
      ? "Server starting…"
      : "Server off (client mode)";
  return [
    { label: status, enabled: false },
    { type: "separator" },
    { label: "Host mode (run the server on this PC)", type: "checkbox", checked: cfg.hostMode, enabled: !busy, click: (item) => setHostMode(item.checked) },
    { label: "Allow LAN devices", type: "checkbox", checked: cfg.allowLan, enabled: !busy && cfg.hostMode, click: (item) => setAllowLan(item.checked) },
    { label: "Copy connection info", enabled: host.running, click: copyConnectionInfo },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
  ];
}

// application menu: hidden behind Alt on windows and linux, but keeps edit shortcuts, reload, devtools and server controls
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : [{ label: "File", submenu: [{ role: "quit" }] }]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Server", submenu: serverMenuItems() },
    { role: "windowMenu" },
  ]);
}

// rebuilds tray and app menus from the current host state so checkboxes and status stay truthful
function refreshMenus() {
  Menu.setApplicationMenu(buildAppMenu());
  if (!tray) return;
  tray.setToolTip(host.running ? `HL Quant · server on port ${host.port}` : "HL Quant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show HL Quant", click: showWindow },
      { type: "separator" },
      ...serverMenuItems(),
      { type: "separator" },
      { label: "Quit HL Quant", click: () => app.quit() },
    ]),
  );
}

// tray icon per platform: ico on windows, template image on macos, png elsewhere
function createTray() {
  const dir = join(RESOURCES, "tray");
  const file = process.platform === "win32" ? "tray.ico" : process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const image = nativeImage.createFromPath(join(dir, file));
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.on("click", showWindow);
}

// startup: settings, session hardening, tray, optional host server, then the window
async function boot() {
  await app.whenReady();
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  loadHostConfig();
  host = new HostServer({
    bundle: join(RESOURCES, "server", "server.mjs"),
    webDist: join(RESOURCES, "web"),
    dataDir: join(app.getPath("userData"), "server-data"),
    logDir: join(app.getPath("userData"), "logs"),
    onChange: () => refreshMenus(),
  });
  createTray();
  refreshMenus();
  if (cfg.hostMode && !(await startHost())) {
    cfg.hostMode = false;
    saveHostConfig();
  }
  refreshMenus();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  ipcMain.on(BOOTSTRAP_CHANNEL, answerBootstrap);
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (event) => {
    if (!host?.child) return;
    event.preventDefault();
    host.stop().finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !host?.wanted) app.quit();
  });
  boot().catch((error) => {
    dialog.showErrorBox("HL Quant failed to start", String(error?.stack ?? error));
    app.exit(1);
  });
}
