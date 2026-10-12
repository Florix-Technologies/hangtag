# Releasing Hangtag to production

The owner runs these steps: each one changes the live Supabase project or Vercel Production, and none is run from this
repository's tools without the owner's word. Work through them in order. A step that fails stops the release; the
rollback for each step is next to it.

Live project: `wcorlmgkwcahyfastjoz` (PostgreSQL 17). Vercel Production: `6af8cc2` (2026-10-07). Branch to release:
`ux-productization`.

## 0. What this release contains
- **App:** everything on `ux-productization` since `6af8cc2`; the Vercel Preview of the branch's tip is the candidate.
- **Database:** sections 3u, 3v and 3w, if the live report flags them; then 3x, 3y, 3z and 3za. Each is a file in
  `supabase/migrations/`, safe to run twice:

  | Section | File |
  |---|---|
  | 3u | `20261007120000_hangtag_return_reasons.sql` |
  | 3v | `20261008120000_hangtag_delivery_reports.sql` |
  | 3w | `20261009120000_hangtag_plans_autopay_platform.sql` |
  | 3x | `20261010120000_hangtag_platform_operations.sql` |
  | 3y | `20261011120000_hangtag_billing_integrity.sql` |
  | 3z | `20261012120000_hangtag_custom_fields_units.sql` |
  | 3za | `20261013120000_hangtag_stock_guards.sql` |

  **Never run `supabase db push` in this checkout.** `supabase/migrations` also holds the unapplied Phase 1 design
  (`20260925180000_phase1_foundation.sql`), which it would apply. Paste files into the SQL Editor instead.
- **Edge Functions:** every function redeployed from the release commit. `npm run preflight:live` lists what is out of date.

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
1. Run the flagged earlier sections (3u, 3v, 3w), in that order. Then run 3x, 3y, 3z and 3za, in that order.
2. After each file, run the report again. Rows that belong to sections not yet run stay not ok until their turn. After
   3za, **all 82 rows are ok**.
3. If a file fails, it stops at the failing statement. The others are unaffected and can be run again. Copy the error,
   stop, and don't continue to the app.
- **Rollback.** The sections only add:
  - tables, columns and functions;
  - looser unit checks;
  - guards.

  The app now in Production keeps working on the new database (`supabase/tests/upgrade-live-database.test.mjs` runs the
  sections on the previous release's database). So the usual rollback is the app's (step 6), not the database's.
  Restoring the backup is the last resort: it loses everything written since it was taken.

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
2. Sign in on a computer and on a phone; both sync.
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
