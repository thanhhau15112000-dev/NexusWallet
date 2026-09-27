// Bundles the MCP server into one file so an MCP client can start it with plain `node`,
// without pnpm or tsx on its PATH (their Windows .cmd shims do not spawn reliably).
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(packageRoot, '../dist/mcp/nexuspay-mcp.mjs');

await build({
  entryPoints: [resolve(packageRoot, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});

console.log(`built ${outfile}`);
