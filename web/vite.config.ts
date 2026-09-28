import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sharedRequire = createRequire(new URL('../shared/package.json', import.meta.url));

// The dashboard calls /api on its own origin so the session cookie is first-party;
// Vite forwards those calls to the agent service.
const agentProxy = {
  '/api': { target: process.env.NEXUS_AGENT_URL ?? 'http://127.0.0.1:8787' },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Shared Solana instruction builders import the browser Buffer polyfill explicitly.
    alias: { buffer: sharedRequire.resolve('buffer/') },
  },
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
