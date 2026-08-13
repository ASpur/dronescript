import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: "es2022",
    // Cloudflare Pages serves this directory as a static site.
    outDir: "dist",
  },
  worker: {
    format: "es",
  },
});
