import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Hono server (npm run dev at the repo root) owns /api, /authorize, /logout and discovery.
const target = process.env.KORE_ID_URL ?? "http://localhost:4000";
const proxy = Object.fromEntries(
  ["/api", "/authorize", "/.well-known", "/token", "/userinfo"].map((p) => [p, { target, changeOrigin: false }]),
);
// GET /logout is the server's (RP-initiated logout); the SPA only renders its confirm screen.
proxy["^/logout$"] = { target, changeOrigin: false };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
});
