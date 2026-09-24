import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'extension');
const output = resolve(root, 'dist', 'chrome-extension');
const distRoot = resolve(root, 'dist');

if (!output.startsWith(`${distRoot}${sep}`)) {
  throw new Error(`refusing to write extension outside ${distRoot}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(root, 'dist'), { recursive: true });
cpSync(source, output, { recursive: true });
console.log(`Chrome extension ready at ${output}`);
