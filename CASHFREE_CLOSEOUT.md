# Cashfree billing: closeout (updated 30 October 2026)

For the owner (Florix). It covers what was finished, the evidence, what is still blocked, and the exact production
operations awaiting your approval. Release reference: `CASHFREE_RELEASE_READINESS.md`. Nothing here was committed,
pushed or deployed. The only contact with the production project was read-only SELECTs on 30 Oct (§3).

## Verdict: NO-GO

The 28 October target has passed. The billing code, the repair and the migrations are verified as far as this computer
allows. The Cashfree sandbox flow now runs for real end to end, up to a renewal charge raised and waiting for its date.
Launch still needs:

- **The live repair.** The cross-shop incident is contained, not repaired, on live. The repair is rehearsed and passes
  on the real backup, but it hasn't been run on live (it needs your approval).
- **A real Supabase runtime.** Your decision on 30 Oct was local Supabase (CLI + Docker), but Docker and WSL2 are not
  installed on this computer.
- **A completed Cashfree renewal.** Three real sandbox renewal charges were raised on 30 Oct. They can only be settled on
  their date, 1 Nov from about 12:00 IST (§2a).
- **The production Cashfree account:** UPI AutoPay activation and the app domain's whitelisting.

## 1. Remaining blockers and the action for each

| # | Blocker | Action | Who |
|---|---|---|---|
| **B1** | **Live repair not run.** Live still has 18 older functions and 3 stale indexes (rechecked 30 Oct, §3). | Approve operations P1–P3 (§6). Before P1, your SQL Editor preflight: `data-fingerprint.sql` and `restore-row-counts.sql`, which I couldn't run (§3); the other preflight checks already pass on live. Then a fresh dump (runbook §2). | You |
| **B2** | **No local Supabase runtime.** Your decision (30 Oct): no hosted test project, `ecommerce` untouched, use the Supabase CLI with Docker. The CLI is here (`node_modules`, v2.118.0), but **WSL2 and Docker Desktop are not installed** ("The Windows Subsystem for Linux is not installed"; no `docker`). `supabase start` needs both. Without it, the real Auth, PostgREST, Edge runtime and pg_cron/pg_net/Vault can't be run here. | Install WSL2 (`wsl --install` in an administrator PowerShell, then restart) and Docker Desktop (free for small businesses), and start it once. Then I run the stack from a scratch folder (never this repo, which is linked to the production project) and verify Auth, row security, PostgREST, the Edge functions, the migrations with their undo, and the hourly schedule. | You install, then me |
| **B3** | **Renewal not yet completed.** Charges were raised on 30 Oct for 1 Nov (§2a). Cashfree's simulator moves a charge only once it is PENDING, on its date. | A watcher on this computer settles them with Cashfree's documented simulator once they are PENDING, but only while the tunnel is up: shop A SUCCESS, shop C FAILED then SUCCESS on a retry. It also runs the reconciler hourly. It needs this computer, this session, the harness and the tunnel running. Fallback in §2a. | Me (automatic), or the fallback |
| **B4** | **Cashfree production account** (seen read-only on 30 Oct, §4). UPI one-time payments are Active, but whether UPI AutoPay is enabled for Subscriptions isn't shown, and it needs Cashfree's commercial approval. `florixtechnologies.com` is whitelisted (Approved 12 Oct); the app runs on `app.hangtag.florixtechnologies.com`, and Cashfree says "certain subdomains are not supported". There is no production Subscriptions webhook yet, and production keys aren't set in Supabase. | Ask Cashfree (account manager or Support Form) to enable UPI AutoPay for Subscriptions, and to confirm that the root entry covers the subdomain, or add the subdomain via Add New. Then `CASHFREE_RELEASE_READINESS.md` §3. | You |
| **B5** | Nothing committed. | Review, then tell me to commit and push. | You |

## 2. The adversarial review (27–30 Oct) and its fixes

