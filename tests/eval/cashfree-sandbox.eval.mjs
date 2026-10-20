// Cashfree's SANDBOX with the provider the Edge Functions run (supabase/functions/subscription/providers/cashfree.js): a
// payment link is made for ₹1.00 and read back as Cashfree answers it. It needs sandbox keys and the network, so it runs
// only when asked; it is not one of the suites `npm test` runs:
//   HANGTAG_EVAL_CASHFREE_APP_ID=… HANGTAG_EVAL_CASHFREE_SECRET_KEY=cfsk_ma_test_… npm run eval:cashfree-sandbox
//   optional: HANGTAG_EVAL_CASHFREE_WAIT=300 — then pay the printed link with Cashfree's sandbox test details within that
//   many seconds, and the check waits for Cashfree to report the PAID order and its SUCCESS payment.
//   optional: HANGTAG_EVAL_CASHFREE_NOTIFY_URL=https://<test-ref>.supabase.co/functions/v1/subscription-webhook — the
//   link then carries a TEST project's webhook as its notify_url, so paying it makes Cashfree deliver a real, signed
//   notification there (RELEASE.md §6d, step 2e). The live project is refused.
// Without keys it says so and exits 0. Production keys are refused (the provider only takes sandbox keys with
// SUBSCRIPTION_TEST_MODE=true). Nothing secret is printed: only the checks, the link's id and its URL.
import crypto from 'node:crypto';
import { providerFor } from '../../supabase/functions/subscription/providers/index.js';

const appId = process.env.HANGTAG_EVAL_CASHFREE_APP_ID || '', secret = process.env.HANGTAG_EVAL_CASHFREE_SECRET_KEY || '';
if (!appId || !secret) {
  console.log('SKIP the Cashfree sandbox check: set HANGTAG_EVAL_CASHFREE_APP_ID and HANGTAG_EVAL_CASHFREE_SECRET_KEY (sandbox keys) to run it.');
  process.exit(0);
}
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 300) : '')); };
const LIVE_REF = 'wcorlmgkwcahyfastjoz', notifyUrl = process.env.HANGTAG_EVAL_CASHFREE_NOTIFY_URL || '';
if (notifyUrl && (notifyUrl.includes(LIVE_REF) || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/subscription-webhook$/.test(notifyUrl))) {
  console.log('REFUSED: HANGTAG_EVAL_CASHFREE_NOTIFY_URL must be a test project\'s subscription-webhook (never the live project).');
  process.exit(1);
}
const P = providerFor({ SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: appId, SUBSCRIPTION_CASHFREE_SECRET_KEY: secret, SUBSCRIPTION_TEST_MODE: 'true' });
check('sandbox keys, on a test project: the provider is the sandbox (production keys are refused here)', !!P && P.mode === 'test');
if (!P) process.exit(1);
const paymentId = crypto.randomUUID();
let page = null;
try { page = await P.createPayment({ paymentId, amount: 1, currency: 'INR', description: 'Hangtag sandbox check', phone: '9999999999', callbackUrl: 'https://example.com/#plans?payment=' + paymentId, notifyUrl: notifyUrl || undefined }); }
catch (e) { check('Cashfree made the payment link', false, { status: e && e.status, code: e && e.code }); process.exit(1); }
check('Cashfree made the payment link (its id is the payment\'s, its page https)', page.orderId === 'ht_' + paymentId.replace(/-/g, '') && /^https:\/\//.test(page.payUrl), page);
console.log('link', page.orderId, page.payUrl);
if (notifyUrl) console.log('Cashfree will notify the test project\'s webhook when it is paid: then its hangtag_billing_exceptions has one unknown_order row for', page.orderId, '(a link no checkout recorded; nothing is activated).');
const again = await P.createPayment({ paymentId, amount: 1, currency: 'INR', description: 'Hangtag sandbox check', phone: '9999999999', callbackUrl: 'https://example.com/#plans?payment=' + paymentId, notifyUrl: notifyUrl || undefined })
  .then((x) => x, (e) => ({ err: e && e.status }));
check('the same request again (same idempotency key): the same link, not a second one', again.orderId === page.orderId || again.err === 409, again);
const v = await P.getPayment(page.orderId);
check('read back: open, nothing paid yet (pending)', v.state === 'pending' && v.paid === 0, v);
check('…with Hangtag\'s notes as Cashfree keeps them (the webhook tells Hangtag\'s links from others\' by these)', v.hangtag === true && v.ref === paymentId, v);
const none = await P.getPayment('ht_' + crypto.randomUUID().replace(/-/g, '')).then((x) => ({ x }), (e) => ({ status: e && e.status }));
check('a link Cashfree never made: 404 (the webhook answers such a notification for good, not "send again")', none.status === 404, none);
const wait = Math.min(900, +process.env.HANGTAG_EVAL_CASHFREE_WAIT || 0);
if (wait > 0) {
  console.log(`Pay the link above with Cashfree's sandbox test details within ${wait} s…`);
  let last = v;
  for (const until = Date.now() + wait * 1000; Date.now() < until && last.state !== 'paid'; ) { await new Promise((r) => setTimeout(r, 5000)); last = await P.getPayment(page.orderId); }
  check('after paying: Cashfree reports the PAID order with its SUCCESS payment, ₹1.00 in paise, INR', last.state === 'paid' && last.paid === 100 && !!last.paymentId && last.currency === 'INR', last);
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
