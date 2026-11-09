// stages everything electron-builder packs into desktop/build: icons, a copy of the built dashboard and the bundled server
// set HLQ_BUILD_WEB=1 to rebuild the dashboard with vite even when web/dist already exists
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// desktop project folder; this script lives in desktop/scripts
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// repository root that holds web/ and server/
const ROOT = resolve(DESKTOP, "..");
// vite output of the dashboard
const WEB_DIST = join(ROOT, "web", "dist");

// runs a command with inherited output and aborts the stage on failure
function run(command, args, cwd = DESKTOP) {
  const res = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (res.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${res.status}`);
}

// builds the dashboard through the shell so npx resolves on windows too
function buildWeb() {
  console.log("[prepare] building dashboard: npx vite build");
  const res = spawnSync("npx vite build", { cwd: ROOT, stdio: "inherit", shell: true });
  if (res.status !== 0) throw new Error("vite build failed; run `npm ci && npx vite build` in the repository root");
}

// stage entry: icons, dashboard copy, server bundle
function main() {
  run(process.execPath, [join(DESKTOP, "scripts", "make-icons.mjs"), "desktop"]);
  if (process.env.HLQ_BUILD_WEB === "1" || !existsSync(join(WEB_DIST, "index.html"))) buildWeb();
  const target = join(DESKTOP, "build", "web");
  rmSync(target, { recursive: true, force: true });
  cpSync(WEB_DIST, target, { recursive: true });
  console.log(`[prepare] copied ${WEB_DIST} -> ${target}`);
  run(process.execPath, [join(DESKTOP, "scripts", "bundle-server.mjs"), ROOT]);
}

main();
