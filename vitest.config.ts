import { defineConfig } from "vitest/config";

// tests live at the repo root, separate from the dashboard's vite root in web/
export default defineConfig({
  test: { root: ".", include: ["tests/**/*.test.ts"] },
});
