// A probe of the subscription-webhook Edge Function as deployed on a TEST Supabase project with Cashfree's sandbox keys
// (RELEASE.md §6d, step 2e). It sends notifications that change nothing — no payment, no database row — and checks the
// answers: the method, a wrong signature, and correctly signed notifications Hangtag has nothing to do with. A 200 for
// the signed ones proves the function holds the same secret key as the probe and verifies Cashfree's signature as
// Cashfree makes it; a real delivery from Cashfree is then checked with a sandbox payment (§6d, step 2e: the sandbox eval
// with HANGTAG_EVAL_CASHFREE_NOTIFY_URL).
//   HANGTAG_PROBE_WEBHOOK_URL=https://<test-ref>.supabase.co/functions/v1/subscription-webhook \
//   HANGTAG_EVAL_CASHFREE_SECRET_KEY=cfsk_ma_test_… npm run probe:cashfree-webhook
// It refuses the live project (and any URL that isn't a Supabase function's or a local `supabase functions serve`), and
// production keys. Without settings it says so and exits 0. Nothing secret is printed.
import crypto from 'node:crypto';

const LIVE_REF = 'wcorlmgkwcahyfastjoz';
const url = process.env.HANGTAG_PROBE_WEBHOOK_URL || '', secret = process.env.HANGTAG_EVAL_CASHFREE_SECRET_KEY || '';
if (!url || !secret) {
  console.log('SKIP the webhook probe: set HANGTAG_PROBE_WEBHOOK_URL (a test project\'s subscription-webhook) and HANGTAG_EVAL_CASHFREE_SECRET_KEY (its sandbox secret key).');
  process.exit(0);
}
const ok = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/subscription-webhook$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/functions\/v1\/subscription-webhook$/.test(url);
if (!ok || url.includes(LIVE_REF)) { console.log('REFUSED: not a test project\'s subscription-webhook URL (the live project is never probed).'); process.exit(1); }
if (!/^cfsk_ma_test_/.test(secret)) { console.log('REFUSED: only a sandbox secret key (cfsk_ma_test_…) is used here.'); process.exit(1); }

let fails = 0;
const check = (name, pass, info) => { if (!pass) fails++; console.log((pass ? 'PASS ' : 'FAIL ') + name + (!pass && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 300) : '')); };
const sign = (ts, raw) => crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
async function send(raw, { method = 'POST', ts = String(Date.now()), signature, type = 'application/json' } = {}) {
  const headers = method === 'POST' ? { 'content-type': type, 'x-webhook-timestamp': ts, 'x-webhook-signature': signature === undefined ? sign(ts, raw) : signature, 'x-webhook-version': '2025-01-01',
    'x-idempotency-key': 'probe-' + crypto.randomUUID() } : {};
  const res = await fetch(url, { method, headers, body: method === 'POST' ? raw : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// an order of another product on the same account, as Cashfree's own dashboard test sends: nothing of Hangtag's in it
const other = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', event_time: new Date().toISOString(),
  data: { order: { order_id: 'probe-' + Date.now(), order_amount: 1, order_currency: 'INR', order_tags: null }, payment: { cf_payment_id: '1', payment_status: 'SUCCESS', payment_amount: 1 } } });

const get = await send('', { method: 'GET' });
check('GET: refused (405)', get.status === 405, get);
const bad = await send(other, { signature: sign('1', other) });
check('a signature that isn\'t Cashfree\'s for this body: refused (400 bad_signature), nothing read', bad.status === 400 && bad.body && bad.body.error === 'bad_signature', bad);
const none = await send(other, { signature: '' });
check('no signature: refused (400)', none.status === 400, none);
const good = await send(other);
check('signed with the sandbox key, an order that isn\'t Hangtag\'s: 200, ignored — the function holds the same key and checks the signature as Cashfree makes it', good.status === 200 && good.body && good.body.ignored === true, good);
const form = 'link_id=probe_link&link_status=PAID';
const formed = await send(form, { type: 'application/x-www-form-urlencoded' });
check('a signed form-data notification (as Cashfree may send for links) with no Hangtag link in it: 200, ignored', formed.status === 200 && formed.body && formed.body.ignored === true, formed);
if (good.status === 503) console.log('503: the function says it isn\'t configured — the sandbox secrets or SUBSCRIPTION_TEST_MODE=true are missing on this project (RELEASE.md §6d, step 3).');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
