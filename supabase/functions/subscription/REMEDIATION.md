# Plan billing: remediation before `subscription` / `subscription-webhook` are deployed

**Status 2026-10-20 (code and tests only; nothing deployed, no secret set, AutoPay off).**
- **Step 11 done**: the provider is asked a limited number of times per account — `hangtag_billing_call_claim` and its
  table `hangtag_billing_call_counts` (post-repair migration, section 7; service role only), counted by the minute and the
  hour with the agent-usage pattern. The app's payment check (`verify`): 60 a minute, 900 an hour; over it (or when the
  count can't be read) the function answers what the database knows ("pending") and asks the provider nothing — the
  notification and the reconciler still settle the payment. Starting AutoPay: 6 and 30, then 429 "too many tries" (503
  when the count can't be read) before the provider's plan is read. Not limited: taking a payment page (checkout already
  allows 20 an hour) and turning AutoPay off (the database refuses it once it is off; refusing a cancel could leave a
  mandate charging). Before the migration: no limit, as before.
- The migration refuses to commit unless its own report is all ok ("The post-repair report is not all ok (…)", nothing
  kept); the runbook says how to read the report after `COMMIT`.
- A charge whose agreed price or plan can no longer be found is kept for review (`amount_mismatch`), never an error the
  provider would send again until it disables the webhook.
- `npm run probe:reconcile`: the reconcile entry of a deployed test project (RELEASE.md §6d step 2g), in place of a curl
  that would leave the secret in the shell's history; both probes are tested against the real handlers
  (`tests/unit/payment-probes.test.mjs`).
- The owner's decisions (refunds, the scheduler, renewal grace, the limits, a Cashfree refund sweep, AutoPay) are listed
  with their options in RELEASE.md §6e. Still unproven against the real APIs: everything in "What a separate Razorpay
  test-mode project must prove first" below, and Cashfree's sandbox (RELEASE.md §6d step 2).

**Status 2026-10-19, later: steps 4, 5, 7, 8 and 9 implemented (code and tests only; nothing deployed, no secret set,
AutoPay off).** Everything the database needs is in the post-repair migration (sections 6–12), never in `schema.sql`: it
reaches live only after the repair (supabase/REPAIR-RUNBOOK.md, steps 6–7). A design review by three independent critics
(money, security and migration, provider realism against Razorpay's and Cashfree's documentation) changed the design
before it was built; what differs from the plan below is said here.
- **The billing mode** (step 4's interlock 4, enforced in the database): `hangtag_billing_settings.billing_mode` ('live' by
  default, changed only in the SQL Editor — a test project sets 'test'). Every database function that can add time or
  record money or a set-up refuses another mode (`hangtag_billing_event_record`, `hangtag_subscription_activate_checked`,
  `hangtag_autopay_report`, `hangtag_autopay_attach_mandate`, `hangtag_autopay_orphan`, `hangtag_billing_reconcile_begin`,
  `hangtag_billing_probe_record`); the functions check it before acting (`billingModeAllows`): a database without it yet
  takes live keys only. A notification in the other mode is never acted on and is kept for review (`mode_mismatch`).
- **Step 4, readiness**: `hangtag_billing_readiness()` — within 7 days (the provider's own times, from the signed body), a
  Razorpay payment-link notification and a subscription notification, each about one of the self-check's probes
  (`hangtag_billing_probes`) or a real Hangtag object, and within 26 hours a complete, ok reconciliation. It gates
  `hangtag_autopay_terms` (so the quote, begin and the function's config), `hangtag_platform_settings_save` (switching
  AutoPay on, or making it a condition of new trials, only when ready — a save that keeps it on still works while the
  proof has lapsed) and `hangtag_subscription_ensure` (a lapsed proof never locks a new shop). The self-check is the
  function's `billing_selfcheck` action (console staff with settings.manage, once in 10 minutes, audited): a ₹1 link and a
  subscription starting in a year, made, noted as probes, cancelled; both also end by themselves within minutes.
- **Step 5, the registry**: `hangtag_autopay_mandates` (its shop column is `shop_owner_id`, not `owner_id`, so schema.sql's
  subscription guard never takes it as a shop table), with the plan, price and currency agreed to. Begin registers the
  set-up and hands back every earlier one not confirmed off (waiting or halted) to be cancelled; attach goes by the
  registry's id (`notes.hangtag_mandate`). `hangtag_autopay_report` (a new function; `hangtag_autopay_event` is kept as it
  was, so no function's arguments change) finds any registered set-up: a charge is recorded once and adds time only at the
  price and currency agreed to (another amount — say a ₹5 authorisation — or currency is kept for review instead), never
  for money already refunded or disputed, never for a set-up no shop recorded (an orphan: `unknown_mandate_charge`); on a
  replaced set-up it is recorded and that set-up is cancelled. Checkout hands a halted set-up back to be cancelled first;
  when that can't be done, no payment by hand.
- **Step 8, order**: the provider's event time (the top-level created_at, never later than now) is kept per set-up; a state
  report older than the newest applied changes nothing; a charge is always recorded once (its state effect only when
  newer); a cancellation always applies.
- **Step 7, reconciliation**: `supabase/functions/subscription/reconcile.js`, the subscription-webhook function's reconcile
  entry (`x-hangtag-reconcile` and `Authorization: Bearer <SUBSCRIPTION_RECONCILE_SECRET>`, 32 characters or more). Sweeps
  A (both providers), B, C and D (Razorpay) as planned, with: one run at a time (the database opens and closes runs and
  stamps their times); a 4xx on one item kept against that item while the run goes on (only a 5xx, 401, 429 or network
  error stops a run); a call cap with resume points (a capped run is ok but not complete, and readiness needs a complete
  one); Razorpay's 400 for a subscription already ended read back as confirmed. The owner's `autopay_verify` runs the same
  check for its own set-up at most every 5 minutes. **The scheduler is the owner's decision** (an hourly external cron).
- **Step 9**: a place in a capped offer is held only by an attached checkout, one per shop, and not by a shop that let two
  such checkouts lapse in a day. The planned reuse of an unattached row was dropped (a double tap could then lose a
  payment); instead a page is attached only to a payment still open for it, and a page that can't be is withdrawn.
- **Step 6, the console**: Payments → Billing review — the billing health (mode, readiness, last runs, the money-and-time
  checks of `hangtag_billing_integrity()`) and the items, settled one at a time with a reason (subscriptions.manage,
  audited); refunds and disputes from both providers' notifications are kept for review, before or after the payment is
  recorded. **Not built: revoking a refunded payment's time** — with periods stacked one after another, taking one out
  changes the others; whether refunds should take time away, and how, is the owner's decision.
- Tests: `supabase/tests/billing-consistency.test.mjs` (the database: steps 4–9 and the console's part), `tests/unit/
  subscription-reconcile.test.mjs`, `tests/unit/subscription-handlers.test.mjs` and `subscription-cashfree` (the functions,
  before and after the migration), `tests/e2e/console-billing-review.test.mjs` (the console).
- **Still open** (then; step 11's throttle done 2026-10-20): step 11's per-owner throttle; the Razorpay test-mode proof below (none of this has met the real API —
  in particular whether a far-off subscription can be cancelled while only "created" and whether that sends
  subscription.cancelled, which the readiness proof relies on); Cashfree's account-level reconciliation (its /pg/recon,
  unverified) — a refund whose notification is missed is not yet found by a sweep for Cashfree.

**Status 2026-10-18 (code only; nothing deployed, no secret set, AutoPay off).**
- Step 1 **done**: `subscription/handler.js` and `subscription-webhook/handler.js` hold the logic (plain JS, injected
  clients); each `index.ts` only reads the request and secrets. Tested by behaviour: `tests/unit/subscription-handlers.test.mjs`.
- Step 2 **done**: the webhook answers 503 when the payment lookup fails, 500 when activation or the failed-payment record
  fails for a reason that may pass, 200 plus an error line (payment and provider ids) when activation is refused for good
  (P0001) or the amount isn't the amount due; `linkState` counts only a captured payment.
- Step 3 **done in part**: test keys need `SUBSCRIPTION_TEST_MODE=true`, live keys are refused with it, any other key is
  refused (`keyMode`); `deploy.json` requires the provider keys for the webhook and declares the flag. Not done: a
  `supabase/config.toml` (whether the CLI would push other project settings from it is unchecked); the import-graph
  settings check (a full-graph scan flags settings of shared modules a function never uses — not a sound rule).
- Step 10 **done in part**: AutoPay checks the provider's plan against the terms before the consent is recorded. CORS
  stays `*`: the function authenticates by bearer token (no cookies), and limiting the origin would stop Previews.
- Also: a payment confirmation that fails for a reason that may pass says "try again" (503), not "contact support".
- Steps 4–9 and 11 change the schema: they wait for the database repair (RELEASE.md §2a), which is blocked.

**Status 2026-10-18, later (Cashfree; code and tests only, nothing deployed).**
- Cashfree payment links as a second provider (`providers/cashfree.js`), checked against Cashfree's documentation (API
  2026-01-01); the webhook picks the provider by its signature header; test credentials only on a test project.
- Step 4 **in part** and step 6 **in part**, in the post-repair migration (after the repair): `hangtag_billing_events`
  (each settled notification noted once; a repeat is known) and `hangtag_billing_exceptions` (amount or currency
  mismatch, a link naming another payment, an activation refused for good, a refund, a charge on an untracked mandate).
  Not yet: readiness interlock, the mandate registry (step 5), reconciliation (step 7), console views of the exceptions.
- CORS is now configurable (`APP_URL` and `SUBSCRIPTION_ALLOWED_ORIGINS`), "*" only when neither is set.
- Tests: `tests/unit/subscription-cashfree.test.mjs` (15 scenarios plus the provider), `supabase/tests/subscription-cashfree.test.mjs`
  (the lifecycle on the real database). Cashfree's real sandbox: `npm run eval:cashfree-sandbox` — not run (no keys here).

**Status 2026-10-19 (code and tests only, nothing deployed).**
- Step 11 **in part**, in the post-repair migration (section 7, after the repair): checkout refuses a suspended shop
  ("This shop is suspended. Contact Hangtag support.", the words AutoPay's start already uses); money for a payment
  started before the suspension is still honoured. Not done: the per-owner throttle on provider-bound actions.
- Step 6 **wider**: money on a Hangtag link that no payment recorded (its note names a Hangtag payment, or the provider's
  own record of the link carries Hangtag's mark) is kept for review as `unknown_order` — never activated; a link the
  provider has never made (404) is answered for good; a request with no provider's signature header is refused (400),
  no longer "not configured" (503, which asks for it again).
- A probe of the deployed webhook on a test project (`npm run probe:cashfree-webhook`) and a real Cashfree delivery to
  it (`npm run eval:cashfree-sandbox` with `HANGTAG_EVAL_CASHFREE_NOTIFY_URL`): RELEASE.md §6d, step 2. Not run (no
  keys, no test project here).
- From the review (AUDIT 167–172): the app's own payment check now reads the payment's currency (it activated a payment
  in another currency with the same number); a Cashfree success its API doesn't show yet is answered 503 and sent again,
  not settled.
- (Closed later the same day by the registry: an untracked mandate whose cancel fails is registered to be cancelled by the
  reconciler.) Open, documented: when cancelling an AutoPay mandate Hangtag no longer tracks fails, the notification is still answered
  200, so the mandate may charge later (step 5's registry and a retry belong together, after the Razorpay test-mode proof
  below — a webhook that keeps failing may be disabled by Razorpay); on the checkout path a missing provider or shop phone
  is reported before "suspended" (the lock screen never offers checkout to a suspended shop).
- Still not done (then): step 9, steps 4, 5, 7, 8, and the console views of the exceptions — all done later the same day
  (the status at the top).

The plan, as written 2026-10-15 (implemented 2026-10-19 with the changes listed at the top). Both functions stay undeployed (the owner's word is needed for any deploy). Written
2026-10-15 from a read-only review of the code at `73d232f` (AUDIT.md item 108). The goal is charge-to-entitlement
consistency: every captured charge, one-time or AutoPay, adds exactly the paid time, once; no paid time without a
captured charge; no charge the system can't see. Steps marked **schema** change `supabase/schema.sql` and so work on live
only after the database update, which is blocked (RELEASE.md §2a).

## Steps, in order

### 1. Make both functions testable without changing behaviour (enabler) — medium, code only

**Defect.** CONFIRMED: supabase/functions/subscription/index.ts and subscription-webhook/index.ts run only under Deno (Deno.serve, npm: import, index.ts:14,25). Their control flow is checked only by regular expressions over the source text (tests/unit/subscription-function.test.mjs:178-183). None of the defects below can be pinned by a behavioural test. No other function in the repository has a testable handler either.

**Change.** Move each body into plain JS with injected dependencies: supabase/functions/subscription/handler.js exports handle({ method, headers, body, env, user, db, admin, provider, now }) and returns { status, body }; supabase/functions/subscription-webhook/handler.js exports handleWebhook({ method, raw, headers, env, admin, provider, now }). Each index.ts keeps only Deno.serve, createClient and CORS. Behaviour stays the same.

**Tests.** New helpers. tests/helpers/fake-razorpay.mjs is a route table over https://api.razorpay.com/v1 with a call log and per-route failure injection (HTTP 500, thrown network error). tests/helpers/fake-supabase.mjs provides rpc(name,args) and from(t).select().eq().maybeSingle(), returns a scripted { data, error } per call, and logs calls. New file tests/unit/subscription-handlers.test.mjs pins today's behaviour: (a) bad signature → 400 and admin never called; (b) payment_link.paid for a known row → hangtag_subscription_activate called once with p_amount 499 and p_provider_payment 'pay_x' → 200; (c) checkout with amount 0 → activate with 'free:<id>' and zero Razorpay calls; (d) autopay_start calls hangtag_autopay_begin, GET /plans, POST /subscriptions and hangtag_autopay_attach in that order; (e) autopay_verify never calls hangtag_autopay_event with p_event 'charged'. A static check asserts that both index.ts files import handler.js and contain no admin.rpc or provider calls of their own.

### 2. The webhook acknowledges only what it recorded; one-time payments activate only on a captured payment — high, code only

**Defect.** CONFIRMED from code (not run). subscription-webhook/index.ts:44-46 drops the lookup's error, so a transient database failure is answered 200 'ignored'. Razorpay does not retry a 200, so the money is captured but no paid time is added unless the owner later opens the app (verify, index.ts:126-143). index.ts:53 ignores errors from hangtag_subscription_fail. index.ts:54 answers an amount mismatch with 200 and logs nothing. providers/razorpay.js:12-15 linkState counts 'authorized' payments toward paid and takes paymentId from them. verify (index.ts:133-139) could therefore activate on an uncaptured authorisation; whether Razorpay ever reports a paid link with an uncaptured payment is INFERRED.

**Change.** In webhook handler.js, a lookup error → 503. An activate error that is not P0001 → 500, so Razorpay retries. P0001 (amount mismatch, reference missing) is permanent, so it gets 200 plus a structured console.error with the payment row id and provider ids, no personal data; step 6 makes it a durable record. A hangtag_subscription_fail error → 500. A hangtag_autopay_event error stays 500. In razorpay.js linkState, only status 'captured' counts toward paid and supplies paymentId; 'authorized' alone reads as pending.

**Tests.** tests/unit/subscription-handlers.test.mjs: (1) from() returns { data: null, error: { code: '57014' } } → status 503 and activate never called; (2) activate returns error code '08006' → 500; (3) activate returns error P0001 → 200 and the console.error spy is called once with 'mismatch'; (4) the fail RPC errors → 500; (5) hangtag_autopay_event errors → 500 (pinned). tests/unit/subscription-function.test.mjs: linkState({ id:'plink_1', status:'paid', amount_paid:49900, payments:[{ payment_id:'pay_1', amount:49900, status:'authorized' }] }) → state 'pending', paymentId null, and verifyDecision on that view → action 'none'. The existing captured case still activates.

### 3. Deploy configuration fails closed: test keys, verify_jwt, declared secrets — medium, code only

**Defect.** CONFIRMED. providers/index.js:12-17 accepts any key pair, including rzp_test_ (the unit test builds one at tests/unit/subscription-function.test.mjs:40). On the one shared project, test-mode payments (no real money) would add real paid time. supabase/ has no config.toml, so verify_jwt depends on remembering --no-verify-jwt (RELEASE.md:224). preflight-core.mjs:68-69 catches a mismatch only after deployment. INFERRED: a webhook deployed with verification on receives 401 from the gateway on every Razorpay call. deploy.json:47-50 declares only SUBSCRIPTION_WEBHOOK_SECRET for subscription-webhook, but the webhook needs the key id and secret through providerFor (webhook index.ts:23-24). Without them every delivery gets 503 while the preflight passes.

**Change.** providerFor reads the mode from the key prefix: rzp_live_ → 'live', rzp_test_ → 'test', anything else → null. Test keys need SUBSCRIPTION_TEST_MODE === 'true'. Live keys are refused when that flag is set. provider.mode is exposed. deploy.json: subscription-webhook required += SUBSCRIPTION_RAZORPAY_KEY_ID and SUBSCRIPTION_RAZORPAY_KEY_SECRET; optional += SUBSCRIPTION_PROVIDER and SUBSCRIPTION_TEST_MODE, the flag also on subscription. Add supabase/config.toml containing only [functions.<slug>] verify_jwt entries that mirror deploy.json. Before adding it, check in the CLI docs whether a repository config.toml can push project settings through link or config push (INFERRED risk).

**Tests.** tests/unit/subscription-function.test.mjs: providerFor({ KEY_ID:'rzp_test_1', SECRET:'s' }) === null; the same plus SUBSCRIPTION_TEST_MODE:'true' → mode 'test'; rzp_live_x plus TEST_MODE → null; rzp_live_x → mode 'live'; a key 'k' with no prefix → null. Update the fixtures at lines 40, 53, 97 and 151 to pass TEST_MODE. tests/unit/release-preflight.test.mjs: (a) for every slug in deploy.json, config.toml has verify_jwt === jwt; (b) the env names read across each function's relative import graph (subscription-webhook → ../subscription/providers/index.js) all appear in its required, anyOf or optional lists. This fails today for subscription-webhook.

### 4. AutoPay offered only when the webhook is proven (readiness interlock) — high, schema

**Defect.** CONFIRMED and reproduced on PGlite (scratch R2). Charges are recorded only by the webhook (subscription/index.ts:90-95; schema.sql:7353-7372). AutoPay availability is only autopay_enabled (schema.sql:7270) plus the key and plan secrets (index.ts:43,48). hangtag_platform_settings_save sets autopay_enabled with no check (schema.sql:7661). In R2, a mandate made 'active' through autopay_verify, with no charge event and 49 h after the trial ended, gives state trial_expired, access_ok false and zero payments, while the provider would keep charging monthly (provider side INFERRED). trial_requires_autopay (schema.sql:6925, 6955) also puts every new shop in trial_setup, locked, whenever autopay_enabled is on, even if the function or plan isn't ready.

**Change.** New section 3zb with a migration. Table hangtag_billing_events: provider, mode, event_id, event_type, entity_id, provider_created_at, received_at, outcome, probe; UNIQUE(provider, event_id). It is written only by the service role through hangtag_billing_event_record(...), which returns duplicate:true for a repeat and refuses a mode that differs from hangtag_platform_config.billing_mode (new column, 'live' or 'test', default 'live'). hangtag_billing_readiness() is ready only when the modes match, a signed subscription.* delivery and a payment_link.* delivery arrived within 7 days, and (once step 7 exists) a reconcile succeeded within 26 h. Readiness gates hangtag_autopay_terms.available, hangtag_autopay_begin, and settings_save of autopay_enabled or trial_requires_autopay; the readiness is written into the audit detail. Function side: the webhook records every verified delivery (event id from X-Razorpay-Event-Id, falling back to sha256 of the raw body) before acting on it. config.autopay also requires readiness. A staff-only action billing_selfcheck (the database checks settings.manage) creates and cancels a ₹1 payment link and a far-future AutoPay subscription with notes.hangtag_probe. No money moves.

**Tests.** PGlite, new file supabase/tests/billing-consistency.test.mjs, migration run twice: (1) a super admin saves autopay_enabled:true with no events → P0001 mentioning the webhook, config unchanged; (2) record payment_link.cancelled and subscription.cancelled in mode live → the save succeeds and the audit detail holds the readiness; (3) events older than 8 days → hangtag_autopay_quote().available false and begin refused; (4) event_record in mode 'test' while billing_mode is 'live' → refused, 0 rows; (5) the same event id twice → duplicate:true, one row; (6) anon or authenticated cannot call event_record or read the table (42501); (7) trial_requires_autopay is refused while not ready, so a newly onboarded shop is trial_active, not trial_setup. Unit tests in subscription-handlers.test.mjs: event_record is called before hangtag_autopay_event; an event_record error → 500; a duplicate → 200 and nothing applied; config.autopay false while not ready; billing_selfcheck by a non-staff account → 403; by staff → exactly POST /payment_links, then its cancel, POST /subscriptions, then its cancel.

### 5. A registry of every mandate; a charge on any Hangtag mandate is recorded exactly once — high, schema

**Defect.** CONFIRMED and reproduced on PGlite. hangtag_autopay_event finds a shop only through its current mandate (schema.sql:7344-7345). hangtag_autopay_begin clears that id (schema.sql:7304-7307) and hands the old one back only when it is 'pending' (schema.sql:7308-7309). R1: mandate sub_OLD halted, AutoPay set up again → previous = null; a captured charge on sub_OLD → {known:false} and 0 payment rows. The webhook then only cancels the mandate and writes a log line (webhook index.ts:38-41). The same loss happens to a charge whose webhook is still being retried when the owner cancels and sets AutoPay up again. index.ts:52 and :60 swallow failed cancels, leaving orphan mandates. R4: with a halted mandate, the owner pays by hand (allowed, because schema.sql:7166-7168 blocks only pending, active and past_due); the halted mandate then charges → AutoPay flips back to 'active' and both 999 payments are honoured (double charge). Whether Razorpay can charge a halted subscription is INFERRED (proof item 4). AUDIT 108 rated this medium; it is rated high here because R1 shows a captured charge recorded nowhere.

**Change.** Table hangtag_autopay_mandates: id uuid, owner_id, provider, subscription_id (UNIQUE with provider, empty until attached), plan_code, created_at, attached_at, current, provider_status, cancel_requested_at, cancel_confirmed_at, last_state_event_at. Backfill it from hangtag_subscriptions. begin inserts the intent row and returns mandate_id (sent to Razorpay as notes.hangtag_mandate), plus to_cancel[] listing every earlier mandate that isn't terminal (pending or halted included), now marked current=false with cancel_requested_at set. attach goes by mandate_id. hangtag_autopay_event looks the id up in the registry. A charge on any registered mandate is inserted once (the existing ON CONFLICT, schema.sql:7361) and its time added. On a mandate that isn't current it also gets the note 'Review: charge on a replaced AutoPay' and returns {known:true, current:false, cancel:true}. State events on a mandate that isn't current change only its provider_status, never the shop's autopay_status. A checkout while the mandate is halted returns cancel_mandate, and the function cancels it at Razorpay before making the link; if that cancel fails, the checkout is refused. New service-role RPC hangtag_autopay_cancel_confirmed. A failed cancel keeps cancel_requested_at, so step 7 retries it.

**Tests.** PGlite, billing-consistency.test.mjs: (1) replay R1 → known:true, current:false, cancel:true; exactly one autopay row for pay_OLD1; period_end extended by one calendar month, once; a second delivery → already:true with the period unchanged; the shop's autopay_status unchanged ('pending', the new mandate). (2) 'activated' on the old mandate → shop status unchanged. (3) begin while halted → to_cancel contains sub_OLD. (4) Replay R4 → checkout returns cancel_mandate sub_KKK; after cancel_confirmed, a charge on sub_KKK is recorded once and autopay_status stays 'cancelled'. (5) An id Hangtag never made → known:false and nothing written. (6) Backfill gives one current mandate per existing subscription id; running the migration twice adds none. Unit: autopay_start sends notes.hangtag_mandate, cancels each to_cancel id, and confirms only those that succeeded; a failing cancel doesn't block the new mandate. The webhook on cancel:true → POST /subscriptions/sub_OLD/cancel. A checkout whose cancel_mandate fails → 502 and POST /payment_links never called.

### 6. Money the system can't match becomes a durable record, not a log line — medium, schema

**Defect.** CONFIRMED. Unmatched money leaves only a console line or nothing: an amount mismatch (webhook index.ts:54, nothing logged), a charge on an unknown mandate (index.ts:40), a payment_link.paid with no row (index.ts:46). readWebhook ignores refunds and disputes (razorpay.js:120). A refunded or charged-back payment therefore keeps its paid time, and nothing checks 'no paid time without a captured charge' after the fact.

**Change.** Table hangtag_billing_exceptions: id; kind in (amount_mismatch, unknown_mandate_charge, unmatched_payment, refund, dispute, stale_mandate, charge_overdue, cancel_failed); provider, ref, owner_id, amount, detail jsonb, opened_at, status, resolved_by, resolution; UNIQUE(provider, kind, ref). Service-role RPC hangtag_billing_exception_open is idempotent. Console functions: hangtag_platform_billing_exceptions (payments.view) lists them; _resolve (subscriptions.manage) resolves one, audited through hangtag_platform_log. The webhook subscribes to refund.processed and payment.dispute.created and opens exceptions for them. A refund never removes time automatically. Staff can revoke the period of a refunded payment as an explicit, audited action; whether full refunds should do this automatically is the owner's decision.

**Tests.** PGlite: opening the same exception twice leaves one row; app roles can't read the table; support_admin can't resolve; billing_admin resolves → an audit row with before and after; revoke shortens period_end by exactly that payment's months and notes the payment. Unit: a mismatch → exception_open(kind 'amount_mismatch', ref 'pay_x', amount), then 200; an exception_open error → 500 (Razorpay retries); an unknown-mandate charge with an owner note → exception plus cancel; refund.processed for a known payment → a 'refund' exception and no activate or extend call.

### 7. Reconciliation: missed webhooks and untracked charges repaired automatically — high, schema

**Defect.** CONFIRMED. Nothing re-reads the provider unless the owner opens the app. One-time payments depend on the webhook or the app's verify (index.ts:126-143); AutoPay charges depend only on the webhook (index.ts:90). A missed delivery, or one whose retries run out, is permanent (R2).

**Change.** RPCs hangtag_billing_reconcile_targets(p_limit), hangtag_billing_reconcile_done(p_run jsonb) and hangtag_billing_integrity(); table hangtag_billing_reconcile_runs. Provider additions: listInvoices(subscriptionId), getPaymentEntity(paymentId), listSubscriptions({ from, to, skip }), and paid_count in getAutopay. The logic lives in plain JS, supabase/functions/subscription/reconcile.js. Its entry point is a 'reconcile' action in subscription-webhook, guarded by SUBSCRIPTION_RECONCILE_SECRET (constant-time header compare, declared in deploy.json). autopay_verify reuses it for the owner's own mandate. The scheduler is left open: pg_cron with pg_net is DDL on live and blocked; an external cron is the alternative. Full design in 'reconciliation'.

**Tests.** Unit, new file tests/unit/subscription-reconcile.test.mjs, with fake Razorpay and a fake database: (1) a created row whose link is paid with captured pay_9 → activated once; a second run → no activate. (2) paid_count 2 with one recorded → invoices → GET /payments/pay_2 'captured' → hangtag_autopay_event charged pay_2 999, once. (3) A paid invoice whose payment is 'authorized' → not recorded. (4) A refunded payment → 'refund' exception. (5) A listed subscription whose hangtag_owner note isn't in the registry and is active → cancel plus exception. (6) A cancel_requested mandate → cancel retried, confirmed on success. (7) Razorpay 500 mid-run → run ok:false with counts so far and nothing half-applied. (8) Wrong or missing secret → 401 and no database call. PGlite: the targets include created rows aged 15 min to 7 days with an order id, and an active mandate whose next_charge_at passed 2 h ago with no autopay payment since (charge_overdue). integrity() reports overlapping paid periods, a paid non-free, non-manual row without captured_at, and period_end below max(paid.period_end). The run log feeds readiness. End-to-end: tests/helpers/pglite-supabase.mjs backs admin.rpc with PGlite; replay 'webhook never delivered' for both kinds, run reconcile → one month per captured charge; a rerun changes nothing.

### 8. Event order and replays — low, schema

**Defect.** CONFIRMED in code: state events are applied in arrival order (schema.sql:7346-7386). A late 'pending' or 'halted' arriving after a newer 'charged' or 'resumed' sets past_due or halted wrongly, and the shop locks after the grace. A re-sent old delivery is applied again. Charges are already idempotent (schema.sql:7361). INFERRED: Razorpay retries deliveries and does not guarantee their order.

**Change.** hangtag_autopay_event takes p_event_at (the payload's created_at) and p_event_id. Each mandate keeps last_state_event_at. A state event older than it is recorded with outcome 'stale' and not applied. Charges are always applied, once. A duplicate event id stops early through the step 4 ledger.

**Tests.** PGlite: charged at t2, then halted at t1 → status active; halted at t3 → halted; the same event id twice → the second is a no-op; a charge with an old timestamp is still recorded once. Unit: the handler passes the payload's created_at and the header's event id.

### 9. Capped offers held only by real checkouts — medium, schema

**Defect.** CONFIRMED and reproduced on PGlite (R3). hangtag_subscription_checkout is granted to authenticated (schema.sql:6675-6676, and the 3w grants), so an owner can call it directly. With max_uses 2, two owners calling it with no payment page tell a third owner 'fully claimed'. A hold counts every 'created' row with the code from the last 30 min (schema.sql:7078-7079), and each owner may create 20 rows per hour (schema.sql:7169-7171).

**Change.** Count a hold only when the row has provider_order_id (set by the service-role attach), at most one per owner (count DISTINCT owner_id). A checkout reuses the owner's own open created row for the same plan and code from the last 30 min instead of inserting another.

**Tests.** PGlite: replay R3 → Z still gets the offer; after X's row is attached → one place held; X checking out twice → one created row; the existing cap tests in plans-autopay-platform.test.mjs (lines 91-126) still pass.

### 10. Consent after the plan check; CORS limited to the app (function only) — low, code only

**Defect.** CONFIRMED. hangtag_autopay_begin records consent and sets 'pending' (index.ts:50) before the provider's plan is checked (index.ts:54). A mismatch leaves a recorded consent and AutoPay pending with nothing at the provider. CORS answers '*' (index.ts:19).

**Change.** Call hangtag_autopay_quote, check getPlan against it, and only then call begin. Access-Control-Allow-Origin becomes APP_URL's origin.

**Tests.** Unit: when the provider's plan doesn't match, hangtag_autopay_begin is never called and the reply is 503 not_configured; a matching plan keeps the order quote, plan, begin, create, attach; the CORS header equals the origin of APP_URL and is absent when APP_URL isn't https.

### 11. Suspended shops can't start a payment; Razorpay calls throttled — low, schema

**Defect.** CONFIRMED. The 3w checkout (schema.sql:7157-7197) has no suspended check, so a suspended shop can pay; activate then extends a shop that stays locked. verify, autopay_verify and checkout call Razorpay on every request with no per-owner limit (only begin has a 20 s guard, schema.sql:7301-7303).

**Change.** Checkout refuses a suspended shop. Activate still honours money already captured. A per-owner counter for Razorpay-bound actions reuses the hangtag_agent_usage pattern.

**Tests.** PGlite: a suspended owner's checkout → P0001; activating that shop's earlier created payment still succeeds. Unit: over the limit → 429 with no Razorpay call.

## Reconciliation

Implemented 2026-10-19 (reconcile.js; the status at the top says what differs).

PRINCIPLE. The provider is the record of money; the database is the record of entitlement. Every repair goes through the same idempotent RPCs as the webhook: hangtag_subscription_activate (locks the payment row, does nothing if it is already paid) and hangtag_autopay_event ('charged' is keyed by UNIQUE(provider, provider_payment_id), schema.sql:7361; this is what makes 'exactly once' hold). So the webhook and the reconciler can race safely. The reconciler never creates a charge, never refunds, and never removes time; anything it can't match becomes a hangtag_billing_exceptions row (step 6).

INVARIANTS CHECKED EACH RUN:
- I1: every captured Hangtag charge at the provider has exactly one paid row with captured_at, or an open exception.
- I2: every paid row whose provider isn't free or manual is captured at the provider; a refund or dispute opens an exception.
- I3: every provider subscription carrying notes.hangtag_owner or hangtag_mandate is in hangtag_autopay_mandates, and every non-current one is cancelled at the provider.
- I4 (hangtag_billing_integrity()): no two paid periods of a shop overlap; subscriptions.period_end >= max(paid.period_end); every autopay row's provider_order_id is a mandate of the same owner.

SWEEPS (the 'reconcile' action of subscription-webhook, behind SUBSCRIPTION_RECONCILE_SECRET):
- A, one-time: rows that are created, expired, cancelled or failed, have a provider_order_id and are 15 min to 7 days old → GET /payment_links/:id → verifyDecision → activate or fail. This repairs a missed payment_link.paid; captured money after expiry is already honoured, as the existing test shows.
- B, AutoPay, for each mandate that needs a check: charge_overdue (active or past_due, next_charge_at more than 2 h past, no autopay payment since), any non-terminal mandate not checked in 24 h, or cancel_requested. GET /subscriptions/:id; if paid_count exceeds the recorded charges, GET /invoices?subscription_id. For each paid invoice whose payment_id isn't recorded, GET /payments/:id; if it is 'captured', call hangtag_autopay_event('charged', id, amount/100). The mandate's state (active, halted, cancelled) is synced through the same event, and pending cancels are retried.
- C, orphans: list subscriptions created since the last successful run's start minus 48 h. Any with a Hangtag note that isn't in the registry is cancelled if not terminal, and an exception is opened. This catches a mandate whose attach and cancel both failed (index.ts:59-60).
- D, account level: list captured payments in the same window. Any carrying hangtag notes, a subscription_id or an invoice_id that matches no row → 'unmatched_payment' exception. The run stores provider-captured totals against recorded-captured plus open exceptions.

TIMING:
- The reconciler runs hourly.
- The renewal grace (renewal_grace_hours, default 48, schema.sql:6876) has to exceed Razorpay's retry window (about 24 h, INFERRED; proof item 5) plus one run, so a missed 'charged' is repaired before the shop locks (the R2 failure).
- charge_overdue moves a shop to the front of the next run. autopay_verify runs sweep B for the owner's own mandate on demand, and the console gets a 'Reconcile now' action.

RUN LOG (hangtag_billing_reconcile_runs):
- Each run records started and finished times, ok, checked, repaired, exceptions_opened, provider_totals and error_code.
- The cursor is the last successful run's start minus 48 h; each run has a call cap and continues in the next run.
- Readiness (step 4) needs a successful run within 26 h. A missing or failed run is a console alert, and new AutoPay set-ups stop automatically while existing mandates keep being recorded.
- The first run covers everything since the earliest mandate or payment.

SCHEDULER: owner decision. pg_cron with pg_net is DDL on live and therefore blocked; an external cron calling the function with the secret is the alternative.

## Deploy-time interlocks

Today the only automated guard is the preflight's verify_jwt comparison (scripts/preflight-core.mjs:68-69), and it runs only after deployment.

1. DATABASE FIRST. No billing function is deployed until the blocked repair puts the 3w functions back. AUDIT.md:82 (item 78, a recorded live fact): live runs the 3t versions. From the code, the 3t hangtag_subscription_state (schema.sql:6106-6117) has no renewal_due or trial_setup, and the 3t checkout has no 'Turn AutoPay off' guard against paying twice. The new section must be applied after the repair. It carries report rows that check function-body markers (for example, hangtag_autopay_event references hangtag_autopay_mandates); preflight-live reads those rows and refuses on any that isn't ok. RELEASE.md must forbid running any older section file after it (the AUDIT 78 failure mode).

2. verify_jwt PINNED. supabase/config.toml sets [functions.subscription] verify_jwt = true and [functions.subscription-webhook] verify_jwt = false. A unit test keeps it equal to deploy.json, and the preflight still checks what is actually deployed.

3. SECRETS COMPLETE. deploy.json declares, for subscription-webhook, SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET and SUBSCRIPTION_RECONCILE_SECRET, with SUBSCRIPTION_TEST_MODE optional. An import-graph test fails when a function reads a setting that isn't listed.

4. TEST KEYS REFUSED. rzp_test_ keys work only with SUBSCRIPTION_TEST_MODE=true; rzp_live_ keys are refused when that flag is set; any other prefix is refused. hangtag_platform_config.billing_mode must equal the function's mode, or hangtag_billing_event_record refuses, so test-mode events can never add time on the live database.

5. AutoPay OFFERED ONLY WHEN THE WEBHOOK IS PROVEN. hangtag_billing_readiness().ready requires signed subscription.* and payment_link.* deliveries in the same mode within 7 days (produced with no money by billing_selfcheck) and a successful reconcile within 26 h. It gates hangtag_autopay_terms.available, config.autopay, autopay_start, and settings_save for autopay_enabled and trial_requires_autopay. Losing readiness stops new set-ups by itself.

6. SWITCH-ON ORDER, each step the owner's explicit approval:
   1. subscription-webhook deployed, and the self-check passes;
   2. reconcile scheduled, with one successful run;
   3. subscription deployed for one-time payments only;
   4. one real low-value one-time payment checked end to end (one paid row, months added once);
   5. AutoPay enabled;
   6. trial_requires_autopay last.

7. Nothing in this plan deploys, sets a secret, or touches the live database.

## What a separate Razorpay test-mode project must prove first

Everything below must be proven in a separate Supabase project (never the shared live one, whose single-project setup is itself the risk) with Razorpay test keys and SUBSCRIPTION_TEST_MODE=true, before any deploy to live. Creating that project needs the owner.

1. SIGNATURE AND HEADERS: X-Razorpay-Signature verifies over the raw body with the test webhook secret, and X-Razorpay-Event-Id is present and identical on every retry.

2. ONE-TIME PAYLOADS: payment_link.paid carries payment.entity with status 'captured' and the link's amount_paid. Can a link ever be 'paid' while its payment is only 'authorized'?

3. AutoPay WITH A FUTURE start_at: the authentication transaction's amount, and whether it is refunded automatically and never reported as subscription.charged. That subscription.authenticated comes before any charge. That subscription.charged carries a captured payment and an invoice. The exact event order at the first charge (activated vs charged).

4. FAILURE PATH: the timings from pending through retries to halted. Can a halted subscription charge again (method update, customer retry), and with which event? This decides step 5's real exposure. Does cancelling a halted subscription succeed?

5. WEBHOOK OUTAGE: make the test webhook answer 500 for a while. Measure the retry schedule, how long retries last, and whether Razorpay disables the webhook. This sets the grace and reconcile margins.

6. ZERO-MONEY PROBE: creating and cancelling a payment link, and a subscription still in 'created', emit payment_link.cancelled and subscription.cancelled. billing_selfcheck depends on this.

7. RECONCILIATION APIS: what paid_count counts (is the authentication transaction excluded?); GET /invoices?subscription_id returns each paid invoice's payment_id; GET /payments/:id status; listing subscriptions by time window, with notes visible; rate limits.

8. REFUNDS AND DISPUTES: refund.processed and payment.dispute.created payloads and their link to the original payment.

9. DEPLOYMENT: a webhook deployed from config.toml has verify_jwt off and Razorpay's requests (no JWT) reach it; the subscription function refuses a request without a JWT.

10. END-TO-END ACCEPTANCE, each asserted in the database:
- A one-time payment gives one paid row and adds its months once; a duplicate delivery changes nothing.
- With the webhook disabled during a charge, reconcile adds exactly one month within the hour.
- AutoPay with start_at 15 min ahead: the first charge adds one month, once.
- Halted, then set up again: the old mandate is cancelled, and a late charge on it is recorded once and flagged.
- A refund opens an exception; the time stays until staff act.
- Test keys against a project whose billing_mode is live are refused.

INFERRED: Razorpay test mode may not simulate every UPI mandate path; whatever it can't simulate stays unproven and has to be listed as such before live.
