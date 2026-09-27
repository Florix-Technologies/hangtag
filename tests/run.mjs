// Runs test files one after another and prints a summary.
//   node tests/run.mjs tests/unit supabase/tests tests/e2e      (folders or files)
// A file passes when it exits with code 0. PASS/FAIL lines are counted for the summary.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const isTest = (f) => /\.test\.(mjs|cjs|js)$/.test(f);
const collect = (p) => statSync(p).isDirectory()
  ? readdirSync(p).sort().flatMap((f) => collect(path.join(p, f)))
  : (isTest(p) ? [p] : []);

const targets = process.argv.slice(2);
const files = (targets.length ? targets : ['tests/unit', 'supabase/tests', 'tests/e2e']).flatMap(collect);
let failedFiles = 0;
const rows = [];
for (const file of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^PASS /gm) || []).length, fail = (out.match(/^FAIL /gm) || []).length;
  const ok = r.status === 0;
  if (!ok) failedFiles++;
  rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${file}  (${pass} passed${fail ? `, ${fail} failed` : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log(rows[rows.length - 1]);
  if (!ok || process.env.VERBOSE) console.log(out.split('\n').filter((l) => !/^PASS /.test(l)).slice(-40).map((l) => '      ' + l).join('\n'));
}
console.log(`\n${files.length - failedFiles}/${files.length} test files passed`);
process.exit(failedFiles ? 1 : 0);
