import { defineConfig } from "vite";
import { serviceWorkerPlugin } from "./scripts/service-worker.mjs";

export default defineConfig({
  base: "./",
  // writes dist/sw.js (offline support); see scripts/service-worker.mjs
  plugins: [serviceWorkerPlugin()],
});
