// bundles server/index.ts into one esm file so desktop host mode, docker and release downloads run it with plain node
// usage: node desktop/scripts/bundle-server.mjs [repoRoot] [outFile]
//   repoRoot defaults to the parent of desktop/, outFile to desktop/build/server/server.mjs
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// desktop project folder; this script lives in desktop/scripts
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// repository root whose server/ gets bundled
const ROOT = resolve(process.argv[2] ?? join(DESKTOP, ".."));
// single-file output path
const OUTFILE = resolve(process.argv[3] ?? join(DESKTOP, "build", "server", "server.mjs"));

// gives bundled commonjs dependencies a working require() inside the esm output
const BANNER = [
  'import { createRequire as __hlqCreateRequire } from "node:module";',
  "const require = __hlqCreateRequire(import.meta.url);",
].join("\n");

// runs esbuild and prints the output size; any resolve or syntax error fails the process
async function main() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "server", "index.ts")],
    outfile: OUTFILE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: BANNER },
    charset: "utf8",
    legalComments: "eof",
    logLevel: "warning",
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(`[bundle-server] ${OUTFILE} (${(statSync(OUTFILE).size / 1024).toFixed(0)} KiB from ${inputs} modules)`);
}

await main();
