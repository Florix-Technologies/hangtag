// The files the service worker saves for offline use, and the cache version that names them (scripts/build.mjs writes
// both into sw.js; tests/unit/sw-cache.test.mjs checks them). Both are the same on every checkout of a commit: git
// checks text out with CRLF on Windows (core.autocrlf) and LF elsewhere, and editors save either, so text is hashed
// with CRLF read as LF (pictures byte for byte), and files are ordered by URL rather than by the system's path.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The app shell outside src/ (every module and stylesheet under src/ follows it)
export const STATIC = ['index.html', 'receipt.html', 'receipt.js', 'order.html', 'order.js', 'store.html', 'store.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'platform/index.html', 'platform/login/index.html'];

const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
export const toUrl = (root, p) => './' + path.relative(root, p).split(path.sep).join('/');
// Windows' "\" sorts after digits and capitals, "/" before them: sorted by path, "src/ui/" and "src/ui2/" would swap
export const sortFiles = (root, files) => files.map((p) => [toUrl(root, p), p]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
export const appFiles = (root) => sortFiles(root, walk(path.join(root, 'src')).filter((p) => /\.(js|css)$/.test(p)));
export const shellFiles = (root) => [...STATIC.map((f) => path.join(root, f)), ...appFiles(root)];

// Binary as git decides it (a NUL byte in the first 8000 bytes): git never converts those, and a PNG's CRLF is data
const binary = (b) => b.subarray(0, 8000).includes(0);
const asLf = (b) => (binary(b) || !b.includes('\r\n') ? b : Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));

export function cacheVersion(root, files, read = readFileSync) {
  const hash = createHash('sha256');
  for (const f of files) { hash.update(toUrl(root, f)); hash.update(asLf(read(f))); }
  return hash.digest('hex').slice(0, 10);
}
