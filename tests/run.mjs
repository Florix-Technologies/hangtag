// Runs test files and prints a summary.
//   node tests/run.mjs tests/unit supabase/tests tests/e2e      (folders or files)
// A file passes when it exits with code 0; exit code 77 means "skipped: the environment lacks something" (not a failure of
// the app). PASS/FAIL lines are counted for the summary.
// Files that don't drive a browser run side by side (TEST_JOBS at a time, default: the cores less one, at most 4) — the
// database suites are slow on one core. Browser suites (they import puppeteer-core) run one at a time afterwards, as they
// share the test server's port; with no Chromium-based browser installed they are reported as skipped (TEST_STRICT=1 makes
// that a failure). A file that runs longer than TEST_TIMEOUT_MS (default 20 minutes) is stopped and reported as a timeout.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import env from './helpers/env.mjs';

const isTest = (f) => /\.test\.(mjs|cjs|js)$/.test(f);
const collect = (p) => statSync(p).isDirectory()
  ? readdirSync(p).sort().flatMap((f) => collect(path.join(p, f)))
  : (isTest(p) ? [p] : []);

const targets = process.argv.slice(2);
const files = (targets.length ? targets : ['tests/unit', 'supabase/tests', 'tests/e2e']).flatMap(collect);
// every e2e suite (some drive Chrome through a helper), and any other suite that loads puppeteer (import or require)
const usesBrowser = (f) => /[\\/]e2e[\\/]/.test(f) || /(?:from\s*|require\(\s*)['"]puppeteer(?:-core)?['"]/.test(readFileSync(f, 'utf8'));
const JOBS = Math.max(1, +process.env.TEST_JOBS || Math.min(4, Math.max(1, cpus().length - 1)));
const TIMEOUT = +process.env.TEST_TIMEOUT_MS || 20 * 60 * 1000;

function runFile(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT);
    child.on('close', (code) => { clearTimeout(timer); resolve({ file, code, out, timedOut, secs: (Date.now() - t0) / 1000 }); });
  });
}

let failed = 0, skipped = 0;
function report({ file, code, out, timedOut, secs, skipNote }) {
  const pass = (out.match(/^PASS /gm) || []).length, fail = (out.match(/^FAIL /gm) || []).length;
  const status = skipNote || code === 77 ? 'SKIP' : timedOut ? 'TIME' : code === 0 ? 'ok  ' : 'FAIL';
  if (status === 'SKIP') skipped++; else if (status !== 'ok  ') failed++;
  const note = skipNote || (code === 77 ? (out.trim().split('\n').pop() || 'environment') : '');
  console.log(`${status}  ${file}  (${status === 'SKIP' ? `skipped: ${note}` : `${pass} passed${fail ? `, ${fail} failed` : ''}`}, ${secs.toFixed(1)} s)`
    + (timedOut ? `  — stopped after ${TIMEOUT / 60000} min` : ''));
  if (status === 'FAIL' || status === 'TIME' || process.env.VERBOSE) console.log(out.split('\n').filter((l) => !/^PASS /.test(l)).slice(-40).map((l) => '      ' + l).join('\n'));
}

const plain = files.filter((f) => !usesBrowser(f)), browser = files.filter(usesBrowser);
// side by side, a pool of JOBS
const queue = [...plain];
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) report(await runFile(queue.shift()));
}));
// then the browser suites, one at a time
for (const f of browser) {
  if (!env.CHROME) { report({ file: f, code: 77, out: '', secs: 0, skipNote: env.NO_BROWSER }); continue; }
  report(await runFile(f));
}
console.log(`\n${files.length - failed - skipped}/${files.length} test files passed${skipped ? ` · ${skipped} skipped for the environment` : ''}${failed ? ` · ${failed} failed` : ''}`);
process.exit(failed || (skipped && process.env.TEST_STRICT === '1') ? 1 : 0);
