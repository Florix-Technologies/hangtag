// Linux reads file names case-sensitively; Windows and macOS (where Hangtag is mostly built) don't, so an import whose
// case differs from the file builds there and breaks on a Linux build or server. Every relative import, require, script
// src and link href names its file exactly.
// Run: node tests/unit/import-case.test.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const walk = (d) => readdirSync(d).flatMap((f) => { if (f === 'node_modules' || f.startsWith('.')) return []; const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(m?js|cjs|ts|html)$/.test(f) ? [p] : []; });
const exact = (p) => {
  let cur = root;
  for (const seg of path.relative(root, p).split(path.sep).filter(Boolean)) { let names; try { names = readdirSync(cur); } catch { return false; } if (!names.includes(seg)) return false; cur = path.join(cur, seg); }
  return true;
};
const files = ['src', 'tests', 'scripts', 'supabase', 'platform'].map((d) => path.join(root, d)).filter(existsSync).flatMap(walk)
  .concat(['index.html', 'store.html', 'order.html', 'receipt.html'].map((f) => path.join(root, f)).filter(existsSync));
let n = 0; const bad = [];
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(/(?:import\s[^'"]*?from\s*|import\(\s*|require\(\s*|src=|href=)["'](\.{1,2}\/[^"'?#]+)["']/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!target.startsWith(root) || !existsSync(target)) continue;
    n++; if (!exact(target)) bad.push(`${path.relative(root, f)}: ${m[1]}`);
  }
}
const ok = n > 500 && bad.length === 0;
console.log(`${ok ? 'PASS' : 'FAIL'} every relative import names its file in exactly the file's case (${n} imports)${bad.length ? '  ' + JSON.stringify(bad.slice(0, 20)) : ''}`);
console.log(ok ? '\nall passed' : '\n1 FAILED');
process.exit(ok ? 0 : 1);
