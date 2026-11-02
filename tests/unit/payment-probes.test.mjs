// The owner's two probes of a deployed test project (RELEASE.md §6d, steps 2e and 2g), run here against a local server
// that wraps the real handlers as subscription-webhook/index.ts does (no network, no database but a scripted one):
// - scripts/cashfree-webhook-probe.mjs: every check passes against the real webhook handler, which reads nothing;
// - scripts/reconcile-probe.mjs: GET 405, no secret and a wrong one 401 before anything is read, the right one one run
//   (ok, complete), at once again busy;
// - both refuse the live project, a production key or a short secret, and URLs that aren't a function's; both skip
//   without settings; neither prints a secret.
// Run: node tests/unit/payment-probes.test.mjs
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleWebhook } from '../../supabase/functions/subscription-webhook/handler.js';
import { providerFor, providerNamed, webhookProviderFor } from '../../supabase/functions/subscription/providers/index.js';
import { handleReconcile } from '../../supabase/functions/subscription/reconcile.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
const script = (f) => fileURLToPath(new URL(`../../scripts/${f}`, import.meta.url));
const CF_KEY = 'cfsk_ma_test_' + crypto.randomBytes(12).toString('hex'), REC = crypto.randomBytes(24).toString('hex');
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST1', SUBSCRIPTION_CASHFREE_SECRET_KEY: CF_KEY, SUBSCRIPTION_CASHFREE_ENV: 'sandbox',
  SUBSCRIPTION_TEST_MODE: 'true', SUBSCRIPTION_RECONCILE_SECRET: REC };
const noNetwork = async () => { throw new Error('no network in this test'); };
const quiet = { error() {}, warn() {}, info() {} };

// the database, scripted: the first run begins (nothing to check on a new project), later ones find it busy
let webhookDb = 0, reconcileDb = 0, begun = 0;
const dbCalls = [];
const reconcileAdmin = () => { reconcileDb++; return { rpc: async (name) => {
  dbCalls.push(name);
  if (name === 'hangtag_billing_reconcile_begin') return begun++ === 0
    ? { data: { run_id: 7, started_at: new Date().toISOString(), payments: [], mandates: [], c_since: null, d_since: null }, error: null }
    : { data: { busy: true }, error: null };
  if (name === 'hangtag_billing_reconcile_done') return { data: { ok: true }, error: null };
  return { data: null, error: { code: 'XX000', message: 'not expected: ' + name } };
} }; };
const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', async () => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const r = headers['x-hangtag-reconcile']
    ? await handleReconcile({ method: req.method, headers }, { env: ENV, admin: reconcileAdmin, provider: providerFor(ENV, noNetwork), autopay: null,
      named: (n) => providerNamed(n, ENV, noNetwork), log: quiet })
    : await handleWebhook({ method: req.method, raw: req.method === 'POST' ? raw : '', headers },
      { provider: webhookProviderFor(ENV, headers, noNetwork), admin: () => { webhookDb++; throw new Error('the database was reached'); }, log: quiet });
  res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body));
}); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_OK = `http://127.0.0.1:${server.address().port}/functions/v1/subscription-webhook`;
const LIVE = 'https://wcorlmgkwcahyfastjoz.supabase.co/functions/v1/subscription-webhook';
const run = (f, env) => new Promise((resolve) => execFile(process.execPath, [script(f)], { env: { ...process.env, HANGTAG_PROBE_WEBHOOK_URL: '', HANGTAG_EVAL_CASHFREE_SECRET_KEY: '',
  HANGTAG_PROBE_RECONCILE_SECRET: '', ...env }, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr })));
const secretFree = (r) => !r.out.includes(CF_KEY) && !r.out.includes(REC);

