// The billing Edge Functions' own entry files (supabase/functions/subscription/index.ts and subscription-webhook/index.ts),
// run as they are — TypeScript included (Node strips the types) — with what Supabase's runtime gives them stood in:
// Deno.env and Deno.serve (the request handler each registers), "npm:@supabase/supabase-js" (tests/helpers/
// supabase-js-stand-in.mjs: each client recorded, its calls answered by the real schema and migrations over PGlite, with
// row security) and the network (a fake Cashfree on globalThis.fetch: nothing leaves this computer). Real Request and
// Response objects throughout.
// What it shows: routing (the ?back= return, the reconcile entry, methods), the raw body and lower-case headers reaching
// the signature check, the service-role client made only after a valid signature, the reconcile secret, CORS, the
// user's own client made from their bearer (and device) for the subscription function, providers chosen from the
// secrets. It is NOT Supabase's runtime (Deno, its gateway, Auth, PostgREST): that needs a deployed test project.
// Run: node supabase/tests/edge-entrypoints.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const STAND_IN = new URL('../../tests/helpers/supabase-js-stand-in.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (specifier === 'npm:@supabase/supabase-js@2.117.2' ? { url: STAND_IN, shortCircuit: true } : next(specifier, context)) });

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
const A = '11111111-1111-1111-1111-111111111111';
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test')`, [A]);
await db.query(`UPDATE public.hangtag_profiles SET shop_name = 'S', full_name = 'X', business_type = 'retail', phone = '+91 98765 43210', onboarded_at = NOW() WHERE id = $1`, [A]);
await db.query(`SELECT public.hangtag_subscription_ensure($1)`, [A]);
await db.query(`UPDATE public.hangtag_billing_settings SET billing_mode = 'test'`);

const RECONCILE = 'rs_' + 'q7'.repeat(20), SECRET = 'cfsk_ma_test_entry';
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key', APP_URL: 'https://app.hangtag.in',
  SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_AUTOPAY_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: SECRET,
  SUBSCRIPTION_TEST_MODE: 'true', SUBSCRIPTION_RECONCILE_SECRET: RECONCILE, SUBSCRIPTION_ALLOWED_ORIGINS: 'https://hangtag-preview.vercel.app' };
globalThis.__sbDb = db;
globalThis.__sbKeys = { anon: 'anon-key', service: 'service-key' };
globalThis.__sbTokens = { 'jwt-of-a': { id: A, email: 'a@shop.test' } };
const handlers = [];
globalThis.Deno = { env: { toObject: () => ({ ...ENV }) }, serve: (h) => { handlers.push(h); } };
// a fake Cashfree: every request recorded; a mandate it doesn't hold → 404
const seen = [];
globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), method: init.method || 'GET' }); return new Response(JSON.stringify({ code: 'subscription_not_found' }), { status: 404 }); };

await import('../functions/subscription-webhook/index.ts');
await import('../functions/subscription/index.ts');
const [webhook, subscription] = handlers;
check('both entry files load as written (TypeScript, the npm: import, Deno.serve) and register one handler each', handlers.length === 2 && typeof webhook === 'function' && typeof subscription === 'function');
const clients = () => globalThis.__sbClients || [];
const W = 'https://proj.supabase.co/functions/v1/subscription-webhook';
const sign = (ts, raw) => crypto.createHmac('sha256', SECRET).update(ts + raw).digest('base64');

console.log('=== subscription-webhook/index.ts ===');
const back = await webhook(new Request(W + '?back=autopay', { method: 'POST', body: 'x=1' }));
const elsewhere = await webhook(new Request(W + '?back=https://evil.example'));
check('the AutoPay return (?back=autopay, GET or POST): 303 to the app\'s own plans page, never anywhere a query names; nothing else happens on it',
  back.status === 303 && back.headers.get('location') === 'https://app.hangtag.in/#plans?autopay=back' && elsewhere.status !== 303 && clients().length === 0,
  { back: back.status, location: back.headers.get('location'), elsewhere: elsewhere.status });
const get = await webhook(new Request(W));
const unsigned = await webhook(new Request(W, { method: 'POST', body: '{"type":"SUBSCRIPTION_STATUS_CHANGED"}' }));
const raw = JSON.stringify({ type: 'SUBSCRIPTION_STATUS_CHANGED', event_time: '2026-10-27T10:00:00+05:30', data: { subscription_details: { subscription_id: 'htap_' + 'a'.repeat(32), subscription_status: 'ACTIVE' } } });
const forged = await webhook(new Request(W, { method: 'POST', body: raw, headers: { 'X-Webhook-Timestamp': '1', 'X-Webhook-Signature': sign('1', raw + ' ') } }));
check('a GET: 405; a POST with no signature or a signature that isn\'t over this raw body: 400 — and the service-role client is never made for any of them',
  get.status === 405 && unsigned.status === 400 && forged.status === 400 && clients().length === 0, { get: get.status, unsigned: unsigned.status, forged: forged.status, clients: clients().length });
