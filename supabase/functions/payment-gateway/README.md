# payment-gateway and payment-webhook (Supabase Edge Functions)

Optional verified payments for a shop's customers, on **the shop's own Razorpay account**: a single-use **UPI QR** for
the exact amount of the bill (or of one part of a split payment), and a **card payment link** the customer opens on their
own phone (shown as a QR). A payment counts as **verified** only when Razorpay's own record shows a captured payment of
exactly that amount. Showing, sharing or refreshing a QR changes nothing.

## The account model

- **Each shop connects its own merchant account.** The shop opens a Razorpay account itself (Razorpay does the shop's KYC)
  and generates API keys in its own Razorpay dashboard. It pastes them in Hangtag (Settings → Payments & Banks → Connect
  a payment gateway). Razorpay settles the money to **the shop's bank**; Hangtag never collects or holds it.
- **There are no Hangtag keys for shops' customers.** The functions don't read `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
  any more, so no shop's payment can go through a shared Hangtag/Florix account. Hangtag's own plan billing is a
  different function (`../subscription`) with its own keys and tables.
- **The keys are stored sealed.** The function seals the Key Secret and the webhook secret before storing them in
  `hangtag_payment_accounts`. Sealing uses AES-256-GCM with the `PAYMENT_ACCOUNTS_KEY` secret, bound to the account and
  the field, so a box copied to another account doesn't open. No app account can read that table at all (row security on,
  no policy, no privilege). The app is shown only a masked key id, the mode, and, to who manages settings, the webhook
  address to set up.
- **Test keys only until live is approved.** `rzp_live_` keys are refused unless `PAYMENT_LIVE_MODE=on`, which is the
  owner's decision after the sandbox steps below.
- **Shop by shop.** `PAYMENT_ALLOWED_USERS` names the shops (user ids or emails, comma-separated, or `*`) that may connect a
  gateway. Unset means off: every shop then uses cash, the card machine and its own UPI QR (checked by hand), as today.
- **Before the paid launch, confirm the model with Razorpay.** A platform that keeps many merchants' API keys is common.
  Razorpay's partner programme, where a shop authorises Hangtag through OAuth instead of pasting keys, is the other model.
  Confirm which one Razorpay expects for Hangtag (RELEASE.md §6e). Only the connect step would change: accounts, intents,
  webhooks and verification work the same way.

## Files

- `core.js`:
  - request checks and the shop's keys (`checkKeys`, `liveAllowed`, `maskKey`);
  - sealing (`accountsKey`, `seal`, `unseal`) and the webhook address (`newHookId`, `webhookUrl`);
  - Razorpay request bodies;
  - reading Razorpay's answers (`qrView`, `linkView`);
  - the intent's next state (`nextIntent`): idempotent; money for a cancelled or expired intent, or of another amount,
    becomes **unmatched**;
  - asking again for an open QR (`reusable`) and matching a hand-checked UPI payment (`matchManual`);
  - refund states, the webhook signature, and the event id.
  - Unit-tested in `tests/unit/payments-delivery-cash.test.mjs`.
- `handler.js`: every action, in plain JS so it runs in Node. Tested end to end on the real schema with a scripted Razorpay
  in `supabase/tests/shop-payments-gateway.test.mjs` and `tests/e2e/shop-payments.test.mjs`.
  - `config` · `connect` · `disconnect` · `create` · `status` · `cancel`;
  - `verify`: matches a hand-checked UPI payment with Razorpay's payments on the shop's account;
  - `refund_return`: once, claimed first;
  - `unmatched` · `resolve`: refund, paid back, or allocated.
- `index.ts`: reads the request and the secrets and serves `handler.js`. Deploy with JWT verification **on**.
- `../payment-webhook/handler.js` and `index.ts`: catch what arrives while no phone is watching. Deploy with
  `--no-verify-jwt`.
  - Each shop's account calls its own address, `?a=<hook id>`. The call must carry a valid `X-Razorpay-Signature` for
    that account's webhook secret; anything else is refused before the body is read.
  - Each event is recorded once per account (`X-Razorpay-Event-Id`) in `hangtag_payment_events`. Only intents of that
    account change. Refund outcomes (`refund.processed` / `refund.failed`) are kept on the return or the receipt.

## Database

All rows live in the shop payments migration, which runs after the repair: `supabase/migrations/20261023120000_hangtag_shop_payments.sql`.
Its report is `supabase/checks/shop-payments-report.sql` and its undo is `supabase/operations/shop-payments-undo.sql`.

- `hangtag_payment_accounts`: the shop's own account, sealed; one connected account per shop.
- `hangtag_payment_intents` (schema.sql 3h): every new intent names its account, of the same shop (a foreign key on both
  columns). The intents are read-only for the app.
- `hangtag_payment_events`: the provider's notifications, once each. Read by the owner and by roles that see the books.
- `hangtag_payments.verification`:
  - `verified` needs a verified intent of the same shop, method and amount;
  - `confirmed` is UPI the shop confirmed reached its account (Reports → Reconciliation → Received), through
    `hangtag_confirm_upi_payment`, by the owner or a role with `view_reports`, with who and when;
  - a phone can't upload UPI as `recorded` or `confirmed`, and sending a bill again never undoes a confirmation.

## Team members

- The shop comes from the database: `hangtag_shop_id()` with the caller's session and the phone's `x-hangtag-device` key,
  which the function forwards.
- Each action needs the member's permission (`core.js` `ACTION_PERMISSIONS`):
  - `create_sale` to take payments;
  - `perform_return` for refunds, and to settle unmatched money;
  - `view_reports` to see unmatched money;
  - `manage_settings` to connect or disconnect the account.

## Deploy (only with the owner's approval; never before the repair and the migration)

```bash
supabase functions deploy payment-gateway --project-ref <ref>
supabase functions deploy payment-webhook --no-verify-jwt --project-ref <ref>
```

| Secret | What |
|---|---|
| `PAYMENT_ACCOUNTS_KEY` (**required**, both functions) | 32 random bytes, base64 (`openssl rand -base64 32`). It seals every shop's keys: keep it with the other secrets. Changing it makes every connected account need connecting again. |
| `PAYMENT_ALLOWED_USERS` (**required**, payment-gateway) | The shops a gateway is switched on for. Unset = off. |
| `PAYMENT_LIVE_MODE=on` (optional) | Lets shops connect live keys. Leave it unset until the sandbox steps below have passed and the owner approves live payments. |

The shop then adds a webhook in its own Razorpay dashboard. It uses the address Hangtag shows after connecting, the
webhook secret it gave Hangtag, and these events: `qr_code.credited`, `qr_code.closed`, `payment_link.paid`,
`payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`. **UPI QR codes must be enabled on
the shop's Razorpay account.**

## Sandbox steps (manual; none of them has run yet)

These need a Razorpay **test** account (the owner's own, as a test shop), on a **test** Supabase project with the migration.
Never use the live project.

1. Set the secrets on the test project and connect the test keys in Settings. The status must read "On · Test mode".
2. Take a UPI QR payment and pay it from Razorpay's test tools. The bill completes by itself, verified, and the webhook
   row appears in `hangtag_payment_events`.
3. Let a QR expire, then pay it. It must show as an unmatched receipt. Refund it: the refund appears in Razorpay, and
   `refund.processed` is kept.
4. Send the same webhook again (Razorpay's resend). It must be recorded once and change nothing.
5. Disconnect. Open QRs are closed in Razorpay, and the old webhook address answers 410.
6. Repeat 2 and 5 with a second test shop and a second Razorpay test account. Each shop sees only its own payments, and
   each Razorpay account only its own QR codes.
