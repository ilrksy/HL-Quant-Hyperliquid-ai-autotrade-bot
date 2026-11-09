import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// relative base lets the same build load from the server, electron file:// and the android webview
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
