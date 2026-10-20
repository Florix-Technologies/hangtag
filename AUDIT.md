# Hangtag audit log

The running checklist of the code audit: what was checked, what was fixed (each with a regression test), what is left.
Newest session first. The audit never changed production data or services (no migration run, no function deployed). On
2026-10-13 the live project's catalog and query statistics were read through the Supabase CLI, which creates a
short-lived login role (`cli_login_postgres`) to connect. Code is pushed only on the owner's word.

## 2026-10-20 (sixteenth session: the last safe work before the pilot, and the gates made runnable)

The owner's brief: finish every safe, locally achievable task — verification, the remaining billing work (refunds,
renewal grace, the reconciler's schedule, the per-owner throttle, AutoPay's cancel), the pilot's preparation, the
database recovery's preparation and Cashfree's verification — and leave only what needs infrastructure, credentials, a
product decision or the owner's approval. Nothing was run on the live project, no function deployed, no secret set, no
trial changed; nothing staged, committed or pushed (not authorised). Baseline checked first: `ux-productization` at
`262dbdb`, nothing staged, the fifteenth session's working tree (26 modified, 20 untracked entries). A five-reviewer
read-only review was started; every reviewer stopped on the session's usage limit before reporting (nothing came back),
so the review was done inline, file by file (below).

| # | Area | Finding | Status |
|---|------|---------|--------|
| 187 | The previous full run's three failures | 2026-10-19's `npm test` (185 of 188): `zxing-fallback`'s timing check (143.5 ms over 120), `units-weighing` (Chrome detached the frame at its first page), `vercel-site` (stopped at the runner's 20 minutes, 3 of 15) | **Cause found, not the code:** Windows' power log shows the lid closed at 22:57:28 IST, 30 minutes into the run — Modern Standby on battery until 23:20:29, then hibernation (Kernel-Power 506, 42, 107); the log was written at 23:20:32. Each passed alone (16, 32, 15) the next morning; the whole suite run again with the machine awake (results below). No assertion or limit changed |
| 188 | REMEDIATION step 11: the per-owner throttle | The app's payment check asked the provider on every call (every 3 s for 10 minutes while a payment is pending, without limit), and starting AutoPay read the provider's plan before any guard | `hangtag_billing_call_claim` + `hangtag_billing_call_counts` (post-repair migration section 7, service role only, report row 7): per account, by the minute and the hour (the agent-usage pattern). `verify` 60 a minute and 900 an hour; over it, or when the count can't be read, the database's own answer ("pending"), the provider not asked (the notification and the reconciler still settle it). `autopay_start` 6 and 30, then 429 (503 if uncountable), before the provider's plan is read and before any consent. Not limited, on purpose: checkout (20 pages an hour already), turning AutoPay off (refused by the database once off; refusing a cancel could leave a mandate charging). Before the migration: no limit, as before. Tests: unit `subscription-handlers` (+4), database `billing-consistency` (+7) |
| 189 | The migration committed whatever its report said | Its 13-row report was only displayed; a false row (a grant missing, a function not replaced) would still commit — and wrapped in `BEGIN`/`COMMIT` as the runbook runs it, the SQL Editor shows `COMMIT`'s empty result, so the report wasn't even seen | The migration now ends with a check of its own report and raises "The post-repair report is not all ok (n name; …). Nothing was changed." — the transaction is rolled back. `post-repair-integrity` runs it as the runbook does with the console functions' grant left out: it stops naming row 12, and nothing of it stays (no new table, every function as the repair left it). The runbook says to read `supabase/checks/post-repair-report.sql` after `COMMIT` |
| 190 | A charge whose agreed price or plan can't be found | `hangtag_autopay_report`: `amount <> NULL` is NULL, so the price check passed, then the insert failed (plan code NOT NULL) — an error on every retry until Razorpay disables the webhook (and a stopped reconciliation) | Kept for review as `amount_mismatch` naming the plan; no time, no error. Test in `billing-consistency` |
| 191 | RELEASE §6d step 2g | Said a call without the `x-hangtag-reconcile` header gets 401 (it is a notification to the function: unsigned, 400); and its curl put the reconcile secret in the shell's history | `scripts/reconcile-probe.mjs` (`npm run probe:reconcile`): GET 405, no secret and a wrong one 401 with nothing read, the right one an ok and complete run, at once again busy; refuses the live project, secrets under 32 characters and other URLs; prints no secret. `tests/unit/payment-probes.test.mjs` (7) runs it and the webhook probe against the real handlers (the webhook probe was only checked by hand before). §6d 2g and gate 5 now name it; §6d step 4 says what the live schedule calls |
| 192 | The runbook's stop conditions | A backup counted without saying how it is verified; step 3 had no explicit abort; the repair ran on a dump possibly days old; the report "after `COMMIT`" can't be seen in the editor | Step 2: a dump counts only with exit 0, a readable `pg_restore -l` (server 17.6, the `public` tables) and its sha256 recorded. Step 3: abort on any unexplained restore error or difference. Step 6.1: a fresh dump minutes before the repair (the recovery point), abort if it fails. Steps 4, 6.3 and 7: each check run on its own (83 rows for `schema.sql`'s report, 13 for the migration's), the migration's own refusal explained. Every file and value named was checked: each of the 55 files the runbook, RELEASE, the pilot checklist and the two READMEs name exists, and each npm script they name; `schema.sql` is 809,397 bytes, sha256 `fde12118…` as stored and 819,383, `56cb6eaa…` in this Windows checkout — unchanged from `ee76f74` to `262dbdb` |
| 193 | Stale references in the probes and the README | The webhook probe pointed at §6d "step 4" and "step 5" (now 2e); the functions' README set secrets on the command line (kept in the shell's history) | Corrected; the README uses `--env-file` like §6d and names every setting |
| 194 | Cashfree's verification, made runnable | The exact settings were spread over code and documents | RELEASE §6d 2d: every setting by name (the test project's secrets, those Supabase sets itself, this computer's for the eval and both probes), how to set them in PowerShell without the history; §6d 2f: the sandbox end-to-end checklist (pay, the same notification again, a failure, a refund, then reconciliation), each with the read-only query that proves it |
| 195 | The pilot and the owner's decisions | No pilot checklist; refunds, the scheduler, renewal grace, the limits, a Cashfree refund sweep and AutoPay were open questions in several places | `PILOT-CHECKLIST.md` (payments off throughout; before it starts; nine areas — sign-in, shop isolation, product import, stock, purchase bills, sales, returns, offline sync, trial expiry and extension — each with what to do, what to expect and the automated tests that prove it locally; when to stop; what only the owner or the client can check). RELEASE §6e: the decisions, with today's behaviour, the options and the gate each is needed by; none is needed for the pilot |
| 196 | The concurrent-returns proof | Rechecked 2026-10-20: no Docker, `psql`, `pg_ctl`, PostgreSQL server or service; `wsl.exe` is the stub (WSL not installed) | **Still blocked.** `supabase/tests/concurrency/README.md` adds a route without Docker (PostgreSQL 17's Windows zip, `initdb`/`pg_ctl` on a local port, deleted after) with exact PowerShell commands and the expected results |
| 197 | `tests/e2e/business-capabilities` crashed in the first full run of this session ("Node is detached from document", line 78, the Home quick action "Sell") | The same crash `4c6726a` (2026-10-12) meant to fix — Home's quick actions re-render when the sync status changes, between puppeteer finding the button and clicking it — but that fix went into `tests/helpers/app.mjs`'s click, and this test builds its own pages and calls puppeteer's click directly: the fix never reached it. Not the app (a real tap lands on the re-drawn button in the same place) | Its pages now click as `app.mjs` does: a node replaced mid-click is found again, twice at most, on that error only; a selector that matches nothing still fails at once; no check, wait or limit changed. Alone 3 runs of 3 (48 each), then the full suite again (below). No other test clicks Home's quick actions without that helper |

**Reviewed inline, no defect:** the webhook's paths — duplicates (ledger, then the database's own idempotency), another
billing mode (kept for review, never acted on), a refund or dispute before its payment (that payment then adds no time),
a paid link no checkout recorded (`unknown_order`), the 2xx-only-once-settled rule; `hangtag_autopay_report` (orphans,
replaced set-ups, stale reports, refunded charges, the price agreed); the reconciler's money (paise from Razorpay's and
Cashfree's lists, rupees to the database, refunds already in rupees); the trial: `schema.sql` sets the Free trial plan to 30
days only where it is still 7 (so the live value set in the console stays until §6c step 3 changes it), each shop's
trial end is written at setup, the console's plan editor allows 1–90 days; the trial corrections change only the
listed shops (an empty list or the placeholder changes nothing), only while "owed", only for an active super admin;
every billing table is closed to app accounts and has row security, on a database with Supabase's default privileges.

AutoPay's cancellation was reviewed with the throttle: the owner's turn-off asks the provider first and records nothing
until the provider confirms it (a failure answers "try again" and AutoPay stays on, as it still is at the provider; not
limited, above); a replaced set-up whose cancel fails stays requested in the registry, and the reconciler retries it
(sweep B) and keeps a `cancel_failed` item for review when the provider refuses.

### Test results (run, not assumed)
- **Final `npm test`** (2026-10-20, 14:00–14:28 UTC, build `hangtag-db09103bf2`, after every change above, nothing else
  running, Windows asked not to sleep): **189/189 test files passed** — 89 unit (2,828 checks), 38 database (1,758), 4
  eval (122), 58 browser (2,056): 6,764 checks — then **`test:db:pg17` 38/38 files (1,758 checks)**. None failed, timed
  out or was skipped. Browser isolation: 59 files, 11,431 requests answered by the tests, 278 refused, **0 violations**.
- The run before it (13:32–13:57 UTC, the same tree but item 197's fix): 188/189 — `tests/e2e/business-capabilities`
  crashed after 12 checks ("Node is detached from document"); its half on PostgreSQL 17 didn't run (`npm test` stops at
  a failure). Item 197; then alone 3 runs of 3 (48 each), then the final run above.
- 2026-10-19's run (185/188, item 187): its three failures each passed alone on 2026-10-20 (`zxing-fallback` 16/16,
  `units-weighing` 32/32, `vercel-site` 15/15), and all three passed in both runs above.
- The suites the brief names, in the final run: `restore-rehearsal` 16; `post-repair-integrity` (the migration, its undo,
  its refusal of a false report) 48; `tenant-rpc-isolation` 27; `billing-consistency` 76; unit `subscription-reconcile`
  20; the payment lifecycle — unit `subscription-handlers` 51, `subscription-cashfree` 40, `subscription-function` 59,
  database `subscriptions` 94 and `subscription-cashfree` 21; `payment-probes` 7 (the webhook probe and the reconcile
  probe against the real handlers); `repair-inventory` 6; browser `console-billing-review` 7, `platform-console` 55.
- `npm run check`, `npm run lint`, `npm run build` (2026-10-20, after the final run): `sw.js` up to date (465 files,
  `hangtag-db09103bf2`), 427 modules, 0 rule violations, 0 cycles, lint 0 errors 0 warnings; the site `dist/site` (466
  files).
- `npm run eval:cashfree-sandbox`, `probe:cashfree-webhook`, `probe:reconcile` without settings: each says SKIP and exits
  0. **No sandbox, test-project or real webhook result exists.**
- The diff (`262dbdb` to the working tree, and every untracked file) scanned for keys, tokens, private keys, the owner's
  account ID and real emails or phone numbers: none (test fixtures only: `*.test` / `example.com` addresses,
  `9876543210`-style numbers).
