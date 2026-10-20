# Releasing Hangtag to production

The owner runs these steps: each one changes the live Supabase project or Vercel Production, and none is run from this
repository's tools without the owner's word. Work through them in order. A step that fails stops the release; the
rollback for each step is next to it.

Live project: `wcorlmgkwcahyfastjoz` (PostgreSQL 17). Vercel Production: `ee76f74` (deployment 7059827088, 2026-10-14). Branch to release:
`ux-productization`.

## 0. What this release contains
- **App:** everything on `ux-productization` since `ee76f74`; the Vercel Preview of the branch's tip is the candidate.
- **Database:** the whole `supabase/schema.sql`, run once in the SQL Editor. It is in order, safe to run again, and
  brings every table, function and policy to the release's version.
  - **Don't run the section files in `supabase/migrations/` by hand on the live project.** An older file run after a
    newer one puts older versions of its functions back. The two files of 2026-09-23, as they were until 2026-10-13,
    reopened every shop's rows to every account (the first) and could renumber every bill's lines (the second); both now
    leave a current database alone, but they still belong only to a database from before shops were kept apart.
  - **Never run `supabase db push` in this checkout.** It would apply every file it hasn't recorded. The live project's
    migration history has only the three September files: the two above and the Phase 1 design
    (`20260925180000_phase1_foundation.sql`, applied on 2026-09-25; its own tables, which no Hangtag table uses).
- **Edge Functions:** every function redeployed from the release commit. `npm run preflight:live` lists what is out of date.

