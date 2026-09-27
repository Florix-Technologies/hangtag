// Build check: the service worker's offline file list and the test hook's module list are up to date,
// the architecture check passes, the whole module graph bundles and ESLint passes (scripts/build.mjs --check).
// Run: npm run test:unit
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--check'], { encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
check('npm run check passes (sw.js and the test hook are current, architecture ok, bundle ok, lint ok)', r.status === 0, out.slice(-600));
check('the bundle check ran', /bundle ok: \d+ modules/.test(out), out.slice(-300));
check('lint passes: no undefined names (a missing import) and no unused variables in src/', /lint ok: \d+ files, 0 errors/.test(out), out.slice(-600));

// The offline copy includes every module and stylesheet, and nothing from outside the app
const sw = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\]);/.exec(sw)[1]);
const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const appFiles = walk(path.join(ROOT, 'src')).filter((p) => /\.(js|css)$/.test(p)).map((p) => './' + path.relative(ROOT, p).split(path.sep).join('/'));
check('sw.js saves every module and stylesheet for offline use', appFiles.every((f) => shell.includes(f)), appFiles.filter((f) => !shell.includes(f)));
check('sw.js saves only this app\'s own files (never Supabase answers)', shell.every((f) => f.startsWith('./')) && !shell.some((f) => /supabase\.co|\?code=/.test(f)));
check('the cache name changes with the files (content hash)', /const CACHE = "hangtag-[0-9a-f]{10}"/.test(sw));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