Three independent reviewers covered billing logic, SQL and rollback, and isolation and secrets. Their refutation agent
didn't run (session limit), so I traced each finding through the code myself. All ten were confirmed, and all are fixed
with tests that fail on the old code.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High** | A charge the reconciler recorded used Cashfree's "asked for" time (days old). The registry treated it as older than the read, so the **next charge never moved**: no renewal was ever raised again, and the shop lapsed with AutoPay "on". | Charges are recorded as of the read that found or confirmed them (`reconcile.js`, webhook `confirmCharge`). |
| 2 | Medium | The same mechanism: **`past_due` never cleared** after Cashfree's own retry succeeded. | The same fix. |
| 3 | Medium | A success reported for an attempt not yet listed, while an earlier attempt showed failed, was **settled as a failure and lost**. | A failure counts only on the API's word about the attempt reported; otherwise 503, so Cashfree resends. |
| 4 | Medium | Re-running the post-repair migration (as the runbook requires) **silently reverted** the Cashfree functions. | `checks/cashfree-readiness-report.sql`, plus the re-run rule in the migration header, runbook §7 and the release reference. |
| 5 | Low | The migration and undo had **no prerequisite guard**. Out of order, they made SECURITY DEFINER functions executable by everyone. | Both refuse without the post-repair migration, and grants are now explicit (service role only). |
| 6 | Low | A retried cancel that errored **skipped withdrawing** charges already raised. | They are withdrawn whatever the cancel answers, and any read of an ended mandate withdraws leftovers. |
| 7 | Low | One mandate's 4xx **aborted the whole reconcile run**. | It is kept for review against that mandate, and the run goes on. |
| 8 | Low | An owner's turn-off that Cashfree couldn't confirm was **not recorded**, so a charge could still be raised. | It is kept owed (`hangtag_autopay_cancel_owed`, new). The reconciler retries the cancel first and asks for no charge meanwhile. |
| 9 | Low | `autopay.html` **opened any Cashfree session** from its link: phishing on Hangtag's own origin. | It opens only a session this app on this device was given in the last 30 minutes. |
| 10 | Low | Retry attempts under one `payment_id` were misread. | Every attempt is judged together (found by me before the review). |

Found while completing the UPI AutoPay events on 30 Oct (each with a test that fails on the code before):

| # | Severity | Finding | Fix |
|---|---|---|---|
| 11 | Medium | A renewal **the payer declined** (Cashfree: CANCELLED, mandate still ACTIVE) was ignored. AutoPay stayed "on" while the plan lapsed, and staff heard only 4 days after the due date. `SUBSCRIPTION_PAYMENT_CANCELLED` wasn't handled. | It counts as past due while the mandate is ACTIVE: by the webhook (confirmed from the API) and by the daily read. A charge withdrawn with a mandate turned off is still ignored. Tests A10b, A19 and A15c. |
| 12 | Low | The **pre-debit notice** (`SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED`) left no trace, so a charge Hangtag never asked for went unnoticed until money moved. | Noted once in the ledger. A notice not for one of Hangtag's charges, over the price, or on a set-up being turned off is kept for review (`unexpected_charge`, labelled in the console). Test A20. |
| 13 | Low | A late non-final report (e.g. "pending" after a cancel) **reset an ended mandate's status to a live one**, so the reconciler read it as live until its next read. | The registry keeps a cancelled, completed or expired mandate ended (migration `20261027120000`, change 3). Report row 2 now checks this too. Tested in `cashfree-autopay` on PostgreSQL 18 and 17, with a negative control. |

## 2a. The real Cashfree sandbox run (30 Oct, continuing)

Setup:
- **Handlers:** the real `subscription`, `subscription-webhook` and reconcile handlers, over a *persistent* PGlite
  database. That is real PostgreSQL with `schema.sql`, the post-repair migration and the Cashfree migration, holding
  synthetic shops A–D only.
- **Webhook:** a Cloudflare quick tunnel exposing only the webhook path (anything else is 404, a GET is 405).
- **Dashboard:** the Cashfree **Test** Subscriptions webhook points at the tunnel: version 2026-01-01, the 7 events in
  `CASHFREE_RELEASE_READINESS.md` §3. Cashfree's own Test button answered 200.

All real Cashfree sandbox, all passed:

