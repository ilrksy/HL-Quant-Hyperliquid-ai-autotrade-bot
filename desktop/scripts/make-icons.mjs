// renders every icon the apps ship (desktop, pwa, android) from one geometric mark so all platforms stay in sync
// usage: node scripts/make-icons.mjs [desktop|web|android ...]   (no argument renders every target)
import { Resvg } from "@resvg/resvg-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// desktop project folder; this script lives in desktop/scripts
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// repository root that holds web/ and mobile/
const ROOT = resolve(DESKTOP, "..");
// brand accent shared with the dashboard
const TEAL = "#50d2c1";
// brand background shared with the window, status bar and splash
const INK = "#0a1419";

// hexagon cell with a rising signal line ending in a node, drawn on a 1024 grid
function markShapes(color, stroke) {
  const dot = Math.round(stroke * 0.8);
  return [
    `<path d="M512 166 811.6 339V685L512 858 212.4 685V339Z" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>`,
    `<path d="M342 640 462 520 562 600 700 428" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<circle cx="700" cy="428" r="${dot}" fill="${color}"/>`,
  ].join("");
}

// one svg variant: plate shape behind the mark, canvas size, mark size relative to the shorter side, colour and stroke
function iconSvg({ plate = "rounded", width = 1024, height = width, scale = 0.86, color = TEAL, stroke = 72 } = {}) {
  const side = Math.min(width, height);
  const k = (side / 1024) * scale;
  const tx = width / 2 - 512 * k;
  const ty = height / 2 - 512 * k;
  const back = {
    rounded: `<rect width="${width}" height="${height}" rx="${Math.round(side * 0.2227)}" fill="${INK}"/>`,
    square: `<rect width="${width}" height="${height}" fill="${INK}"/>`,
    circle: `<circle cx="${width / 2}" cy="${height / 2}" r="${side / 2}" fill="${INK}"/>`,
    none: "",
  }[plate];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${back}<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(5)})">${markShapes(color, stroke)}</g></svg>`;
}

// thicker strokes for tiny bitmaps so the mark stays legible in tray and favicon sizes
function strokeFor(px) {
  return px <= 24 ? 112 : px <= 48 ? 92 : 72;
}

// rasterises an svg at the requested pixel width
function render(svg, width) {
  const img = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
  return { size: img.width, png: img.asPng(), rgba: img.pixels };
}

// app icon on the rounded plate at one size, bolder and larger when tiny
function appIcon(px, plate = "rounded") {
  return render(iconSvg({ plate, scale: px <= 32 ? 0.94 : 0.86, stroke: strokeFor(px) }), px);
}

// 32-bit bottom-up bgra bitmap with an and-mask, the classic ico payload every windows version reads
function dib({ size, rgba }) {
  const maskStride = Math.ceil(size / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      const a = rgba[s + 3];
      const straight = (v) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
      pixels[d] = straight(rgba[s + 2]);
      pixels[d + 1] = straight(rgba[s + 1]);
      pixels[d + 2] = straight(rgba[s]);
      pixels[d + 3] = a;
      if (a === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

// packs rendered sizes into a windows .ico: bitmaps below 256 px and png for 256 px, like native icon tools
function ico(images) {
  const entries = images.map((img) => ({ size: img.size, data: img.size >= 256 ? img.png : dib(img) }));
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const p = 6 + 16 * i;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p);
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(e.data.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

// writes a file, creating its folder first, and records it for the summary line
async function put(file, data, written) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  written.push(file);
}

// electron-builder resources: app png/ico, linux icon set and tray images for every os
async function desktopIcons(written) {
  const build = join(DESKTOP, "build");
  await put(join(build, "icon.png"), appIcon(1024).png, written);
  await put(join(build, "icon.ico"), ico([16, 20, 24, 32, 40, 48, 64, 256].map((px) => appIcon(px))), written);
  for (const px of [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]) await put(join(build, "icons", `${px}x${px}.png`), appIcon(px).png, written);
  await put(join(build, "tray", "tray.ico"), ico([16, 20, 24, 32, 40, 48].map((px) => appIcon(px))), written);
  await put(join(build, "tray", "tray.png"), appIcon(32).png, written);
  await put(join(build, "tray", "tray@2x.png"), appIcon(64).png, written);
  await put(join(build, "tray", "app.png"), appIcon(256).png, written);
  for (const [name, px] of [["trayTemplate.png", 16], ["trayTemplate@2x.png", 32]])
    await put(join(build, "tray", name), render(iconSvg({ plate: "none", scale: 1.1, color: "#000000", stroke: strokeFor(px) }), px).png, written);
}

// pwa and browser icons served from web/public (vite copies them into web/dist)
async function webIcons(written) {
  const pub = join(ROOT, "web", "public");
  await put(join(pub, "favicon.svg"), iconSvg({ stroke: 96 }), written);
  await put(join(pub, "favicon.ico"), ico([16, 32, 48].map((px) => appIcon(px))), written);
  await put(join(pub, "icons", "icon-192.png"), appIcon(192).png, written);
  await put(join(pub, "icons", "icon-512.png"), appIcon(512).png, written);
  await put(join(pub, "icons", "maskable-512.png"), render(iconSvg({ plate: "square", scale: 0.78 }), 512).png, written);
  await put(join(pub, "apple-touch-icon.png"), render(iconSvg({ plate: "square", scale: 0.8 }), 180).png, written);
}

// reads width and height from a png ihdr chunk so regenerated splash screens keep their original sizes
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// android launcher icons for every density, adaptive icon layers, brand colour and splash screens
async function androidIcons(written) {
  const res = join(ROOT, "mobile", "android", "app", "src", "main", "res");
  if (!existsSync(res)) {
    console.log("[icons] mobile/android not generated yet, skipping android icons");
    return;
  }
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, f] of Object.entries(densities)) {
    const dir = join(res, `mipmap-${density}`);
    await put(join(dir, "ic_launcher.png"), appIcon(48 * f).png, written);
    await put(join(dir, "ic_launcher_round.png"), render(iconSvg({ plate: "circle", scale: 0.82, stroke: strokeFor(48 * f) }), 48 * f).png, written);
    await put(join(dir, "ic_launcher_foreground.png"), render(iconSvg({ plate: "none", scale: 0.66 }), 108 * f).png, written);
  }
  await put(
    join(res, "values", "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${INK.toUpperCase()}</color>\n</resources>\n`,
    written,
  );
  for (const dir of readdirSync(res).filter((d) => d.startsWith("drawable"))) {
    const file = join(res, dir, "splash.png");
    if (!existsSync(file)) continue;
    const { width, height } = pngSize(file);
    await put(file, render(iconSvg({ plate: "square", width, height, scale: 0.3 }), width).png, written);
  }
}

// command-line entry: renders the requested targets, or all of them
async function main() {
  const wanted = new Set(process.argv.slice(2));
  const all = wanted.size === 0;
  const written = [];
  if (all || wanted.has("desktop")) await desktopIcons(written);
  if (all || wanted.has("web")) await webIcons(written);
  if (all || wanted.has("android")) await androidIcons(written);
  console.log(`[icons] wrote ${written.length} files`);
}

await main();
