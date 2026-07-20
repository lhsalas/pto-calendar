import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backendTarget = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev proxy allowlist (everything else falls through to Vite's SPA
    // fallback, which returns HTML and breaks our `apiRequest<…>()` JSON
    // parses as "Malformed response from server"). Add a new entry per
    // backend router prefix: `/auth`, `/pto`, `/users`, and `/holidays`.
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/auth': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/pto': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/users': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/holidays': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/health': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});
