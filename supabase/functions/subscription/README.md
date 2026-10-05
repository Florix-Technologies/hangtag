# subscription and subscription-webhook (Supabase Edge Functions)

Hangtag's plans: the shop owner chooses a plan (1, 3 or 6 months), may add a promo code, pays on the payment provider's
page, and the plan starts as soon as the provider confirms the payment.

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

Deploy (these are Hangtag's OWN Razorpay keys — not a shop's payment-gateway keys):

```
supabase functions deploy subscription --project-ref <your-project-ref>
supabase functions deploy subscription-webhook --no-verify-jwt --project-ref <your-project-ref>
supabase secrets set SUBSCRIPTION_PROVIDER=razorpay SUBSCRIPTION_RAZORPAY_KEY_ID=rzp_live_… SUBSCRIPTION_RAZORPAY_KEY_SECRET=… \
  SUBSCRIPTION_WEBHOOK_SECRET=… APP_URL=https://<your app's address> --project-ref <your-project-ref>
```

Razorpay dashboard (Hangtag's account) → Webhooks → URL `https://<project>.supabase.co/functions/v1/subscription-webhook`,
the same secret, events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`.

Needs `supabase/migrations/20261006120000_hangtag_plans_subscriptions.sql` (schema.sql section 3t).
Unit tests (Node, no network): `tests/unit/subscription-function.test.mjs`; database: `supabase/tests/subscriptions.test.mjs`.