- Not run, and why: the concurrent-returns test (no PostgreSQL server here: item 196); Cashfree's sandbox, a deployed test
  project and the Razorpay test-mode proof (no keys, no project); the signed-in checks on Production (the owner's and the
  client's accounts and devices: RELEASE §6a); anything on the live project (not authorised).

## 2026-10-19, later (fifteenth session: the billing remediation — steps 4, 5, 7, 8, 9 — and the remaining safe work)

The owner's brief: finish all remaining locally achievable work — the database and inventory checks, the billing
reconciliation and readiness items (REMEDIATION steps 4, 5, 7, 8, 9), Cashfree and subscriptions, and the documents — with
every production gate left to the owner. Nothing was run on the live project, no function deployed, no secret set, no
trial changed; nothing committed or pushed (not authorised). Baseline checked first: `ux-productization` at `262dbdb`,
23 modified and 13 untracked files, nothing staged; a copy of all of them was kept outside the repository before work.
The design was critiqued before it was built by three independent reviewers (money correctness; security, tenancy and
migration; provider realism against Razorpay's and Cashfree's documentation) — 48 critiques, read and settled here (their
synthesis step hit a usage limit; the critiques themselves were complete).

| # | Area | Finding | Status |
|---|------|---------|--------|
| 173 | The design review | Among the 48: charges on a replaced or ownerless AutoPay would have hit NOT NULL and looped the webhook into 5xx (Razorpay then disables it); any captured amount bought a full plan; a test-mode reconciler or verify could add live time; a checkout row reused on a double tap could lose a paid page; new tables with `owner_id` would take schema.sql's subscription guard (owners locked out of AutoPay set-up); readiness could never match (Razorpay events carried no type); Razorpay answers 400 for "already cancelled" and "not found" alike; list endpoints page at 100 and need time slices | Each settled in the design below; the rejected parts recorded in REMEDIATION.md's status |
| 174 | The billing mode (REMEDIATION interlock 4) | Test keys on the live project (with `SUBSCRIPTION_TEST_MODE` set by mistake) could add real time from sandbox money | `hangtag_billing_settings.billing_mode` ('live' by default; SQL Editor only). Every database function that adds time or records money or a set-up refuses another mode; the functions check before acting (`billingModeAllows`); a database without it takes live keys only; a notification in the other mode is kept for review (`mode_mismatch`), never acted on. Tests: `billing-consistency`, unit `subscription-handlers`, database `subscription-cashfree` (sandbox refused until the test project's mode is set) |
| 175 | AutoPay readiness (step 4) | AutoPay could be switched on with no proof its notifications arrive; new trials could then wait for an AutoPay that can't be set up | `hangtag_billing_readiness()`: within 7 days (signed provider times), a payment-link and a subscription notification about the self-check's probes or real Hangtag objects, and a complete reconciliation within 26 h. Gates the terms (quote, begin, config), switching AutoPay on (a save that keeps it on still works), and new trials (`ensure`). The self-check: the function's `billing_selfcheck` (settings.manage, once in 10 min, audited). Tested |
| 176 | The AutoPay registry (step 5) | A charge on an earlier set-up was recorded nowhere (R1); a halted set-up could charge after a payment by hand (R4); a failed cancel of an untracked set-up was forgotten (172a) | `hangtag_autopay_mandates` (shop column `shop_owner_id`), with the price and currency agreed to; begin hands back every earlier set-up to cancel; attach by registry id; `hangtag_autopay_report` (new; `hangtag_autopay_event` kept unchanged, so no function's arguments change) records a charge on any registered set-up once, only at the price and currency agreed (else kept for review — a ₹5 authorisation can't buy a month), never for refunded or disputed money, never for an ownerless set-up; checkout cancels a halted set-up first or refuses; an untracked set-up whose cancel fails is registered for the reconciler. **172(a) closed.** Tested (R1, R4, backfill, orphans, mismatches) |
| 177 | Event order (step 8) | A late "pending" or "halted" could undo a newer charge | The provider's event time per set-up (clamped to now); an older state report changes nothing; charges always recorded once; cancellations always apply. Tested with past provider times |
| 178 | Reconciliation (step 7) | A missed notification was permanent | `supabase/functions/subscription/reconcile.js` (sweeps A both providers; B, C, D Razorpay) behind the webhook function's reconcile entry (`SUBSCRIPTION_RECONCILE_SECRET`, 32+ characters, constant-time); the database opens and closes runs (one at a time, its own times), gives the targets, records resume points and what was read; a 4xx on one item is kept against it (`reconcile_error`) and the run goes on; a capped run is ok but not complete. The owner's `autopay_verify` runs the same check at most every 5 min. Unit `subscription-reconcile` (20) and `billing-consistency`. **The scheduler is the owner's decision** |
| 179 | Offer holds (step 9) | Direct checkout calls with no page held capped places (R3) | A place is held only by an attached checkout, one per shop, not by a shop that let two lapse in a day. The planned row reuse was dropped (it could lose a paid page); instead a page attaches only to a payment still open for it, and one that can't is withdrawn at the provider (Razorpay and Cashfree `cancelPayment`). Tested |
| 180 | Refunds and disputes (step 6, the rest) | Razorpay refunds and disputes, and Cashfree disputes, were not kept | Both providers' notifications kept for review, against the payment when recorded and also before it (Hangtag's money only: its notes, link or AutoPay); a payment whose refund or dispute is open adds no time (`hangtag_subscription_activate_checked` and the registry). Tested (unit and database) |
| 181 | The console's billing review (step 6) | Money kept for review was readable only in SQL | Payments → Billing review: the billing mode, readiness, last runs and `hangtag_billing_integrity()`; items settled with a reason (subscriptions.manage, audited before/after); an old database told what it needs. `tests/e2e/console-billing-review.test.mjs` (7, in Chrome). **Not built: revoking a refunded payment's time** — stacked periods make it a design decision (the owner's) |
| 182 | The migration itself | Twelve sections; the earlier generator lived only in a temp folder | `scripts/gen-post-repair.mjs` (in the repository) builds the migration, its undo and `supabase/checks/post-repair-report.sql` from `schema.sql` and `supabase/tests/post-repair-edits.mjs` — every change to an existing function listed there, byte-checked (10 functions; no argument changes). Report 13 rows. `post-repair-integrity` now also checks the undo restores every function's grants and settings, and that outside function bodies only the migration's own tables are written or altered (DO blocks read too). `hangtag_deleted_products` carries schema.sql's subscription guard like every shop table; the billing tables have no `owner_id` (the guard would lock owners out). The 13 Oct version check shows 5 functions changed by design after it; it must be run again after any later `schema.sql` run (RELEASE §3, runbook step 7) |
| 183 | RELEASE §6a item 3 | Said the network-entry merge was "not yet deployed" | Corrected on the owner's instruction, after checking: Production's `src/shared/logging/diagnostics.js` is `262dbdb`'s byte for byte (line endings aside), `API_REPEAT_MS` included; `sw.js` `hangtag-1601181284` |
| 184 | The documents | §6c said "not promoted"; the pilot had no explicit payments-off rule; the test project's billing mode, the reconcile secret and schedule weren't in §6d | RELEASE §3 (re-run rule), §6a (Production), §6c, §6d (steps 1, 2c, 2d, 2g, 3–6), new §6e (the pilot: payments off; the seven gates with the evidence each needs); the runbook's steps 4, 7 and recovery; REMEDIATION.md; the functions' README and headers. Every file and npm script §6a–§6e names exists (checked) |
| 185 | The concurrent-returns proof | Still no Docker, `psql`, PostgreSQL server or WSL on this machine (checked again) | **Blocked**; `supabase/tests/concurrency/README.md` now states the prerequisite with the exact commands and expected results |
| 186 | Still open, by design or by what they need | Step 11's per-owner throttle; the Razorpay test-mode proof (whether a far-off subscription cancels while only "created" and sends subscription.cancelled — readiness relies on it); Cashfree's account-level reconciliation (/pg/recon unverified: a missed Cashfree refund isn't found by a sweep); revoking refunded time | Documented in REMEDIATION.md; AutoPay stays off |

### Test results (run, not assumed)
- `npm test` (2026-10-19, 16:57–17:50 UTC, build `hangtag-db09103bf2`, after every change above): **185 of 188 test files
  passed, 3 failed** — 88 unit (87 passed), 38 database (38), 4 eval (4), 58 browser (56). The three, each passed in
  every earlier full run this week:
  - `tests/unit/zxing-fallback`: 15 of 16 — the timing check "an empty camera frame costs well under the 120 ms between
    frames" measured 143.5 ms with the whole suite running beside it;
  - `tests/e2e/units-weighing`: stopped before its first check — Chrome detached the frame while the first page was
    loading ("Navigating frame was detached");
  - `tests/e2e/vercel-site`: 3 of 15, then stopped by the runner's 20-minute limit (1,377 s; it takes 10–20 s).
  Because `npm test` failed, its second half (`test:db:pg17`) did not run then. Browser isolation: 58 files, 11,148
  requests answered by the tests, 282 refused, **0 violations**.
- Run again on 2026-10-20, 07:42 UTC, with nothing changed, alone: **3/3 files passed** — `zxing-fallback` 16/16,
  `units-weighing` 32/32 (isolation 0 violations), `vercel-site` 15/15. None of the three touches billing or the
  database. No assertion or limit was changed.
- `npm run test:db:pg17` (2026-10-20, 07:42–07:44 UTC): **38/38 files, 1,749 checks** — the same as the default database
  run. Among them: `billing-consistency` (68, new), `post-repair-integrity` (47; the migration, its undo and the report),
  `restore-rehearsal` (16), `tenant-rpc-isolation` (27), `subscription-cashfree` (21), `subscriptions`, `repair-inventory`.
- Unit, new or changed: `subscription-reconcile` (20, new), `subscription-handlers` (47), `subscription-cashfree` (40),
  `subscription-function`. Browser: `console-billing-review` (7, new; 0 isolation violations), `platform-console` (55).
- `npm run check` (2026-10-20): `sw.js` up to date (465 files, `hangtag-db09103bf2`), 427 modules, 0 rule violations,
  0 cycles, lint 0 errors 0 warnings. `npm run lint`: clean.
- The webhook probe (`scripts/cashfree-webhook-probe.mjs`) against a local server wrapping this session's webhook
  handler with a made-up sandbox-format key: 5/5, and the database never touched. It refused the live project's URL and a
  production key, and skipped without settings. **This is not a sandbox or test-project result**; none has been run.
- `npm run eval:cashfree-sandbox`: skipped — no sandbox keys on this machine (it says so and exits 0).
- Not run, and why: the concurrent returns test (no PostgreSQL server, Docker, `psql` or WSL; the prerequisite and
  commands are in `supabase/tests/concurrency/README.md`); Cashfree's sandbox, a deployed test project and the Razorpay
  test-mode proof (no keys, no project: RELEASE §6d); anything on the live project (not authorised).

## 2026-10-19 (fourteenth session: the restore rehearsal, the remaining safe fixes, the review)

The owner's brief: complete all remaining safe work from the current state, verified outside production. Nothing was
run on the live project, no function deployed, no secret set; nothing committed or pushed (not authorised). A
three-reviewer pass (payments, database, tests) over this session's changes; its findings were checked against the
code one by one, inline (items 167–171).

| # | Area | Finding | Status |
|---|------|---------|--------|
| 158 | The runbook's steps 2–4, rehearsed | The backup, restore, comparison and rehearsal had never run end to end with the runbook's own check files | `supabase/tests/restore-rehearsal.test.mjs` (16, both PostgreSQL versions): a live-like database (18 older functions, containment, two shops' rows) backed up as a whole data directory (a physical backup), restored into a separate database; data fingerprint, exact row counts, function versions and open policies identical; no reference pointing at nothing; a row written after the backup is the one difference, by table. On the restored copy: dry run 0, the repair in one transaction (report ok), version check ok, fingerprint unchanged, the isolation probes clean (60 probe rows), the post-repair migration (report ok, existing rows unchanged, new tables empty) and its undo; on a second copy the repair's undo restores every function. Not covered: the `pg_dump`/`pg_restore` tools themselves (no PostgreSQL server tools here) — the owner's real backup is still the hard blocker |
| 159 | Migration order | The post-repair migration could be run before the repair (it would mix versions on live's older functions) | Its first statement checks three functions the repair brings up to date and stops ("run the repair first"), nothing changed. Tested on the live-like database |
| 160 | The migration and existing rules and rows | — | Tested: every existing row-security rule unchanged, one added on its own new table; existing rows unchanged; nothing outside a function body writes a row or alters an existing table (static check, item 171) |
| 161 | The rollback chain | — | Tested: the migration's undo, then the 2026-10-13 repair undo, gives every function back exactly as live has it now; the undo's final check now also covers `hangtag_cap_on` and the two billing functions (item 170) |
| 162 | A suspended shop could start a plan payment (REMEDIATION step 11) | The payment then extended a shop that stayed locked | Fixed in the post-repair migration, section 7: checkout refuses a suspended shop with AutoPay's words; money for an earlier payment still honoured; generated from `schema.sql` with one stated four-line edit (byte-checked). Tested both ways, and that without the migration the defect returns. Not done: the per-owner throttle (step 11's second half) |
| 163 | What Production serves | RELEASE said `hangtag.vercel.app` served the 01:51 tree | It serves `262dbdb` (`hangtag-1601181284`, sw.js Last-Modified 2026-10-18 13:47:30 UTC; read 10-18 and again 10-19), promoted outside this work. RELEASE §6, §6a, §6c corrected; the signed-in checks now apply to Production |
| 164 | Money on a Hangtag link no payment recorded | Answered 200 "ignored" with no record | Kept for review as `unknown_order` (never activated) when the notification's or Cashfree's own record of the link names Hangtag; a link Cashfree never made (404) answered for good; others ignored. Unit (Cashfree, Razorpay) and database tests |
| 165 | The webhook on a deployed test project | No way to check the deployed function without money | `npm run probe:cashfree-webhook` (refuses the live project and production keys; writes nothing): method, wrong and missing signature, signed notifications of no Hangtag payment. Run here against a local server wrapping the real handler (all pass); not against a deployed project (none). `npm run eval:cashfree-sandbox` gains a guarded `HANGTAG_EVAL_CASHFREE_NOTIFY_URL` for a real Cashfree delivery to a test project; RELEASE §6d step 2 has the procedure. A request with no provider's signature header is now 400, not 503 |
| 166 | The runbook's step 7 | Said the data fingerprint stays identical after the migration | It gains a line per new shop table (0 rows); found by item 158; corrected, and the step names the three checked functions the migration changes |
| 167 | (review) The app's own payment check ignored the currency | `verify` read the payment without its currency, so a payment in another currency with the same number was activated by the app's check though the webhook refused it — reproduced (a month added) | Fixed (`currency` selected); database test: the app's check 409, the webhook keeps it for review, no time added |
| 168 | (review) A success Cashfree's API didn't show yet was settled | Answered 200 and noted, so Cashfree never sent it again; the plan then waited for the owner's app | Not settled until readable: 503, sent again (Cashfree only — a state read from the notification itself would repeat for ever). Unit scenario 3 now expects 503 (still nothing activated, nothing noted); new: money listed but unreadable → 503, then activated once readable |
| 169 | (review) Month ends in the tests | JavaScript's month arithmetic (31 Oct + 1 = 1 Dec) differs from the database's (30 Nov): false failures on month-end days | The expected dates come from the database (`subscription-cashfree`, `subscriptions`); checked directly |
| 170 | (review) The undo's final check | Didn't cover `hangtag_cap_on` or the billing functions; the runbook said "three functions" | Both fixed |
| 171 | (review) The migration's row check | Taken before any shop had rows | Relabelled; a static check that nothing outside function bodies writes; the restore rehearsal compares shops' rows (customers added to its seed) |
| 172 | (review, documented, not changed; (a) closed by item 176) | (a) A failed cancel of an untracked AutoPay mandate is answered 200, so the mandate can charge later; (b) on the checkout path a missing provider or phone is reported before "suspended" | (a) AutoPay is off; retrying needs the Razorpay test-mode proof (REMEDIATION) or Razorpay may disable the webhook. (b) The lock screen never offers checkout to a suspended shop. Both in REMEDIATION.md |


### Test results (run, not assumed)
- `npm test` (2026-10-19, 04:48–05:15 UTC, build `hangtag-3cce4c2260`, after every change above): **185/185 test files
  passed** — 87 unit (2,780 checks), 37 database (1,669), 4 eval (122), 57 browser (2,049): 6,620 checks — then **37/37 on
  PostgreSQL 17** (1,669). None failed, timed out or skipped. Browser isolation: 58 files, 11,380 requests answered by
  the tests, 282 refused, **0 violations**.
- An earlier run the same night (before items 167–171) was cut off when the session ended: 157 files reached, one
  failure — `accounts-isolation` (an unchanged, committed browser test) stopped after 4 of its 28 checks with
  `__ev is not defined` while review agents were running beside it. Alone it passed 3 runs of 3 (28/28 each), and it
  passed in the full run above.
- New or changed this session: `restore-rehearsal` (16), `post-repair-integrity` (41, was 31), `subscription-cashfree`
  database (19, was 17) and unit (40, was 35), `subscription-handlers` (+1), `subscriptions` (month-end dates).
- `npm run check`: `sw.js` up to date, 427 modules, 0 rule violations, 0 cycles, lint 0/0. `npm run lint`: clean.
  The probe was run against a local server wrapping the real webhook handler (5/5); its refusals (live ref, production
  key) and the eval's skip and refusals were checked by hand.
- Not run, and why: the concurrent returns test (still no PostgreSQL server, Docker or WSL here; installing one changes
  the system: `supabase/tests/concurrency/`); Cashfree's sandbox and a deployed test project (no keys, no project:
  RELEASE §6d step 2); anything on the live project (not authorised).

## 2026-10-18 (thirteenth session: database integrity, tenant isolation, Cashfree)

The owner's brief: finish the database-integrity work that depends on the repair and the Cashfree subscription payments,
verified outside production. Nothing was run on the live project, no function was deployed, no secret set; nothing was
committed or pushed (not authorised this time).

| # | Area | Finding | Status |
|---|------|---------|--------|
| 145 | The live database's state | Confirmed (read-only evidence of 10-13/10-14): the out-of-order run left 18 older functions, 3 indexes and six open policies; the policies were dropped at 23:45 IST; no backup, PITR off (10-15). Assumed, not re-checked (no access here): nothing changed since. Unknown: whether rows were read or changed across shops while the policies were open | `supabase/REPAIR-RUNBOOK.md` §0 separates the three; its step 1 re-checks the assumptions |
| 146 | What the repair changes, exactly | On the live state as reconstructed (with the containment): the 18 functions, `hangtag_sales_money_check` re-added (NOT VALID: no row re-checked — RELEASE §3 had it under "stays as it is"), the 3 indexes dropped; nothing added; no policy, column, trigger, row security, grant or row changed | Pinned by `supabase/tests/repair-inventory.test.mjs` (6); RELEASE §3 corrected |
| 147 | Fixes that need the database, without touching the repair's script | A separate migration after the repair, `supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql`: `schema.sql` (the repair's script, its hash and rehearsals) unchanged. Its three replaced functions are generated from `schema.sql` with exactly one stated edit each, and a test proves nothing else differs. Its own report (6 rows) and undo (`supabase/operations/post-repair-integrity-undo.sql`) | `supabase/tests/post-repair-integrity.test.mjs` (31, both PostgreSQL versions): the runbook's order (live-like → repair → 13 Oct check all ok → migration twice), the fixes below, the tenant sweep over every shop table, the undo and re-apply |
| 148 | Two returns of one bill line at once (114, 141) | The return check takes a transaction lock per bill line (`pg_advisory_xact_lock`) before summing: no table privilege needed (a row lock would need UPDATE rights a cashier lacks) | Fixed in the migration; the lock is shown held during a return and released after; sequential limits unchanged. **The concurrent proof needs a real PostgreSQL** (none here): ready to run in `supabase/tests/concurrency/` (two `psql` sessions, expected results with and without the fix; its statements checked one after the other on PGlite) |
| 149 | Stock records of tracked products (56, I4) | A serial-tracked product's stock record needs its serial numbers, a batch-tracked one its batch, on every path (a trigger before the shape check; an empty list counts as none). Matches every path the app uses (counts exclude serial products; repack and purchase cancellation carry theirs) | Fixed in the migration; tested |
| 150 | Bill lines' unit (61, I21) | `hangtag_save_sales` now stores the unit sent (a re-sent line keeps the first; none sent → the product's, as before); the app sends `unit` (`mappers.js`), ignored by the older function until the migration | Fixed (migration + app); tested end to end through the app's mapper; unit `tracking` (+1) |
| 151 | An edit bringing back a product deleted elsewhere (57, 143) | A delete leaves a mark (`hangtag_deleted_products`, read by its shop only, written only by the delete); the app's product edit that finds no row checks the mark: there → a conflict for the review list (no name in the message); absent or the table missing → saved whole, as before | Fixed (migration + `cloud-gateway.js`); tests: `post-repair-integrity`, `sync-backup-events` (+3) |
| 152 | `hangtag_cap_on` inference | It answered about any shop given its id (capabilities, and through the store check whether its plan runs). Now an app account gets answers about its own shop only; the public store pages (no session: `store.js`, `order.js`) and the database's own checks unaffected. A signed-in account of another shop calling the store functions with its session would see the store closed — not a path the app uses | Fixed in the migration; tested both ways |
| 153 | Tenant isolation beyond tables | The functions an app account may call with the owner's rights are exactly a reviewed list of 55 (6 for the signed-out, each by token or the sign-in question); the migration adds none. Cross-shop probes: webhooks (rotate, change, test, delete), console functions, trigger functions called directly — all refused or without effect. The bills bucket (Storage stand-in): own folder only for reading, adding and changing; nobody deletes; the signed-out see nothing | `supabase/tests/tenant-rpc-isolation.test.mjs` (23). Tables were already swept (`team-tenancy`); the sweep now also runs on the migrated database |
| 154 | Cashfree for Hangtag plans | Ported from the paused branch (`e62d23c`) into the current handlers; checked against Cashfree's docs (API 2026-01-01; webhook Base64 HMAC-SHA256 of timestamp + raw body; at-least-once delivery). Payment Links (no Cashfree script in the app); notifications are nudges (state read from the API); sandbox only on a test project; one link per payment (idempotency key); Hangtag's mark on each link; refunds traced and kept for review; orders of other products on the account ignored; currency checked; a payment naming another payment never activated; a provider payment that already paid another payment refused for good (23505 → review, not retried); duplicates known after settling; CORS configurable. The branch's shop UPI-QR picture feature is not part of this | Code and tests; **not deployed**. Tests: `tests/unit/subscription-cashfree.test.mjs` (35), `supabase/tests/subscription-cashfree.test.mjs` (17, both versions), `subscription-handlers` and `subscription-function` updated |
| 155 | The payment lifecycle, scenario by scenario | See the matrix below | — |
| 156 | Cashfree's real sandbox | No sandbox keys on this machine | **Blocked.** `npm run eval:cashfree-sandbox` is ready (sandbox keys; refuses production keys; prints no secret) |
| 157 | Low-stock decimals (I22) | The column is INTEGER; the app can't send decimals before a migration changes it (an integer column refuses 2.5), so it needs a two-step release | Deferred (low). Not in the post-repair migration |

**The payment lifecycle (Cashfree), as tested here** — unit: `subscription-cashfree` (fake Cashfree, scripted database);
database: `supabase/tests/subscription-cashfree` (real schema and post-repair migration, real handlers, fake Cashfree).

| Scenario | Result | Where |
|---|---|---|
| A successful payment adds the plan's months once, after the trial | Pass | unit 1; database |
| A rejected attempt (link still open) changes nothing | Pass | unit 2 |
| A success message Cashfree's API doesn't confirm, or the app claiming "paid": nothing activated (state only from the API); not settled, sent again (503) | Pass | unit 3 (2026-10-19: 503, was 200) |
| Money listed by Cashfree but its payment not readable yet: 503, then activated once readable | Pass | unit 3 |
| An invalid signature, or none at all: 400, database and Cashfree untouched | Pass | unit 4 |
| A duplicate notification (key or same body): nothing twice | Pass | unit 5; database |
| Retries: Cashfree down 503, database down 503, activation lost 500, never noted as settled | Pass | unit 6 |
| A delayed notification after the app's own check: nothing added again | Pass | unit 7; database |
| Out of order (a failure after a success): no change | Pass | unit 8 |
| An amount or a currency that isn't due: never activated, kept for review; the app's own check refuses it too (409) | Pass | unit 9, 10; database |
| A link naming another shop's payment: nothing activated, kept for review | Pass | unit 11; database |
| A refund: kept for review, no time removed | Pass | unit 12; database |
| Another Florix product's order on the same account: ignored | Pass | unit 13 |
| Money on a Hangtag link no payment recorded: kept for review (`unknown_order`), never activated; a link Cashfree never made: ignored for good | Pass | unit 13b; Razorpay unit; database |
| Sandbox keys on the live project: refused | Pass | unit 14 |
| Checkout needs the shop's phone (asked before any payment exists) | Pass | unit 15 |
| Money taken after a link expired: honoured | Pass | database |
| A plan that ended: a new payment starts from now | Pass | database |
| One Cashfree payment for two Hangtag payments: refused, kept for review | Pass | database |
| The real Cashfree sandbox (link made, read back, paid) | **Blocked** (no keys) | `npm run eval:cashfree-sandbox` |
| The deployed webhook's signature check (probe) | Pass against a local server wrapping the real handler; **blocked** on a deployed test project | `npm run probe:cashfree-webhook` |
| Real webhook delivery and signature from Cashfree | **Blocked** (needs sandbox keys and a deployed test project) | RELEASE §6d step 2e |

### Test results (run, not assumed)
- `npm test` (15:03–15:28 UTC, build `hangtag-3cce4c2260`): **184/184 test files passed** — 87 unit (2,774 checks),
  36 database (1,640), 4 eval (122), 57 browser (2,049): 6,585 checks — then **36/36 on PostgreSQL 17** (1,640). None
  failed, timed out or skipped. Browser isolation: 58 files, 11,380 requests answered by the tests, 277 refused,
  **0 violations**.
- New this session: `repair-inventory` (6), `post-repair-integrity` (31), `tenant-rpc-isolation` (23),
  `subscription-cashfree` database (17), `subscription-cashfree` unit (35); changed: `live-recovery` (the incident's own
  files only), `subscription-handlers`, `subscription-function`, `sync-backup-events` (+3), `tracking` (+1).
- `npm run check`: `sw.js` up to date, 427 modules, 0 rule violations, 0 cycles, lint 0/0. `npm run lint`: clean.
- Not run, and why: the concurrent returns test (no PostgreSQL server, Docker or WSL here: `supabase/tests/concurrency/`);
  Cashfree's sandbox (no keys: `npm run eval:cashfree-sandbox`); anything on the live project (not authorised).

## 2026-10-18 (twelfth session: the completion pass)

The owner's brief: finish every safe local item, test it, document what is left, then commit and push for a Preview
(not Production). Nothing in the live project was run or changed.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 135 | Console dashboard, any answer | After item 128 a newer answer missing a count still showed it as 0 (the old rule: "a missing figure is 0") | Fixed — `dashboardTiles` shows only figures the database sent: a missing one is no tile, an empty group none, a real 0 stays 0; the older (3w) answer uses its own counts. Unit `platform-console`: newer full, newer partial, older, empty |
| 136 | `subscription` / `subscription-webhook` (REMEDIATION steps 1, 2, parts of 3 and 10) | The webhook answered 200 when the payment lookup failed (Razorpay never retries a 200: money captured, no time added until the owner opens the app), ignored a failed "mark failed", logged nothing on an amount mismatch, and retried for ever an activation refused for good; a paid link with an authorised (uncaptured) payment counted as paid; test keys were accepted on the one shared project; the webhook's provider keys weren't declared; AutoPay recorded the consent before checking the provider's plan | Fixed in code (**not deployed**) — logic in `handler.js` (plain JS, testable), `index.ts` only wiring; 503/500 when an event isn't recorded and may be, 200 + an error line with ids when it never can; captured only; `keyMode` (test keys only with `SUBSCRIPTION_TEST_MODE=true`); `deploy.json`; plan checked before consent; a passing activation failure on confirm says "try again". Tests: `subscription-handlers` (new, behaviour), `subscription-function` (fixtures, order). Not done, with reasons: `config.toml`, CORS (REMEDIATION.md status) |
| 137 | The app's lock against the live answer | The live database answers with the 3t status (no AutoPay or lifecycle fields); the suites ran the app only against the current one, and no test drove the refresh triggers | Tested — `subscription-refresh` (new): the live answer for an ended 15-day trial locks; the console's extension opens the app on the next question, without a reload, by each trigger (back on screen after 30 s, reconnect, network back, "Check again", HT402, page shown); not before 30 s; offline or a failed call keeps the saved answer; a database without plans never locks; the server's time, not the device's; a trial ending while open locks then and asks again. No app change was needed |
| 138 | The owner's SQL, permanently tested | The rehearsals of items 126–132 lived only in the scratchpad | `supabase/tests/owner-operations.test.mjs` (34): on a database built like the live project (its 18 older functions), each file as written — access check and trial audit read only; first super admin once, never a second, never a mistyped ID; corrections: none without a list, none for a shop not owed or for an actor who isn't super admin, the client exactly to start + 30, part 9's list, a second run nothing, audited; plan at 30 for the next shop; permissions update and undo |
| 139 | Purchases and stock (AUDIT 62, PLAN I12, part of I22) | Purchase line money rounded differently from sales (1.005 at ₹1: ₹1.00 against ₹1.01); "Received today" counted opening stock; opening stock from a product file had no cost; serial and batch history called any record with an import id "Purchased" | Fixed — `lineMoney` uses `linePaise`; `stockReceived` (stock in only); the opening record keeps the row's or product's cost; labels by kind (opening, adjustment, then purchased / purchase cancelled, else stock in). Tests: `bill-import`, `business-today`, `product-import`, `tracking` (+1 each) |
| 140 | Diagnostics privacy, merged entries | Item 130 merged repeats; nothing checked a merged entry for leaked values | Tested — two failed calls whose address carries a token and a phone number make one entry with only the operation, counts and times (`diagnostics-events`) |
| 141 | Two returns of one bill line at once (item 114) | Still a hypothesis: it needs two transactions at the same moment, and every database here is single-connection PGlite (no PostgreSQL server, Docker or WSL on this machine) | **Blocked**, not changed. The fix (lock the bill line before the sum in `hangtag_check_return_qty`) changes `schema.sql`, so it also reaches live only with the repair; it needs a two-connection test on a real PostgreSQL 17 first **→ Fixed in the post-repair migration (item 148); concurrent proof ready, not run (no PostgreSQL server here).** |
| 142 | Defects whose fix is in the database | AUDIT 56 (I4: stock records of the wrong shape on every path), 61 (I21: `hangtag_save_sales` never stores the unit sent), low-stock decimals (I22: an INTEGER column), 114 | Deferred to a schema section after the repair: none can reach live before it, and changing `schema.sql` now would change the script whose rehearsal, hash and undo the repair approval rests on (RELEASE §2a) **→ Done as a separate post-repair migration (items 147–150), schema.sql untouched; low-stock decimals stay deferred (157).** |
| 143 | A product edited on one device after a delete on another (item 57) | An update that finds no row can't tell "deleted elsewhere" from "not uploaded yet"; recreating is the current behaviour | Not changed: dropping the edit would lose a product made offline. Needs I10's server-side comparison (PLAN.md) **→ Done: item 151 (a deleted product leaves a mark the app checks).** |
| 144 | Restore checks in the repository (item 121) | The two checks the repair evidence needs (no reference pointing at nothing after a restore; exact counts of every table) lived only in the scratchpad | Added — `supabase/checks/restore-fk-orphans.sql`, `restore-row-counts.sql` (stored data untouched: a temporary result table), named in RELEASE §2a item 3. Test `supabase/tests/restore-checks.test.mjs` (5): a clean database has no orphan across 104 foreign keys; a bill line loaded without its bill (triggers off) is found by its key; all 72 tables counted, only counted |

### Test results (run, not assumed)
- `npm test` (10:25–10:52 UTC) on items 135–143: **178/178 test files passed** — 86 unit (2,735 checks), 31 database
  (1,559), 4 eval (122), 57 browser (2,049): 6,465 checks — then **31/31 on PostgreSQL 17** (1,559). None failed, timed
  out or skipped. Browser isolation: 58 files, 11,383 requests answered by the tests, 294 refused, **0 violations**
  (`test-isolation`, `network-isolation` among them).
- Item 144 came after: `npm run test:db` and `npm run test:db:pg17` again, **32/32 files each** (1,564 checks each).
  `owner-operations` was run once more on both after its sample account ID was made fictional (34 each).
- `npm run check`: `sw.js` up to date (`hangtag-1601181284`), 427 modules, 0 rule violations, 0 cycles, lint 0/0.
  `npm run lint`: clean. The project has no typecheck script (plain JS; `index.ts` files are Deno-only wiring).
- Not run, by design: anything against the live project or a real payment provider; the signed-in Preview (§6a).

## 2026-10-16 (eleventh session: a failing download no longer floods Diagnostics; its recovery is recorded)

The owner's brief: fix the Diagnostics noise found on 10-15 (each failed check made two entries; the 50-entry history
was full in about 20 minutes, the earlier entries gone by 30; recovery left no entry), with one entry per failure,
bounded retries and a recovery entry, keeping the 60-second merge rule unless shown to be insufficient. Local only: no
commit, push or deploy.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 117 | Work found in the tree | Uncommitted changes from 10-16 11:44 (not this session's): `download-health.js` (one entry per failing part, one when it recovers), `retry-backoff.js` (1, 2, 4, then 5 minutes), and their use in `catch-up-core.js`, `catch-up.js`, `connection.js` (a team phone's poll with the same backoff), `pull.js`, `app/main.js`, `window-events.js`. Reviewed and kept. **Found in it and fixed:** `installCatchUp` ignored the callback `main.js` passed, so a team phone's back-on-screen check never ran; "orders" and "commerce" failures never closed (no recovery entry, and every later failure of them unrecorded); on a database without those change checks a team phone fell back to the whole download every 5 minutes; the team check (`refreshAccess`) and the other parts of the change check (stock moves, returns, customers, events, cash, settings, photos, bills) still warned on every retry; a team phone checked on every return to the app, however brief | Fixed: the shared `pullPart`; every part of the change check is its own incident (and the others still come down); the team check is one incident ("access"); only a missing shop change check sends a phone to the whole download; back on screen after 30 s away, or while a failed check waits | 
| 118 | Diagnostics noise | **Confirmed before, fixed.** Three hours of a failing product download on an owner's device (simulation with the real catch-up, downloads and Diagnostics store): **before** (`1b9b573`) 176 checks, the history full at 20 minutes, 0 of 20 earlier entries left at 30 minutes, no recovery entry; **after** 37 checks (1, 2, 4, then every 5 minutes), 21 entries (the 20 earlier + one "download failed (catalog)"), all 20 kept, and "download recovered (catalog)" once when it comes down. The full download keeps its own wording for what stopped it ("Pull from Supabase failed … (table:hangtag_meta)"), once per incident | Test: `tests/unit/sync-diagnostics-noise.test.mjs` (19): owner 3 h, team phone 1 h and offline 30 min, retries 1/2/4/5 with cap and reset, immediate signals one at a time, markers never moved by a failure, the missing product there after recovery, one recovery entry, none repeated, earlier and unrelated entries kept |
| 119 | Network-layer entries | **Confirmed, not fixed (by the brief: proposal only).** The fetch layer (`client.js withTiming`) notes every failed call ("connection failed (table:hangtag_products) · under 1 s"), one per attempt, identical but more than 60 s apart, so never merged: with the backoff, 3 hours of failures still push 8 of 20 earlier entries out (20 of 20 kept at 2 hours) | **Done in item 130** (wider than this proposal). Proposal: merge an identical consecutive *api* entry (connection failed, server error) within 6 minutes, just over the 5-minute retry cap, keeping when it first happened; the 60-second rule stays for everything else |
| 120 | Realtime | **Not verified against real Supabase.** The catch-up's realtime path is tested by calling the status handler directly; the browser tests refuse the realtime socket. Whether supabase-js reports a drop before re-joining, what real browsers fire for online/offline, and a hung download (never cancelled; the catch-up stops waiting after 2 minutes) remain open | Needs a non-live Supabase project, or the owner's Preview check |
| 121 | Restore checks | `fk-orphans.sql` (rows whose foreign key points at nothing; the restore loads data with triggers off) and `row-counts.sql` (exact counts of every `public` and `auth` table, and storage objects by bucket) exist **only in the session's scratchpad**, not in the repository. Validated in PGlite on `schema.sql`: 104 foreign keys, no orphans on a clean database, the one planted orphan found; 72 tables counted | **Done in item 144.** Proposal: add them to `supabase/checks/` and RELEASE §2a, in a separate commit |

