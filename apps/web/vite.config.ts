import { defineConfig } from 'vite';

// In dev, the run server (apps/server) handles /api and /ws.
const server = process.env.EXITLIQ_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2020' },
});
