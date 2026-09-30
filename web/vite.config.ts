import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run web:dev` serves the UI with live reload and sends /api to the server (npm run serve).
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4400', ws: true } } },
});
