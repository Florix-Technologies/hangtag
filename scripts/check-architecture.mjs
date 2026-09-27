// Architecture check: enforces the dependency rules in ARCHITECTURE.md and reports import cycles.
//   node scripts/check-architecture.mjs            (exit 1 on any rule violation)
//   node scripts/check-architecture.mjs --report   (also list cycles and module sizes)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');

const files = walk(SRC).map(rel).sort();
const graph = new Map();
for (const f of files) {
  const text = readFileSync(path.join(SRC, f), 'utf8');
  const deps = [...text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
    .filter((s) => s.startsWith('.')).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(f), s)));
  graph.set(f, { deps, text, lines: text.split('\n').length });
}

// ---- layers ----
const layerOf = (f) => f.split('/')[0];                   // app | features | domain | infrastructure | shared
const featureOf = (f) => (f.startsWith('features/') ? f.split('/')[1] : null);
const kindOf = (f) => (f.startsWith('features/') ? f.split('/')[2] : null);   // components | pages | use-cases | services | repositories ...
const ALLOWED = {
  shared: ['shared'],
  domain: ['domain', 'shared'],
  infrastructure: ['infrastructure', 'domain', 'shared'],
  features: ['features', 'domain', 'shared'],
  app: ['app', 'features', 'domain', 'infrastructure', 'shared'],
};
const violations = [];
for (const [f, { deps, text }] of graph) {
  const L = layerOf(f);
  for (const d of deps) {
    if (!graph.has(d)) { violations.push(`${f}: imports missing file ${d}`); continue; }
    const DL = layerOf(d);
    if (!ALLOWED[L] || !ALLOWED[L].includes(DL)) violations.push(`${f} (${L}) must not import ${d} (${DL})`);
  }
  // Logging goes through shared/logging/logger.js (one place to change how the app logs)
  if (f !== 'shared/logging/logger.js' && /\bconsole\.(log|info|warn|error|debug)\(/.test(text))
    violations.push(`${f}: calls console directly (use shared/logging/logger.js)`);
  // Only infrastructure talks to Supabase or the network: no supabase-js client use, table queries or fetch elsewhere
  // (features reach Supabase through the "cloud" port; checking store.sbClient for presence is allowed)
  if (L !== 'infrastructure' && /\bsupabase\.createClient|\bsbClient\s*\.\s*(from|auth|rpc|channel|removeChannel|storage|functions)\b|\.from\(['"`]hangtag_|\.rpc\(['"`]|\.channel\(['"`]|\bfetch\(/.test(text))
    violations.push(`${f}: talks to Supabase/network directly (only infrastructure may)`);
  const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');   // without comments
  // The domain stays free of browser APIs and app state
  if (L === 'domain' && /\b(window|document|localStorage|sessionStorage|navigator|location)\b|\bstore\./.test(code))
    violations.push(`${f}: domain code uses browser APIs or app state`);
  // Browser storage only behind the "storage" port; config.js and the test flag only through shared/config
  if (!f.startsWith('infrastructure/storage/') && /\b(localStorage|sessionStorage)\b/.test(code))
    violations.push(`${f}: uses browser storage directly (only infrastructure/storage may; use the "storage" port)`);
  if (f !== 'shared/config/app-config.js' && /\b(HANGTAG_CONFIG|__HANGTAG_TEST__)\b/.test(code))
    violations.push(`${f}: reads config.js or the test flag directly (only shared/config/app-config.js may)`);
}

// ---- cycles (strongly connected components) ----
let idx = 0; const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
function strong(v) {
  index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
  for (const w of graph.get(v).deps.filter((d) => graph.has(d))) {
    if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) { const c = []; let w; do { w = stack.pop(); onStack.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c.sort()); }
}
for (const f of graph.keys()) if (!index.has(f)) strong(f);

const report = process.argv.includes('--report');
console.log(`${files.length} modules · ${violations.length} rule violations · ${sccs.length} import cycles (${sccs.reduce((a, c) => a + c.length, 0)} modules in cycles)`);
if (violations.length) console.log('\nRule violations:\n  ' + violations.join('\n  '));
if (report) {
  sccs.forEach((c, i) => console.log(`\ncycle ${i + 1} (${c.length}): ${c.join(', ')}`));
  const big = [...graph].map(([f, g]) => [f, g.lines]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\nLargest modules:\n  ' + big.map(([f, n]) => `${n}\t${f}`).join('\n  '));
}
process.exit(violations.length ? 1 : 0);
