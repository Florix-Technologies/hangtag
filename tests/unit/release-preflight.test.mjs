// The release preflight (npm run preflight:live) checks a Supabase project's Edge Functions against
// supabase/functions/deploy.json. No other test can see a project's set-up: a function can be deployed without its key (bill
// reading then answers "isn't set up yet"), older than its code, with the JWT setting its README says not to use, or not at
// all. This keeps deploy.json in step with the code, and checks what assess() reports for such a project.
// Run: npm run test:unit
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_DEFAULTS, assess, declared, functionFiles, functionNames, ownFiles, settingsRead } from '../../scripts/preflight-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions');
let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const manifest = JSON.parse(readFileSync(path.join(FN, 'deploy.json'), 'utf8'));
const names = functionNames(FN);
const entries = Object.keys(manifest).filter((k) => !k.startsWith('$')).sort();
const reads = (files) => new Set(files.flatMap((f) => settingsRead(readFileSync(f, 'utf8'))));

// deploy.json against the code
check('deploy.json has an entry for every function folder, and only for those', JSON.stringify(entries) === JSON.stringify(names), { entries, folders: names });
check('every entry says how it is deployed (jwt true or false)', entries.every((n) => typeof manifest[n].jwt === 'boolean'), entries.filter((n) => typeof manifest[n].jwt !== 'boolean'));
for (const name of names) {
  const shared = functionFiles(FN, name).filter((f) => f.includes(`${path.sep}_shared${path.sep}`));
  const undeclared = [...reads([...ownFiles(FN, name), ...shared])].filter((s) => !declared(manifest[name]).has(s) && !PROJECT_DEFAULTS.includes(s));
  check(`${name}: every setting its code reads is in deploy.json`, !undeclared.length, undeclared);
  const used = reads(functionFiles(FN, name));
  const unused = [...(manifest[name].required || []), ...(manifest[name].anyOf || []).flat()].filter((s) => !used.has(s));
  check(`${name}: deploy.json requires only settings its code reads`, !unused.length, unused);
}

// the reader finds what the code reads (so the checks above can't pass by finding nothing)
const src = (f) => readFileSync(path.join(FN, f), 'utf8');
check('Deno.env.get reads are found (extract-bill: ANTHROPIC_API_KEY, EXTRACT_MODEL)',
  ['ANTHROPIC_API_KEY', 'EXTRACT_MODEL'].every((s) => settingsRead(src('extract-bill/index.ts')).includes(s)), settingsRead(src('extract-bill/index.ts')));
check('settings read from Deno.env.toObject() are found (webhook-dispatch: env.WEBHOOK_DISPATCH_SECRET)',
  settingsRead(src('webhook-dispatch/index.ts')).includes('WEBHOOK_DISPATCH_SECRET'), settingsRead(src('webhook-dispatch/index.ts')));
const bundled = functionFiles(FN, 'extract-bill').map((f) => path.relative(FN, f).split(path.sep).join('/'));
check('a deploy bundles what it imports from other folders (extract-bill: _shared/plan-gate.js, agent/core.js)',
  bundled.includes('_shared/plan-gate.js') && bundled.includes('agent/core.js'), bundled);

// assess(): what a project lacks
const fn = (slug, updated_at, verify_jwt, more = {}) => ({ slug, version: 1, status: 'ACTIVE', updated_at, verify_jwt, ...more });
const allDeployed = () => entries.map((n) => fn(n, '2026-10-11T12:00:00Z', manifest[n].jwt));
const everySecret = [...new Set(entries.flatMap((n) => [...(manifest[n].required || []), ...(manifest[n].anyOf || [])[0] || []]))];
const rowOf = (rows, name) => rows.find((r) => r.name === name);

