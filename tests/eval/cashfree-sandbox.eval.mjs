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
import { autopayProviderFor, providerFor } from '../../supabase/functions/subscription/providers/index.js';
import { autopayIdFor, chargeIdFor } from '../../supabase/functions/subscription/providers/cashfree.js';

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

// AutoPay (Cashfree Subscriptions): a sandbox mandate made as the subscription function makes it, read back, a charge
// refused while it isn't approved, turned off, and confirmed off. Approving it needs a person on Cashfree's page:
//   optional: HANGTAG_EVAL_CASHFREE_AUTOPAY_APP_URL=https://<a Preview of the app> (where autopay.html is served) with
//   HANGTAG_EVAL_CASHFREE_AUTOPAY_WAIT=600 (its own wait, apart from the link's) — then open the printed AutoPay page
//   (served from that address, or this computer: only its #part matters), approve with Cashfree's sandbox test details, and the
//   check waits for ACTIVE, asks for a charge 3 days out (the trial's end, as the reconciler does) and turns it all off.
const A = autopayProviderFor({ SUBSCRIPTION_AUTOPAY_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: appId, SUBSCRIPTION_CASHFREE_SECRET_KEY: secret, SUBSCRIPTION_TEST_MODE: 'true' });
check('AutoPay: the sandbox provider takes mandates (SUBSCRIPTION_AUTOPAY_PROVIDER=cashfree)', !!A && A.mode === 'test' && typeof A.createAutopay === 'function');
if (A) {
  const ref = crypto.randomUUID(), appUrl = process.env.HANGTAG_EVAL_CASHFREE_AUTOPAY_APP_URL || 'https://example.com';
  const terms = { price: 1, currency: 'INR', plan: { code: 'm1', label: 'Sandbox check', months: 1 } };
  let made = null;
  try { made = await A.createAutopay({ ref, terms, phone: '9999999999', email: 'sandbox-check@example.com', appUrl, notes: { hangtag_check: 'sandbox' } }); }
  catch (e) { check('Cashfree made the AutoPay mandate (on demand, up to ₹1, ₹1 to confirm, refunded)', false, { status: e && e.status, code: e && e.code }); }
  if (made) {
    check('Cashfree made the AutoPay mandate (on demand, up to ₹1, ₹1 to confirm, refunded): its id is the set-up\'s, its page is the app\'s autopay.html',
      made.subscriptionId === autopayIdFor(ref) && made.authUrl.startsWith(appUrl.replace(/\/+$/, '') + '/autopay.html#cf='), made);
    const st0 = await A.getAutopay(made.subscriptionId);
    check('read back: waiting for the owner (INITIALIZED → created), nothing to report yet', st0.status === 'created' && st0.event === null, st0);
    const due = Date.now() + 3 * 86400e3;
    const early = await A.raiseCharge({ subscriptionId: made.subscriptionId, ref: chargeIdFor(made.subscriptionId, due), amount: 1, scheduleAt: due }).then((x) => ({ x }), (e) => ({ status: e && e.status, code: e && e.code }));
    check('a charge on a mandate nobody approved: refused by Cashfree (nothing can be charged before the owner approves)', !early.x, early);
    const wait2 = process.env.HANGTAG_EVAL_CASHFREE_AUTOPAY_APP_URL ? Math.min(900, +process.env.HANGTAG_EVAL_CASHFREE_AUTOPAY_WAIT || 0) : 0;
    if (wait2 > 0) {
      console.log(`Open ${made.authUrl} and approve AutoPay with Cashfree's sandbox test details within ${wait2} s…`);
      let st = st0;
      for (const until = Date.now() + wait2 * 1000; Date.now() < until && st.event !== 'authenticated'; ) { await new Promise((r) => setTimeout(r, 5000)); st = await A.getAutopay(made.subscriptionId); }
      check('after approving: ACTIVE (AutoPay reads it as authenticated: the trial would open)', st.event === 'authenticated', st);
      if (st.event === 'authenticated') {
        const ch = await A.raiseCharge({ subscriptionId: made.subscriptionId, ref: chargeIdFor(made.subscriptionId, due), amount: 1, scheduleAt: due }).then((x) => x, (e) => ({ err: e && e.status, code: e && e.code }));
        check('a charge asked for 3 days out (the trial\'s end): accepted, not taken yet', !ch.err && ['initialized', 'pending'].includes(ch.status), ch);
        const charges = await A.listCharges(made.subscriptionId);
        check('…its charges read back: that one charge (the ₹1 authorisation is not listed as a charge)', charges.filter((c) => c.ref === chargeIdFor(made.subscriptionId, due)).length === 1, charges);
      }
    }
    const off = await A.cancelAutopay(made.subscriptionId).then((x) => x, (e) => ({ err: e && e.status, code: e && e.code }));
    const offRead = await A.getAutopay(made.subscriptionId);
    check('turned off (as during the free month): Cashfree cancels it, and reading it back says so — no charge can follow', offRead.status === 'cancelled', { off, offRead });
    const charges2 = await A.listCharges(made.subscriptionId).catch(() => []);
    check('…and no charge on it is left waiting to be taken', !charges2.some((c) => c.status === 'initialized' || c.status === 'pending'), charges2);
  }
}
// the console's webhook self-check (billing_selfcheck) with Cashfree: its two probes made and withdrawn for real
if (A) {
  const ref = crypto.randomUUID();
  const link = await A.createProbeLink(ref).then((x) => x, (e) => ({ err: e && e.status, code: e && e.code }));
  const cancelled = typeof link === 'string' ? await A.cancelPayment(link).then(() => true, (e) => ({ err: e && e.status, code: e && e.code })) : null;
  const linkNow = typeof link === 'string' ? await A.getPayment(link) : null;
  check('self-check probe link: made (₹1, Hangtag\'s id), cancelled at once, read back cancelled', typeof link === 'string' && cancelled === true && linkNow.state === 'cancelled', { link, cancelled, linkNow });
  const sub = await A.createProbeAutopay({ ref }).then((x) => x, (e) => ({ err: e && e.status, code: e && e.code }));
  const off = typeof sub === 'string' ? await A.cancelAutopay(sub).then(() => A.getAutopay(sub), (e) => ({ err: e && e.status, code: e && e.code })) : null;
  check('self-check probe mandate: made (on demand, ₹1), cancelled at once, read back cancelled', typeof sub === 'string' && off && off.status === 'cancelled', { sub, off });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