const ts = String(Date.now());
const ok = await webhook(new Request(W, { method: 'POST', body: raw, headers: { 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': sign(ts, raw), 'X-Idempotency-Key': 'entry-1' } }));
const okBody = await ok.json();
const svc = clients().filter((c) => c.role === 'service_role');
check('a signed Cashfree notification (header names as sent, Mixed-Case): checked on the raw body, then settled through the service-role client made from SUPABASE_URL and the service key; JSON answer',
  ok.status === 200 && okBody.ok === true && svc.length >= 1 && svc.every((c) => c.url === ENV.SUPABASE_URL && c.key === 'service') && ok.headers.get('content-type') === 'application/json',
  { status: ok.status, body: okBody, clients: clients().map((c) => [c.role, c.key]) });
const payRaw = JSON.stringify({ type: 'SUBSCRIPTION_PAYMENT_SUCCESS', event_time: '2026-10-27T10:01:00+05:30',
  data: { subscription_id: 'htap_' + 'a'.repeat(32), cf_payment_id: '9001', payment_id: 'htc_x_20261030', payment_type: 'CHARGE', payment_amount: 999, payment_status: 'SUCCESS' } });
const ts2 = String(Date.now());
const pay = await webhook(new Request(W, { method: 'POST', body: payRaw, headers: { 'x-webhook-timestamp': ts2, 'x-webhook-signature': sign(ts2, payRaw), 'x-idempotency-key': 'entry-2' } }));
const asked = seen.filter((s) => s.url.includes('/subscriptions/htap_'));
check('a signed charge notification: the charge is read back from Cashfree before anything counts — the SANDBOX API (the provider chosen from the secrets), the mandate\'s payments; one it doesn\'t hold → nothing recorded',
  pay.status === 200 && asked.length === 1 && asked[0].url === 'https://sandbox.cashfree.com/pg/subscriptions/' + 'htap_' + 'a'.repeat(32) + '/payments'
  && (await db.query(`SELECT count(*)::int n FROM public.hangtag_subscription_payments`)).rows[0].n === 0, { status: pay.status, asked });
const rec = (auth) => webhook(new Request(W, { method: 'POST', body: '{}', headers: { 'x-hangtag-reconcile': '1', ...(auth ? { Authorization: auth } : {}) } }));
const r1 = await rec(null), r2 = await rec('Bearer ' + 'x'.repeat(40)), r3 = await rec('Bearer ' + RECONCILE);
const r3b = await r3.json();
const runs = (await db.query(`SELECT count(*)::int n FROM public.hangtag_billing_reconcile_runs WHERE ok AND complete`)).rows[0].n;
check('the reconcile entry (x-hangtag-reconcile: 1): no bearer or another secret 401; the reconcile secret → a run, completed and recorded',
  r1.status === 401 && r2.status === 401 && r3.status === 200 && r3b.ok === true && r3b.complete === true && runs === 1, { r1: r1.status, r2: r2.status, r3: r3b, runs });

console.log('=== subscription/index.ts ===');
const S = 'https://proj.supabase.co/functions/v1/subscription';
const pre = await subscription(new Request(S, { method: 'OPTIONS', headers: { Origin: 'https://app.hangtag.in' } }));
const preview = await subscription(new Request(S, { method: 'OPTIONS', headers: { Origin: 'https://hangtag-preview.vercel.app' } }));
const evil = await subscription(new Request(S, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
check('CORS: the app\'s origin and the allowed Previews are let in (with authorization and the device header allowed); any other origin is not',
  pre.status === 200 && pre.headers.get('access-control-allow-origin') === 'https://app.hangtag.in' && preview.headers.get('access-control-allow-origin') === 'https://hangtag-preview.vercel.app'
  && !evil.headers.get('access-control-allow-origin') && /authorization/.test(pre.headers.get('access-control-allow-headers')) && /x-hangtag-device/.test(pre.headers.get('access-control-allow-headers')),
  { pre: pre.headers.get('access-control-allow-origin'), evil: evil.headers.get('access-control-allow-origin') });
const before = clients().length;
const anon = await subscription(new Request(S, { method: 'POST', body: JSON.stringify({ action: 'config' }), headers: { 'Content-Type': 'application/json' } }));
const cfg = await subscription(new Request(S, { method: 'POST', body: JSON.stringify({ action: 'config' }),
  headers: { Authorization: 'Bearer jwt-of-a', 'x-hangtag-device': 'dev-1', 'Content-Type': 'application/json', Origin: 'https://app.hangtag.in' } }));
const cfgBody = await cfg.json();
const user = clients().slice(before).filter((c) => c.role === 'authenticated');
check('no sign-in: refused (401); signed in: the owner\'s own client from the anon key and their bearer (and device), the provider\'s availability answered, CORS on the answer',
  anon.status === 401 && cfg.status === 200 && cfgBody.provider === 'cashfree' && user.length >= 1 && user[0].key === 'anon' && user[0].url === ENV.SUPABASE_URL && user[0].device === 'dev-1'
  && cfg.headers.get('access-control-allow-origin') === 'https://app.hangtag.in', { anon: anon.status, cfg: cfgBody, user });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