// a project with only email receipts set up; extract-bill deployed before its fixes; team with JWT verification;
// the subscription functions never deployed
const project = {
  manifest,
  deployed: allDeployed().filter((d) => !d.slug.startsWith('subscription'))
    .map((d) => d.slug === 'extract-bill' ? fn('extract-bill', '2026-10-02T18:08:55Z', true) : d.slug === 'team' ? fn('team', '2026-09-30T04:25:47Z', true) : d),
  secrets: ['SEND_ALLOWED_USERS', 'RESEND_API_KEY', 'EMAIL_FROM'],
  changedAt: { 'extract-bill': '2026-10-10T20:12:26+05:30', team: '2026-09-29T10:00:00+05:30', 'send-receipt': '2026-10-08T09:00:00+05:30' },
};
const found = assess(project);
const eb = rowOf(found, 'extract-bill').problems.join(' | ');
check('a function without its key is reported (extract-bill: missing secret ANTHROPIC_API_KEY)', /missing secret ANTHROPIC_API_KEY\b/.test(eb), eb);
check('a function older than its code is reported, with both dates (extract-bill: changed 2026-10-10, deployed 2026-10-02)', /2026-10-10.*2026-10-02.*redeploy/.test(eb), eb);
check('the wrong JWT setting is reported (team must be deployed with --no-verify-jwt)', /with --no-verify-jwt/.test(rowOf(found, 'team').problems.join(' | ')), rowOf(found, 'team'));
check('a function that was never deployed is reported (subscription, subscription-webhook)', ['subscription', 'subscription-webhook'].every((n) => rowOf(found, n).problems.includes('not deployed')), found.filter((r) => r.name.startsWith('subscription')));
check('a channel with all its secrets is ok (send-receipt: email)', rowOf(found, 'send-receipt').problems.length === 0, rowOf(found, 'send-receipt'));
check('a provider-less webhook says what to set (delivery-status: one of its providers)', /no provider set up: one of RESEND_WEBHOOK_SECRET/.test(rowOf(found, 'delivery-status').problems.join(' | ')), rowOf(found, 'delivery-status'));
check('a function that needs nothing is ok (receipt)', rowOf(found, 'receipt').problems.length === 0, rowOf(found, 'receipt'));

// after the fix: the key set and extract-bill redeployed
const fixed = assess({ ...project, secrets: [...project.secrets, 'ANTHROPIC_API_KEY'],
  deployed: project.deployed.map((d) => d.slug === 'extract-bill' ? fn('extract-bill', '2026-10-12T09:00:00Z', true) : d) });
check('with ANTHROPIC_API_KEY set and extract-bill redeployed, extract-bill is ok', rowOf(fixed, 'extract-bill').problems.length === 0, rowOf(fixed, 'extract-bill'));
check('a code change older than the deploy is not reported (team: changed 2026-09-29, deployed 2026-09-30)', !/redeploy/.test(rowOf(found, 'team').problems.join(' ')), rowOf(found, 'team'));

// the Supabase CLI's functions list gives updated_at in epoch milliseconds, not text
const asCli = assess({ ...project, deployed: project.deployed.map((d) => ({ ...d, updated_at: Date.parse(d.updated_at) })) });
check('deploy times as the CLI gives them (epoch milliseconds) still find extract-bill older than its code',
  /2026-10-10.*2026-10-02.*redeploy/.test(rowOf(asCli, 'extract-bill').problems.join(' | ')), rowOf(asCli, 'extract-bill'));
check('and report the deployed day as a date', rowOf(asCli, 'extract-bill').deployed.day === '2026-10-02', rowOf(asCli, 'extract-bill').deployed);

const complete = assess({ manifest, deployed: allDeployed(), secrets: everySecret, changedAt: {} });
check('a project with every function deployed as its README says and every key set: nothing to do', complete.every((r) => r.problems.length === 0), complete.filter((r) => r.problems.length));
const paused = assess({ manifest, deployed: allDeployed().map((d) => d.slug === 'receipt' ? { ...d, status: 'THROTTLED' } : d), secrets: everySecret });
check('a function that is not ACTIVE is reported', rowOf(paused, 'receipt').problems.includes('status THROTTLED'), rowOf(paused, 'receipt'));
const backwards = assess({ manifest, deployed: allDeployed().map((d) => d.slug === 'agent' ? { ...d, verify_jwt: false } : d), secrets: everySecret });
check('a function that needs JWT verification but runs without it is reported (agent)', /without JWT verification/.test(rowOf(backwards, 'agent').problems.join(' ')), rowOf(backwards, 'agent'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
