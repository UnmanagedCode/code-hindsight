import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev` proxies the plugin API to the backend running standalone (`PORT=4747 npm start`).
const backend = process.env.PLUGIN_BACKEND || 'http://127.0.0.1:4747';

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(here, 'src') } },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  cacheDir: path.join(here, '.vite-cache'),
  server: { proxy: { '/-/api': { target: backend } } },
});
