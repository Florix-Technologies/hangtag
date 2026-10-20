// A probe of the reconciliation entry of the subscription-webhook Edge Function as deployed on a TEST Supabase project
// (RELEASE.md §6d, step 2g), in place of a hand-typed curl that would leave the secret in the shell's history. It asks
// for one reconciliation run and checks the answers: GET refused (405); no secret, or a wrong one, refused (401) before
// anything is read; the right one runs a reconciliation (ok and complete, with what it checked and repaired); a second
// call right after answers busy (one run at a time, at most one every 5 minutes). A run reads the provider and repairs
// only through the database's own functions, as the hourly schedule will.
//   HANGTAG_PROBE_WEBHOOK_URL=https://<test-ref>.supabase.co/functions/v1/subscription-webhook \
//   HANGTAG_PROBE_RECONCILE_SECRET=<that project's SUBSCRIPTION_RECONCILE_SECRET> npm run probe:reconcile
// It refuses the live project (and any URL that isn't a Supabase function's or a local `supabase functions serve`), and a
// secret shorter than the function takes. Without settings it says so and exits 0. Nothing secret is printed.
import crypto from 'node:crypto';

const LIVE_REF = 'wcorlmgkwcahyfastjoz';
const url = process.env.HANGTAG_PROBE_WEBHOOK_URL || '', secret = process.env.HANGTAG_PROBE_RECONCILE_SECRET || '';
if (!url || !secret) {
  console.log('SKIP the reconciliation probe: set HANGTAG_PROBE_WEBHOOK_URL (a test project\'s subscription-webhook) and HANGTAG_PROBE_RECONCILE_SECRET (its SUBSCRIPTION_RECONCILE_SECRET).');
  process.exit(0);
}
const ok = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/subscription-webhook$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/functions\/v1\/subscription-webhook$/.test(url);
if (!ok || url.includes(LIVE_REF)) { console.log('REFUSED: not a test project\'s subscription-webhook URL (the live project is never probed).'); process.exit(1); }
if (secret.length < 32) { console.log('REFUSED: the reconcile secret is shorter than 32 characters, which the function never takes (RELEASE.md §6d, step 2d).'); process.exit(1); }

let fails = 0;
const check = (name, pass, info) => { if (!pass) fails++; console.log((pass ? 'PASS ' : 'FAIL ') + name + (!pass && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 300) : '')); };
/* the reconcile entry: its header, and the secret as a bearer token when given (never printed: only answers are) */
async function call({ method = 'POST', auth } = {}) {
  const res = await fetch(url, { method, headers: { 'x-hangtag-reconcile': '1', ...(auth === undefined ? {} : { authorization: auth }) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const get = await call({ method: 'GET', auth: 'Bearer ' + secret });
check('GET: refused (405)', get.status === 405, get);
const none = await call();
check('no secret: refused (401), nothing read', none.status === 401 && !!none.body && none.body.error === 'unauthorized', none);
const bad = await call({ auth: 'Bearer ' + crypto.randomBytes(24).toString('hex') });
check('a wrong secret: refused (401), nothing read', bad.status === 401 && !!bad.body && bad.body.error === 'unauthorized', bad);
const run = await call({ auth: 'Bearer ' + secret });
const b = run.body || {};
check('the right secret: one reconciliation run, ok and complete', run.status === 200 && b.ok === true && b.complete === true && !b.busy, run);
if (run.status === 200 && b.ok === true && !b.busy) {
  console.log(`      the run: ${b.complete ? 'complete' : 'NOT complete (capped: it resumes in the next run)'}, ${b.checked} checked, ${b.repaired} repaired, ${b.exceptions_opened} kept for review`);
}
const again = await call({ auth: 'Bearer ' + secret });
check('called again at once: busy (one run at a time, at most one every 5 minutes), nothing run', again.status === 200 && !!again.body && again.body.busy === true, again);

if (b.busy) console.log('busy on the first call: a run finished less than 5 minutes ago or is running. Run the probe again in 5 minutes.');
if (run.status === 503 && b.error === 'not_configured') console.log('503: the function says it isn\'t configured — SUBSCRIPTION_RECONCILE_SECRET (32+ characters) or the provider\'s keys are missing on this project (RELEASE.md §6d, step 2d).');
if (run.status === 503 && b.error === 'not_migrated') console.log('503: the post-repair migration isn\'t on this project\'s database (RELEASE.md §6d, step 2c).');
if (b.error === 'mode_mismatch') console.log('mode_mismatch: this project\'s billing mode isn\'t the keys\' mode — on a test project: UPDATE public.hangtag_billing_settings SET billing_mode = \'test\'; (§6d, step 2c).');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
