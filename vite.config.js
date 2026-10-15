import {defineConfig, loadEnv} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({mode}) => {
  // Only API_* values are read here; ODOO_* secrets are never loaded into the Vite process or bundle.
  const env = loadEnv(mode, process.cwd(), 'API_');
  const proxy = {
    '/api': {target: `http://127.0.0.1:${env.API_PORT || 8787}`, changeOrigin: true},
  };
  return {
    plugins: [react()],
    server: {host: '127.0.0.1', port: 5173, proxy},
    preview: {host: '127.0.0.1', port: 4173, proxy},
  };
});
