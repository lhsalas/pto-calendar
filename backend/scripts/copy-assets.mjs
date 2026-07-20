#!/usr/bin/env node
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const srcDir = join(backendRoot, 'src');
const distDir = join(backendRoot, 'dist');

/**
 * Runtime asset bundles: directories under `src/` that need to be copied
 * verbatim into `dist/` after `tsc` runs. `tsc` with `resolveJsonModule:
 * true` only inlines JSON files that are imported as TypeScript modules;
 * JSON files read at runtime via `fs.readFile` from `__dirname` are not
 * copied automatically. Each entry here is `src/<path>` → `dist/<path>`.
 *
 * Add a new entry here when introducing a new runtime-asset directory.
 */
const RUNTIME_ASSET_DIRS = ['services/holidays/presets'];

for (const rel of RUNTIME_ASSET_DIRS) {
  const src = join(srcDir, rel);
  const dst = join(distDir, rel);
  await cp(src, dst, { recursive: true });
  console.log(`[copy-assets] ${relative(backendRoot, src)} -> ${relative(backendRoot, dst)}`);
}