### 2026-10-18 (the client-delivery sprint: the trial, the console, the deployed build)

| # | Area | Finding | Status |
|---|------|---------|--------|
| 122 | The 15-day trial | **No code produces 15 days** (no constant, copy or calculation; the app's clock follows the server). A shop's trial length is the "Free trial" plan's `days` when the shop finishes setting up (`hangtag_subscription_ensure`, at onboarding), written into its own row; changing the plan later never lengthens a running trial (`schema.sql:6809` moves only the plan, and only from 7). So 15 days is live data: most likely the plan set to 15 in the console's plan editor (allowed, audited as `plan.update`), or that shop's end set directly. **The exact cause is not established**: it needs the read-only diagnosis on live (owner's approval) | Prepared: `supabase/checks/2026-10-18-trial-diagnosis.sql` (read-only); the fix is the console's own audited actions (RELEASE §6b). Rehearsed on PGlite (15 checks): diagnosis read-only, first super admin once, Extend refused without a role and needing a reason, trial to 30 days after Extend, audited; plan set to 30 for new shops |
| 123 | Product-owner admin | **Already built** (Platform Console, `/platform/`): staff roles checked in the database on every call, customers, trial and plan status, Extend 1–90 days, Give a plan, promotions and promo codes, the plan editor, an audit log (who, role, shop, reason, before, after), framing refused. On live (older functions until the repair) Suspend, Restore and End all sign-ins are refused for every role; Extend, Give a plan, Plans and Promotions work. The first super admin needs one SQL insert (no public sign-up) | Tests: `platform-console` e2e (55), unit (37), `platform-operations` (65), `plans-autopay-platform` (83) |
| 124 | The expired-trial screen | Says the data is safe; with online payment not set up (live: `subscription` not deployed) it shows "Online payment isn't set up yet. Contact Hangtag support to choose a plan", and "Checking how you can pay…" (no Pay button) until it knows | No change needed. `subscription` e2e (70) |
| 125 | What `hangtag.vercel.app` serves | **Confirmed: the uncommitted working tree**, deployed 2026-10-18 01:51 UTC outside git (not by this session; GitHub's deployment records still name `ee76f74` as Production). Its build is `hangtag-1803427d85`, the local build's; uncommitted files (`download-health.js`, `retry-backoff.js`) are served byte for byte. This machine has no Vercel CLI on its path and no project link | Reported to the owner: keep it, or promote `ee76f74` again (Vercel dashboard). Nothing changed by this session |
| 126 | The diagnosis as written | The Supabase SQL Editor shows only a script's **last** result, so the six-query diagnosis run whole would have shown only the staff counts. It also couldn't say whether the owner's own account is console staff, or which other shops are short of the standard | Added (the first file kept): `supabase/checks/2026-10-18-trial-audit.sql`, one read-only SELECT, two emails at its top, eight parts incl. the owner's console role and every shop below 30 days with its verdict and days owed (counted as Extend counts: from the trial's end or now). Rehearsed on a copy built like the live project (`schema.sql`, then the section files newest-first: exactly the 18 older functions; 22 checks): runs in a READ ONLY transaction, changes nothing; email case/spaces ignored; team member → the owner's trial; a reused email's 0-day trial and a shop past its 30 days are owed nothing; first super admin by email or account ID, idempotent; Extend by the days owed ends the trial at its 30-day mark (under a day after) and access returns; refusals audited; Give a plan works and Suspend is refused there; the plan at 30 gives the next shop 30 under the live 3t setup; no shop data changed. RELEASE §6b updated |
| 127 | The deployment, rechecked 08:04 UTC | Still `hangtag-1803427d85`; `index.html`, `platform/index.html`, `sw.js`, `main.js`, `pull.js`, `connection.js`, `download-health.js`, `retry-backoff.js` served byte-identical to the working tree (the last five differ from `HEAD`). `/platform/`'s Last-Modified (07:30) is the edge cache's: same ETag as `/platform/index.html` (01:51). GitHub's newest deployment record is still the Preview of `1b9b573` (2026-10-15) | No discrepancy beyond item 125. Nothing deployed or promoted |
| 128 | Console dashboard on the live database | Live's dashboard function is the older 3w one: no `customers` counts, so every Customers tile showed **0** (All customers, Trials, Expired…) whatever the shops. Its plan-state counts were there under `subscriptions`. (Checked alongside: live's older permissions list has every permission the console's pages use except Suspend/Restore/End sign-ins, whose buttons the console already hides; the client's lock decision uses only `state`, `access_until`, `plan_code`, all in live's 3t status, and re-asks on reconnect, focus, every 10 min and "Check again".) | Fixed locally — `src/domain/platform/console.js` `dashboardTiles`: on the older shape the Customers tiles use its counts (Active, Trials incl. ending, Expired, Suspended, payment failures), and none it didn't count. Unit `platform-console` +1 (passing). Build `hangtag-da7bfdbfc7`. **Not deployed** |
| 129 | Correcting existing trials | The console's Extend counts from the trial's end or now, so many owed shops mean many clicks and a rounded day | Prepared (not run): `supabase/operations/2026-10-18-trial-corrections.sql`, one statement: each "owed" shop (the audit's part 8 rule) ends exactly 30 days after it started; never shortens; skips paid, AutoPay, suspended, 0-day (reused email), past-30; only for an active super-admin actor; audited as `customer.extend` (via SQL); idempotent. Rehearsed on a live-like copy (7 checks) |
| 130 | Network-layer entries (item 119), finished | The fetch layer writes a failed connection or a server error on every attempt, and other periodic calls run in between (the plan check every 10 minutes, a token refresh, uploads), so the proposed "consecutive only" merge would still miss most repeats | Fixed locally — `src/shared/logging/diagnostics.js`: a `connection-failed` or `server-error` entry merges with its latest identical entry (same message, status and code) within 11 minutes (just over the plan check's 10), wherever it is in the history: counted, moved to the end, keeping when it first happened (`first`); a 500 never folds into a 503; everything else keeps the one-minute rule. The history says "since …" (`diagnostics-view.js`). Test `diagnostics-events` (+5): 3 hours, 300 failed calls (the catch-up at 1, 2, 4 and every 5 minutes, the plan check, a token refresh every 30 s, a table's 503s and a 500): all 20 earlier entries kept, one entry per call with its count and first time, 25 of 50 entries, in time order; a repeat after 11 minutes is a new entry; slow calls and other events unchanged. Simulation with the real catch-up and network layer: 3 h, 37 checks, 22/50 entries, 20/20 earlier kept (before: 8 lost). Build `hangtag-4617c53586`. **Not deployed** |
| 131 | Trial corrections, precise | Given no list, the corrections (129) changed every shop the audit called "owed": close to a blanket extension | Changed — `operations/2026-10-18-trial-corrections.sql` changes only the account IDs it lists (none listed: nothing), and a listed shop that isn't owed is left alone; `checks/2026-10-18-trial-audit.sql` part 9 gives the owed shops as a list to review and paste. Rehearsed on a live-like copy: corrections 9 checks, audit 22 |
| 132 | Console administration on live | The first super admin needed SQL typed by hand; Suspend, Restore and End all sign-ins are refused on live for every role by the older permissions function (3w) | Prepared, not run: `checks/2026-10-18-console-access.sql` (read-only pre-check), `operations/2026-10-18-first-super-admin.sql` (only while no active super admin exists, only for a real account), `operations/2026-10-18-console-permissions.sql` (the current permissions function only, byte for byte from `schema.sql`: adds `customers.suspend` and `customers.sessions` to super_admin and admin, `customers.sessions` to support_admin, removes nothing) and its undo (the live body). Rehearsed with the files as written on a live-like copy (12 checks). Applying the permissions file moves the 13 Oct baseline to 17 older functions (RELEASE §2a item 3) |
| 133 | The repair evidence's script hash | RELEASE §2a named the sha256 of a Windows checkout of `schema.sql` (CRLF, 819,383 bytes); the repository's own bytes (LF, 809,397) hash differently, so a check against a GitHub copy would fail | Corrected: §2a and §3 name both, the repository's (`fde12118…`) as the reference; the file is unchanged from `ee76f74` to `1b9b573` |
| 134 | A release-blocker review (10-18) | A four-area review workflow was started; the session ended before any reviewer finished | No findings. Not resumed (the owner's instruction: no new audits) |

### Test results (run, not assumed)
- Focused: `node tests/unit/sync-diagnostics-noise.test.mjs` 19/19; `sync-catch-up` 39, `sync-overlap` 15, `access` 61,
  `diagnostics` 14, `diagnostics-events`, `sync-backup-events` 68, all passing; browser: `team-devices` 63,
  `sync-catch-up` 12, `open-policies-incident` 11, `diagnostics` 16, `network-isolation` 16, `platform-console` 55,
  `subscription` 70, all passing, 0 violations.
- `npm run check`: clean (427 modules, 0 rule violations, 0 cycles, lint 0/0). `npm run build`: `sw.js` cache
  `hangtag-1803427d85`, the tree unchanged by it.
- `npm test` on this tree: **175/175 files** (6,370 checks: 2,796 unit and eval, 1,525 database, 2,049 browser), then
  **30/30 database files on PostgreSQL 17** (1,525 checks); none failed, timed out or skipped. 58 browser files: 11,370
  requests answered by the tests, 274 refused at name resolution, **0 violations**.
- Two earlier full runs (10-16 and 10-18) were stopped when the session ended (125 and 162 files passed, none failed);
  the run above is the complete one.
- Simulated, not real: realtime (the handler is called directly; the socket is refused) and the browser's online/offline
  events (dispatched by the test). Real Supabase realtime reconnection remains unverified.
- After items 128–132 (10-18, later), focused runs only (the owner asked not to rerun the suite): `diagnostics-events`
  (incl. +5), `diagnostics` 14/14, `sync-diagnostics-noise`, `observability`, `platform-console` (incl. +1), all passing;
  the noise simulation (item 130); the live-like rehearsals (trial audit 22, corrections 9, console files 12), all passing.
  `npm run build`: `hangtag-4617c53586`, lint 0/0. **The full suite has not been rerun on these changes.**

## 2026-10-15 (tenth session: owner devices catch up; downloads never lose what landed meanwhile)

The owner's brief: push `bf9cf63` once reviewed; finish the approved owner-device catch-up (realtime re-join, back
online, back on screen, a bounded 5-minute look, one check at a time, nothing lost or doubled), prove it in an isolated
two-device browser test that fails on the old code; then the release audit (sync, tenancy, transactions, payments,
extraction, import), the repair's readiness and a Preview checklist. No production change, no SQL on the live database.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 109 | `bf9cf63` | Docs only (item 104's auth-log evidence, RELEASE §2a, the plan-billing remediation plan); no secret, token, id or log payload | **Pushed** (`73d232f..bf9cf63`). Preview `hangtag-npsalkwg6-florixtechnologies-projects.vercel.app` (deployment 7083454069, success). Production is still `ee76f74` (7059827088) |
| 110 | An owner's device after a gap | **Confirmed.** A device whose realtime dropped, or that was offline, asleep or in the background, never fetched what the other devices did meanwhile: "online" only uploaded. Shown on the old code: B offline while A sold two bills, took a return and stocked in; 20 s after B came back it had none of it (Kurta stock 50 against 54) | Fixed: `catch-up-core.js` / `catch-up.js`. The team phone's change check (fingerprints, then only the parts that moved) on a re-join after a drop, back online, back on screen after 30 s away (hidden, frozen, back/forward cache), and every 5 minutes on screen; never for the first connection; one at a time (one more after it when a reason comes meanwhile); own work up first (waited for at most 30 s); a check stuck 2 minutes no longer blocks the next; every listener and timer removable. Tests: `tests/unit/sync-catch-up.test.mjs` (33), `tests/e2e/sync-catch-up.test.mjs` (12) |
| 111 | A failed download counted as up to date | **Confirmed.** The products' download swallowed its error, so the change check marked the products current and never asked again (team phones too); a full download whose products failed still said "Everything is up to date"; a check that failed advanced the 5-minute look | Fixed: a failed part keeps its old fingerprint and the check fails; the catch-up counts only a check that got everything, and one that failed is owed and tried again a minute later. Tests: `sync-overlap` (4), `sync-catch-up` (+8) |
| 112 | A download replacing what landed while it was on its way | **Confirmed** (each case fails on the old code): a stock move or return uploaded during the download disappeared here until the next one (stock wrong); so did another device's move, bill or cancel brought by realtime meanwhile; of two downloads at once, the one that began first could replace what the later one brought; a price list deleted here came back while its delete was waiting or going up | Fixed: `sync-ledger.js`. Uploads the cloud took and realtime changes applied are noted in order; each download keeps this device's copy of anything noted after it began, and never replaces what a later download of the same part brought. Kept only until a download that began after it. Test: `tests/unit/sync-overlap.test.mjs` (15) |
| 113 | A restored bill cancelled again | **Confirmed** on the old code: a bill restored here (un-cancelled) showed cancelled again after a download read the cloud before the restore landed, or while it waited offline (its stock off by the bill) | Fixed in the same ledger. Test: `sync-overlap` (+2) |
| 114 | Two returns of one bill line at the same moment | **Hypothesis, from the code; not reproduced** (the test databases are single-connection PGlite). `hangtag_check_return_qty` reads the bought and already-returned quantities without a lock; two transactions in flight at once could each miss the other's return. One after the other is refused (report row 14; `cloud-roundtrip` returns the same last piece on two devices) | **Blocked (item 141).** Open, medium. Fix: lock the bill line (`SELECT … FOR UPDATE` on `hangtag_sale_items`) before the sum; needs a schema section, a multi-connection test, and the live repair (blocked) **→ Fix in the post-repair migration: item 148 (the concurrent proof needs a real PostgreSQL).** |
| 115 | `hangtag_shop_changes` on live | **Current.** Its body matches `schema.sql` (the read-only catalog comparison of 10-13/14), and nothing has changed the live functions since: the database's own logs show statements for the 10-13 schema run (16) and containment (4), then only two read-only check scripts (10-14 06:32 and 06:38 UTC), none since (to 10-15 13:00 UTC). `hangtag_biz_changes` on live is the older 3r version: changes to the shop's own fields and units aren't noticed by the change check until the repair | No SQL run. The catch-up relies on it |
| 116 | Reviewed, no defect | Customer payments: the webhook checks the signature over the raw body (constant time) before parsing, takes amounts from the stored intent, changes an intent once (a repeat is a no-op; the update is conditioned on the status it read); the app can only read intents. Bill extraction: review before anything is saved, Confirm separate, a repeated supplier invoice refused, "isn't set up yet" with manual entry when the function has no key. Bills: a re-sent bill, its lines and payments update in place (`ON CONFLICT`), never doubled | — |

### Test results (run, not assumed)
- `npm test` on the committed code: **174/174 files** (6,345 checks: 2,771 unit and eval, 1,525 database, 2,049 browser),
  then **30/30 database files on PostgreSQL 17** (1,525 checks); none failed, timed out or skipped. `npm run check` and
  `npm run build` clean (425 modules, 0 rule violations, 0 cycles, lint 0/0, `sw.js` cache `hangtag-8b251d57e8`); the
  build leaves the tree unchanged. 58 browser files: 11,348 requests answered by the tests, 275 refused at name
  resolution, **0 violations** (the refused ones include the live project's realtime socket).
- Production untouched (read-only, end of session): Edge Functions the same 9, none updated since 2026-10-07, no
  `subscription`/`subscription-webhook`; Vercel Production `ee76f74`; no SQL run on the live database.
- `tests/e2e/sync-catch-up.test.mjs`, three runs in a row: B shows A's bills, return and stock **0.1 s** after coming
  back online; with its own offline bill and stock count waiting, both ways in **0.1–0.3 s**; each bill and the return
  once on both devices; the same stock on both. On the old code it failed: nothing after 20 s.
- `tests/unit/sync-overlap.test.mjs` on the old code (`bf9cf63`, in a throwaway worktree): 13 of 15 fail.

### Not done / next
- Item 114 (the return race) and item 108's plan-billing work need schema sections; the repair stays blocked (backup).
- The audit's four parallel reviewers hit the session's usage limit before starting; the review above was done inline.
- Residual sync risks (by design, measured): an owner device whose realtime never joins at all catches up only every
  5 minutes; a download that hangs is not cancelled (the catch-up stops waiting after 2 minutes); the 5-minute look is
  one small query per owner device on screen.

## 2026-10-14 (ninth session: the diagnostics fix pushed; the tests cut off from the live project)

The owner's brief: push `2827a20` once checked; make the browser tests unable to reach the live project (fail closed, with
regression tests, never running browser tests against it while doing so); a Preview of the diagnostics change; the
remaining diagnostics, the historical kept apart from the current. No production change.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 100 | `2827a20` | Its diff is the diagnostics (3 files), `sw.js`'s cache name, AUDIT.md and the described tests. Every operation the diagnostics keep is a literal app table name (4 × `table:hangtag_meta`, and `sbFetchAll`'s literal tables), and only `table:`/`rpc:` + `hangtag_` + letters is kept | **Pushed** (`40cf202..2827a20`, 16:29 UTC). Preview `hangtag-7v182xuei-florixtechnologies-projects.vercel.app` (Vercel: success). Not yet tested in the Preview: the owner signs in |
| 101 | Browser tests reached the live project | **Confirmed.** Realtime WebSockets from every owner-mode test (request interception never sees them), and HTTP from five files that passed Supabase requests through: `accounts-isolation`, `offline-queue-sw`, `signin-tabs`, `shop-setup-settings`, `google-signin` (auth settings, profiles, sign-in methods, the status check, Edge Functions, the Google sign-in redirect, and one deliberate fetch of the auth settings) | Fixed: `tests/helpers/isolation.cjs` (`tests/README.md`, "Network isolation"). The five answer or refuse every Supabase request themselves. The Google check now checks the app's part (the sign-in address it sends the browser to); the service-worker check uses another origin on this computer. Tests: `tests/unit/test-isolation.test.mjs`, `tests/e2e/network-isolation.test.mjs` |
| 102 | The proposed `MAP *.supabase.co 127.0.0.1` | Not enough. It sends those names to this computer (anything listening on 443 here would answer) instead of refusing them; it leaves every other host open (`supabase.co` itself, `supabase.com`, payment providers, IP literals); and a proxy resolves names itself, past the rule | Used instead: no name resolves except this computer and three static hosts (`MAP * ~NOTFOUND` + 6 `EXCLUDE`, IP literals included), `--no-proxy-server`, and the tripwire. This computer has no proxy |
| 103 | `fn:subscription` | **Current.** Still not deployed: 9 functions are live, neither `subscription` nor `subscription-webhook`; the preflight answers 404 (15:36 UTC). In Chrome (isolated, preflight answered 404 as live): the call never leaves, "connection failed (fn:subscription)" is noted as a warning, and Plans & Billing still shows the plan, the trial and the prices, with "Online payment isn't set up yet. Contact Hangtag support to choose a plan." | Left undeployed: the owner's word, after reviewing the function |
| 104 | `auth:token` ×6 | **Historical; none of the six reached Supabase** (read-only log queries, 2026-10-15, counts and status codes only). In 15:30–18:30 UTC on 10-13 the API gateway saw 3 refresh POSTs: 16:20:55, 17:21:24 and 18:21:21 UTC (21:50:55, 22:51:24, 23:51:21 IST). All three were 200, with no refresh-token reuse; Auth logged them 200 in about 0.3 s, with no error or warning; the audit log has 3 `token_refreshed` and 3 `token_revoked` (rotation). Over the 24 h the report covers, 22 token POSTs reached the gateway (18 refresh, 4 PKCE), all 200. So the six failed before reaching Supabase (the device's network, sleep, or a request the browser stopped). Which of these is **not established**: the report's own times are still needed. Also seen: the earlier, un-isolated test runs (headless Chrome) reached the live project at 16:00–16:20 and 18:20 UTC, realtime included (item 101) | Needs the owner: "Download report" in the browser that recorded them; then each failure's time can be set against the gateway's quiet minutes |
| 106 | The isolation, under test configuration | **Confirmed gaps, closed.** Before pushing `b107b32`, these were found: a browser context with its own proxy (through puppeteer or the protocol); a proxy on this computer, which is allowed, then resolves names itself; a wrapper given as the browser could drop the rules, because only the spawn arguments were checked; spellings Chrome reads but the check didn't (`/proxy-server`, any case); a machine policy forcing a proxy past `--no-proxy-server`; `puppeteer.connect` to a browser the guard never configured; Node processes started by a test | Closed in a third commit: each refused, and tested in `tests/unit/test-isolation.test.mjs` (+5) and `tests/e2e/network-isolation.test.mjs` (+4). Not prevented: a bypass written on purpose (a hand-made DevTools connection, another program); a network answer still fails the file |
| 107 | The isolation, reviewed again (red team of four) | Every way through test configuration is closed. Found and fixed: the static "no connect" check flagged the isolation test itself; `iframe` added to the watched targets (a later review found puppeteer 25 reports iframe targets as `other`, already watched: no gap there); a worker thread from code (eval) runs its code before an `--import` loads, so it wasn't guarded, through the runner or not; a file run on its own didn't pass the guard to its Node processes. Confirmed: a host given by its IP address is refused (192.0.2.1, reserved, by HTTP and WebSocket). Not prevented: code written to get around it (raw UDP or DNS, internal socket bindings, a scrubbed child, another program, WebRTC to an IP, a hand-made DevTools connection) | Fixed in a fourth commit. Tests: `test-isolation` (15), `network-isolation` (16) |
| 108 | `subscription` and `subscription-webhook`, reviewed (not deployed) | Authentication and authorization are sound: the shop always comes from the token, owner-only actions are enforced in the database, the database sets every amount, and the webhook's signature check is correct (HMAC-SHA256 of the raw body, constant time, before parsing). Before they go live: **high:** AutoPay can start before the webhook can record charges (monthly charges with no paid time added). **Medium:** a failed lookup in the webhook is acknowledged instead of retried; a halted mandate is forgotten when AutoPay is set up again; Razorpay test keys are accepted on the one shared project; `autopay_enabled` has no readiness interlock; direct calls to the checkout RPC can tie up a capped offer. **Low:** event order and replays; promo-code probing; `verify_jwt` not pinned in a `config.toml`; `deploy.json` under-declares the webhook's secrets; consent recorded before the plan check; a suspended shop can pay; no throttle on Razorpay calls; CORS `*` | Left undeployed (owner's word). Full findings and the before-deploying list: the review of 2026-10-15 |
| 105 | Slow calls: the page's time or the network's? | **Still a hypothesis** (item 97). To settle it, a slow call now carries the network's own time as the browser measured it (Resource Timing through a PerformanceObserver, as the 250-entry buffer fills with the app's own files), as a band, and "page hidden" when the page was hidden at any time during the call; a failed connection carries "page hidden" too. Matched in memory by operation and start time; only names, bands and a flag are kept. In Chrome: a page busy 3.5 s with a quick answer gives "slow call (…) · 3–10 s · network under 1 s"; a 3.5 s answer "· network 3–10 s"; a hidden page "· page hidden". Review (no privacy issue) found and a fifth commit fixed: two calls of one operation within 100 ms could take each other's network time (now: the closest timing, used once, and none when two started together); a call waiting at unload was lost (now noted at `pagehide`; the wait is 3 s, not 10); the entry was stamped when the timing came, not the answer (now the answer's time); a failing timing could turn an answer into an error (now the notes can't touch the call) | Not deployed to Production. Tests: `tests/unit/diagnostics-events.test.mjs` (+9), `tests/e2e/slow-call-timing.test.mjs` (new) |

### Test results (run, not assumed)
- With every test isolated: `npm test` **170/170 files**, then **30/30 database files on PostgreSQL 17**; `npm run check` clean
  (`b107b32`). With the instrumentation (item 105): **171/171**, then **30/30**; 57 browser files, 10,367 requests answered
  by the tests, 266 refused at name resolution, 0 violations; `npm run check` clean, `sw.js` cache `hangtag-9b4a5bcb7d`.
- The first isolated run failed 5 browser files on their requests to the live project (item 101), 4 of them with every
  check passing; after their fix, all pass. The tripwire is itself tested: a test-only name mapped to this computer is
  caught (HTTP and WebSocket); a public host and the live project's REST, Auth, Functions, Storage and realtime addresses
  are refused at name resolution — checked in that order, the live addresses only after the public host was refused.
- No browser test ran against the live project while this was built.

## 2026-10-14 (eighth session: the remaining production errors, diagnosed)

The owner's brief: find the cause of each remaining code in the report printed 2026-10-14 13:45 IST (`PGRST116`,
`PGRST205`, `auth:token`, `fn:subscription`, slow status checks), reproduce, fix only app bugs, and change nothing in
production. Read-only on live: the catalog, `pg_stat_statements`, the schema cache, the backup list. All 20 entries that
print lists are dated 2026-10-13; nothing new was recorded on 10-14.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 94 | `PGRST116` ×5 (20:49–21:00 IST, 10-13) | **Confirmed, historical.** The settings read (`maybeSingle`, no shop filter: row security scopes it) got one row per shop while the six open policies stood (item 76). supabase-js 2.117.2 makes `PGRST116` itself after the server's 200 (item 76 said PostgREST: corrected). The app's single-row reads are right: three `maybeSingle` (settings, logo, profile by id), no `.single()`. The old diagnostics kept only the code, so "settings, not logo" is inferred from code order. Live now: 1 `settings` and 1 `logo` row per shop | Fixed (diagnostics only): a database event names its table, "more than one row (table:hangtag_meta)", kept only in the app's own shape (`table:`/`rpc:` + a `hangtag_` name of letters). Tests: `tests/unit/diagnostics-events.test.mjs` (+4), `tests/e2e/open-policies-incident.test.mjs` (new: the incident and its containment end to end) |
| 95 | `PGRST205` "database update needed ×4" (10:41, 14:16, 20:09) | **Confirmed, historical.** `fetchBiz` reads `hangtag_attributes` and `hangtag_units` (section 3z) on every full download; 3z reached live at 20:39:56. Two tables × two downloads within a minute = ×4. Live now: all 43 tables the app names are in the schema cache | Same fix: the next one says which table. Trade-off: two missing tables now make two entries per download, not one merged |
| 96 | `auth:token` "connection failed" ×6 (21:01–midnight IST, 10-13) | **Cause not established.** "Connection failed" means no answer reached the page (an answer the browser blocked looks the same); 20 of 26 refreshes that day succeeded; none failed on 10-14. Needs: the report's download (each entry's time) and the dashboard's Auth logs (`auth.audit_log_entries` is empty on this project) | No app defect: `tests/e2e/session-refresh.test.mjs` (new) drops two refreshes: supabase-js retries, the app stays signed in, both drops noted, no token in diagnostics; signing out clears the session and no refresh follows (a tick that refreshes a present session passes) |
| 97 | `fn:subscription`; slow `rpc:hangtag_subscription_status` | `subscription` still isn't deployed (preflight 404, 13:57 IST): item 80. Database time of the status check: 664 calls since 2026-09-23, mean 18.3 ms, max 83.9 ms. The max was the same at 21:22 IST on 10-13, so the slow calls after it (up to 5.2 s) weren't slow in the database. Locally, calls made while the app starts are recorded at ~10× their network time (124 vs 12 ms). That this explains 1–5 s in production is a **hypothesis** | No change. Proposed: record the network time (Resource Timing, through a PerformanceObserver: the default buffer of 250 fills with the app's own files) and whether the page was hidden |
| 98 | Tests: realtime goes to the live project | **Confirmed (pre-existing).** Owner-mode browser tests open a realtime WebSocket to the live project: Puppeteer's interception doesn't cover WebSockets (seen with the host mapped to 127.0.0.1: 3 attempts in 4 s). The stand-in's token is unsigned, so the live service should refuse it (not observed) | Not changed (every browser test; needs the owner's word). Proposed: launch test browsers with `--host-resolver-rules=MAP *.supabase.co 127.0.0.1` |
| 99 | The database repair (item 91) | **Blocked: no verified backup.** 0 physical backups and PITR off (re-checked 2026-10-14 08:38 UTC) | Not run. First the owner's own `pg_dump` (or a plan with backups), verified by a restore |

