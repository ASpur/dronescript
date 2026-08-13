import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Vite rejects requests whose Host header it does not recognise, so a tunnel
// hostname has to be named explicitly or the page just reads "Blocked request".
const TUNNEL_HOSTS = [".ts.net"];

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: "es2022",
    // Cloudflare Pages serves this directory as a static site.
    outDir: "dist",
  },
  server: {
    allowedHosts: TUNNEL_HOSTS,
    // Honour an externally assigned port (e.g. a dev harness passing PORT).
    port: process.env["PORT"] ? Number(process.env["PORT"]) : undefined,
  },
  preview: {
    allowedHosts: TUNNEL_HOSTS,
  },
  worker: {
    format: "es",
  },
});
