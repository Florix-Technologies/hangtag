# Database repair runbook (reviewed 2026-10-18; stop conditions and report reading checked 2026-10-20)

The one procedure for repairing the live database (`wcorlmgkwcahyfastjoz`) and then applying the post-repair
migration. Every step that touches the live project is the owner's, on the owner's word for that step. Nothing here
has been run on the live project.

## 0. What is known, and what is assumed

| | Fact or assumption | Source |
|---|---|---|
| Confirmed | On 2026-10-13, after the whole `schema.sql` (20:39 IST), the section files 3za…3r ran newest-first and then the first migration ran as it was. 18 functions went back to older versions, six "Public access" policies came back (every shop's rows readable and writable by any signed-in account), and 3 indexes came back | AUDIT 76–78, read-only catalog reads of 10-13/10-14 |
| Confirmed | Containment on 2026-10-13 at 23:45 IST dropped the six policies; the catalog was otherwise unchanged | AUDIT 89, 93 |
| Confirmed | Preflight of 2026-10-14 (read-only): PostgreSQL 17.6, system identifier 7678071634733212629, dry run all 0, 61 shop tables / 4,205 rows, migration history only the three September files | RELEASE §3 |
| Confirmed | No platform backup: 0 physical backups and point-in-time recovery off (as of 2026-10-15) | AUDIT 99, RELEASE §2a |
| Confirmed in rehearsal | On the live state as reconstructed, the repair changes exactly the 18 functions, re-adds `hangtag_sales_money_check` (NOT VALID: no row re-checked), and drops the 3 indexes. It adds nothing and changes no policy, column, trigger, row security, grant or row | `supabase/tests/repair-inventory.test.mjs`, `live-recovery.test.mjs` |
| **Assumed** | Nothing has changed on the live project since 2026-10-15 (no SQL run, no repair) | No access from here; step 1 re-checks it |
| **Assumed** | The live data is still in the 2026-10-14 shape (no corruption beyond what the incident left) | Step 1's fingerprint and step 3's integrity checks |
| **Unknown** | Whether any rows were read or changed across shops while the six policies were open (10-13, 20:39–23:45 IST) | Needs the project's API logs for that window, if still retained |

## 1. Read-only preflight on live (owner, SQL Editor)
Run each file whole; the SQL Editor shows the last result only. **Abort** if a result differs from what is expected
here, unless the difference is understood and written down.

| File (`supabase/checks/`) | Expected |
|---|---|
| `select current_setting('server_version'), system_identifier from pg_control_system();` | `17.6`, `7678071634733212629` |
| `schema-dry-run.sql` | all 26 numbers 0 |
| `2026-10-13-function-versions.sql` | 18 `OLDER VERSION`, 3 `STILL THERE` (17 older if the console permissions update of RELEASE §6b was applied) |
| `open-policies.sql` | no row |
| `data-fingerprint.sql` | keep the output: compared again in steps 3 and 7 |
| `restore-row-counts.sql` | keep the output |
| Dashboard → Database → Backups | note what exists (expected today: none) |

## 2. A backup you can restore (owner)
Choose one; record what the approval needs (RELEASE §2a item 1).
- **Platform:** move the project to a plan with daily backups and turn on point-in-time recovery, then wait until the
  dashboard lists a backup or shows PITR active. Note the recovery point (time, UTC).
- **Your own dump** (always, even with the platform's): `scripts/backup/hangtag-backup.ps1`, in your own PowerShell, with
  PostgreSQL client tools 17.6 or newer.
  - It takes every schema but Supabase's own (`public`, `private`, `auth`, `storage`, `supabase_migrations`), in UTC.
    pg_dump asks for the password itself.
  - It records the archive's size, SHA-256 and `pg_restore --list` result. It refuses to call it a backup when
    `public`, `auth` or `private` is missing.
  - Never dump by hand with `-n public -n auth`: such a dump lacks `private`, `storage` and `supabase_migrations`, and
    no recovery (`supabase/RESTORE-RUNBOOK.md` §5) can use it.

  The dump holds customers' and staff's personal data: keep it in the script's private folder, outside the repository,
  off shared drives. The bills bucket's files are not in it (only their rows): download the bucket separately if it
  holds anything.

**Abort** if no backup can be made: the repair stays blocked. A dump counts only when the script reports pg_dump's exit
0, the archive's SHA-256, and a readable `pg_restore --list` that holds every expected schema. A dump that fails any of
these is no backup. Step 3 then proves it can be restored.

## 3. Isolated restore and integrity (owner or a trusted operator)
Restore only where the app can't reach it. **Never the live project.**
- **On this computer** (2026-10-25): `node scripts/backup/verify-restore.mjs <archive>` and `… --target supabase-sim`
  (`supabase/RESTORE-RUNBOOK.md` §4). Owners and privileges come back as in the archive, and Supabase's platform
  entries are left out by name with their reasons. Every definition, right, row and sequence is compared.
- **Into a throwaway Supabase project:** only by `supabase/RESTORE-RUNBOOK.md` §5 exactly: the preflight,
  `before-recovery.sql`, one transaction, and the step 8 compare. Never `pg_restore --no-owner --no-privileges` into a
  Supabase project: its default privileges would give `anon` and `authenticated` every restored function and table.
  `anon` could then run 104 SECURITY DEFINER functions instead of 6.

Checks:
- Both runs end with `RESULT: restorable …` (and step 8 with its exit 0 for a §5 project). An unexplained error or
  difference means the restore doesn't count.
- On a restored copy (a §5 project, or the verifier's copy kept with `--keep`) and on live (read-only, close to the
  dump's time), compare line by line:
  `data-fingerprint.sql`, `restore-row-counts.sql`, `2026-10-13-function-versions.sql`, `open-policies.sql`; and on the
  restored copy `restore-fk-orphans.sql` (expected: no row). Rows written on live after the dump are the only allowed
  difference, named table by table.

**Abort** if the restore doesn't count, or a comparison differs in any other way: the backup isn't proven restorable, so
the repair stays blocked. Take a new dump (step 2) and restore it again; never go on to step 4 with an unexplained
difference.

## 4. Rehearsal on the restored copy
On the restored copy, exactly what step 6 will run, then its checks:
- the release commit's `supabase/schema.sql` between `BEGIN;` + `SET LOCAL lock_timeout = '10s';` and `COMMIT;`
  (repository bytes 809,397, sha256 `fde12118a672b66c4f7271a675ec2a02049a74ca32370ba595ada6336acc184c`; a Windows
  checkout 819,383, `56cb6eaa62ef4d378141b77fd0a2e02009043e16a537dd0c32e62b09ab4daee7`);
- after it (each run on its own: after `COMMIT` the editor shows no rows): the report (the final `SELECT check_name …` of
  `schema.sql`) all 83 rows ok, row 96 0;
  `2026-10-13-function-versions.sql` all ok; `open-policies.sql` no row; `schema-dry-run.sql` all 0;
  `data-fingerprint.sql` identical to before; `sync-read-isolation.sql` 0 rows of other shops;
- on a second restored copy: `2026-10-13-repair-undo.sql` after the repair puts the 18 functions back byte for byte;
- then step 7's migration as step 7 runs it, and `supabase/checks/post-repair-report.sql` (13 rows, all ok); then
  `supabase/operations/post-repair-integrity-undo.sql` (its last row: undone true). The migration refuses to commit unless
  its own report is all ok: if it stops with "The post-repair report is not all ok (…)", nothing of it was kept.

**Abort** on any difference from the rehearsal in the repository (`live-recovery`, `repair-inventory`,
`post-repair-integrity`, `restore-rehearsal` tests). `supabase/tests/restore-rehearsal.test.mjs` runs steps 3–4 as written
on a physical backup and restore of a live-like database, with these check files and these expected outputs (AUDIT 158).

**On the real backup (2026-10-27):** `node scripts/backup/rehearse-repair.mjs <archive> --sha256 <its sha256>` runs this
step on a restored copy of the owner's own dump, on this computer only:

- **How it runs:**
  - It restores into a simulated new Supabase project with `verify-restore.mjs --target supabase-sim`, where postgres is not a superuser.
  - Then it runs the repair, the post-repair migration and the Cashfree migration as postgres, then the three undos.
  - Results are counts, names and hashes only. They are written beside the archive as `<archive>.rehearse-repair.txt`.
  - The copy is deleted afterwards, and the archive is hashed before and after.
- **What it adds to this step:**
  - Every account reads every shop table as itself.
  - Every account tries to change and to delete another shop's row on the six tables reopened on 2026-10-13.
  - Every account tries to add a row that names another shop, with that shop's plan made current, so row security itself must refuse it with 42501.
  - Every owner changes its own row, with its plan made current.
  - All of these run in sub-transactions that are always rolled back.
- **Reading the two-shop probe against real data:**
  - A probe that needs a row the shop doesn't have reads "has no row here". It is not applicable.
  - A shop whose plan has lapsed is refused by the plan guard (HT402) before row security. That applies both to "add as other shop" and to its own change. The row isn't added either way, and the probes above show row security and own writes with the plan made current.
- **Two allowances model what Supabase gives postgres:**
  - membership of anon, authenticated and service_role, as the SQL Editor's `set role authenticated` uses;
  - supabase_auth_admin and supabase_storage_admin while the repair runs, for its trigger on `auth.users` and its policies on `storage.objects`. Live accepted both from postgres on 2026-10-13.
- **Result for `…092928.dump`: 51/51 passed.**

## 5. The approval request (owner's decision alone)
It names: the dump's sha256 and where it is kept; the restore's exit and explained errors; the integrity comparisons;
the rehearsal's outputs; the script's hash (step 4) and the undo; the time window (a quiet minute; the 10-13 run took
about a second) and who runs it.

## 6. The repair on live (owner, SQL Editor, approved)
1. Re-run step 1. **Abort** if anything changed since the rehearsal. Then a fresh dump with step 2's commands, checked
   the same way (exit 0, `pg_restore -l` reads it, sha256 recorded), minutes before the repair: it is the recovery point
   if anything has to be restored, so as little as possible is written after it. **Abort** if it fails.
2. Paste and run, with the whole release `schema.sql` in the middle:
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '10s';
   -- the whole supabase/schema.sql here
   COMMIT;
   ```
   One transaction: on any error, or a lock not given within 10 s, nothing changes. Copy the error, stop, and run it
   again later. Exclusive locks on Hangtag tables last until `COMMIT` (about a second): the app's requests wait.
3. After (read-only; the editor shows only the last statement's result, here `COMMIT`'s, so each is run on its own), each
   must match: the report (the final `SELECT check_name …` of `schema.sql`, run on its own) all 83 rows ok, row 96 0;
   `2026-10-13-function-versions.sql` all ok;
   `open-policies.sql` no row; `schema-dry-run.sql` all 0; `data-fingerprint.sql` identical to step 1's (apart from rows
   written meanwhile); `sync-read-isolation.sql` 0; `shop-isolation-probe.sql` as its header says.

## 7. The post-repair migration (owner, separately approved)
Only after step 6's checks are all ok (`2026-10-13-function-versions.sql` must be run **before** this step: the
migration changes five of those functions on purpose — `hangtag_save_sales`, `hangtag_cap_on`, `hangtag_subscription_checkout`,
`hangtag_promo_evaluate`, `hangtag_subscription_ensure` — so afterwards that check shows them as different by design).
Run before the repair, the migration stops at its first statement and changes nothing. Before it, read-only: `SELECT
count(*) FROM public.hangtag_subscriptions WHERE autopay_subscription_id IS NOT NULL` (AutoPay set-ups it will register;
0 on live, where AutoPay was never switched on).
```sql
BEGIN;
SET LOCAL lock_timeout = '10s';
-- the whole supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql here (its report runs inside)
COMMIT;
```
The migration ends with its report and refuses to commit unless every row is ok: an error "The post-repair report is not
all ok (…)" names the rows, and nothing of it is kept — **abort**, keep the error, and find out why before any retry. The
editor shows only `COMMIT`'s result, so afterwards run `supabase/checks/post-repair-report.sql` (read-only).
Expected: 13 rows, all `ok = true`. Then `data-fingerprint.sql` again: every line as before, plus one line
for its one new shop table (`hangtag_deleted_products`) with 0 rows (its billing tables have no `owner_id` column, so the
fingerprint doesn't list them). `SELECT count(*) FROM public.hangtag_autopay_mandates` equals the count read before.
`SELECT billing_mode FROM public.hangtag_billing_settings` says `live` — and stays so on the live project (only a test
project sets `test`). Then the app's checks (RELEASE §6a). What it does: AUDIT 147–152, 162, 173–186 and the file's header.
**Until the migration is folded into `schema.sql`, run it again after any run of `schema.sql`** (a `schema.sql` run puts
the older bodies of its ten functions back; `supabase/checks/post-repair-report.sql`, read-only, shows which rows then
read false). **After any run of this migration, run `20261027120000_hangtag_cashfree_readiness.sql` again** (this migration
puts back its own two definitions of the functions that one changes). `supabase/checks/cashfree-readiness-report.sql`,
read-only, shows whether the Cashfree migration is in place: 4 rows, all ok.

## 8. Recovery
| What happened | What to do |
|---|---|
| Step 6 or 7 failed | Nothing changed (one transaction). Read the error; fix; repeat from step 1 |
| The app misbehaves after step 7 | `supabase/operations/post-repair-integrity-undo.sql` (approval): its ten functions back to `schema.sql`'s (their grants unchanged), its triggers and every function it added removed, its tables kept. The subscription functions fall back to the older database functions by themselves |
| A repaired function is proven to break the app after step 6 | Roll the app back first (RELEASE §6). `2026-10-13-repair-undo.sql` puts back the 18 older functions and 3 indexes, with their known gaps: only on the owner's word |
| Data is damaged | Point-in-time recovery to the noted point, or restore the step-2 dump into a new project and move the app to it (`supabase/RESTORE-RUNBOOK.md` §5). Both lose what was written after the backup |
| Never | Re-run an older section file to "undo" anything: that is what caused the incident |