| Step | Evidence |
|---|---|
| Readiness | The billing self-check's ₹1 probe link and mandate were withdrawn. Their signed notifications (v2026-01-01, with an idempotency key) arrived; a complete reconcile followed. Readiness: **ready**. |
| Subscription creation and UPI mandate checkout (A, C, D) | Through the real `autopay_start` with the owner's consent (₹999, nothing due today, first charge at the trial's end). The app's `autopay.html` accepted only the session the app stored, then opened Cashfree's checkout: UPI, test UPI ID `testsuccess@gocash`, Cashfree's simulator "Simulate Success". |
| Approval and activation | For each shop: auth status and status changed (ACTIVE) recorded as authenticated. The ₹1 AUTH payment and its refund were ignored. 3 mandates ACTIVE at Cashfree (ON_DEMAND, max ₹999, UPI), the shops `trial_active`, AutoPay `active`, next charge = trial end; **0 payments, 0 exceptions**. |
| Recurring charge raised by the reconciler's own rules | `htc_<mandate>_20261101`, ₹999, **INITIALIZED**, scheduled by Cashfree for **1 Nov 12:00 IST**, for A, C and D. |
| Cancellation and withdrawal (D) | Real `autopay_cancel`. Cashfree shows mandate **CANCELLED** and its charge **CANCELLED** (withdrawn). The notification was recorded; D is cancelled with no next charge. |
| Signature verification | A tampered signature or body: 400 `bad_signature`. Unsigned: 400. |
| Duplicates | Cashfree's own deliveries replayed exactly: 200 `duplicate`, nothing applied twice. |
| Delayed / out of order | D's earlier "ACTIVE", re-sent under a new event id after the cancel, was accepted but **stale**: D stays cancelled, mandate and shop alike. |
| Isolation (owner B) | No direct access to the subscription, mandate, event or exception tables (42501). 0 of A's payments. The registry and cancel-owed functions are refused. B's own cancel touches nothing of A's. Each owner's status function returns their own shop only. |

Still to come:
- **The pre-debit notices,** about a day before the charges (31 Oct). They are recorded only if the tunnel is up then.
- **The renewal itself on 1 Nov,** handled by the watcher (`rn-watch.mjs`):
  - **A:** simulator SUCCESS, then the webhook (confirmed from the API) and the reconciler. Expected: one AutoPay payment of
    ₹999, a month added after the trial, the next charge at the new end.
  - **C:** FAILED, so past due. Then, if Cashfree makes a retry attempt, SUCCESS, so active again.

Fallback if the tunnel or session is gone on 1 Nov:
1. Start the harness and a new tunnel.
2. Point the Test webhook at the new URL.
3. Run `cf-simulate-charge.mjs <htc_ ref> SUCCESS`.
4. Reconcile.
5. Take an evidence snapshot.

Evidence (session scratchpad, no keys): `renewal.log`, `renewal.log.deliveries.jsonl`, `cf-evidence-2026-10-30T1450.json`,
`rn-watch.log`.

## 3. Database security and recovery

**Live, read-only, 30 Oct 09:57–09:59 UTC** (Supabase connector, SELECTs only):

| Check | Result |
|---|---|
| `2026-10-13-function-versions.sql` | **18 OLDER VERSION, 3 STILL THERE**, the same as the 25 Oct backup and the 13 Oct record |
| `open-policies.sql` | **no row**: no always-true policy, so the containment holds |
| Row security | **on for all 61 shop tables** (172 policies in `public`) |
| `schema-dry-run.sql` | **all 26 numbers 0** |
| Accounts | 30, as in the backup |
| Post-repair or Cashfree migration applied | no |

The data fingerprint wasn't run. It writes a session TEMP table, and this session's safety classifier refused that on
production. It is your preflight step in the SQL Editor.

**Backup:**
- `%USERPROFILE%\hangtag-backups\hangtag-wcorlmgkwcahyfastjoz-20261025-092928.dump`
- 1,572,945 bytes, SHA-256 `334bf7f29f82b07d4d30a35193dde8bf9cdc7df35572e68a0c4cdcb8715da336`, unchanged across every run.

**Rehearsal on the real backup** (`scripts/backup/rehearse-repair.mjs`, runbook §4): **52/52 passed on 30 Oct** with
the final migration and undo (51/51 on 27 Oct). Report: `<dump>.rehearse-repair.txt`; the copy was deleted.
- It restores into a simulated new Supabase project, where postgres is not a superuser (`verify-restore.mjs`: zero
  errors; definitions, rights and rows identical).
