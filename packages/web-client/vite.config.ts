import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 4000,
    proxy: {
      '/api': 'http://localhost:3000',
      // session restore (/auth/refresh) and login, as in the admin panel's dev server
      '/auth': 'http://localhost:3003',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
  },
});
