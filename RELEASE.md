# Releasing Hangtag to production

The owner runs these steps: each one changes the live Supabase project or Vercel Production, and none is run from this
repository's tools without the owner's word. Work through them in order. A step that fails stops the release; the
rollback for each step is next to it.

Live project: `wcorlmgkwcahyfastjoz` (PostgreSQL 17). Vercel Production: `6af8cc2` (2026-10-07). Branch to release:
`ux-productization`.

## 0. What this release contains
- **App:** everything on `ux-productization` since `6af8cc2`; the Vercel Preview of the branch's tip is the candidate.
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

## 3. Database (SQL Editor)
The whole `supabase/schema.sql` of the release commit, once, in one transaction. On the live project of 2026-10-13
(compared with `schema.sql` object by object, read-only) it changes:
- the bodies of the 18 older functions;
- the three redundant indexes the first migration put back (dropped).

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

**Stays as it is** (older and harmless, not from 2026-10-13):
- the owner foreign keys of six tables carry older names (`hangtag_sales_owner_fkey` …), with the same definition;
- `hangtag_sales_money_check` prints `subtotal` without a cast;
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
- **Rollback.** Deployments → the previous Production deployment (`6af8cc2`'s) → Promote to Production. It is instant,
  and the database needs nothing (step 3).

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
