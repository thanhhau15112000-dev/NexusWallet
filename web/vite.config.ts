import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard calls /api on its own origin so the session cookie is first-party;
// Vite forwards those calls to the agent service.
const agentProxy = {
  '/api': { target: process.env.NEXUS_AGENT_URL ?? 'http://127.0.0.1:8787' },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the Codespaces port forwarder can reach the dev server.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: agentProxy,
  },
  preview: { host: true, port: 5173, proxy: agentProxy },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js'],
        },
      },
    },
  },
});
