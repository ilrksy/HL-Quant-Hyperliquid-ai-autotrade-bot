// copies the built dashboard (../web/dist) into mobile/www because capacitor only accepts a webDir inside its own project
// set HLQ_BUILD_WEB=1 to rebuild the dashboard with vite first
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// mobile project folder; this script lives in mobile/scripts
const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// repository root that holds web/
const ROOT = resolve(MOBILE, "..");
// vite output of the dashboard
const WEB_DIST = join(ROOT, "web", "dist");
// capacitor webDir (see capacitor.config.json)
const WWW = join(MOBILE, "www");

// rebuilds the dashboard when asked or when no build exists, then mirrors it into www/
function main() {
  if (process.env.HLQ_BUILD_WEB === "1" || !existsSync(join(WEB_DIST, "index.html"))) {
    console.log("[copy-web] building dashboard: npx vite build");
    const res = spawnSync("npx vite build", { cwd: ROOT, stdio: "inherit", shell: true });
    if (res.status !== 0) throw new Error("vite build failed; run `npm ci && npx vite build` in the repository root");
  }
  rmSync(WWW, { recursive: true, force: true });
  cpSync(WEB_DIST, WWW, { recursive: true });
  console.log(`[copy-web] copied ${WEB_DIST} -> ${WWW}`);
}

main();