## 0a. The live database on 2026-10-13 (read at 21:17 IST, catalog and query statistics only)
Between 20:39 and 20:45 IST the whole `schema.sql` ran, then the section files newest-first (3za … 3r), then the
first migration of 2026-09-23. Rebuilt the same way on PGlite, the result matches the live project's 162 functions
exactly (`supabase/tests/live-recovery.test.mjs` rehearses it and the way back):
- **Six tables open to every signed-in account.** The first migration's "Public access to …" policies came back on
  `hangtag_meta`, `hangtag_sales`, `hangtag_sale_items`, `hangtag_products`, `hangtag_images` and `hangtag_sizes`
  (`USING (true) WITH CHECK (true)`; policies are OR-ed, so any account reads and changes every shop's rows there). The
  app's single-row reads of the shop's settings and logo now get one row per shop and are refused (`PGRST116`), so every
  download stops there ("Pull from Supabase failed" since 20:49), and new bills and products of other shops reach every
  connected device.
- **18 functions in older versions** (3r, 3t, 3w, 3z instead of 3t … 3za): among them the bill-cancel guard (3y), the
  supplier-bill and serial locks (3za), the plan rules (3w) and the store closing when a plan ends (3t).

**Contained on the owner's word, 2026-10-13 23:45:55 IST (18:15:55 UTC)**, through `supabase db query --linked`:
```
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS "Public access to hangtag_products"   ON public.hangtag_products;
DROP POLICY IF EXISTS "Public access to hangtag_sizes"      ON public.hangtag_sizes;
DROP POLICY IF EXISTS "Public access to hangtag_images"     ON public.hangtag_images;
DROP POLICY IF EXISTS "Public access to hangtag_sales"      ON public.hangtag_sales;
DROP POLICY IF EXISTS "Public access to hangtag_sale_items" ON public.hangtag_sale_items;
DROP POLICY IF EXISTS "Public access to hangtag_meta"       ON public.hangtag_meta;
COMMIT;
```
Verified on the live project afterwards:
- **Policies:** the six tables keep exactly their 24 shop policies, identical to `schema.sql`. No policy anywhere in the database is always true, and report row 96's count is 0.
- **Access, as two shops' owners** (`supabase/checks/shop-isolation-probe.sql`):
  - other shops' rows visible: 0 in every table (before: A saw 103 other products, 49 bills, 121 bill lines, 17 settings rows);
  - changing or deleting the other shop's rows: 0 rows;
  - adding a row as the other shop: refused by row security;
  - changing an own row: works.
- **Settings and logo:** each shop reads exactly 1 `settings` and 1 `logo` row (the read the app makes).
- **Signed out:** 401 on all six tables (no privilege, as before).

Still to do: the 18 functions (step 3).

Since then (read-only, the database's own logs, 2026-10-15): the only statements after the containment were two
read-only check scripts (10-14 06:32 and 06:38 UTC); no function or policy has changed. `hangtag_shop_changes`, which
team phones and now owner devices use to catch up, is current; `hangtag_biz_changes` is the older 3r version (changes
to the shop's own fields and units are not noticed by the change check until step 3).

## 1. Before anything changes (read-only)
1. `npm run preflight:live` reports, per function:
   - whether it is deployed, and whether its code is newer than the deploy;
   - its JWT setting;
   - which secrets it needs (names only; it never prints values).
2. In the SQL Editor, run the report at the end of `supabase/schema.sql` (the final `SELECT check_name …`). It only
   reads. Note which rows are not ok: they say which sections are missing.
3. Open the Vercel Preview of the release commit, signed in to Vercel. **It uses the live database:** look, don't change
   anything.
4. Pick a quiet hour. Tell the staff, and ask them to keep their phones online so queued work uploads before the
   update.

## 2. Backups
- **Platform backup.** In the Supabase dashboard, Database → Backups, note the time of the latest daily backup. With
  point-in-time recovery, note the current time instead: it is the point to return to.
- **Your own copy (recommended).** Take a logical dump with the database password, on a machine with `pg_dump` 17.
  Use the connection string from Supabase → Connect: the session pooler where the network has no IPv6.
  ```
  pg_dump "<connection string>" -n public -n auth -F c -f hangtag-before-release.dump
  ```
  The dump holds customers' and staff's personal data:
  - keep it encrypted and off shared drives;
  - never commit it, attach it or upload it;
  - delete it once the release has settled.

  `npx supabase db dump --linked` is an alternative on a machine with Docker.

## 2a. Before the repair can be approved: the evidence
The repair (section 3) stays blocked until each item below exists and the owner approves the run itself, separately. As of
2026-10-15, none exists: the live project has 0 physical backups and point-in-time recovery off.

1. **The backup.** A `pg_dump` 17 of the live project (step 2), taken by the owner. Record:
   - the time (UTC);
   - `pg_dump --version`, and the server's PostgreSQL 17.6 and system identifier `7678071634733212629` (the dump's header);
   - the file's size and sha256.

   Keep it encrypted, outside the repository. The bills bucket's files are not in a dump; only their rows are.
2. **An isolated restore.** Restore it into a database that is not the live project, and that the app can't reach:
   - a local PostgreSQL 17 (Docker `postgres:17` with the `anon`, `authenticated`, `service_role` and `supabase_*` roles
     created first), or a throwaway Supabase project;
   - `pg_restore` exits 0. Record every error line; each one is explained, or the restore doesn't count.
3. **Integrity, the restored copy against live.** Run each check on both and keep both outputs. Live is read-only and
   close to the dump's time.
   - `supabase/checks/data-fingerprint.sql`: the same 61 shop tables, with the same row counts and hashes (rows
     written on live after the dump are the only allowed difference, named table by table);
   - `select count(*) from auth.users`: the same count;
   - `2026-10-13-function-versions.sql`: the same baseline (18 OLDER VERSION, 3 STILL THERE; 17 if the console
     permissions update of §6b was applied);
   - `open-policies.sql`: no row on either;
   - `restore-row-counts.sql`: every table of `public` and `auth` (and storage objects by bucket) with the same count,
     line by line (rows written on live after the dump named);
   - `restore-fk-orphans.sql` on the restored copy: no row (the restore loads with triggers off, so no reference may
     point at nothing). Both checks are under test (`supabase/tests/restore-checks.test.mjs`).
4. **A rehearsal on the restored copy** of the exact run in section 3:
   - `supabase/schema.sql` of the release commit, unchanged from `ee76f74` to `1b9b573`. Its reference hash is the
     repository's own bytes (LF), `git show <commit>:supabase/schema.sql | sha256sum`: 809,397 bytes, sha256
     `fde12118a672b66c4f7271a675ec2a02049a74ca32370ba595ada6336acc184c`. A Windows checkout (CRLF) of the same file is
     819,383 bytes, `56cb6eaa62ef4d378141b77fd0a2e02009043e16a537dd0c32e62b09ab4daee7`; the request names which copy ran.
     It runs between `BEGIN;` + `SET LOCAL lock_timeout = '10s';` and `COMMIT;`;
   - then the section 3 "After" checks: the report all 83 rows ok with row 96 0; `2026-10-13-function-versions.sql` all
     21 ok; `open-policies.sql` no row; `schema-dry-run.sql` all 0;
   - `data-fingerprint.sql` identical before and after; `sync-read-isolation.sql` 0 rows of other shops;
   - `2026-10-13-repair-undo.sql` on a second restored copy puts the 18 functions back byte for byte.
5. **A fresh read-only preflight on live,** on the day of the request (section 3 "Preflight"):
   - the identity (ref, version, system identifier);
   - the dry run all 0;
   - the catalog unchanged since 2026-10-14 (or each difference named);
   - the migration history;
   - the data fingerprint;
   - the backup status.
6. **The approval request** names:
   - the dump's sha256 and where it is kept;
   - the outputs of items 2–5;
   - the script's sha256 and the undo;
   - the time window and who runs it.

   Approving it is the owner's decision alone. Until then, nothing in section 3 runs.

## 3. Database (SQL Editor)
**The ordered procedure, from preflight to recovery, is `supabase/REPAIR-RUNBOOK.md` (reviewed 2026-10-18).** This
section keeps the detail.

The whole `supabase/schema.sql` of the release commit, once, in one transaction. On the live project of 2026-10-13
(compared with `schema.sql` object by object, read-only) it changes:
- the bodies of the 18 older functions;
- the three redundant indexes the first migration put back (dropped);
- `hangtag_sales_money_check`, dropped and re-added as `schema.sql` has it (NOT VALID: no existing row is re-checked).

Exactly this, and no policy, column, trigger, row security, grant or row: `supabase/tests/repair-inventory.test.mjs`.

Every other table, column, default, trigger, policy, grant and function is re-applied as it already is.

**Before** (read-only; each file in `supabase/checks/` says what to expect):
1. `schema-dry-run.sql`: all 26 numbers 0. On 2026-10-13 at 23:50 IST they were. Then `schema.sql` changes no shop's
   rows. A number that isn't 0 names the rows it would change: stop and look.
2. `2026-10-13-function-versions.sql`: 18 OLDER VERSION and 3 STILL THERE. That was the live baseline on 2026-10-13.
3. Note the backup point (step 2).

**Run** (a quiet minute; the run of 20:39 took about a second): paste this, the whole `schema.sql` where it says so:
```
BEGIN;
SET LOCAL lock_timeout = '10s';
-- the whole supabase/schema.sql here
COMMIT;
```
One explicit transaction: if any statement fails, or a table stays locked for 10 s, nothing at all changes. Copy the
error, stop, and run it again later.

**After** (read-only):
1. The report (the final `SELECT check_name …` of `schema.sql`, run on its own): **all 83 rows ok**, row 96 0.
2. `2026-10-13-function-versions.sql`: all 21 ok.
3. `open-policies.sql`: no row.
4. `shop-isolation-probe.sql`: what its header says (it changes nothing: every write is rolled back).
5. `schema-dry-run.sql`: still all 0.

All of this was rehearsed on PGlite, on PostgreSQL 17 and 18, from the live project's state: `supabase/tests/live-recovery.test.mjs`.

**Then, separately approved: the post-repair migration** (`supabase/REPAIR-RUNBOOK.md`, step 7; its report 13 rows, all
ok). From then on, until it is folded into `schema.sql`, **every run of `schema.sql` is followed by the migration again**:
a `schema.sql` run puts the older bodies of the ten functions it changes back (`supabase/checks/post-repair-report.sql`,
read-only, shows which rows then read false).

**Preflight of 2026-10-14 (06:32–06:38 UTC, read-only, on the live project):**
- **Which database:** `wcorlmgkwcahyfastjoz`, PostgreSQL 17.6, system identifier 7678071634733212629.
- **Dry run:** all 26 numbers 0.
- **Catalog:** exactly as after the containment: the 18 functions, the 3 indexes, the older drift and nothing else.
- **Migration history:** only the three September files.
- **Data fingerprint:** 61 shop tables, 4,205 rows. Take it again right before the run.
- **Size:** the Management API took an 830 KB script, larger than the 819 KB repair.

**What runs:** `supabase/schema.sql` of `ee76f74` (repository bytes: 809,397, sha256 `fde12118a672b66c…`; a Windows
checkout: 819,383, `56cb6eaa62ef4d37…`; §2a item 4), between `BEGIN;` +
`SET LOCAL lock_timeout = '10s';` and `COMMIT;`.
- **Constraints:** 49 of its 85 `ADD CONSTRAINT` re-check existing rows: the same constraints the 20:39 run validated, enforced on every write since. The other 36 are `NOT VALID`.
- **Column types:** its 5 `ALTER COLUMN … TYPE` name the type the columns already have (`numeric(12,2)`), so no table is rewritten.
- **Locks:** exclusive locks on Hangtag tables are held until `COMMIT`, about a second as on 2026-10-13. The app's requests wait for them.

**Recovery:**
- **No platform backup:** the live project has none. 0 physical backups, point-in-time recovery off.
- **Data:** the repair changes no row (dry run). A `pg_dump` before it (step 2) is still the prudent copy.
- **Undo:** `supabase/checks/2026-10-13-repair-undo.sql` puts back exactly what the repair replaces. That is the 18 functions as captured from the live project on 2026-10-14, and the 3 indexes. It is rehearsed: byte for byte the live versions again, no row changed. It brings back the older functions' gaps, so it is only for a repaired function that is proven to break the app, and only on the owner's word.
- **Checks to add for the proof after the run:** `data-fingerprint.sql` (the same before and after) and `sync-read-isolation.sql` (a full sync as two owners reads no other shop's row).

**Stays as it is** (older and harmless, not from 2026-10-13):
- the owner foreign keys of six tables carry older names (`hangtag_sales_owner_fkey` …), with the same definition;
- (corrected 2026-10-18: `hangtag_sales_money_check` doesn't stay — the repair re-adds it, NOT VALID; see above);
- `hangtag_payments_provider_fee_check` is missing, but the payments' shape check already refuses a negative fee.
- **Rollback.** The sections only add:
  - tables, columns and functions;
  - looser unit checks;
  - guards.

  The app now in Production keeps working on the new database (`supabase/tests/upgrade-live-database.test.mjs` runs the
  sections on the previous release's database). So the usual rollback is the app's (step 6), not the database's.
  Restoring the backup is the last resort: it loses everything written since it was taken. Never roll back by running
  an older section file: that is what put older functions back on 2026-10-13.

## 4. Secrets
Set them from a file outside the repository, so no value lands in the shell history or the repository:
```
npx supabase secrets set --env-file C:\path\outside\the\repo\hangtag-live.env --project-ref wcorlmgkwcahyfastjoz
```
- **`ANTHROPIC_API_KEY`:** bill reading. Use a key from the Anthropic Console, limited to this use, with a monthly spend
  limit. Without it, bill reading says "Reading bills isn't set up yet".
- **`AGENT_ALLOWED_USERS`:** only if the Agent's AI is wanted (it also uses `ANTHROPIC_API_KEY`).
- **Providers, only when each goes live:**
  - payments: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `PAYMENT_ALLOWED_USERS`;
  - receipt sending: `SEND_ALLOWED_USERS` and a channel's keys;
  - subscriptions: `SUBSCRIPTION_RAZORPAY_KEY_ID`, `SUBSCRIPTION_RAZORPAY_KEY_SECRET`, `SUBSCRIPTION_WEBHOOK_SECRET`, `APP_URL`;
  - webhooks: `WEBHOOK_DISPATCH_SECRET`.
- `supabase/functions/deploy.json` is the full list per function.
- Delete the env file afterwards. A key that was ever pasted into a chat, a ticket or a commit is rotated in its
  provider's console.
- Check the real Claude path once, from your own machine, before or after the deploy:
  ```
  HANGTAG_EVAL_ANTHROPIC_KEY=<the key> npm run eval:extract-bill
  ```
  The key is passed only to that command, never written to a file.

## 5. Edge Functions
Deploy each function from the release commit:
```
npx supabase functions deploy <name> --project-ref wcorlmgkwcahyfastjoz
```
- **With `--no-verify-jwt`:** `team`, `webhook-dispatch`, `payment-webhook`, `subscription-webhook`, `delivery-status`
  and `receipt`.
  - Each checks its caller itself: a single-use QR token or a session for `team`, a shared secret for
    `webhook-dispatch`, provider signatures for the webhooks, and per-receipt tokens.
  - The app's key is a publishable key, not a JWT. So with verification on, the gateway refuses a phone redeeming a
    team QR and the scheduler calling `webhook-dispatch`, before either function runs.
  - The gates are unit-tested: `tests/unit/team.test.mjs`, `tests/unit/webhooks.test.mjs`.
- **With verification on:** `extract-bill`, `agent`, `payment-gateway`, `send-receipt` and `subscription`.
- Deploy `subscription` and `subscription-webhook` only when subscriptions go live.
- Then `npm run preflight:live` should list only providers left off on purpose.
- **Rollback.** Deploy the previous version of a function from the previous release's commit (`git worktree add` that
  commit, deploy from there).

## 6. The app (Vercel)
1. In Vercel → the project → Deployments, find the Preview of the release commit (the commit must be pushed to
   `ux-productization`) → Promote to Production.
2. Open Production in a private window. Phones pick up the update the next time the app starts with a connection. The
   service worker's cache name changes with every release.
- **Rollback.** Deployments → the deployment Production had before → Promote to Production. Since 2026-10-18 13:47 UTC
  Production serves `262dbdb` (build `hangtag-1601181284`); before it, a tree deployed outside git (`hangtag-1803427d85`,
  AUDIT 125); before that, `ee76f74`'s deployment (7059827088). It is instant, and the database needs nothing (step 3).

## 6a. Checking signed in: Production now, and a Preview before any later promotion
Production and every Preview read and write the **live** shop: check without changing real stock or making real bills, sign in only
with your own accounts, and run no SQL. Tick each:
1. **The build.** Settings → Advanced → Diagnostics & health → "Build" shows `hangtag-<hash>`, the cache name in the
   release commit's `sw.js` (for the catch-up commit it is given in the release report). A hard reload shows the same.
2. **Cloud refresh.** "Refresh" says everything is up to date; "Last full sync" moves to now; no new "Pull … failed".
3. **Diagnostics.** No new entries after the refresh; a slow call, if any, says "network …" and "page hidden" where it
   applies. (In builds after `1b9b573`: a download that keeps failing shows once as "download failed (…)", naming the
   part, and once as "download recovered (…)" when it works again; each failed call still adds its own "connection
   failed (…)" line.)
   In builds with the 2026-10-18 network-entry merge (AUDIT 130; in Production since 2026-10-18 13:47 UTC, `262dbdb`), a call that keeps failing is one
   "connection failed (…)" line with a count (×N) and "since …", and earlier entries stay.
4. **Your shop only.** The products, bills and customers are your shop's; a second owner account (another shop) sees
   none of them.
5. **Offline recovery, two devices.** Open the Preview on a computer (A) and a phone (B), both signed in to your shop.
   Without changing anything: turn B's network off and on, and put B in the background for a minute and bring it back —
   no error, nothing in its sync queue or review, the same data as A. *Only if you choose to change one live record:*
   with B offline, edit a test product's name on A, bring B back online — within 20 s B shows it — then change it back.
   (The isolated two-device test proves bills, returns and stock this way without live data. It can't prove what real
   Supabase realtime does when it reconnects — the tests refuse the realtime socket and call the app's handler directly
   — so note how long B took to catch up after its network came back: this check is the first real evidence of it.)
6. **Workflows, non-destructively.** Open a bill, a return screen and Stock without saving; open "Upload bill" (it says
   reading isn't set up yet, and offers entry by hand) and cancel; open Plans & Billing (online payment shows as not
   available).
7. Note anything wrong with its time, and download the Diagnostics report.

**Who does each check.** Production has served the pushed commit `262dbdb` since 2026-10-18 13:47 UTC (AUDIT 163), so
these checks now apply to Production as it is; it uses the same live database as a Preview.
| Check | Who | Why |
|---|---|---|
| 1 build, 2 refresh, 3 Diagnostics | The owner, own account | Read from the owner's own device |
| 4 your shop only | The owner, with a second account of their own (a second shop) | The client's shop is never used to test isolation |
| 5 two devices | The owner, own devices and shop; the optional live edit only if the owner chooses | It changes a live record |
| 6 workflows, 7 the report | The owner; then the client, in their own shop | Nothing is saved |
| The client's trial | The client, signed in, after §6c step 5: Plans & Billing shows "N days remaining — Trial ends on …", the end 30 days after their shop was set up (or the end the owner gave); nothing is locked | Only the client can sign in to their shop |
| The client's daily work | The client: bills, returns, stock, as they work | Their business, not a test |

## 6b. Client access: the free trial and the Platform Console (the owner)
A shop's trial is as long as the "Free trial" plan says **when the shop finishes setting up**; its end is written then, and
changing the plan later never lengthens a trial already running. **The standard from 2026-10-18 is 30 days** for every new
shop. Rehearsed end to end on `schema.sql` (15 checks) and on a copy built like the live project, its 18 older functions
included (22 checks).
1. **Audit, read-only** (needs the owner's approval as production SQL): `supabase/checks/2026-10-18-trial-audit.sql`, run
   whole in the SQL Editor after changing the two emails at its top (the client's, and the owner's own). One SELECT; it
   changes nothing and returns one table: the trial new shops get, console edits to it, trial lengths (counts), the
   client's trial and what it is owed, console actions on that shop, console staff (counts), **the owner's own console
   role**, every shop below 30 days with its verdict and the days it is owed, and (part 9) the owed shops as a list for
   step 5. (The editor shows only a script's last result, so the older `2026-10-18-trial-diagnosis.sql` must be run one
   query at a time.)
2. **The first console account.** `/platform/` shows "No access" and the account ID. First, read-only,
   `supabase/checks/2026-10-18-console-access.sql` (that ID filled in; one row: is there an active super admin, is the ID
   an account, did the console refuse it). Only if there is no active super admin (approval; once):
   `supabase/operations/2026-10-18-first-super-admin.sql`, the same ID filled in. It adds one row (that account,
   super_admin, active) and only while no active super admin exists and the ID is a real account: one row back means
   granted, none means nothing changed (a second run, a mistyped ID). Undo: set that row's `active` to false. There is no
   public sign-up for the console; further staff are added in the console (Settings → Staff), by role. Rehearsed on a
   live-like copy, with both files as written.
3. **Sign in** at `/platform/` with that account (the app's own sign-in). The database checks the role on every action
   and keeps an audit log (who, role, shop, reason, before and after).
4. **New shops get 30 days:** Plans → Free trial → days 30 (audited as `plan.update`). Only shops set up afterwards get it.
5. **Shops owed days** (part 8, verdict "owed"): Customers → search the account ID → Extend → its `extend_days`, with the
   reason, **the same day as the audit** (Extend counts from the trial's end or now, whichever is later). The preview shows
   the new end first: it should be the shop's `entitled_end` (start + 30 days; under a day later). Nothing else changes.
   - Several shops, or the exact entitlement wanted: `supabase/operations/2026-10-18-trial-corrections.sql` (writes;
     approval of that operation and of the shops it names). Your account ID and the approved shops' account IDs at its
     top (part 9's list, or fewer); without a list it changes nothing, and a listed shop that isn't "owed" by part 8's
     rule is left alone. One statement: each listed owed shop's trial ends exactly 30 days after it started, audited as
     `customer.extend` (via SQL); nothing unless your account is an active super admin, nothing on a second run.
     Rehearsed on a live-like copy (9 checks).
   - Not owed: a shop whose 30 days from its start have passed (more is the owner's goodwill decision), a shop whose email
     had already had a trial (0 days, by design), a shop with a paid period. A shop with AutoPay set up: Give a plan.
   - Longer access stays possible: Extend 1–90 days per action (repeatable) or Give a plan (1, 3 or 6 months, recorded as a
     manual payment), both audited. Promo codes only discount paid plans, which can't be bought while payment is off.
- On the live database until the repair (section 3), Suspend, Restore and End all sign-ins are refused for every role (their
  permissions arrived with the newer functions); Extend, Give a plan, Plans and Promotions work. To have them before the
  repair (optional; approval of that DDL): `supabase/operations/2026-10-18-console-permissions.sql` puts back only the
  current console permissions function (it maps a role to its list; no table, no row), byte for byte from `schema.sql`;
  its last row says whether it took. Undo: `2026-10-18-console-permissions-undo.sql` (the live body now). Afterwards
  the 13 Oct version check shows 17 older functions, not 18 (§2a item 3 then expects 17), and `2026-10-13-repair-undo.sql`
  would put the older body back too. Rehearsed on a live-like copy (12 checks): before it Suspend is refused; after it
  Suspend locks the shop, Restore unlocks it, End all sign-ins ends the owner's and the team's sessions, each audited;
  read-only and billing roles still refused; the undo puts the live body back.

## 6c. Where things stand, and the owner's approvals (2026-10-18)
**Since the push below, not committed (no commit authorised):** the thirteenth to fifteenth sessions' work — the
repair runbook and inventory, the restore rehearsal, the post-repair migration (twelve sections, with its order guard,
generated by `scripts/gen-post-repair.mjs` from `schema.sql` and the stated edits in
`supabase/tests/post-repair-edits.mjs`) and its tests, tenant-isolation tests, Cashfree plan payments, the test-project
webhook probe, and the billing remediation — the billing mode, AutoPay's readiness and registry, reports in order,
reconciliation, offer holds, refunds and disputes kept for review, the console's billing review (REMEDIATION steps 4, 5,
7, 8, 9; AUDIT 145–186); and on 2026-10-20 (AUDIT 187–197) the provider-call limit per account (step 11), the
migration's refusal to commit unless its report is all ok, the runbook's stop conditions, `npm run probe:reconcile`, the
pilot checklist (`PILOT-CHECKLIST.md`) and the owner's decisions (§6e). None of it changes Production until the repair,
the migration and the deploys of §6d. Its verification, 2026-10-20 (AUDIT.md, the sixteenth session's "Test results"):
`npm test` **189/189 files** (6,764 checks: 89 unit, 38 database, 4 eval, 58 browser; 0 isolation violations) and
**38/38 on PostgreSQL 17** (1,758 checks), none failed, timed out or skipped; `npm run check`, `lint` and `build` clean
(`sw.js` `hangtag-db09103bf2`, unchanged). **Not run** (no infrastructure or keys here): the concurrent-returns test, Cashfree's
sandbox, a deployed test project, the Razorpay test-mode proof; and nothing on the live project.

**Committed and pushed to `ux-productization` on 2026-10-18; in Production since 13:47 UTC that day (promoted outside this work).** App build `hangtag-1601181284`
(the cache name in `sw.js`). Before the push: `npm test` 178/178 files and 31/31 on PostgreSQL 17, `npm run check` and
`npm run lint` clean (AUDIT, 2026-10-18 twelfth session). In it, beyond Production's `ee76f74`:
- Diagnostics: a download that keeps failing is one entry per part plus one when it recovers, with retries at 1, 2, 4,
  then every 5 minutes; a server call that keeps failing is one entry with a count and "since …"; the earlier history
  stays through a 3-hour outage (AUDIT 117–118, 130, 140).
- The console's dashboard shows only figures the database sent, on its older and newer answers (AUDIT 128, 135).
- `subscription` / `subscription-webhook` corrected in code, **not deployed** (AUDIT 136, REMEDIATION.md status).
- Purchases and stock: line money as sales, "Received today", opening stock's cost, history labels (AUDIT 139).
- The owner's SQL (§6b) and the restore checks (§2a), each under test (AUDIT 138, 144).

**What `hangtag.vercel.app` serves:** `262dbdb`, build `hangtag-1601181284` (its `sw.js`, Last-Modified 2026-10-18
13:47:30 UTC; read again 2026-10-19). It was promoted outside this work; GitHub's deployment list may still name
`ee76f74` as Production. The signed-in checks (§6a) now apply to Production itself; if one fails, roll back (§6).

**The owner's approvals, in order.** Nothing below has been run.
1. Read-only: `supabase/checks/2026-10-18-console-access.sql`, your account ID filled in.
2. Only if it shows no active super admin: `supabase/operations/2026-10-18-first-super-admin.sql`, the same ID.
3. In the console: Promotions → Plans → Free trial → Edit → Days 30 → Save. Shops that finish setting up from then on
   get 30 days (audited). The editor accepts 1–90: keep it at 30 or more.
4. Read-only: `supabase/checks/2026-10-18-trial-audit.sql`, the client's email and yours filled in.
5. Only the shops you approve: Customers → Extend by part 8's `extend_days` with a reason, or
   `supabase/operations/2026-10-18-trial-corrections.sql` with those account IDs (part 9).
6. Optional: `supabase/operations/2026-10-18-console-permissions.sql` (Suspend, Restore, End all sign-ins before the
   repair; the undo is beside it).
7. The signed-in check (§6a) on Production, which already serves `262dbdb`; keep it, or roll back (§6) if a check
   fails.
8. The client: after step 5, reopen the app (or "Check again" on the lock screen), then §6a's checks with their sign-in.

**Pending work, by what it waits for**
| Waits for | Item | Next step |
|---|---|---|
| Nothing (done; in Production since 2026-10-18 13:47 UTC) | AUDIT 117–118, 128, 130, 135–140, 144 | The signed-in check (§6a) |
| The owner's signed-in check | §6a; the dashboard on live's older function (128, 135); realtime catch-up timing (120) | §6a, noting how long a second device takes to catch up |
| The owner's approval (production) | Steps 1–8 above; Production promotion; deploying `subscription` / `subscription-webhook` (only after the repair, a test project and REMEDIATION.md's switch-on order); bill reading's key and `extract-bill` deploy (81); the Agent's key (74) | Each its own word |
| A backup | The repair (78, 91, 99; `supabase/REPAIR-RUNBOOK.md`, rehearsed on a restored copy: 158); then the post-repair migration, prepared and tested (147–152, 162: returns one at a time, tracked stock records, bill lines' unit, deleted products' marks, own-shop capabilities, billing notifications and exceptions, no payment from a suspended shop) and the billing remediation (173–182: the billing mode, readiness, the AutoPay registry, reports in order, reconciliation's run log, offer holds, the console's billing review); low-stock decimals (157) | The runbook, step by step |
| A real multi-connection PostgreSQL | The concurrent proof of the returns fix (114, 148): `supabase/tests/concurrency/` | Docker `postgres:17` or a throwaway project, never the live one |
| Keys or a test project | Cashfree's real sandbox (156: `npm run eval:cashfree-sandbox`); the deployed webhook on a test project (`npm run probe:cashfree-webhook`, 165) and a real Cashfree delivery to it; a reconciliation run there (`npm run probe:reconcile`, §6d step 2g); for AutoPay later, the Razorpay test-mode proof (REMEDIATION.md) | Sandbox keys; a Supabase project that isn't the live one |
| The owner's decision | The reconciler's scheduler; refunds and disputes; renewal grace; the provider-call limits; a Cashfree refund sweep; AutoPay — each with its options and the gate it is needed by in §6e | Each its own word |
| Evidence the repository can't see | The six `auth:token` failures of 10-13 (104): the device's own report times; whether anything was read across shops while the policies were open (145: the project's logs, if kept); a staging project (46, 73); real-provider evals (31, 42) | The owner's Diagnostics report and logs; the owner's decision on staging and keys |
| Design, not a fix | The online store's Add (51: the owner's call); PLAN I5–I30 (roadmap) | Planned work |

Online payment, AutoPay and bill reading stay unavailable throughout.

## 6d. Plan payments (Cashfree): the deployment checklist (each step the owner's approval)
Nothing below has been done. Payments stay off until the last step. Use a separate Cashfree account or app for Hangtag's
plans where possible; on a shared Florix account, orders that aren't Hangtag plan payments are ignored by the webhook,
but a payment webhook set in the dashboard to this function's address also sends it every other product's events.
1. **The database:** the repair and the post-repair migration (`supabase/REPAIR-RUNBOOK.md`, steps 1–7; its report 13 rows).
   The live database stays in billing mode `live` (the migration's default): it counts only production money.
2. **A test project first.** Nothing here touches the live project; every script below refuses its ref.
   a. *Sandbox keys.* In Cashfree's merchant dashboard, switch to the sandbox (test) environment → Developers → API Keys →
      generate. The App ID and the secret key (it starts `cfsk_ma_test_`) stay in a password manager or in a file
      outside this repository; never in chat, a commit or a screenshot.
   b. *The keys alone:* `HANGTAG_EVAL_CASHFREE_APP_ID=… HANGTAG_EVAL_CASHFREE_SECRET_KEY=… npm run eval:cashfree-sandbox`
      — a ₹1 link is made, read back with Hangtag's notes, the same request gives the same link, an unknown link is a
      404. Every line PASS.
   c. *A test project:* a new Supabase project (never `wcorlmgkwcahyfastjoz`). SQL Editor: `supabase/schema.sql` whole
      (its report all ok), then `supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql` whole (its last
      result is its report: 13 rows, all ok; it refuses to commit otherwise, with an error naming the rows), then
      `UPDATE public.hangtag_billing_settings SET billing_mode = 'test';` — a test project counts sandbox money only.
      Without it, sandbox keys are refused there (no checkout) and every sandbox notification is kept for review as
      `mode_mismatch`, never acted on.
   d. *Its secrets and functions* (Supabase CLI, signed in; `<test-ref>` is the new project's ref): put
      `SUBSCRIPTION_PROVIDER=cashfree`, `SUBSCRIPTION_CASHFREE_APP_ID`, `SUBSCRIPTION_CASHFREE_SECRET_KEY`,
      `SUBSCRIPTION_CASHFREE_ENV=sandbox`, `SUBSCRIPTION_TEST_MODE=true`, `APP_URL` (an https address) and
      `SUBSCRIPTION_RECONCILE_SECRET` (32 random characters or more, e.g. `openssl rand -hex 24`) in a file
      outside the repository, then `npx supabase secrets set --project-ref <test-ref> --env-file <that file>`,
      `npx supabase functions deploy subscription --project-ref <test-ref>` and
      `npx supabase functions deploy subscription-webhook --no-verify-jwt --project-ref <test-ref>`.
      Every setting by name (values only in that file and a password manager; checked against the code 2026-10-20):

      | Where | Setting | |
      |---|---|---|
      | Both functions, the test project's secrets | `SUBSCRIPTION_PROVIDER` = `cashfree` | required for Cashfree (Razorpay is the default when its key is set) |
      | | `SUBSCRIPTION_CASHFREE_APP_ID`, `SUBSCRIPTION_CASHFREE_SECRET_KEY` (`cfsk_ma_test_…`) | required |
      | | `SUBSCRIPTION_CASHFREE_ENV` = `sandbox`, `SUBSCRIPTION_TEST_MODE` = `true` | both required: the sandbox is refused without `TEST_MODE`, and a `cfsk_ma_prod_` key with it |
      | | `SUBSCRIPTION_RECONCILE_SECRET` (32+ characters) | required for the reconciler (without it: 503) |
      | `subscription` only | `APP_URL` (an https address: the return page) | required; `SUBSCRIPTION_ALLOWED_ORIGINS` optional |
      | Supabase sets these itself | `SUPABASE_URL` (the webhook address each link carries), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | never set by hand |
      | This computer, `npm run eval:cashfree-sandbox` | `HANGTAG_EVAL_CASHFREE_APP_ID`, `HANGTAG_EVAL_CASHFREE_SECRET_KEY` | required (sandbox keys only) |
      | | `HANGTAG_EVAL_CASHFREE_NOTIFY_URL`, `HANGTAG_EVAL_CASHFREE_WAIT` | optional: the real delivery of step e |
      | This computer, `npm run probe:cashfree-webhook` | `HANGTAG_PROBE_WEBHOOK_URL`, `HANGTAG_EVAL_CASHFREE_SECRET_KEY` | required |
      | This computer, `npm run probe:reconcile` | `HANGTAG_PROBE_WEBHOOK_URL`, `HANGTAG_PROBE_RECONCILE_SECRET` | required |

      Set the computer's ones in the terminal session only, never in a file in this repository. The `NAME=… npm run …`
      form of steps b, e and g is Git Bash's; in PowerShell set each first, typed or pasted at the prompt so it stays out of the
      command history (`$env:HANGTAG_EVAL_CASHFREE_SECRET_KEY = Read-Host`), run `npm run …`, then `Remove-Item Env:HANGTAG_*`.
   e. *The deployed webhook:* `HANGTAG_PROBE_WEBHOOK_URL=https://<test-ref>.supabase.co/functions/v1/subscription-webhook
      HANGTAG_EVAL_CASHFREE_SECRET_KEY=… npm run probe:cashfree-webhook` — GET 405, a wrong or missing signature 400, a
      correctly signed notification of no Hangtag payment 200 (the function holds the key and checks Cashfree's
      signature as Cashfree makes it). Nothing is written. Then **a real delivery from Cashfree**: step b again with
      `HANGTAG_EVAL_CASHFREE_NOTIFY_URL=` that same address and `HANGTAG_EVAL_CASHFREE_WAIT=300`; pay the printed link
      with Cashfree's sandbox test details. In the test project, `SELECT kind, ref, amount FROM
      hangtag_billing_exceptions` shows one `unknown_order` row for that link (a paid Hangtag link no checkout recorded:
      kept for review, nothing activated), and Cashfree's webhook logs show the delivery answered 200.
   f. *The app end to end (before any real payment):* a copy of the app whose `config.js` names the test project, served
      at an https address (the one in `APP_URL`, and in `SUBSCRIPTION_ALLOWED_ORIGINS` if different), never a commit of
      that `config.js`. Sign up a test shop there and finish its setup (its trial starts). Each line is read in the test
      project's SQL Editor (one query at a time):
      - **Pay a plan** (Plans & Billing → a plan → Cashfree's sandbox success): the app shows the plan; `SELECT status,
        amount, currency, provider_payment_id, period_end FROM public.hangtag_subscription_payments ORDER BY created_at DESC
        LIMIT 3` — one `paid` row at the plan's amount; `SELECT period_end FROM public.hangtag_subscriptions` — moved once,
        by the plan's months.
      - **The same notification again** (Cashfree's dashboard → the webhook's log → resend, where offered): nothing
        changes; `SELECT event_type, outcome, count(*) FROM public.hangtag_billing_events GROUP BY 1, 2` — that event once.
      - **A payment that fails or is left** (the sandbox's failure, or the page left until it expires): that row `failed`
        or `expired`, no time added.
      - **A refund** of the paid one (Cashfree's sandbox dashboard): `SELECT kind, ref, amount, status FROM
        public.hangtag_billing_exceptions ORDER BY id DESC LIMIT 5` — a `refund` row, open; `period_end` unchanged (a refund
        never takes time away by itself: §6e, the owner's decisions); the console's Payments → Billing review lists it.
      - **Then step g**: the reconciliation repairs nothing, and Billing review says "Money and time agree: Yes".
   g. *The reconciler:* `HANGTAG_PROBE_WEBHOOK_URL=https://<test-ref>.supabase.co/functions/v1/subscription-webhook
      HANGTAG_PROBE_RECONCILE_SECRET=… npm run probe:reconcile` (not a hand-typed curl: the secret would stay in the shell's
      history) — GET 405, no secret and a wrong one 401 with nothing read, the right one one run that is ok and complete
      (it prints what it checked and repaired), a second call at once `busy`. Every line PASS; if the first call is already
      `busy` (a run in the last 5 minutes), run it again 5 minutes later. The console's Payments → Billing review (pointed
      at the test project) then shows the run, and "Money and time agree: Yes". (A request without the
      `x-hangtag-reconcile` header is a provider notification to the function: unsigned, it is refused with 400.)
3. **The live project's secrets** (never test keys there; never `SUBSCRIPTION_TEST_MODE` there):
   `SUBSCRIPTION_PROVIDER=cashfree`, `SUBSCRIPTION_CASHFREE_APP_ID`, `SUBSCRIPTION_CASHFREE_SECRET_KEY` (a `cfsk_ma_prod_…`
   key), `SUBSCRIPTION_CASHFREE_ENV=production`, `APP_URL`, `SUBSCRIPTION_RECONCILE_SECRET` (a new one, not the test
   project's), optionally `SUBSCRIPTION_ALLOWED_ORIGINS`. `npm run preflight:live` (the owner's) then shows the functions
   and secrets as expected.
4. **Deploy** `subscription-webhook --no-verify-jwt`, then the reconciler's schedule and one complete run (Payments →
   Billing review shows it), then `subscription`. The schedule (the owner's choice of scheduler) makes, hourly, a `POST` to
   `https://<live-ref>.supabase.co/functions/v1/subscription-webhook` with the headers `x-hangtag-reconcile: 1` and
   `Authorization: Bearer <the live SUBSCRIPTION_RECONCILE_SECRET>`, the secret kept in the scheduler's own secret store
   (`probe:reconcile` refuses the live project on purpose). Each link carries the webhook as its `notify_url`; in
   Cashfree's dashboard, add the webhook only if Hangtag has its own account.
5. **One real low-value payment** end to end (the owner's own shop): one paid row, the months added once, the money
   counted; then a refund in Cashfree's dashboard appears for review and removes no time; the next reconciliation repairs
   nothing, and Payments → Billing review says money and time agree.
6. **Then** the app offers online payment to everyone (it does as soon as the function says `available`: provider keys
   set, in the database's billing mode). AutoPay stays off: it is Razorpay's. It can be switched on only after the
   Razorpay test-mode proof (REMEDIATION.md), its live keys and webhook, the console's billing self-check, and a complete
   reconciliation — the database refuses it before (readiness), and offers it to no shop while that proof lapses.
**Undo:** remove the provider's secrets (the function answers "not set up" at once; payments already made stay
honoured); the webhook keeps settling notifications still on their way.

## 6e. The controlled pilot, and the gates before money
**For the pilot, payments stay off.** Today, on the live project: `subscription` and `subscription-webhook` are not
deployed and no provider secret is set, so the app says online payment isn't available; AutoPay is off
(`hangtag_platform_config.autopay_enabled` false — and after the post-repair migration the database refuses to switch
it on without the proof); bill reading is off. The pilot runs on the 30-day trial (§6b), with the console's Extend and
Give a plan for anything longer — each audited, named shops only, never a reset of every account. Keep it so until
every gate below has its evidence:

| # | Gate | Evidence that closes it |
|---|---|---|
| 1 | A recoverable backup of live | The `pg_dump` (runbook step 2), its sha256, and where it is kept |
| 2 | Restored in isolation, the rehearsal complete | Runbook steps 3–4 on the restored copy: every comparison and check as `supabase/tests/restore-rehearsal.test.mjs` expects |
| 3 | The live repair, approved | The owner's approval (runbook step 5), then step 6's checks all ok |
| 4 | The post-repair migration, approved after the repair is verified | Runbook step 7: its report 13 rows ok, the fingerprint and registry counts as expected |
| 5 | Cashfree sandbox and the deployed test-project webhook | §6d step 2: `eval:cashfree-sandbox` all PASS, `probe:cashfree-webhook` all PASS, a real sandbox delivery (`unknown_order` row), `probe:reconcile` all PASS (an ok, complete run) |
| 6 | The signed-in release checks and the trial corrections | §6a done by the owner and the client; §6c steps 1–5 with the shops the owner approved |
| 7 | One real low-value payment, and reconciliation after it | §6d step 5, then Payments → Billing review: money and time agree; nothing to repair |

**The pilot's own checklist** — what the owner and the client check, area by area, and which automated tests already
prove each locally: `PILOT-CHECKLIST.md`.

**The owner's decisions** (none is needed for the pilot; each is needed before the gate it names). Nothing here is
built as a policy until the owner chooses:
| Decision | Today | Options | Before |
|---|---|---|---|
| Refunds and disputes | Never take time away by themselves: kept for review (Payments → Billing review); one open before its payment is recorded stops that payment from adding time | (a) as today, settled by hand (Extend, or nothing); (b) an audited console action "take back this payment's months" (not built: with periods stacked it shortens the shop's end by that payment's months); (c) automatic (not advised: a partial refund or a dispute Hangtag wins would cost the shop time) | Gate 7 |
| The reconciler's scheduler | None (the entry and its secret are ready) | Hourly `POST` as §6d step 4 says, from: a scheduler the owner already trusts (its own secret store); or `pg_cron` with `pg_net` on the project (DDL on live: after the repair, its own approval; the secret in Supabase Vault) | Gate 7 (payments on) |
| Renewal grace (`renewal_grace_hours`, console Settings, 0–168) | 48 | Used only while AutoPay renews (a trial or a one-time plan that ends locks the app at once). Before AutoPay: longer than Razorpay's charge retries (measured in the test-mode proof, REMEDIATION.md item 5) plus an hour | AutoPay |
| Provider calls per account (REMEDIATION step 11) | The app's payment check 60 a minute and 900 an hour; starting AutoPay 6 and 30 (`hangtag_billing_call_claim`, post-repair migration) | Keep, or other numbers (a change to the migration) | Gate 7 |
| A missed Cashfree refund notification | Not found by any sweep (Cashfree's account-level listing is unverified); refunds are made by the owner in Cashfree's dashboard, so each is known | Keep; or a Cashfree refund sweep, built after the sandbox shows its API | Gate 7 |
| AutoPay | Off; the database refuses it without proof | Offer it only after the Razorpay test-mode proof (REMEDIATION.md), its live keys and webhook, the self-check and a complete reconciliation | — |

## 7. After the release
Use a test product and a test customer, and cancel what you create afterwards:
1. The report: all rows ok. `npm run preflight:live`: nothing unexpected.
2. Sign in on a computer and on a phone; both sync. In Settings → Advanced → Diagnostics & health, "Last full sync"
   moves to now and no new "Pull … failed" appears. Each device shows only its own shop's products and bills (a full
   download replaces what other shops' rows reached it while tables were open).
3. Read a real supplier bill. A line in boxes of a product counted in pieces asks for the pieces. Cancel without
   saving.
4. Make a field and a unit (Settings → Products & Inventory), use them on the test product, then archive them.
5. Sell the test product (cash), cancel the bill, and check that stock returns.
6. If the team is used: add a phone with a QR code.
7. Open a receipt link and the store page, signed out.
8. Look at Supabase → Edge Functions → Logs for errors in the first hour.

## Who decides
Production migrations, secrets, function deploys and promotion to Production happen only on the owner's word. A push
to `ux-productization` makes a Preview, which uses live data.
