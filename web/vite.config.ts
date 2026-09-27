import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the Codespaces port forwarder can reach the dev server.
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
