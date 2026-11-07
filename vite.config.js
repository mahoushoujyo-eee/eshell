import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // Also ignore editor/tooling temp artifacts. On Windows a watcher that
      // picks up a file inside one of these transient `.tmpdir` directories can
      // die on `EBUSY` and take the whole dev server down with it — the editor
      // creates the file, starts watching it, and the tool removes the
      // directory before chokidar lets go.
      ignored: ["**/src-tauri/**", "**/.*.tmpdir/**", "**/*.tmp"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
}));
