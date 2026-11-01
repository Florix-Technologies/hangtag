# Cashfree subscription billing: release readiness

Status on **30 October 2026** (first written 27 October for the planned 28 October launch). This covers Hangtag's own plan
billing, collected by Florix through Cashfree: plan payments, AutoPay with the 30-day free trial, renewal and
cancellation. It does not cover the payment integrations shops use for their own customers. Those are separate: the
`payment-gateway` and `payment-webhook` functions, `PAYMENT_*` secrets and their own tables. No code, secret, table or
webhook is shared, as checked on 27 Oct.

The verdict, its blockers and the exact production approval request are in **`CASHFREE_CLOSEOUT.md`**. This file is the
release reference: what the code does, how to configure, deploy and smoke-test it.

## 1. How billing works now

**Plan payments: Cashfree Payment Links.**
- A link (`ht_<payment id>`) is made per payment.
- The notification is only a nudge. The link, its PAID orders and SUCCESS payments are read from Cashfree's API, and
  the database activates the payment once, only at the exact amount due (`hangtag_subscription_activate_checked`).
- The browser's return is never proof of payment.

**AutoPay: Cashfree Subscriptions, an ON_DEMAND mandate.**
- **Set-up:** one mandate `htap_<set-up id>` per set-up, for up to the AutoPay price. UPI or a card takes ₹1 to confirm
  it, refunded by Cashfree. The ₹1 authorisation is never a payment. The mandate is approved on the app's `autopay.html`
  (Cashfree's checkout script).
- **Renewals:**
  - The reconciler asks for one charge per due date (`htc_<mandate>_<YYYYMMDD>`), 4 days before it is due and at least
    2 days ahead, for the price agreed.
  - Cashfree refuses a `payment_id` it has seen, so a charge can't be raised twice.
- **Notifications** are verified on the raw body (Base64 HMAC-SHA256 of `x-webhook-timestamp` + body, with the client
  secret). Each is noted once by its `x-idempotency-key`.
- **Charge notifications only name the charge.** It is read back from Cashfree's API, all of the mandate's payments, so
  the ₹1 authorisation is known as such. Then it counts **as of that read**:
  - any attempt SUCCESS → charged, with Cashfree's own id and amount;
  - every attempt failed or withdrawn → past due, on the API's word about the attempt reported;
  - reported paid but not readable yet → 503, so Cashfree resends. That includes when only an earlier attempt shows
    failed.
  - **cancelled** (`SUBSCRIPTION_PAYMENT_CANCELLED`, or a failure whose every attempt the API lists as cancelled): past due
    only while Cashfree still shows the mandate ACTIVE, because then the payer declined the charge. On a mandate turned off
    the charge was withdrawn with it, and nothing is reported.
- **The pre-debit notice** (`SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED`, sent about a day before a UPI charge is taken):
  - Nothing is reported, since no money moves. It is noted once in the ledger, against the mandate and the charge it names.
  - A notice for a charge Hangtag never asked for is kept for review (`unexpected_charge`) while the charge can still be
    withdrawn: not one of Hangtag's `htc_` charge refs, over the price agreed, or on a set-up turned off or being turned off.
- **Charges the reconciler finds** are also recorded as of its read. Either way the next charge always moves to the end
  of the newly paid time.
- **Duplicates and staleness:**
  - A charge adds the plan's time once, keyed by Cashfree's payment id, and only at the price and currency agreed.
  - A report older than the newest applied is stale.
  - A cancelled AutoPay is never turned back on, and a mandate ended at Cashfree stays ended in Hangtag's records: a later
    report that isn't an end itself never makes it look live.
- **A failed renewal stays `past_due`:**
  - The daily read reports it from the charge list. "On" is no longer reported while the due charge has failed.
  - Cashfree retries UPI charges itself, up to 1+3 attempts hourly; the attempt that succeeds counts.
  - To pay another way, the owner turns AutoPay off: checkout refuses a manual payment while AutoPay is on.
- **Pause and resume:** a mandate paused and resumed in the UPI app gets its next charge back, at the end of the time
  paid for.
- **Cancel:** the mandate is cancelled at Cashfree, and charges not yet begun are withdrawn, before it is recorded.
  - Charges are withdrawn even when a retried cancel errors because the mandate is already off.
  - Any later read of an ended mandate withdraws a charge left behind.
  - If Cashfree can't confirm a cancel at the time, it is kept owed (`hangtag_autopay_cancel_owed`). The reconciler then
    retries it first and asks for no charge meanwhile.
- **The AutoPay page** (`autopay.html`) opens only a Cashfree session that this app, on this device, was given in the
  last 30 minutes. A link made with someone else's Cashfree session can't use Hangtag's own page.
- **Refunds and disputes** are kept for review. Time is never taken away by itself.

**Reconciliation: hourly, inside the project.**
- pg_cron calls the webhook function through pg_net with a bearer secret kept in Supabase Vault
  (`supabase/operations/billing-reconcile-schedule.sql`).
- Each run reads back unpaid links and every live mandate, records charges no notification recorded, retries owed
  cancels, and raises charges that are due.
- Runs are leased (one per 5 minutes) and recorded in `hangtag_billing_reconcile_runs`.

**Readiness:** AutoPay is offered only while readiness is `ready`:
- Cashfree's own notifications about the self-check's probes are proven in this database's mode within 7 days;
- a complete reconciliation has run within 26 hours.

If reconciliation stops, AutoPay stops being offered to new shops.

**Live and test are kept apart:**
- Sandbox keys work only with `SUBSCRIPTION_TEST_MODE=true`, and production keys never with it. The secret key's own
  prefix must agree (`cfsk_ma_test_` vs `cfsk_ma_prod_`).
- The database's `billing_mode` refuses every call and notification in the other mode.

## 2. Production secrets (names only; set with `supabase secrets set`, never pasted into chat)

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.

| Name | Functions | Production value |
|---|---|---|
| `APP_URL` | both | the app's https origin (also the only return target) |
| `SUBSCRIPTION_PROVIDER` | both | `cashfree` |
| `SUBSCRIPTION_AUTOPAY_PROVIDER` | both | `cashfree` |
| `SUBSCRIPTION_CASHFREE_APP_ID` | both | production App ID |
| `SUBSCRIPTION_CASHFREE_SECRET_KEY` | both | production secret key (`cfsk_ma_prod_…`); it also signs the webhooks |
| `SUBSCRIPTION_CASHFREE_ENV` | both | `production` |
| `SUBSCRIPTION_TEST_MODE` | both | **unset** |
| `SUBSCRIPTION_RECONCILE_SECRET` | both | 32+ random characters, e.g. `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` |
| `SUBSCRIPTION_ALLOWED_ORIGINS` | subscription | extra allowed origins (Previews), comma-separated; may be empty |

**Supabase Vault** (Dashboard → Project Settings → Vault), for the schedule:

| Secret | Value |
|---|---|
| `hangtag_reconcile_url` | `https://<project-ref>.supabase.co/functions/v1/subscription-webhook` |
| `hangtag_reconcile_secret` | the same value as `SUBSCRIPTION_RECONCILE_SECRET` |

**Database settings:**
- `hangtag_billing_settings.billing_mode = 'live'`. That is the default; never change it on production.
- `hangtag_platform_config.autopay_enabled = TRUE`, only after readiness is `ready`.

## 3. Cashfree production configuration (owner, Cashfree Merchant Dashboard, Production)

1. **Account activation:**
   - KYC complete; Payment Gateway and Payment Links live.
   - Subscriptions enabled, and **UPI AutoPay activated**. That is not self-serve: request it from the account manager
     or through Cashfree's Support Form (it needs commercial approval).
   - Optionally card and eNACH mandates.
   - Plan prices are well under the ₹15,000 limit that applies without AFA.
2. **Domain whitelisting** (Developers → Whitelisting): the app's domain, `APP_URL`'s host (`app.hangtag.florixtechnologies.com`).
   `autopay.html` opens Cashfree's subscription checkout from it, and an unlisted domain is blocked in production.
   - Seen read-only on 30 Oct: production has one entry, `florixtechnologies.com` (Website, **Approved**, added 12 Oct 2026).
   - Cashfree's whitelisting guide says "certain subdomains are not supported" without naming them. So either confirm with
     Cashfree that the root entry covers `app.hangtag.florixtechnologies.com`, or add it as its own entry (Add New;
     usually approved within 24 hours).
3. **Subscriptions webhook** (Developers → Webhooks → *Subscriptions* tab):
   - URL: `https://<project-ref>.supabase.co/functions/v1/subscription-webhook`
   - Version: **2026-01-01**
   - Events (7, as the dashboard lists them): subscription auth status, payment cancelled, payment failed, **payment
     notification initiated** (the pre-debit notice), payment success, refund status, status changed.
   - Not needed: card expiry reminder, and controlled execution / notification status (Controlled API integrations only).
     Anything else is acknowledged and ignored.
   - The same set is configured on the Test (sandbox) Subscriptions tab, pointed at the local test tunnel (30 Oct). Remove it
     after testing.
4. **Payment Gateway webhook** (*Payments* tab, the same URL):
   - payment success and failure;
   - payment link events;
   - `REFUND_STATUS_WEBHOOK` and `AUTO_REFUND_STATUS_WEBHOOK`;
   - `DISPUTE_CREATED`, `DISPUTE_UPDATED` and `DISPUTE_CLOSED`.

   Each plan payment link also carries this URL as its `notify_url`.
5. **Signing:** Cashfree signs with the production client secret, which is `SUBSCRIPTION_CASHFREE_SECRET_KEY`. That was
   verified with real sandbox deliveries on 27 Oct. There is no separate webhook secret. A rotated secret key must be
   set in the function secrets at the same time.
6. **API version:** the functions send `x-api-version: 2026-01-01`.
7. **UPI AutoPay hours:** NPCI processes UPI AutoPay debits only off-peak (before 10:00, 13:00–17:00, after 21:30).
   Cashfree executes a charge on its scheduled date accordingly.

## 4. Deployment sequence (only after the gate in `CASHFREE_CLOSEOUT.md` and your explicit approval of each step)

1. **The live database repair** (`supabase/REPAIR-RUNBOOK.md` §6), then the post-repair migration (§7). Both are
   rehearsed on the real backup: `CASHFREE_CLOSEOUT.md` §2.
2. **Migration `20261027120000_hangtag_cashfree_readiness.sql`** in the SQL Editor, in one transaction.
   - It refuses, changing nothing, unless the post-repair migration is in place.
   - Expect `supabase/checks/post-repair-report.sql`: 13 rows, all ok. Expect `supabase/checks/cashfree-readiness-report.sql`:
     4 rows, all ok.
   - **Run it again after any later run of the post-repair migration.** That migration puts back its own two definitions,
     and the report then shows rows 1–2 false.
   - Undo: `supabase/operations/cashfree-readiness-undo.sql` (guarded the same way).
3. **Function secrets** (section 2).
4. **Deploy:** `supabase functions deploy subscription`, then
   `supabase functions deploy subscription-webhook --no-verify-jwt`.
5. **Cashfree dashboard:** section 3.
6. **The schedule:**
   - Enable pg_cron (Integrations → Cron) and pg_net (Database → Extensions).
   - Add the two Vault secrets.
   - Run `supabase/operations/billing-reconcile-schedule.sql`.
   - After the next :07, run `supabase/checks/reconcile-schedule-health.sql`. Expect: the job active, its run
     `succeeded`, the answer 200 with `"ok":true,"complete":true`, and the last complete run under 2 hours old.
   - Undo: `supabase/operations/billing-reconcile-schedule-undo.sql`.
7. **The console's billing self-check:** a ₹1 probe link and a ₹1 probe mandate, each withdrawn at once. Readiness then
   turns `ready`; check it in Billing health.
8. **`autopay_enabled = TRUE`.**

## 5. Production smoke test (owner's own shop, real money, after step 8; each step with your approval)

| Step | Action | Success criterion | Idempotency and reconciliation check |
|---|---|---|---|
| 1 | Plan payment: check out the lowest plan, pay on Cashfree's page | Plan active once; payment row `paid` with Cashfree's payment id; amount = price | Press "I've paid" twice and wait for the webhook: still one payment, one period. The next reconcile run shows `repaired: 0` |
| 2 | AutoPay set-up in trial: approve by UPI | `autopay_status = active`; trial end unchanged; next charge = trial end; **0** new payment rows (₹1 auth not counted); 0 open exceptions | Cashfree's dashboard shows the mandate ACTIVE, the AUTH ₹1 then refunded |
| 3 | Cancel AutoPay in the app | App shows cancelled; Cashfree shows the mandate CANCELLED; no INITIALIZED charge left | The next reconcile run raises nothing (`checked` includes the mandate, no `/subscriptions/pay` call); readiness stays `ready` |
| 4 | Watch for 26 h | Hourly runs `complete`; `open_exceptions` 0 | `reconcile-schedule-health.sql` healthy |

A first real renewal is only observable on its due date: one charge, raised 4 days before, taken once, one payment row.
Watch the first one in Billing health.

**Rollback:**
- `autopay_enabled = FALSE`;
- remove the Cashfree webhooks;
- run the schedule undo;
- redeploy the previous functions;
- run `cashfree-readiness-undo.sql`.

Paid time is never taken away.
