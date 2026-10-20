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
- **Your own dump** (always, even with the platform's), on a machine with PostgreSQL 17 client tools, using the
  connection string from Supabase → Connect (session pooler if the network has no IPv6):
  ```sh
  pg_dump --version                                   # must say 17.x
  pg_dump "<connection string>" -n public -n auth -F c -f hangtag-before-repair.dump
  sha256sum hangtag-before-repair.dump                # record it with the file's size and the time (UTC)
  pg_restore -l hangtag-before-repair.dump | head -20 # the header: server 17.6, the database name
  ```
  The dump holds customers' and staff's personal data: keep it encrypted, outside the repository, off shared drives.
  The bills bucket's files are not in it (only their rows): download the bucket separately if it holds anything.

**Abort** if no backup can be made: the repair stays blocked. A dump counts only when `pg_dump` exited 0, `pg_restore -l`
reads it (its header names server 17.6 and lists the `public` tables, `hangtag_sales` among them), and its sha256 is
recorded; a dump that fails any of these is no backup. Step 3 then proves it can be restored.

## 3. Isolated restore and integrity (owner or a trusted operator)
Restore into a database the app can't reach: a throwaway Supabase project (it already has Supabase's roles and
extensions), or a local PostgreSQL 17 with the `anon`, `authenticated`, `service_role` and `supabase_*` roles created
first. **Never the live project.**
```sh
pg_restore --no-owner --no-privileges -d "<throwaway connection string>" hangtag-before-repair.dump 2> restore-errors.txt; echo "exit $?"
```
- `pg_restore` exits 0, or every line of `restore-errors.txt` is explained (for example, objects Supabase already
  creates). An unexplained error means the restore doesn't count.
- On the restored copy and on live (read-only, close to the dump's time), compare line by line:
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
read false).

## 8. Recovery
| What happened | What to do |
|---|---|
| Step 6 or 7 failed | Nothing changed (one transaction). Read the error; fix; repeat from step 1 |
| The app misbehaves after step 7 | `supabase/operations/post-repair-integrity-undo.sql` (approval): its ten functions back to `schema.sql`'s (their grants unchanged), its triggers and every function it added removed, its tables kept. The subscription functions fall back to the older database functions by themselves |
| A repaired function is proven to break the app after step 6 | Roll the app back first (RELEASE §6). `2026-10-13-repair-undo.sql` puts back the 18 older functions and 3 indexes, with their known gaps: only on the owner's word |
| Data is damaged | Point-in-time recovery to the noted point, or restore the step-2 dump into a new project and move the app to it. Both lose what was written after the backup |
| Never | Re-run an older section file to "undo" anything: that is what caused the incident |
