import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the API and WebSocket live on the server (npm run dev -w server).
const server = process.env.WATCH_SERVER ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
