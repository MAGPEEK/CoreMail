import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4001,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3003',
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
