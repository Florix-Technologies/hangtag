// Release preflight for a Supabase project, read-only: which Edge Functions are missing, older than their code, deployed with
// the wrong JWT setting, or lack the secrets supabase/functions/deploy.json lists. Only names are read and printed: secret
// values never leave Supabase, and their digests are dropped.
//   npm run preflight:live                          the project this checkout is linked to (supabase/.temp/project-ref)
//   npm run preflight:live -- --project-ref <ref>
// Needs the Supabase CLI to be logged in (npx supabase login). Changes nothing. Exit code 1 when something needs doing.
// The database is not checked here: run the report at the end of supabase/schema.sql in the SQL editor (every row ok).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, functionFiles, functionNames } from './preflight-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = path.join(ROOT, 'supabase', 'functions');
const argAt = process.argv.indexOf('--project-ref');
const linkedFile = path.join(ROOT, 'supabase', '.temp', 'project-ref');
const ref = argAt > 0 ? process.argv[argAt + 1] : (existsSync(linkedFile) ? readFileSync(linkedFile, 'utf8').trim() : '');
if (!/^[a-z0-9]{10,40}$/.test(ref || '')) {
  console.error('No project: link this checkout (npx supabase link) or pass --project-ref <ref>.');
  process.exit(2);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`);
  return r.stdout;
}
const supabase = (...args) => JSON.parse(run('npx', ['--no-install', 'supabase', ...args, '--project-ref', ref, '-o', 'json']));

let deployed, secrets;
try {
  deployed = supabase('functions', 'list');
  secrets = supabase('secrets', 'list').map((s) => s.name);   // names only: the digests are dropped here
} catch (e) {
  console.error(String(e.message || e));
  console.error('Is the Supabase CLI logged in (npx supabase login) and is the project reachable?');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(FN, 'deploy.json'), 'utf8'));
const changedAt = {};
for (const name of functionNames(FN)) {
  const files = functionFiles(FN, name).map((f) => path.relative(ROOT, f));
  changedAt[name] = run('git', ['log', '-1', '--format=%cI', '--', ...files]).trim() || null;
}

const rows = assess({ manifest, deployed, secrets, changedAt });
console.log(`Project ${ref}${argAt > 0 ? '' : ' (linked)'}: Edge Functions, read-only\n`);
for (const r of rows) {
  const where = r.deployed ? `v${r.deployed.version} ${r.deployed.day}` : '-';
  console.log(`${r.name.padEnd(22)} ${where.padEnd(15)} ${r.problems.length ? r.problems.join('; ') : 'ok'}`);
}
const extra = deployed.filter((d) => !manifest[d.slug]).map((d) => d.slug);
if (extra.length) console.log(`\nDeployed but not in this checkout: ${extra.join(', ')}`);
const todo = rows.filter((r) => r.problems.length).length;
console.log(`\n${todo ? `${todo} of ${rows.length} functions need something.` : `All ${rows.length} functions are deployed and set up.`}`
  + ' The database is not checked here: run the report at the end of supabase/schema.sql in the SQL editor.');
process.exit(todo ? 1 : 0);
