# subscription and subscription-webhook (Supabase Edge Functions)

Hangtag's plans: the shop owner chooses a plan (Monthly, 3, 6 or 12 Months; the launch offer applies by itself to new
customers), may add a promo code, pays on the payment provider's page, and the plan starts as soon as the provider confirms
the payment. Or AutoPay: the 30-day trial, nothing to pay today, then the AutoPay plan (Monthly) each month until cancelled.

- **The database decides the money.** `hangtag_subscription_checkout` (called as the signed-in owner) computes the price
  and the promo discount and creates the payment; `hangtag_subscription_activate` (service role) activates it only when
  the provider confirmed exactly the amount (and currency) due. The app never sends a price, discount or amount.
- **Providers** (`providers/index.js`): Razorpay or Cashfree payment links, with Hangtag's OWN keys (never a shop's
  payment-gateway keys). Not configured → `{ available: false }` and the app says so honestly. A 100% promo needs no
  provider. Test credentials (Razorpay `rzp_test_…`, Cashfree's sandbox) only with `SUBSCRIPTION_TEST_MODE=true`, on a test
  project; live credentials never there. A payment is always checked with the provider that took it.
- **Cashfree** (`providers/cashfree.js`, API 2026-01-01): Payment Links, so no Cashfree script runs in the app. Each link is
  `ht_` + the payment's id, made with that id as idempotency key and noted as Hangtag's (`link_notes.hangtag_app`), with
  this project's webhook as its `notify_url`. A notification is only a nudge: the link, its PAID orders and their SUCCESS
  payment are read from Cashfree's API before anything is decided. Cashfree needs the payer's mobile number: the shop's.
- **Actions** (POST JSON): `config` → `{ ok, available, provider, autopay }`; `checkout { plan, promo }` → `{ ok, payment_id,
  amount, pay_url }` (or `{ ok, free: true, status: "paid" }`); `verify { payment_id }` → `{ ok, status }`. Only the shop
  owner can check out; a payment can only be verified by its own shop.
- **subscription-webhook** activates a plan when the provider reports the payment (the app may be closed by then). The
  signature is checked on the raw body first. It answers 2xx only once a notification is settled or can never be, so the
  provider sends it again otherwise; money that can't be matched (an amount or currency that isn't due, a link naming
  another payment, a refund, an activation refused for good) is kept for review in `hangtag_billing_exceptions` and never
  activates or removes time by itself; a settled notification sent again is known (`hangtag_billing_events`). Orders that
  aren't Hangtag plan payments (another product on the same provider account) are ignored. Refunds and disputes (both
  providers) are kept for review; a payment whose refund or dispute is open adds no time.
- **The billing mode** (after the post-repair migration): the database says whose money it counts — `live`, or `test` on
  a test project (set in the SQL Editor). Keys in the other mode do nothing: no checkout, no activation, and a
  notification in the other mode is kept for review (`mode_mismatch`), never acted on.
- **Reconciliation** (`reconcile.js`): the webhook function also answers a scheduled call — POST with
  `x-hangtag-reconcile: 1` and `Authorization: Bearer <SUBSCRIPTION_RECONCILE_SECRET>` (32 characters or more) — that reads
  back what the provider holds and repairs missed notifications through the same database functions, once; what can't be
  matched is kept for review. One run at a time. The schedule (hourly) is the owner's to set up.
- **billing_selfcheck** (console staff who manage settings): a ₹1 Razorpay link and a subscription starting in a year,
  made and cancelled at once; their notifications are what proves AutoPay's webhook (readiness).
- **AutoPay** (Razorpay Subscriptions; `autopay_start { consent: true, consent_version }`, `autopay_verify`,
  `autopay_cancel`): the provider's plan is checked against the AutoPay terms before the owner's consent is recorded; only
  the provider moves AutoPay on, and only a CAPTURED charge at the price agreed adds paid time. Every set-up is in a
  registry (replaced ones are cancelled at the provider; a charge on one is still recorded once). The database lets
  AutoPay be switched on only once its webhook is proven (the self-check and a complete reconciliation); keep it off
  until the Razorpay test-mode proof (REMEDIATION.md).
- **The provider asked a limited number of times per account** (after the post-repair migration; REMEDIATION step 11):
  the payment check 60 a minute and 900 an hour (over it, the database's own answer, "pending"), starting AutoPay 6 and
  30 (then 429). Checkout is already limited (20 pages an hour); turning AutoPay off isn't.
- **CORS:** the app's origin (`APP_URL`) and `SUBSCRIPTION_ALLOWED_ORIGINS` (comma-separated; one `*` stands for one part of
  a host name, e.g. `https://hangtag-*-<team>.vercel.app` for Previews).

Deploy only through RELEASE.md's checklist (§6d), after the database repair and the post-repair migration. Secrets go in
from a file kept outside the repository, never on the command line (it would stay in the shell's history); every setting
by name is in RELEASE.md §6d step 2d. For example:
```
supabase secrets set --env-file <file outside the repository> --project-ref <ref>
supabase functions deploy subscription --project-ref <ref>
supabase functions deploy subscription-webhook --no-verify-jwt --project-ref <ref>
```
That file, for Cashfree: `SUBSCRIPTION_PROVIDER=cashfree`, `SUBSCRIPTION_CASHFREE_APP_ID`, `SUBSCRIPTION_CASHFREE_SECRET_KEY`,
`SUBSCRIPTION_CASHFREE_ENV` (`production`; `sandbox` only with `SUBSCRIPTION_TEST_MODE=true` on a test project), `APP_URL`,
`SUBSCRIPTION_RECONCILE_SECRET`; for Razorpay (and AutoPay's plan): `SUBSCRIPTION_PROVIDER=razorpay`,
`SUBSCRIPTION_RAZORPAY_KEY_ID`, `SUBSCRIPTION_RAZORPAY_KEY_SECRET`, `SUBSCRIPTION_WEBHOOK_SECRET`,
`SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID`, `APP_URL`, `SUBSCRIPTION_RECONCILE_SECRET`.

Needs the database repair (schema.sql: sections 3t, 3w) and `supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql`
(the billing mode, the ledger, the AutoPay registry, reconciliation). Without the migration both functions fall back to
the older database functions, with live keys only (test keys need a database in test mode).
Tests (no network, no keys): `tests/unit/subscription-function.test.mjs`, `subscription-handlers.test.mjs`,
`subscription-cashfree.test.mjs`, `subscription-reconcile.test.mjs`, `payment-probes.test.mjs`; database:
`supabase/tests/subscriptions.test.mjs`, `subscription-cashfree.test.mjs`, `billing-consistency.test.mjs`; the console:
`tests/e2e/console-billing-review.test.mjs`. On a test project (RELEASE.md §6d step 2): `npm run eval:cashfree-sandbox`
(sandbox keys), `npm run probe:cashfree-webhook`, `npm run probe:reconcile`.
