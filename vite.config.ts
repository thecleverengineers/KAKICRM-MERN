import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client/src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': {
        target: 'ws://localhost:4000',
        ws: true
      }
    }
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true
  }
});