try {
  console.log('=== the webhook probe (§6d, step 2e) ===');
  const wh = await run('cashfree-webhook-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK, HANGTAG_EVAL_CASHFREE_SECRET_KEY: CF_KEY });
  check('against the real webhook handler: every check passes (GET 405, a wrong or missing signature 400, signed notifications of no Hangtag payment 200), exit 0',
    wh.code === 0 && (wh.out.match(/^PASS /gm) || []).length === 5 && !/^FAIL /m.test(wh.out) && /all passed/.test(wh.out), wh.out);
  check('…the database never reached, and no secret in its output', webhookDb === 0 && secretFree(wh), { webhookDb });
  const whLive = await run('cashfree-webhook-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: LIVE, HANGTAG_EVAL_CASHFREE_SECRET_KEY: CF_KEY });
  const whProd = await run('cashfree-webhook-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK, HANGTAG_EVAL_CASHFREE_SECRET_KEY: 'cfsk_ma_prod_' + 'x'.repeat(20) });
  const whElse = await run('cashfree-webhook-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: 'https://example.com/functions/v1/subscription-webhook', HANGTAG_EVAL_CASHFREE_SECRET_KEY: CF_KEY });
  const whNone = await run('cashfree-webhook-probe.mjs', {});
  check('…refuses the live project, a production key and a URL that isn\'t a Supabase function (exit 1, nothing sent); skips without settings (exit 0)',
    whLive.code === 1 && /REFUSED/.test(whLive.out) && whProd.code === 1 && /REFUSED/.test(whProd.out) && whElse.code === 1 && /REFUSED/.test(whElse.out)
    && whNone.code === 0 && /^SKIP/.test(whNone.out) && webhookDb === 0 && [whLive, whProd, whElse].every(secretFree), [whLive, whProd, whElse, whNone].map((r) => [r.code, r.out.slice(0, 120)]));

  console.log('=== the reconciliation probe (§6d, step 2g) ===');
  const rc = await run('reconcile-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK, HANGTAG_PROBE_RECONCILE_SECRET: REC });
  check('against the real reconcile entry: GET 405, no secret 401, a wrong one 401, the right one a run (ok, complete), at once again busy — exit 0',
    rc.code === 0 && (rc.out.match(/^PASS /gm) || []).length === 5 && !/^FAIL /m.test(rc.out) && /the run: complete, 0 checked, 0 repaired, 0 kept for review/.test(rc.out), rc.out);
  check('…the database reached only with the right secret: one run begun and recorded, the second call answered busy; no secret in its output',
    reconcileDb === 2 && JSON.stringify(dbCalls) === JSON.stringify(['hangtag_billing_reconcile_begin', 'hangtag_billing_reconcile_done', 'hangtag_billing_reconcile_begin']) && secretFree(rc),
    { reconcileDb, dbCalls });
  const rcLive = await run('reconcile-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: LIVE, HANGTAG_PROBE_RECONCILE_SECRET: REC });
  const rcShort = await run('reconcile-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK, HANGTAG_PROBE_RECONCILE_SECRET: REC.slice(0, 31) });
  const rcElse = await run('reconcile-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK.replace('subscription-webhook', 'subscription'), HANGTAG_PROBE_RECONCILE_SECRET: REC });
  const rcNone = await run('reconcile-probe.mjs', {});
  check('…refuses the live project, a secret shorter than 32 characters and another function\'s URL (exit 1, nothing sent); skips without settings (exit 0)',
    rcLive.code === 1 && /REFUSED/.test(rcLive.out) && rcShort.code === 1 && /REFUSED/.test(rcShort.out) && rcElse.code === 1 && /REFUSED/.test(rcElse.out)
    && rcNone.code === 0 && /^SKIP/.test(rcNone.out) && reconcileDb === 2 && [rcLive, rcShort, rcElse].every(secretFree),
    [rcLive, rcShort, rcElse, rcNone].map((r) => [r.code, r.out.slice(0, 120)]));
  const again = await run('reconcile-probe.mjs', { HANGTAG_PROBE_WEBHOOK_URL: URL_OK, HANGTAG_PROBE_RECONCILE_SECRET: REC });
  check('…a run less than 5 minutes before: not counted as a pass (busy on its first call), and it says to wait 5 minutes',
    again.code === 1 && /^FAIL the right secret/m.test(again.out) && /Run the probe again in 5 minutes/.test(again.out) && secretFree(again), again.out);
} finally {
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
