// Lists the app internals the browser tests reach through the test hook (window.__ev), and checks they
// still exist: every name must stay exported from some module in src/ (or stay a key of the state store).
//   node scripts/test-api.mjs          (exit 1 if a name the tests use has disappeared)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d, ext) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p, ext) : ext.test(p) ? [p] : []; });

const exported = new Set();
for (const f of walk(path.join(ROOT, 'src'), /\.js$/)) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) exported.add(m[1]);
  for (const m of t.matchAll(/^export \{([^}]+)\}/gm)) m[1].split(',').forEach((s) => exported.add(s.trim().split(/\s+as\s+/).pop()));
}
const store = readFileSync(path.join(ROOT, 'src/shared/state/store.js'), 'utf8');
const stateKeys = new Set(JSON.parse(/STATE_KEYS = (\[[\s\S]*?\]);/.exec(store)[1]));

// The names the tests use: the committed list (tests/test-api.json) is the contract.
const contract = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'test-api.json'), 'utf8'));
const missingExports = contract.exports.filter((n) => !exported.has(n));
const missingState = contract.state.filter((n) => !stateKeys.has(n));
console.log(`test API: ${contract.exports.length} exports, ${contract.state.length} state keys`);
if (missingExports.length) console.log('missing exports: ' + missingExports.join(', '));
if (missingState.length) console.log('missing state keys: ' + missingState.join(', '));
process.exit(missingExports.length || missingState.length ? 1 : 0);
