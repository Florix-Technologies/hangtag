# payment-gateway and payment-webhook (Supabase Edge Functions)

Verified payments through **Razorpay**: a single-use **UPI QR** for the exact amount of the bill (or of one part of a
split payment), and a **card payment link** the customer opens on their own phone (shown as a QR). A payment counts as
**verified** only when Razorpay's own record shows a captured payment of exactly that amount. Showing, sharing or
refreshing a QR changes nothing.

- `core.js`: request checks, Razorpay request bodies, reading Razorpay's answers (`qrView`, `linkView`), the intent's
  next state (`nextIntent`: idempotent; money for a cancelled / expired intent or of another amount becomes
  **unmatched**), matching a UPI payment checked by hand with Razorpay's payments (`matchManual`: same amount and bank
  reference), and the webhook signature. Unit-tested in Node: `tests/unit/payments-delivery-cash.test.mjs`.
- `index.ts` (payment-gateway, JWT verification on): `config` · `create` · `status` · `cancel` · `verify` ·
  `unmatched` · `resolve` (refund through Razorpay, or mark paid back / allocated).
- `../payment-webhook/index.ts` (no JWT verification; Razorpay signs each call): catches payments that arrive while no
  phone is watching, so late money is recorded (as verified, or as an unmatched receipt).

Rows live in `hangtag_payment_intents` (schema.sql section 3h), written only by these functions; the app can read its
own. **Team members** (section 3i) take payments for their shop: the shop comes from the database (`hangtag_shop_id()`
with the caller's session and the phone's `x-hangtag-device` key, which the function forwards), each action needs the
member's permission (`core.js` `ACTION_PERMISSIONS`: `create_sale`; refunds `perform_return`; listing unmatched receipts
`view_reports`, settling one (`resolve`: a refund, paid back or added to a bill) `perform_return`), and `PAYMENT_ALLOWED_USERS` may name the member or, for the whole team, the shop's owner. `hangtag_payments.verification = 'verified'` is refused by the database unless a verified intent of the same shop,
method and amount exists, so the app can't claim a verification.

## What the app does

- UPI on the payment screen shows the verified QR straight away when this function is set up and the phone is online.
  The screen checks the status every 3 seconds; when Razorpay confirms the payment the bill completes by itself and the
  bank book records it as verified. Expired / failed / cancelled QRs can be made again, or the payment checked by hand.
- Without the provider (not set up, offline, or unreachable), UPI is **checked by hand**: the shop's UPI ID (Settings →
  Payments) as a QR with the amount, and the customer's transaction reference (UTR) is required. It is saved as
  **Unverified** and matched with Razorpay's payments later (Reports → Reconciliation, and each time the app connects).
- Card: the **card machine** reference is required (and at most the last 4 digits; a card number is refused); or a
  verified **card link**. Tap-to-pay on the phone itself needs a native SDK from the provider and is not available in a
  web app.
- A QR still open when the app closes is shown again when it reopens.

## Deploy

```bash
supabase functions deploy payment-gateway --project-ref <your-project-ref>
supabase functions deploy payment-webhook --no-verify-jwt --project-ref <your-project-ref>
```

Secrets (`supabase secrets set NAME=value --project-ref <ref>`):

| Secret | What |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | API keys from the Razorpay dashboard (test keys `rzp_test_…` first). UPI QR codes must be enabled on the account. |
| `PAYMENT_ALLOWED_USERS` (**required**) | Accounts that may take provider payments: user ids or sign-in emails, comma-separated, or `*`. Unset = off. |
| `RAZORPAY_WEBHOOK_SECRET` | The secret of the webhook below (for payment-webhook). |
| `PAYMENT_CARD_LINK=off` | Optional: hide card payment links. |

Razorpay dashboard → Webhooks: URL `https://<project-ref>.supabase.co/functions/v1/payment-webhook`, the same secret,
events `qr_code.credited`, `qr_code.closed`, `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`.

Test mode: create a QR from the app with test keys, then pay it from the Razorpay dashboard's test tools; the bill
completes when the status check (or the webhook) sees the captured payment.
