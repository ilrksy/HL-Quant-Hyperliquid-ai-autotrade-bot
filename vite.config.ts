import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// dashboard lives in web/, api calls are proxied to the bot server during development
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
