# subscription and subscription-webhook (Supabase Edge Functions)

Hangtag's plans: the shop owner chooses a plan (Monthly, 3, 6 or 12 Months; the launch offer applies by itself to new
customers), may add a promo code, pays on the payment provider's page, and the plan starts as soon as the provider confirms
the payment. Or AutoPay: the 30-day trial, nothing to pay today, then the AutoPay plan (Monthly) each month until cancelled.

- **The database decides the money.** `hangtag_subscription_checkout` (called as the signed-in owner) computes the price
  and the promo discount and creates the payment; `hangtag_subscription_activate` (service role) activates it only when
  the provider confirmed exactly the amount due. The app never sends a price, discount or amount (ignored if it does).
- **Provider abstraction** (`providers/index.js`): Razorpay Payment Links today; another provider is another file with the
  same shape. Not configured → `{ available: false }` and the app says so honestly. A 100% promo needs no provider.
- **Actions** (POST JSON): `config` → `{ ok, available, provider }`; `checkout { plan, promo }` → `{ ok, payment_id, amount,
  pay_url }` (or `{ ok, free: true, status: "paid" }`); `verify { payment_id }` → `{ ok, status: "paid" | "pending" |
  "expired" | "cancelled" | "failed", period_end? }`. Only the shop owner can check out; a payment can only be verified by
  its own shop.
- **subscription-webhook** activates a plan when the provider reports the payment (the app may be closed by then).
  Requests without a valid signature are refused. Idempotent.
- **AutoPay** (`autopay_start { consent: true, consent_version }`, `autopay_verify`, `autopay_cancel`): the owner's consent
  is recorded by the database (`hangtag_autopay_begin`, as the owner); the function checks the provider's plan is exactly
  the AutoPay plan's price, then makes the mandate (Razorpay Subscriptions, first charge when the trial ends). Only the
  provider moves AutoPay on (`subscription.*` webhooks, or `autopay_verify` asking it); only a CAPTURED charge
  (`subscription.charged`) adds paid time and counts as money received (`captured_at`). Turning it off cancels at the
  provider first; the trial or paid time running is kept. Switch AutoPay on for Hangtag in the Platform Console
  (Settings: "AutoPay is set up") only after the plan secret below is set: new trials then need AutoPay.

Deploy (these are Hangtag's OWN Razorpay keys — not a shop's payment-gateway keys):

```
supabase functions deploy subscription --project-ref <your-project-ref>
supabase functions deploy subscription-webhook --no-verify-jwt --project-ref <your-project-ref>
supabase secrets set SUBSCRIPTION_PROVIDER=razorpay SUBSCRIPTION_RAZORPAY_KEY_ID=rzp_live_… SUBSCRIPTION_RAZORPAY_KEY_SECRET=… \
  SUBSCRIPTION_WEBHOOK_SECRET=… APP_URL=https://<your app's address> --project-ref <your-project-ref>
# AutoPay: a monthly plan in the Razorpay dashboard at exactly the AutoPay plan's price (Monthly: 999.00 INR)
supabase secrets set SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID=plan_… --project-ref <your-project-ref>
```

Razorpay dashboard (Hangtag's account) → Webhooks → URL `https://<project>.supabase.co/functions/v1/subscription-webhook`,
the same secret, events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled` and, for AutoPay,
`subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`,
`subscription.cancelled`, `subscription.completed`, `subscription.resumed`.

Needs `supabase/migrations/20261006120000_hangtag_plans_subscriptions.sql` (schema.sql section 3t), then
`supabase/migrations/20261009120000_hangtag_plans_autopay_platform.sql` (section 3w: plans, the launch offer, AutoPay).
Unit tests (Node, no network): `tests/unit/subscription-function.test.mjs`; database: `supabase/tests/subscriptions.test.mjs`.