### Test results (run, not assumed)
- `npm test`: **168/168 files passed** (unit, database, eval, browser), then **30/30 database files on PostgreSQL 17**;
  `npm run check`: clean, `sw.js` cache `hangtag-f075904626`.
- The new checks of the fix fail on the code before it: the op label and kind (2 unit, 2 browser checks), the op guard
  (1 unit check). The two new browser tests' weak
  checks found by review were made real: the server's 200 with 2 rows is observed; B's bill is shown to arrive before its
  removal is checked; with sign-out skipped, the "no refresh after sign-out" check fails (4 refreshes).
- Nothing was verified on a Preview or on the live project: this is not pushed.

## 2026-10-13 (seventh session: the Diagnostics & Health report — reliability before features)

The owner's brief: stop the Cashfree work and all new features; start from the latest Diagnostics & Health report
(printed 21:01 IST, app build `hangtag-80042738a2` = `acee306`, a Preview); find the real causes in code, configuration
and deployed state; no production change without the owner's word.

The paused work (Cashfree sandbox plan payments, the shop's own UPI QR picture) is on the local branch
`paused/cashfree-sandbox` (`e62d23c`), not pushed. `ux-productization` went back to `acee306`.

### How the deployed state was read (read-only)
- `npm run preflight:live`: functions, their JWT setting and secret names (names only).
- Public REST probes with the publishable key: zero rows asked, no function run.
- `supabase db query --linked`: function bodies as MD5 fingerprints, columns, triggers, policies, indexes, constraints,
  and `pg_stat_statements`. No table row was read. The CLI's connection creates `cli_login_postgres` (21:16 IST).
- `supabase migration list --linked`: the live migration history.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 76 | "Pull from Supabase failed", "Pull settings failed" (5 from 20:49) | **Confirmed.** At 20:44:53 IST the first migration (`20260923102731`) ran again on the live project and put back its six "Public access to …" policies (`USING (true) WITH CHECK (true)`) on `hangtag_meta`, `_sales`, `_sale_items`, `_products`, `_images`, `_sizes`. Policies are OR-ed, so the app's single-row reads of the shop's `settings` and `logo` get one row per shop: the server answers 200 with them all and supabase-js refuses them itself (`PGRST116`; corrected 2026-10-14, item 94), the app reports UNKNOWN, and every download stops at the settings | Repository: the first migration no longer makes those policies on a database that keeps shops apart; report row 96 counts tables open to everyone. Test: `supabase/tests/live-recovery.test.mjs`. **Live: needs the owner** (`RELEASE.md` §0a: six `DROP POLICY` lines, then the whole `schema.sql`) |
| 77 | Security: every shop's rows open to every account | **Confirmed, critical.** Since 20:44 IST any signed-in account can read and change every shop's settings, bills, bill lines, products, pictures and sizes. Realtime also delivers other shops' new bills and products to every connected device; `onRemoteSaleEvent` adds a bill without checking its shop. Devices replace their copy at the next full download, which today stops at the settings (item 76) | **Live: needs the owner** (as item 76). The app's own check of the shop on live events: proposed, not made (not the cause; a wrong shop check would hide a team member's own bills) |
| 78 | 18 functions in older versions | **Confirmed.** After the whole `schema.sql` (20:39:56) the section files ran newest-first (3za … 3r). Each older file put its older functions back: `hangtag_save_sales` (3r: no 3y cancel guard), `hangtag_import_stock` (3z: no 3za locks), the subscription functions (3t instead of 3w), `hangtag_mobile_catalog` (3r: the store doesn't close when a plan ends; no 3z units), the console dashboard (3w). Rebuilt that way on PGlite, all 162 live functions match byte for byte | **Live: needs the owner:** the whole `schema.sql` once. Rehearsed in `live-recovery.test.mjs`: every function current again, no open table, report all 83 ok, **every shop row unchanged** |
| 79 | "database update needed ×4" (10:41, 14:16, 20:09) | **Confirmed.** Sections 3y, 3z and 3za first reached the live database at 20:39:56 (statement statistics); before that the `acee306` app asked for their tables and functions | Their tables exist now; what is left is item 78 |
| 80 | `fn:subscription` "connection failed" | **Confirmed.** `subscription` (and `subscription-webhook`) aren't deployed. Supabase answers the browser's preflight with 404 and doesn't allow `content-type`, so the browser reports a network failure. Only when the owner opens Plans & Billing; the app then shows online payment as not available | No code change. Owner's choice: deploy `subscription` (it answers "not set up" without payment keys), or leave it until subscriptions go live |
| 81 | Bill reading `NOT_CONFIGURED` | **Confirmed.** The live project has no `ANTHROPIC_API_KEY` secret, and `extract-bill` (v1, 2026-10-02) predates its fixes of 10-10 | No code change and no other provider. **Owner:** the key (`RELEASE.md` §4), then redeploy `extract-bill` |
| 82 | Slow calls (`hangtag_subscription_status` 786 ms, `hangtag_profiles` 715 ms, `auth:token` 845 ms) | **Not the database or the network.** Inside the database `hangtag_subscription_status` takes 18 ms on average (589 calls since 2026-09-23, max 84 ms); profile reads 1–2.5 ms, the last-seen update 4 ms. The project is in ap-south-1 (Mumbai); from this computer a TCP connection takes ~20 ms and a whole request 0.07–0.23 s. 76 status checks a day is the design (on connect, back on screen, every 10 minutes). **Hypothesis:** the app's timer counts until its own thread takes the answer, and these calls run when the app starts or comes back | No change. Measuring the network time alone (Resource Timing) would settle it |
| 83 | Diagnostics: "erro[amount]js:20" | **Confirmed.** The amount filter took "rs." (of errors.js) for rupees: any "rs." or "inr." inside a word was mangled | Fixed: ₹, or Rs / INR starting a word, then a number. Test: `tests/unit/diagnostics.test.mjs` |
| 84 | Diagnostics: "Problem · error" with no code | **Confirmed.** The panel showed an entry's code and HTTP status only when it had a source file. Database events have none, so the five errors hid `PGRST116` | Fixed: code and status shown for every entry. Test: `tests/unit/diagnostics.test.mjs` |
| 85 | The line-number migration of 2026-09-23 | Run again on a current database, it would number every bill's lines anew by their random ids (and bring back an index across shops). It ran once, on 2026-09-23 (statistics), not on 10-13 | Guarded: it changes nothing once the per-shop line key exists. Test: `live-recovery.test.mjs` |
| 86 | `RELEASE.md` | It told the owner to run the section files. That way can't remove the six policies (only `schema.sql`'s last part does), and it said the Phase 1 design was unapplied: the live migration history shows it applied on 2026-09-25 | Rewritten: the whole `schema.sql`, never older files; §0a with today's state and the containment |
| 87 | The live database's load | Supabase Realtime's change polling is 96% of the database's execution time (1.34 million calls since 2026-09-23). The app listens to about 25 tables | Observation only. It slows nothing measurable today (item 82) |

Not done (each needs the owner's word): the six `DROP POLICY` lines and the whole `schema.sql` on the live project;
the functions' redeploys and secrets (`npm run preflight:live`: 11 of 11 need something); a push for a Preview of these
fixes. A Preview uses the live database, so the database part can only be seen there after the owner's run.

### Later the same night: containment (on the owner's word) and the repair, prepared
| # | Area | Finding | Status |
|---|------|---------|--------|
| 88 | The six open tables (item 77), before acting | Every intended shop policy on them was present and identical to `schema.sql` (24 of 24: read, add, change and delete on all six); the six "Public access" ones were the only always-true policies in the whole database; signed-out users had no privileges on those tables, signed-in users all four. As two real shops' owners (counts only, no id printed): A saw 103 other products, 49 bills, 121 bill lines, 17 settings rows; B likewise | Containment safe: dropping the six leaves the designed state |
| 89 | Containment, 2026-10-13 23:45:55 IST | Six `DROP POLICY IF EXISTS` in one transaction (`RELEASE.md` §0a). Verified on live: 24 shop policies left, identical to `schema.sql`; no always-true policy anywhere; as both owners, 0 rows of other shops visible in all six tables, changing or deleting the other's rows reached 0 rows, adding a row as the other was refused by row security, own changes worked (every write rolled back); 1 `settings` and 1 `logo` row each; 401 signed out | **Done.** Not yet seen in the app: a device's next full sync (after the push) |
| 90 | Other ways in | Views (Phase 1's two) are `security_invoker`; the one Storage bucket (`hangtag-bills`) is private and per-shop-folder; no public table without row security is granted; the app uses Realtime only for database changes, which Realtime checks against each subscriber's row security (`realtime.apply_rls`, present). No live subscription at the time to observe | No other exposure found. Realtime's own delivery was not observed live (no connected device) |
| 92 | The pushed commits and their Preview (2026-10-14) | `origin/ux-productization` = `ee76f74` (pushed by the owner); Vercel built Preview `hangtag-axut0xoup-florixtechnologies-projects.vercel.app` (GitHub status "Vercel: success", 06:26 UTC). The app inside it was **not** opened here: the browser extension wasn't connected and signing in to the owner's account is the owner's step. Instead, as two real owners at the database: a full sync's reads over all 61 shop tables return 0 rows of other shops (A 704 own rows, B 234); 10 tables refuse direct reads by design (42501, as `schema.sql` grants) | The in-app checks (build `hangtag-45f5fb3c06`, "Last full sync", the codes in Diagnostics) wait for the owner's browser |
| 93 | The repair's preflight (2026-10-14, read-only) | Live database identified (ref, PostgreSQL 17.6, system identifier); dry run all 0; catalog unchanged since containment; migration history unchanged; data fingerprint 61 tables / 4,205 rows; **no platform backup** (0 physical backups, PITR off); the Management API takes the 819 KB script | Ready for the owner's decision. Undo captured and rehearsed: `supabase/checks/2026-10-13-repair-undo.sql`; two more checks: `data-fingerprint.sql`, `sync-read-isolation.sql` (all under test in `live-recovery.test.mjs`) |
| 91 | The repair (item 78), prepared | Object-by-object comparison after containment: only the 18 function bodies and 3 redundant indexes differ (grants, columns, defaults, triggers, policies identical); older harmless drift stays (owner FK names, a CHECK's printing, a fee check covered by the shape check). `schema.sql`'s 26 data changes, counted on live: **0 rows each**. It has no transaction control or non-transactional statement, so an explicit `BEGIN … COMMIT` makes it all-or-nothing | Prepared, **not run**: `RELEASE.md` §3 and four checks in `supabase/checks/` (each under test in `live-recovery.test.mjs`). Needs the owner's word |

### Test results (run, not assumed)
- `npm test`: **166/166 files passed** (unit, database, eval, browser), then **30/30 database files on PostgreSQL 17.5**.
- New: `supabase/tests/live-recovery.test.mjs` (21 checks, on both versions). Changed: `tests/unit/diagnostics.test.mjs`
  (+2 checks; both fail on the code before the fix).
- `npm run check`: clean, `sw.js` cache `hangtag-45f5fb3c06`.
- Nothing was verified on a Preview or on the live project after the fixes: neither has them yet.

## 2026-10-12 (sixth session: the roadmap, release fixes for stock and units, function sign-in)

The owner's brief:
- **Part A:** production readiness first.
- **Part B:** universal products and inventory.
- **Part C:** products and services, with a laptop repair as the first scenario.

`PLAN.md` now holds all three. `RELEASE.md` is the owner's runbook for the live project.

### State at the start
- `ux-productization` had 12 local commits (`1eb8788` … `db47975`).
- The owner said "push the current work".
- Local `main` (1 ahead, `4e4b215`, already in this branch) was left alone: it deploys to GitHub Pages.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 63 | Pushing the local commits (A2) | The 87 files and 4,936 added lines were reviewed before pushing:<br>- no keys or tokens, only placeholders such as `<key>` and `sk-ant-…`;<br>- `.env.local`, the Google client secret and `supabase/.temp/` are git-ignored and untracked;<br>- `config.js` has only the URL and the publishable key;<br>- no logs or build output | Pushed `f090c70..db47975` to `ux-productization` (not `main`). Vercel built the Preview (status "success") |
| 64 | A product's unit (items 52, 58) | — | Fixed `7a372f9` (I1):<br>- the unit is pinned once the product has stock records, bills, an open order or an open purchase order, and the editor locks "Sold by" with the reason;<br>- a changed count with more decimals than its unit is refused in the stock box, Stock in, Adjust and batch counts, never rounded;<br>- an unchanged 12.5 pieces from before is no change.<br>Tests: `unit-safety` 24, `units-weighing` (browser) +1 |
| 65 | Repack (item 60) | — | Fixed `451ded6` (I20):<br>- the output is q × per exactly; one the target's unit can't hold is refused, with the nearest amounts in stock that fit;<br>- per is kept to 3 decimals, as the database keeps it.<br>Tests: +5, including a sweep of 3,240 plans: every one accepted fits `hangtag_repacks_qty_check`, and every suggestion is accepted |
| 66 | Supplier bills in boxes (item 59) | — | Fixed `93308e2` (I19):<br>- the review keeps the bill's unit; a line in another unit than its product's needs the base quantity, and the plan refuses it until that is entered;<br>- stock is the base quantity at the cost spread over it, while the purchase keeps the bill's own quantity and cost, so its money stays exact;<br>- one new product, one unit.<br>Tests: `bill-import` unit suite +8, browser +5 (a "5 box" bill end to end) |
| 67 | Races and the database's own guards (items 53, 54, 58; 52 at the database) | — | Fixed `ea09567`, section 3za (migration `20261013120000_hangtag_stock_guards.sql`):<br>- a new serial's insert takes a row only from a write-off, and is refused when another device's insert won;<br>- supplier bills lock on their file and invoice number before the duplicate check, and keep field values;<br>- products and variants keep a database-maintained `updated_at`;<br>- the database refuses a unit change under history;<br>- report rows 94 and 95; `REPORT_ROWS` = 82 in one place (`supabase/tests/report-rows.mjs`).<br>Tests: `stock-guards` (20, on PostgreSQL 18 and 17). PGlite has one session, so the races are checked in the functions' text, as row 94 checks them live |
| 68 | Saved stock records (item 55, re-checked) | **Item 55 was wrong:**<br>- section 3n's `hangtag_tracking_shape` already refuses a change of a saved record's serials, batch or expiry;<br>- a serial record's quantity must equal its serial count;<br>- batch quantities are read from the records.<br>A quantity correction by the owner or a manager is allowed and logged by design, and "Combine colours" re-points records. A guard refusing every change was tried: three suites failed on exactly those designed paths, so it was not kept | Corrected. `0b60613` pins the right behaviour in `stock-guards` (+4). PLAN.md's T3 is dropped |
| 69 | `team` and `webhook-dispatch` sign-in (A5) | **The app's key is a publishable key (`sb_publishable_…`), not a JWT.** With JWT verification on, as on the live project, the gateway refuses both before they run:<br>- a phone redeeming a team QR (it has no session yet);<br>- the scheduler calling the dispatcher with its secret.<br>Both are designed for `--no-verify-jwt` and check callers themselves. `team` lets only `enroll_redeem` run without a session; its single-use, expiring token is marked used in one conditional update. Every other action needs `getUser()`, and managing the team also needs `hangtag_role()` = owner. `webhook-dispatch` compared its secret with a plain string comparison | `7dff39f`: both gates are explicit and tested; the dispatcher now compares in constant time and refuses everything while its secret is unset. Live redeploy with `--no-verify-jwt`: owner (`RELEASE.md` §5). Not tested against deployed functions: deploying is the owner's step, and nothing was sent to the live project |
| 70 | A browser suite crashed once in a full run | `business-capabilities`: "Node is detached from document". Home re-rendered between finding a button and clicking it | Fixed `4c6726a`: the shared click helper looks the element up again on that error only. 3 runs of 3 then passed (48 checks) |
| 71 | The Vercel Preview (A6) | Built from `db47975`. It sits behind Vercel's sign-in, the browser tools weren't connected here, and a Preview uses live data | **Not inspected.** Items 47 and 72 stand in; the owner opens it (`RELEASE.md` §1) |
| 72 | Production's app on the new database (the rollback in `RELEASE.md`) | `6af8cc2` (Vercel Production) ran its own 44 browser suites against today's `schema.sql` (3x to 3za and everything before): **43 of 44 passed.** `subscription` failed 13 checks, every one on a number section 3w changed on purpose: a 30-day trial instead of 7, a 12-month plan, new prices. The old app showed the database's new values correctly; no check failed on an error | Supports rolling the app back without the database (`RELEASE.md` §6). 3w's new defaults are what the old app shows if it is restored |
| 73 | Staging (A4) | Unchanged: no staging project, and creating one is a billing decision | **Blocked.** Planned once it exists: Previews pointed at staging through Vercel environment variables (PLAN.md R1), so testing a Preview never touches live data |
| 74 | The real Claude API (A3) | Unchanged: no key here | **Blocked.** How to set `ANTHROPIC_API_KEY` safely (an env file outside the repository, a spend limit, rotation): `RELEASE.md` §4 |
| 75 | The roadmap | Parts A–C with dependencies, acceptance criteria, risks and tests. **Services:** catalog items with no stock. **Repairs:** a job record of its own (asset, complaint, diagnosis, technician, status machine, append-only history), whose money goes through quotation → sales order → bill. The laptop scenario is mapped step by step | `PLAN.md`. A design workflow was started for Part C; its agents hit the session usage limit before returning anything, so the design was done directly from the code |

Items 56, 57, 61 and 62 stay open, in PLAN.md as I4, I10, I21, I12 and I22.

### Test results (run, not assumed)
- **Each fix:** its own suites ran before it was committed:
  - unit-safety, bill-import, commerce-batch;
  - every database suite, on both PostgreSQL versions for `stock-guards`;
  - the unit, bill-import and store browser suites.
- **Full suite on `7a372f9`** (I1, in a clean Windows checkout): **164/164** test files, then **28/28** database suites on PostgreSQL 17.5.
- **Full suite on `93308e2`** (I19): 163/164; the one failure was item 70, fixed and re-run.
- **Full suite on the final code (`0b60613`)**, in a clean Windows checkout: `npm run check` clean (`sw.js` current, `hangtag-80042738a2`, 0 architecture violations, lint 0/0). **165/165** test files (80 unit, 29 database, 4 eval, 52 browser), then **29/29** database suites on PostgreSQL 17.5.
- **Not run:**
  - the real Anthropic API;
  - a hosted staging database;
  - the deployed Edge Functions (nothing was sent to the live project);
  - the Preview itself;
  - a real phone.

### Committed
On `ux-productization` after `db47975` (pushed), all local:
- `7a372f9` I1;
- `451ded6` I20;
- `93308e2` I19;
- `ea09567` 3za;
- `7dff39f` function gates;
- `4c6726a` click helper;
- `0b60613` item 68;
- then this log, `PLAN.md` and `RELEASE.md`.

### Release blockers (each needs the owner)
1. **An Anthropic key:** for the real check and for the live secret (item 74).
2. **A staging project,** or the decision to release without one (item 73).
3. **The word to push** the commits above, for a Preview with them.
4. **The live project, in `RELEASE.md`'s order:**
   - backups;
   - sections up to 3za, with the report at 82 rows ok;
   - secrets;
   - function deploys, `team` and `webhook-dispatch` with `--no-verify-jwt`;
   - promotion.

## 2026-10-11 and 12 (fifth session: release verification, then the plan for import updates and unit conversions)

### State at the start (inspected, nothing discarded)
- `ux-productization` was clean, 7 commits ahead of `origin/ux-productization` (`f090c70`, pushed 2026-10-10): `1eb8788`, `97df853`, `ed806ad`, `b1f66cc` (third session) and `63b48d9`, `dd2216a`, `760f2e0` (fourth session). This session adds 5 more (under Committed), so 12 are local.
- Local `main` is 1 ahead of `origin/main` (`4e4b215`, Wave 2, already part of this branch's history). Other local branches and the old workflow worktrees were left as they are.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 41 | `extract-bill`, the request | Checked against the current Messages API reference:<br>- model `claude-opus-5-5`, adaptive thinking;<br>- effort set explicitly (Opus 5.5 defaults to medium);<br>- JSON through `output_config.format`, not the deprecated `output_format`;<br>- the fallback header `server-side-fallback-2026-07-01` with `fallbacks: "default"` (the matching pair);<br>- streaming with `finalMessage()`;<br>- refusals and truncation handled;<br>- the PDF block before the text | No defect |
| 42 | `extract-bill`, the real API | No Anthropic credentials on this machine: `ANTHROPIC_API_KEY` and `HANGTAG_EVAL_ANTHROPIC_KEY` unset; no Anthropic CLI or profile | **Blocked** — `HANGTAG_EVAL_ANTHROPIC_KEY=<key> npm run eval:extract-bill`, once a key is available |
| 43 | The live project's Edge Functions (read-only: the functions list and secret names through the Supabase CLI, no values) | - **No `ANTHROPIC_API_KEY` secret.** Bill reading answers 503 "Reading bills isn't set up yet" whatever version is deployed. The Agent's AI is off too; it also needs `AGENT_ALLOWED_USERS`.<br>- **Stale deploys.** `extract-bill` v1 (2026-10-02) predates its fixes (items 16–20), and every deployed function predates the 2026-10-10 changes (pinned imports and more).<br>- **Wrong JWT setting.** `team` and `webhook-dispatch` run with JWT verification, though their READMEs deploy them with `--no-verify-jwt`: a phone redeeming a team QR has no session yet, and `webhook-dispatch` checks its own secret.<br>- **Not deployed:** `subscription` and `subscription-webhook`.<br>- **No provider secrets** for payments or the webhooks (UPI is checked by hand without them) | Found. The fixes are secrets and deploys on the live project, left to the owner (release order below) |
| 44 | Release preflight | Nothing could see how a project is set up | Added — `supabase/functions/deploy.json` lists, per function, the JWT setting and the required, provider and optional secrets (names only). `npm run preflight:live` is read-only and exits 1 while anything is needed. `tests/unit/release-preflight.test.mjs` (41) keeps `deploy.json` in step with the settings the code reads. Its first live run read the CLI's epoch-millisecond times as text and so never found a stale deploy; two checks for that failed before the fix |
| 45 | Migrations on the live version | The live project runs PostgreSQL 17.6, but every database suite ran on PGlite's 18.3, so SQL only 18 has would pass and then fail live | Fixed — `npm run test:db:pg17` runs the suites on `pglite-pg17` (PGlite 0.4.6, PostgreSQL 17.5) through a resolve hook, and `npm test` runs it too. All 28 suites pass on 17.5, including 3x, 3y and 3z on the previous release's database. `postgres-versions.test.mjs` fails when the live project moves to another major version. A table defaulting to `uuidv7()` passes on 18.3 and fails on 17.5 |
| 46 | Hosted staging | The Supabase account has four projects: `hangtag` (the live one, linked), `ecommerce` (another app) and two paused ones. None is a Hangtag staging database, and there's no Docker here for a local Supabase | **Blocked** — needs a staging project (the owner's call: it may need a paid plan or pausing a project). Runbook below |
| 47 | What Vercel serves | Every browser suite loads the repository through a test page with a loosened Content-Security-Policy | Added — `tests/e2e/vercel-site.test.mjs` (15) serves `dist/site`'s files with `vercel.json`'s headers, Supabase blocked. Checks:<br>- the shop app, the receipt, order and store pages and the Platform Console open with no CSP violation, page error or missing file;<br>- the service worker installs all 458 files under the committed cache name.<br>Vercel's build was reproduced from a fresh LF clone of `b818098`: `npm ci` and `npm run build` left `git status` clean with the same `hangtag-2af8ebe5c8`, and the test passed in that clone |
| 48 | Receipt and order pages (found by 47) | No icon link, so each receipt or order link a customer opened also asked for `/favicon.ico`, which the site doesn't have | Fixed — both name `icon.svg`, as `store.html` does |
| 49 | Vercel Preview | The commits are local, and a Preview needs a push, which needs the owner's word. Previews run `config.js`, which names the live Supabase project, so signing in on a Preview uses live data (and the fields screens need 3z there) | **Blocked** on the owner's word to push. Until then, item 47 and the clone build stand in for it |
| 50 | The shop's own units in the database (3z, not yet released; found while auditing the importer) | The database knew only Hangtag's nine units:<br>- a supplier bill refused 24.5 sq ft ("too many decimal places"): every unit of the shop's own was taken as whole numbers;<br>- a quotation or order saved 2.5 rolls: units outside the nine weren't checked at all;<br>- the online store refused 2.5 sq ft, and its + button stepped a shop's unit by 0.001, because the page never learned the unit's decimals | Fixed in 3z, before its release:<br>- `hangtag_unit_decimals(owner, unit)` gives Hangtag's nine as `units.js` keeps them, the shop's unit as saved (archived too), and 3 for an unknown code (as the app reads one);<br>- `hangtag_save_order`, `hangtag_import_stock` and `hangtag_place_mobile_order` are re-created in 3z as exact copies, with only that check changed;<br>- the store's catalog gives the shop's units (`units`: id, label, decimals), and `store.js` hands them to `setShopUnits`;<br>- report row 93 checks all of it (10).<br>8 checks: `custom-fields` 4, `mobile-store` (database) 2, the store's unit test 1, the store in Chrome 1. The 4 run before the fix failed (3 in `custom-fields`, 1 in `mobile-store`); the Chrome check fails with the old `store.js` |
| 51 | The online store's Add (found by 50) | Add puts the unit's smallest step in the cart: 0.001 kg, 0.01 m, and now 0.01 sq ft for a shop's 2-decimal unit, so a customer has to type the quantity. Released behaviour (Wave 12), not part of 3z | Found, not fixed: the owner's call (Add could put 1, or what is left when that's less) |
| 52 | Changing a product's unit | A product with stock can change unit, and its stock is then re-rounded into the new unit with an ADJUST: switching 12.5 kg to pcs writes +0.5 (`save-product.js:60-62`). The database doesn't stop it either | Confirmed in the code. Plan I1 (the app) and I3 (the database) |
| 53 | Two devices adding the same new serial | `hangtag_track_move` inserts a new serial with `ON CONFLICT … DO UPDATE` and no status check (`schema.sql:3238-3242`). If another device added the serial in between, the second insert silently takes it over | Confirmed in the code, not raced in a test. Plan I2 |
| 54 | The same supplier bill on two devices | The duplicate-file and duplicate-invoice checks are plain SELECTs with no lock, and the file-hash index isn't unique (`schema.sql:668`). Two devices confirming the same bill at once can both add its stock | Confirmed in the code, not raced. Plan I2 |
| 55 | A saved stock record sent again | Stock records are upserted by id, and a role with `manage_inventory` may update one (`schema.sql:1881-1883`). The serial and batch registers follow only inserts and deletes (`AFTER INSERT OR DELETE`, `schema.sql:3278`), so a rewritten quantity or serial list leaves them out of step | ~~Confirmed in the code.~~ **Corrected in item 68: not a defect.** Section 3n already freezes a saved record's serials and batch, and a quantity correction is a logged, designed capability |
| 56 | Stock records of the wrong shape | Only `hangtag_import_stock` checks that a serial-tracked line has serials, and a batch line its batch. `hangtag_save_purchase` and the outbox insert whatever they are sent | Confirmed in the code. Plan I4. **Deferred to after the repair: item 142** **→ Done in the post-repair migration: item 149.** |
| 57 | A product edit after a delete elsewhere | `patchProduct` falls back to a whole upsert when the row is missing (`cloud-gateway.js:142`). An edit queued on one device brings back a product deleted on another | Confirmed in the code. Plan I10. **Not changed: item 143** **→ Done (migration + app): item 151.** |
| 58 | Checking a product before updating it | `updated_at` on products and variants is whatever the client sends; no trigger sets it. So it can't tell an update from a file whether the product changed since. The audit's first design assumed it could, and its own verifier refuted that | Confirmed in the code. Plan I3 adds the trigger; I10 uses it |
| 59 | Supplier bills in boxes | `extract-bill` returns each line's printed unit (`core.js:33,56`), but the review lines drop it (`bill-import.js:42-57`). "5 box @ ₹600" becomes 5 of a pcs product at ₹600 each, and "Update cost prices" can then set a wrong cost | Confirmed in the code. Plan I19 (such a line needs its base quantity first), then I24–I26 (conversions, packs) |
| 60 | Repacking into a whole-number unit | `repackOutput` rounds the output to the target unit's decimals (`repack.js:19`). Opening 1 kg into pieces at 2.5 a kg makes 3 pieces on the device | Confirmed in the code, not run. Plan I20 |
| 61 | Bill and return lines | `saleItemRows` doesn't send the unit sold (`mappers.js:66-70`). The database fills it from the product's current unit, so a bill uploaded after a unit change gets the new unit | Confirmed in the code. Plan I21. **Deferred to after the repair: item 142** **→ Done (migration + app): item 150.** |
| 62 | Smaller findings (reported by the audit, not re-checked) | - Opening stock from a product file has no cost (`product-import.js:348`).<br>- "Received today" counts opening stock that has a cost (`business-today.js:96`).<br>- Serial and batch history calls any record with an import id "Purchased" (`tracking.js:110,147`).<br>- Purchase line money rounds differently from sales (`purchase.js:47-49` against `paise.js:9`).<br>- Low-stock levels are whole numbers (`stock-levels.js:5`, `mappers.js:90`) | **Fixed in item 139:** line money, "Received today", opening stock's cost, history labels. Low-stock decimals: item 142 |

### The plan for the next feature
`PLAN.md`: 30 increments in dependency order, for updating products from a file (variants, fields, opening stock, batches and expiry, serials) and for unit conversions (box to piece, kg to g) that don't corrupt stock or cost. Each increment lists its scope, database change, safety and tests. Items 52–62 above map onto them.
- **Order:**
  1. stop today's corruption (I1, I19, I20);
  2. database guards (I2, I3);
  3. updating from a file (I5–I11);
  4. stock from files (I12–I18);
  5. units and costing (I21–I26).
- **Not started.** Per the brief, it waits until the release blockers below are cleared, or the owner says to go ahead.

### Release order (dependency order; the owner's steps change the live project)
1. **Staging** (when a project exists): the runbook below. Until then, items 45 and 30 stand in for it.
2. **Live database** (owner, SQL editor):
   - run the report at the end of `schema.sql` first;
   - then run whichever of 3u, 3v, 3w it flags, followed by 3x, 3y and 3z, in that order;
   - run the report again: 80 rows, every one ok.
3. **Secrets** (owner): `npx supabase secrets set ANTHROPIC_API_KEY=… --project-ref wcorlmgkwcahyfastjoz`, plus `AGENT_ALLOWED_USERS` if the Agent's AI is wanted. Payment, subscription and webhook secrets are needed only when those go live.
4. **Functions** (owner):
   - redeploy every function, `team`, `webhook-dispatch`, `payment-webhook`, `delivery-status` and `receipt` with `--no-verify-jwt` as their READMEs say;
   - deploy `subscription` and `subscription-webhook` when subscriptions go live.
5. **Check:** `npm run preflight:live` should leave only providers deliberately not set up. Then `HANGTAG_EVAL_ANTHROPIC_KEY=… npm run eval:extract-bill` with the same key.
6. **Push** `ux-productization` (owner's word). Vercel builds a Preview; open it signed in to Vercel and don't make changes there while it runs on live data.
7. **Promote** the Preview to Production in the Vercel dashboard (owner). Live updates need 3z first, because the app's realtime channel names the two new tables. That ordering is not verified here: there's no hosted Realtime to test against.

### Staging runbook (for when a staging project exists)
- **Never run `supabase db push` in this checkout.** `supabase/migrations` also holds the unapplied Phase 1 design (`20260925180000_phase1_foundation.sql`), which it would apply. Paste files into the SQL editor instead.
- **Keep this checkout linked to the live project.** Run CLI commands for staging with `--project-ref <staging-ref>` rather than re-linking.
- **Steps:**
  1. Load the schema the live app was built on: `git show 6af8cc2:supabase/schema.sql` (the Vercel Production build).
  2. Add a shop with products, a bill and a return through a local copy of the app whose `config.js` names staging.
  3. Run the migrations in order, then each one a second time (they must be re-runnable): `20261007120000_hangtag_return_reasons.sql` (3u), `20261008120000_hangtag_delivery_reports.sql` (3v), `20261009120000_hangtag_plans_autopay_platform.sql` (3w), `20261010120000_hangtag_platform_operations.sql` (3x), `20261011120000_hangtag_billing_integrity.sql` (3y), `20261012120000_hangtag_custom_fields_units.sql` (3z).
  4. Run the report from the current `schema.sql`: 80 rows, every one ok.
  5. Check that the shop's data is unchanged, and that a field and a unit can be made and used by the app.
- **What staging adds over items 30 and 45:** Supabase's real roles and grants, PostgREST's schema cache picking up `attrs`, the realtime publication, and 17.6 itself.

### Test results (run, not assumed)
- `npm run check`: `sw.js` current (458 files, `hangtag-740e26b846`), 420 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- `npm test` passed:
  - **163/163 test files** (79 unit, 28 database, 4 eval, 52 browser) on Windows with Chrome;
  - then **28/28 database suites again on PostgreSQL 17.5**.
- **New suites:** unit `release-preflight` 41, database `postgres-versions` 3, browser `vercel-site` 15.
- **Grown for item 50:** `custom-fields` (database) 44 → 48, `mobile-store` (database) 16 → 18, `mobile-store` (unit) 5 → 6, `store` (browser) 40 → 41.
- **Tests that failed first:**
  - the preflight's two checks of the CLI's epoch-millisecond times (item 44);
  - `vercel-site` on `/favicon.ico` (item 48);
  - the unit decimals (item 50): 3 checks in `custom-fields` and 1 in `mobile-store`, and the Chrome store check against the old `store.js`.
  - The first full run after item 50 failed 3 database suites: `bank-accounts`, `commerce-batch`, `subscriptions`. Each runs an older migration on top of `schema.sql`, which brings back the older store catalog or checkout, and report row 93 now notices. They now run the 3z migration after it, as `commerce-batch` already did for 3y ("in the real order it runs after this one").
- **Not run:** the real Anthropic API (item 42), a hosted staging project (item 46), a Vercel Preview (item 49), a real phone.

### Committed (local, not pushed)
On `ux-productization` after `760f2e0`:
- `b3a4d44`: the database suites on PostgreSQL 17 (item 45);
- `3e5fc91`: the read-only release preflight (items 43–44);
- `b818098`: what Vercel serves, and the receipt and order page icons (items 47–48);
- `d23941f`: the shop-unit decimals in the database and the store (item 50);
- this log and `PLAN.md`, in the commit after it.

### Release blockers (each needs the owner)
1. **An Anthropic key.** With it, `HANGTAG_EVAL_ANTHROPIC_KEY=… npm run eval:extract-bill` checks the real API (item 42). The same key is the `ANTHROPIC_API_KEY` secret the live project lacks (item 43).
2. **A staging project** (item 46), or the decision to release without one; items 30 and 45 stand in.
3. **The word to push** `ux-productization`, so Vercel builds a Preview (item 49). 12 commits are local.
4. **The live project, in the release order above:**
   - the schema sections the report flags, up to 3z;
   - the secrets;
   - the function deploys, with the JWT settings their READMEs give.
5. **Not a blocker:** item 51, the store's Add, is a product decision.

## 2026-10-10 (fourth session: any kind of product, without code changes)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 32 | Product model (audit) | **Already generic:** variants (up to 3 options of any name, 100 values each, 400 variants), each variant with its own SKU, barcode, price, cost and stock; SKU and barcode unique per shop in the database; tracking chosen per product (none, serial/IMEI, batch, batch + expiry), with business types only setting default capabilities; stock always the sum of stock records. **Missing:** fields of the shop's own (only fixed fields and a free-text description); units were a fixed list of nine, enforced by CHECKs on products, bill, return and order lines; the import read an option column only if it was one of 13 built-in names; the template was fixed, and there was no export | Audited |
| 33 | Custom fields | Nothing let a shop describe a product in its own words | Added — `domain/catalog/attributes.js`: seven kinds, choices, required, lowest/highest, decimals, unit after the number, longest text, limited to categories; values per product (`attrs`); names of built-in fields refused with where they live (Price, Stock, SKU, IMEI, Expiry…). Database section 3z: `hangtag_attributes`, each value checked against its field's kind, a field in use kept (kind fixed, archived not removed), row security as products, the plan-ended guard. Settings → Products & Inventory → Product fields; the editor's folded "More details"; the product view; search. Tests: `attributes.test.mjs` (49), `supabase/tests/custom-fields.test.mjs` (44) |
| 34 | Variants from fields | Variant options were free text per product | Added — a product option can take its values from a field (`opts[i].a`, `options.opts[].attr`). The editor offers the shop's fields first, with their choices one tap away. A choice renamed in Settings is renamed on every product using it, values and variants alike (ids, stock and codes kept; renames apply at once, so a swap works). Tests: `shop-fields-sync.test.mjs` (21), the e2e |
| 35 | Units | A unit outside the nine (roll, pair, sq ft…) was refused by the app and the database | Fixed — the shop's own units (`hangtag_units`: code, name, decimals 0–3, counted or measured, GST unit code). One registry in `units.js` lets all 51 modules that read units know them, including the GST exports. The database takes any unit code, also in sections 3k and 3p, so `schema.sql` re-runs. Report row 36 flags a code the shop doesn't have. A code this device hasn't downloaded keeps its code instead of becoming pieces. Stock count, supplier-bill import and code intake list the shop's units too |
| 36 | Import and export | (a) A column such as "Wattage" was dropped silently, though the template's notes said any option name works. (b) No custom data could be imported. (c) No export | Fixed — a column named as a field imports into it. The same value on every row of a product is the product's; a value that differs makes its rows variants (linked to the field; a date, yes/no or several-choices field can't, said plainly). Required fields are checked per category. A column with no field is listed with the kind its values suggest, and "Add as fields" makes it one and reads the file again. The template has the shop's option names and a column per field. The export uses the same columns and reads back as the same products, values and variants. Tests: `product-import-fields.test.mjs` (27); the 31 + 44 earlier import checks still pass |
| 37 | Sync, backups | — | Fields and units sync as commerce-batch records (kinds `at`, `un`; live updates; team members' poll). A product's upload waits for the fields it uses (`need`); a full upload sends units and fields first; backups carry and restore them |
| 38 | Plan-ended guard (latent) | Section 3t puts the guard on the tables that exist when it runs, so a table made by a later section has none unless it adds its own. The upgrade test's report row 76 caught it | Fixed for 3z's tables; any future section with a new table must attach the guard |
| 39 | Touch targets (pre-existing) | The variant editor's value chips (14 px and 22 px) and the variant table's checkboxes (18 px) were under 24 px on phones, found by the new e2e's phone check | Fixed — larger on touch screens |
| 40 | Editor regression caught | Redrawing the whole editor when the category box lost focus swallowed the tap that moved the focus (`pos-variants` e2e) | Fixed — only "More details" is redrawn |

### Demonstrated without code changes (`tests/e2e/custom-fields.test.mjs`, 33 checks, in Chrome against the real schema)
An owner with no template for their products:
- makes Wattage (one choice), Spectrum (one choice) and Warranty months (0–60) in Settings; IMEI is refused, pointing to serial numbers;
- makes a unit, Sq ft (2 decimals, GST SQF);
- adds an LED grow light whose variants come from Wattage, with its spectrum and warranty, and a hand-knotted rug sold by the square foot (24.5 in stock);
- finds the light by "bloom", sees its details, and is stopped by a warranty of 72;
- imports bar lights by Wattage with a Lumens column the shop had no field for, makes Lumens a field in one tap, and exports the catalog;
- sells a 100 W light (stock 5 → 4), renames 100 W to 100 Watt (same variants and stock, on every product) and archives Spectrum (values kept).

The database holds every step, and the new screens pass the phone layout checks.

### Test results (run, not assumed)
- `npm run check`: `sw.js` current (458 files, `hangtag-3031e0e5c1`), 420 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite: **160/160 test files passed** (78 unit, 27 database, 4 eval, 51 browser) on Windows with Chrome.
  - The run before it failed two browser suites. `pos-variants` caught the editor regression (item 40, fixed). `google-signin` hit a 30 s navigation timeout while the machine was busy; it passed alone and in the final run.
- **New suites:**
  - unit: `attributes` 49, `shop-fields-sync` 21, `product-import-fields` 27;
  - database: `custom-fields` 44, `upgrade-live-database` 20 (3x, 3y and 3z on the previous release's database, which still has the fixed unit list; report 80/80);
  - browser: `custom-fields` 33.
- **Existing suites kept passing:** the import checks (31 + 44), `options` 49, the responsive matrix 427, and the team-tenancy leak sweep, now covering the two new tables (155).
- **Tests that failed first:**
  - the new phone check failed on the chips and checkboxes (item 39);
  - `pos-variants` failed on the regression (item 40);
  - the suggestion test failed on free text offered as a choice;
  - `attributes` caught `.map(tidy)` passing the index as a length.
- **Not run:** a hosted Supabase project (the new section ran on PGlite only, PostgreSQL 18.3), and a real phone (puppeteer's touch emulation).

### Committed (local, not pushed)
On `ux-productization` after `b1f66cc`: `63b48d9` (rules and database section 3z), `dd2216a` (the app, import and export, the e2e), and this log in the commit after them.

### Supported, and what is not
- **Supported for any product:** the shop's own fields of seven kinds, in any category; variants from any field or free option names; per-variant SKU, barcode, price, cost and stock; tracking chosen per product (serial, batch, expiry or none); the shop's own units; import and export with all of it; search by field values. All of it is checked, shop-isolated and kept through archiving.
- **Not done:**
  - **Per-variant values:** a variant has only its options, SKU, barcode, price and cost; a field value per variant (each variant's own model number) needs the field as an option.
  - **Tracking by import:** import doesn't set a product's tracking or take serial numbers or batches. Tracked stock comes in through Stock in or Purchases, as before.
  - **Updating by import:** import still adds new products only.
  - **Unit conversions:** units convert only by repack between products. There's no box-of-12 purchase conversion, and a shop unit can't be read from a scale.
  - **Fields elsewhere:** values aren't printed on bills or stickers and aren't filters in reports (search only). There's no drag-to-reorder for fields (new ones go last). Field permissions follow `manage_products`.
- **Built-in names still used, outside core workflows:**
  - example catalogues and placeholder names per business type;
  - the draft assistant's guess of Size, Colour or Storage;
  - Colour and Size treated specially for swatches, the "pieces by size" report and the database's old colour/size columns;
  - the list of suggested option names.

  None of these stops another kind of product from being made, stocked, sold, imported or exported.
- **The live database** needs section 3z (`20261012120000_hangtag_custom_fields_units.sql`), after 3x and 3y; report rows 36 and 91–93. Until then the app sends field values only for products that have some, so every other product still syncs.

## 2026-10-10 (third session: release readiness)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 28 | Build (`sw.js`) | The cache name hashed the app's files byte for byte. Git stores them with LF (all 449 text files in the shell are `i/lf`) and checks them out with CRLF on Windows (`core.autocrlf=true`, set by Git for Windows) and LF on Linux, while this working tree was mixed (105 CRLF, 344 LF). So each checkout of the same commit computed its own name: on `f090c70` a fresh Windows clone gave `hangtag-e4a3197d42`, a Linux-style (LF) clone `hangtag-756745c4f5`, the committed `sw.js` said `hangtag-1b40e9a88a`, and both clones failed `npm run check` / `build.test` with "sw.js is out of date" | Fixed — `scripts/sw-cache.mjs` (the file list and hash, moved out of `build.mjs`) hashes text with CRLF read as LF and pictures byte for byte (git's own NUL test for binary). `tests/unit/sw-cache.test.mjs` computes the name from the real files as an LF and a CRLF checkout would have them: 3 failures before the fix (the two names above against `1b40e9a88a`, and the order below), 8/8 after. `sw.js` regenerated: `hangtag-756745c4f5`, one line changed |
| 29 | Build (latent) | The file list was sorted by system path. Windows' `\` sorts after digits and capitals, `/` before them, so a folder such as `src/ui/` next to `src/ui2/` or `src/uiB.css` would be listed in another order on Linux (another `sw.js`, another test-hook module order). None of today's 437 files hit it | Fixed — sorted by URL; the same test |
| 30 | Migrations 3x, 3y (validation) | The suites ran each migration only on top of a `schema.sql` that already holds it. The upgrade a live database goes through had not been run | Checked, no defect — `supabase/tests/upgrade-3x-3y.test.mjs` (renamed `upgrade-live-database.test.mjs` in the fourth session, which added 3z to it) builds the previous release's database (today's `schema.sql` without 3x, 3y and their 4 report rows is exactly `9623601`'s, checked with `git diff`) with a shop, a cashier, bills (one cancelled, one with a return) and a console admin; shows its bug (a re-sent cancelled bill comes back); runs 3x then 3y, each twice, and 3y then 3x on a second copy. Report 77/77 ok, every row of the 67 tables unchanged, 3y holds for the old bills, 3x lists and opens the old shop and refuses its owner. Without 3y, 6 of its checks fail. PostgreSQL 18.3 (PGlite 0.5.8) with Supabase stand-ins; a hosted non-production project was not available (below) |
| 31 | `extract-bill` with the real Claude API | Needs a key. There is none in this environment (the function reads `ANTHROPIC_API_KEY` from the Supabase project's secrets, not from this machine), and no Deno or Docker to serve the function locally | **Blocked** — added `npm run eval:extract-bill`: the function's own provider, request (schema, thinking, effort, fallback) and answer code on a made-up PDF bill, with only the HTTP call replaced by `fetch`. Skipped without a key. `extract-bill-provider-plumbing.test.mjs` proves its plumbing against a local stand-in for the Messages API (headers, fallback beta, streaming, JSON-schema format, a well-formed PDF, a split stream, a refused schema failing): 7/7 |

### Pushed and deployed (on the owner's word, 2026-10-10)
- `git push origin ux-productization`: `9623601..f090c70` (the eight commits of 2026-10-10). Scanned first: no `.env`, keys, tokens, logs, screenshots or `dist/` in the 103 files.
- Vercel builds each push of the branch (`npm ci`, `npm run build`, `dist/site`). It built `f090c70` as a **Preview** (GitHub status "Deployment has completed", 14:06 UTC). The preview sits behind Vercel's sign-in (HTTP 302), so its pages weren't checked from here. Vercel's **Production** is still `6af8cc2` (2026-10-07). Promoting is done from the owner's Vercel account; this machine has no Vercel CLI login.
- No migration was run and no Edge Function deployed. `main` (GitHub Pages) was not touched.

### Test results (run, not assumed)
- `npm run check` (this working tree): sw.js current (453 files, `hangtag-756745c4f5`), 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite on the working tree with every change of this session: **155/155 test files passed** (75 unit, 26 database, 4 eval, 50 browser) on Windows with Chrome.
- Clean checkouts of `ed806ad`, one a fresh Windows clone (CRLF) and one an LF clone (the bytes Linux and Vercel check out):
  - `npm run check` passes in both with the same `hangtag-756745c4f5`;
  - unit, database and eval suites pass 105/105 in each;
  - `npm run build` leaves `sw.js` as it is (`git status` clean), so Vercel's build produces the committed file;
  - the service-worker browser test (`offline-queue-sw`) passes from the Windows clone.
- Before the fix the regression test failed 3 of 8 checks; after, 8/8. The upgrade test fails 6 checks without 3y.
- Not run: the real Claude API (no key), a hosted non-production database (none available), a Linux machine (the LF clone stands in for its checkout).

### Committed (local, not pushed)
On `ux-productization` after the pushed `f090c70`: `1eb8788` (items 28–29, the `sw.js` fix), `97df853` (item 30, the upgrade test), `ed806ad` (item 31, the real-API evaluation and its plumbing test), and this log in the commit after them.

### Release blockers
- **Live database**: sections 3x (`20261010120000_hangtag_platform_operations.sql`) and 3y (`20261011120000_hangtag_billing_integrity.sql`), in that order (the other order also works). Then run the report at the end of `schema.sql`: 77 rows, every one ok. If an earlier section (3u, 3v, 3w) was never run there, its rows say so; run it first.
- **`extract-bill`**: run `HANGTAG_EVAL_ANTHROPIC_KEY=<key> npm run eval:extract-bill` once, then redeploy the function (items 16–20 live there).
- **Vercel production**: promote a preview only after the two steps above. The Console's new pages need 3x; bill upload needs the redeployed function.
- **Hosted staging**: the migrations have run only on PGlite. The one Supabase project this checkout is linked to (`supabase/.temp`) is the live one, so nothing was run there. A staging project (or a branch database) would close this.
- Open from earlier sessions: updating known products by import; `hangtag_cap_on` callable for any shop; the console shop list's cost at scale; an unbundled first load; HSTS / nosniff on GitHub Pages.

## 2026-10-09 (second session: bill upload, product import, billing, Home, responsiveness)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 16 | Upload bill (root cause) | The extraction schema had 19 nullable (`anyOf`) fields; the Claude API compiles at most 16 and refuses the rest with "Schema is too complex for compilation" — every real reading failed (the e2e stubs the function, so it never showed) | Fixed — text not on the bill is `""`, only the 6 numbers nullable; `extract-bill` unit test counts union and optional fields against the limits |
| 17 | Upload bill | A long bill could pass Supabase's 150 s wait for a first byte (504) | Fixed — the function answers 200 at once and streams spaces until the JSON; failures in the body, mapped by the app; unit + e2e |
| 18 | Upload bill | The original was uploaded to the cloud before reading started (a large photo went up twice before anything happened) | Fixed — kept on the device first, cloud copy in the background; e2e holds the upload and checks the reading went ahead |
| 19 | Upload bill | A PDF or photo the picker gives no type was refused or stored as `application/octet-stream` (the bucket rejects it); an undecodable picture failed with a vague message; error advice was said twice | Fixed — type from the name, original sent when the browser can't shrink it, HEIC said plainly; unit + e2e |
| 20 | Upload bill | The new rate limit refused every reading on a database without section 3t | Fixed — reads without a limit there (as before), refuses on any other limiter failure; unit |
| 21 | Product import | Template technical ("Option 1 name / value"), no instructions; row numbers in errors didn't match the sheet when it had blank rows; Excel's damage (8.9E+12 barcodes, lost leading zeros, ANSI "CSV") not caught; a re-import of known products blocked the whole file with no way past | Fixed — plain columns (Colour, Size…), notes and examples (left out if kept), the sheet's own row numbers, errors in the file's own column names, Excel damage explained, "leave them out" for known products, the file downloadable with its problems written in; `product-import` unit test + new e2e |
| 22 | Billing integrity | A till re-sending a bill (lost answer, or "upload every bill") overwrote `is_void`: a bill cancelled on another till came back — its stock out again, its money back in the books | Fixed in schema section 3y (migration `20261011120000`): an upload may cancel, never un-cancel; Restore stays the one way back; DB test (fails without the fix) |
| 23 | Billing integrity | A bill with a return could still be cancelled by a till that hadn't seen the return (its refund then left the cash book though the cash went out); an exchange's new bill could be cancelled, losing the customer's credit | Fixed — section 3y trigger refuses the cancel (an upload leaves the bill as it is); the app refuses an exchange bill and doesn't offer Cancel; DB + e2e |
| 24 | Payments | A second tap on "New QR"/link while the old one was being closed made two payment requests at the provider (one could take money that never reached the bill) | Fixed — one request per part while it is being made; unit test (fails without the guard) |
| 25 | Layout (app-wide) | A leftover `.sm{margin-top:14px}` (old stock list) pushed every small button, thumbnail and small avatar 14 px down | Fixed — removed; `tests/unit/css-modifiers.test.mjs` refuses a modifier class styled on its own |
| 26 | Responsive | Stock's barcode field squeezed to ~10 px on phones; product editor's code-type choices 18 px targets on touch; purchase search unnamed | Fixed — the matrix now also checks overlap, cards over cards, clipped controls, controls stuck under the tab bar and squeezed fields, on 33 screens × 4 sizes (16 forms and sheets added); `layout-checks` e2e proves each check fires |
| 27 | Home | Cluttered: four banners before any figure, the same UPI fact five times, a "why" panel opening by itself, ten equal tiles | Redesigned — one header with a large New sale, four headline figures, compact money / owed rows, reasons on a tap, briefing folded, side column for bank, agent and trend; `home` and `business-today` e2e check the new layout and that nothing opens by itself |

### Test results (run, not assumed)
- `npm run check`: sw.js current, 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite: **152/152 test files passed** (74 unit, 25 database, 3 eval, 50 browser) on Windows with Chrome. The first run failed only `business-today` (it still expected a figure's reasons to open by themselves, removed on purpose); updated and passing.
- Each fix's test was checked to fail without the fix (schema 3y upload and cancel, the QR double tap, the `.sm` rule, the layout checks on a page made to break them).
- Not run: the real Claude API or a deployed Edge Function (the schema fix follows the documented limits; the function's request is unit-tested).

### Committed (2026-10-10, local, not pushed)
One commit per piece of work, on `ux-productization` after `9623601`: Phase 56 `4cbd12e`; audit round 1 (items 1–15) `53e3aa8`; upload bill (16–20) `ffc9341`; product import (21) `4876b63`; billing and payments (22–24) `56bbb48`; Home (27) `5ebc4b3`; layout and responsiveness (25–26) `af72653`; this log in the commit after them. Each commit built cleanly and passed its own unit, database and browser tests when it was made. The one exception is Phase 56's commit, which keeps `9623601`'s `phase1_foundation` failure (the 3w migration's missing marker); the next commit fixes it.

### Not done / next
- The live database needs section 3y (`20261011120000_hangtag_billing_integrity.sql`) after 3r; report row 90 must say 2.
- `extract-bill` needs redeploying for items 16–20 to reach the live app (the schema fix is in the function).
- Products already in the shop can be left out of an import, not updated by it (prices / stock by file would be a feature).
- ~~`sw.js`'s cache name hashes the app's files byte for byte, line endings included~~: fixed 2026-10-10 (item 28).

## 2026-10-09

### Checklist (priority order)

| # | Area | Finding | Status |
|---|------|---------|--------|
| 1 | Data integrity / migrations | The 3w and 3x migrations lacked `-- Requires: supabase/schema.sql`, so the Phase 1 foundation suite ran them on an empty database and failed | Fixed — `tests/unit/migrations.test.mjs` |
| 2 | Data integrity / migrations | Nothing checked that a migration said to be "exactly section N of schema.sql" still is | Fixed — the same test compares all 7 byte for byte (3r and 3s may add only their declared row-security block) |
| 3 | Security / supply chain | Edge Functions imported `npm:@supabase/supabase-js@2` (any new 2.x on the next deploy) | Fixed — pinned to 2.117.2, the app's own version; `tests/unit/function-imports.test.mjs` |
| 4 | Test infrastructure | e2e browser path hard-coded to Windows Chrome | Fixed — Chrome, Chromium or Edge found on Windows, macOS and Linux (or `CHROME_PATH`); as root on Linux started with `--no-sandbox` |
| 5 | Test infrastructure | A missing browser was reported as an app failure | Fixed — the runner reports browser suites as skipped for the environment (exit 77); `TEST_STRICT=1` fails instead |
| 6 | Test infrastructure | Database suites ran one after another (slow; long runs timed out); a hung file blocked the run | Fixed — unit and database suites run side by side (`TEST_JOBS`), 25 DB suites in 55 s; per-file `TEST_TIMEOUT_MS` (20 min) |
| 7 | Build | esbuild installed for another platform (node_modules copied from Windows to Linux) crashed the build at import | Fixed — the build says it is the environment and to run `npm ci` |
| 8 | Console (Phase 56) | Hard-coded `₹` in the console's domain text (currency rule) | Fixed — formatter passed in; `currency-hardcoding` test |
| 9 | Console (Phase 56) | Double-clicking a row opened its panel and the second click closed it; a second panel could stack | Fixed — e2e `platform-console` check |
| 10 | Tenant isolation (shared device) | Four per-shop keys stayed with the device when another account signed in: the bill-number series (`hangtag_till`: the next shop could number its bills in a stray series), a pending AutoPay approval, the last full sync time (could hide the next account's "not in the cloud yet" warning for 6 h) and the backup log (could hide its backup reminder) | Fixed — kept per account, sync time re-read on switch; `DEVICE_KEYS` names what deliberately stays; `tests/unit/account-keys.test.mjs` fails on any new key that is neither |
| 11 | Cost abuse | `extract-bill` (paid AI per call, reachable from a free trial) had no rate limit | Fixed — 6/min and 60/day per user, 12/min and 150/day per shop (settable), on the Agent's limiter with separate counters; refuses if the limit can't be checked; `extract-bill` unit test |
| 12 | Test infrastructure | The runner missed CommonJS and helper-driven e2e suites (13 of 48), so they ran in the parallel pool | Fixed — every `tests/e2e` file, and any file loading puppeteer, is a browser suite |
| 13 | Security (clickjacking) | `vercel.json` sends `frame-ancestors 'none'` / `X-Frame-Options`, but a host that sends no headers (GitHub Pages serving the repo) left the shop app and the console frameable | Fixed — `src/app/frame-guard.js` stops both before they boot inside another site's frame (own-site frames still work; public store/order/receipt pages untouched); unit test + real-browser check in `platform-console` e2e |
| 14 | Linux build | Windows and macOS ignore letter case in import paths, Linux doesn't | Checked: 3,919 relative imports all exact — kept as `tests/unit/import-case.test.mjs`. The lockfile carries the Linux/macOS binaries of esbuild and the Supabase CLI, so `npm ci` on Linux works; node_modules copied from Windows is the environment (the build now says so) |
| 15 | Accessibility | Products' search box (placeholder only) and category filter had no name for screen readers; nothing checked control names | Fixed — named; the responsive matrix now fails any control without a name a screen reader can say, on 17 screens × 4 sizes (Products added) |
| — | Security scan | SECURITY DEFINER functions callable without sign-in: 6, all token-gated public endpoints by design (store/table ordering, sign-in methods); public order prices, stock and quantities are checked server-side; every table has row security | No defect |
| — | Security scan | Webhooks verify HMAC signatures before parsing, in constant time; outbound webhooks refuse private/loopback addresses; receipt links are token-only | No defect |

### Test results (run, not assumed)
- `npm run build`: 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite after the fixes: **148/148 test files passed** (unit, 25 database, 3 eval, 48 browser) in 17 m 52 s on Windows with Chrome.
- The double-click check then switched from `clickCount` (ignored by puppeteer-core 25) to `count: 2`: with the fix turned off it fails, with it on `platform-console` passes 55/55.
- Not run here: a Linux machine (the Linux fixes are verified by their unit tests and by simulating a machine without a browser).

### Also checked, no defect
- Public store/order/receipt pages build their markup with `textContent` (no injected HTML); the app's own templates escape data (a scan of every interpolation in markup found none unescaped).
- Bill originals: a private bucket, each shop confined to its own folder by `hangtag_shop_id()`, permission-gated, 15 MB and file types limited.
- A plan that ends (HT402) keeps every unsent bill queued until renewal; nothing is dropped.
- The CDN script carries an integrity hash; `vercel.json` sends CSP, HSTS, nosniff, `frame-ancestors 'none'`.

### Not done / next
- `hangtag_cap_on(owner, cap)` can be called by any signed-in account for any shop (reads one yes/no setting, needs the shop's UUID). Low risk; it runs inside triggers as the writer, so restricting it needs a schema section and those triggers checked.
- Console shop list computes stock and errors for every shop on each request: fine at today's scale, index or cache it beyond a few thousand shops.
- The app loads ~415 ES modules unbundled on first visit (the service worker caches them after). A production bundle would cut first-load time on slow networks; it is a build change, not a fix.
- If the live site is GitHub Pages (no `vercel.json` headers): HSTS and `nosniff` don't apply there; clickjacking is now covered by the frame guard.
