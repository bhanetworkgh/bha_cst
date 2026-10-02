/**
 * Copies the static web assets into the TypeScript build output.
 *
 * `engine/src/app.ts` resolves the web root as `<dirname(app)>/../../web`:
 *
 *   dev  (engine/src/app.ts)        -> <repo>/web        ✅
 *   prod (dist/engine/src/app.js)   -> <repo>/dist/web   ❌
 *
 * `tsc` only emits JavaScript, so a `npm run build` + `npm start` deployment
 * served `/admin`, `/admin/login` and `/web` as HTTP 500 (ENOENT on admin.html)
 * even though the source assets were present in the repository.
 *
 * Run automatically as part of `npm run build`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web');
const dest = path.join(root, 'dist', 'web');

if (!fs.existsSync(src)) {
  console.error(`copy_web_assets: source directory not found: ${src}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

const copied = fs.readdirSync(dest);
console.log(`copy_web_assets: copied ${copied.length} entr${copied.length === 1 ? 'y' : 'ies'} to dist/web`);