- **Before the repair:** 18 older functions plus 3 indexes, 0 open policies, dry run 0. Isolation on the real data:
  - every account (30) reading every shop table (61): 4,001 rows visible, **0 of another shop**;
  - 360 cross-shop change/delete attempts: **0 changed**;
  - 180 inserts naming another shop: **all refused by row security (42501)**;
  - owners' own writes: 69 of 69 work.
- **The repair** (the whole `schema.sql`, 819,383 bytes, sha256 `56cb6eaa…daee7`, as postgres in one transaction): report
  **83/83 ok, row 96 = 0**; versions all ok; no open policy; dry run 0; **data fingerprint identical**; isolation the same.
- **The post-repair migration:** report 13/13 ok; no row changed (one new, empty table). **The Cashfree migration,**
  run twice: its report 4/4, the post-repair report still 13/13, service role only.
- **Undos:** each exact, back to every hangtag function byte for byte as before the repair, and the fingerprint as
  before.
- **Modelling:** postgres may act as anon, authenticated and service_role. During the repair only, it is also a member
  of supabase_auth_admin and storage_admin (for `schema.sql`'s trigger on `auth.users` and its policies on
  `storage.objects`, which live accepted on 13 Oct). The local server is PostgreSQL 18.6; live is 17.6.
- **Not done:** the recovery drill into a real new project (B2).

## 4. Supabase runtime, scheduler and Cashfree configuration

**Runtime:** not verified (B2: no Docker here). Locally, the real `index.ts` entry files run under Node 26 with
stand-ins (`edge-entrypoints.test.mjs`, 8/8). The real handlers also ran against real Cashfree sandbox traffic (§2a). That
is not Supabase's runtime.

**Scheduler:** implemented, not activated (`operations/billing-reconcile-schedule.sql`: pg_cron, pg_net and Vault,
hourly at :07, with its undo and `checks/reconcile-schedule-health.sql`). `reconcile-schedule.test.mjs` proves the
job's request is accepted by the real reconcile handler and that any other secret is refused. Monitoring:
- Billing health (the last 5 runs);
- readiness (false after 26 hours without a complete run, and AutoPay is then no longer offered);
- the health check.

**Cashfree:** documented (`CASHFREE_RELEASE_READINESS.md` §3).
- **Test (sandbox):** the Subscriptions webhook is configured with the 7 events, pointed at the local tunnel (30 Oct).
  Remove it when testing ends.
- **Production, seen read-only on 30 Oct, nothing changed:**
  - Subscriptions webhooks: none.
  - The Subscriptions product pages are available, with no subscriptions.
  - Payment Methods: UPI Active, for one-time payments; the page doesn't cover subscription mandates.
  - Whitelisting: `florixtechnologies.com` Approved.
  - I didn't open the production API keys page.

**Still needed in production:**
- UPI AutoPay enabled for Subscriptions (commercial approval);
- the subdomain's whitelisting confirmed;
- the production webhook and keys.

**Separation:** Florix plan billing and shops' own payment integrations share no code, secret, table or endpoint.

## 5. Repository incident (found 30 Oct, repaired)

On 29 Oct at 22:20, outside this session, an interrupted write corrupted the repository's metadata. It looks like a
fetch by another tool (`FETCH_HEAD` and `.git/kilo` changed in the same minute) cut short by a crash or power loss:

- `.git/config` gained 359 NUL bytes;
- **`.git/packed-refs` became 840 zero bytes**, so every git command failed.

**Repaired 30 Oct, losing nothing:**
- the NUL bytes were stripped from the config, with every setting byte for byte as before;
- `packed-refs` was rebuilt from the reflogs (each branch's last recorded commit; `FETCH_HEAD` agrees for `origin/main`).
  Each of the 9 hashes was verified as a commit first.
- The current branch, its remote and 3 others had survived as loose refs, and all agree with their reflogs.
- `git fsck --connectivity-only` passes. No commit, working-tree file or remote was touched.
- The corrupt originals are kept in the session scratchpad (`git-config.corrupt-2026-10-29.bak`,
  `packed-refs.zero-filled-2026-10-29.bak`).
- Check the machine's disk and the tool that fetched at 22:20.

## 6. For your explicit approval (none of it has been run)

**P1: the live repair** (runbook §6).
- **What:** in the SQL Editor on hangtag:
  ```sql
  BEGIN; SET LOCAL lock_timeout = '10s';
  <the whole supabase/schema.sql>
  COMMIT;
  ```
  Use the release file: 819,383 bytes on this checkout, sha256 `56cb6eaa62ef4d378141b77fd0a2e02009043e16a537dd0c32e62b09ab4daee7`.
- **Before it:**
  - your fingerprint preflight (§3);
  - a fresh `pg_dump` with `scripts/backup/hangtag-backup.ps1`, checked: exit 0, `pg_restore -l`, sha256 recorded. It is
    the recovery point.
- **Impact** (rehearsed on the real backup):
  - replaces the 18 older functions and drops the 3 stale indexes;
  - **no row changes**;
  - no policy opens;
  - about a second of exclusive locks on Hangtag tables;
  - on any error or a lock wait over 10 s, nothing changes.
- **After it** (read-only):
  - the report: 83 ok, row 96 = 0;
  - function versions: all ok;
  - open policies: no row;
  - dry run: all 0;
  - the fingerprint: as before;
  - `sync-read-isolation.sql`: 0;
  - `shop-isolation-probe.sql`: read per the runbook §4 note.
- **Rollback:** `supabase/checks/2026-10-13-repair-undo.sql` restores every function byte for byte (rehearsed). No
  data rollback is needed. Last resort: the fresh dump, through the recovery drill.

**P2: the post-repair migration** (runbook §7), after P1's checks.
- **What:** the whole `20261019120000_hangtag_post_repair_integrity.sql` in one transaction. It refuses unless its own
  report is all ok.
- **After:** `post-repair-report.sql` shows 13 ok.
- **Rollback:** `operations/post-repair-integrity-undo.sql` (rehearsed).

**P3: the Cashfree migration** `20261027120000`, after P2.
- **What:** in one transaction. It refuses without P2.
- **After:** `cashfree-readiness-report.sql` shows 4 ok; `post-repair-report.sql` still shows 13 ok.
- **Rollback:** `operations/cashfree-readiness-undo.sql` (rehearsed, exact).

**P4 onwards** (deploy, secrets, Cashfree webhooks, schedule, self-check, `autopay_enabled`) follow
`CASHFREE_RELEASE_READINESS.md` §4. They need B2–B4 first, and each needs your approval at the time.

## 7. Tests (30 Oct, on the final code)

| Run | Result |
|---|---|
| `node tests/run.mjs tests/unit` | **92/92 files passed** (30 Oct, after findings 11–13). That includes `subscription-cashfree` **84** (+3), `autopay-page` 4, `architecture` 13 and `build` 6. |
| `node tests/run.mjs supabase/tests` (PGlite) | **45/45 files passed**. That includes `cashfree-autopay` **16** (+1), `cashfree-readiness` 8, `reconcile-schedule` 6, `edge-entrypoints` 8, `subscription-cashfree` 21, `post-repair-integrity` 48 and `tenant-rpc-isolation` 27. |
| The same seven on PostgreSQL 17 (`--import ./tests/helpers/postgres17.mjs`) | 16 / 8 / 6 / 8 / 21 / 48 / 27, all passed |
| Negative control: `cashfree-autopay` with the old charge timestamp (temporary copies, deleted) | The 3 renewal and cancel scenarios **fail**; with the fix, all pass |
| Negative control (30 Oct): the new tests on the code from before findings 11–13. Restored from the verified backup, then restored byte-identical. | Unit: exactly A10b, A19, A20 and A15c **fail**. DB: the withdrawn-charge and ended-mandate scenario **fails** on the old migration. With the fixes, all pass. |
| `scripts/backup/rehearse-repair.mjs` on the real backup | **52/52 passed**, re-run 30 Oct 14:54 UTC with the updated migration. The Cashfree report shows 4/4 ok, isolation is clean after it, the undo is exact, the archive sha256 is unchanged and the copy was deleted. |
| `npm run build` | 0 rule violations, 0 import cycles, lint 0 errors; `sw.js` cache `hangtag-718776c264` |
| The real Cashfree sandbox run | §2a |
