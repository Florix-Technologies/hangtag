# Restoring Hangtag from a backup

The backup is a `pg_dump` archive made by `scripts/backup/hangtag-backup.ps1`. The check is
`scripts/backup/verify-restore.mjs`. Every step that touches a Supabase project is the owner's, on the owner's approval.
**Never restore over the live project** (`wcorlmgkwcahyfastjoz`).

**Status (2026-10-25).** The archive `hangtag-wcorlmgkwcahyfastjoz-20261025-092928.dump` (SHA-256 `334bf7f2…a336`,
unchanged by every run) has been rehearsed on one computer only, with no connection to any Supabase project:
- **Plain PostgreSQL 18.6:** restore exit 0, 0 errors.
  - 1,753 definitions: 1,749 identical, 4 equivalent (§2), 0 different, 0 missing.
  - The rights of `anon` and `authenticated` on all 181 functions and 83 tables and views match the archive's grants.
    Neither role has a superuser-like attribute or a membership.
  - All 116 tables and 5,487 rows are identical, and the 3 sequences are at the archive's positions.
- **A simulated new Supabase project** (§5's commands exactly, as a `postgres` role that isn't a superuser): the same
  results, and:
  - both parts of the preflight passed;
  - a rollback drill left nothing behind, except the one sequence position a rollback can't undo (§7);
  - the recovery command ran with 0 errors and 0 warnings;
  - a second run refused, changing nothing.
- **Negative tests:**
  - Without `before-recovery.sql`, the same recovery runs with no error yet over-grants: 240 grant definitions differ,
    and `anon` can run 104 SECURITY DEFINER functions instead of 6. The check fails, as it must.
  - The read-only compare (§5 step 8):
    - It passes on a correct copy.
    - With one of Supabase's own indexes dropped, it ends "review needed" (exit 3).
    - It fails, naming each one, on nine deliberate changes:
      - a grant to `anon`;
      - row security off on `storage.objects`;
      - a moved sequence;
      - one changed row;
      - one dropped policy;
      - a new schema whose SECURITY DEFINER function `anon` can run;
      - a trigger on `auth.users` calling a function there;
      - a column grant on `auth.users`;
      - BYPASSRLS on `authenticated`.
- **The one-command script** (`scripts/backup/recover-into-new-project.ps1`, §5), rehearsed on this computer in
  Windows PowerShell 5.1 against throwaway new projects (2026-10-26): 44 of 44 checks passed.
  - It recovered a fresh project, and its check passed; `-CheckOnly` then re-ran only the check.
  - It stopped at the preflight on a second run and on a pre-filled Supabase table, changing nothing.
  - A failure halfway through was rolled back, and its error never showed a row's value, even one that quoted an
    e-mail address.
  - It cleaned up after a rehearsal killed midway: it stopped that server and deleted its copy.
  - It refused, before connecting and without showing the value: the live ref, a host holding the live ref, and a
    pasted connection string.
- **Not yet done:** a drill on a real new Supabase project (§6).

## Before you start: the PostgreSQL tools must be 17.6 or newer
`psql` and `pg_restore` must be **version 17.6 or newer**. Check in PowerShell:
```
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" --version
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --version
```
Each must print `17.6` or higher; this computer prints `18.6`. If it prints an older version, or the file isn't there,
install PostgreSQL 18 (only its command-line tools are needed) and use its `bin` folder.

Why: the recovery's SQL files start and end with `\restrict` lines, which `psql` older than 17.6 rejects. The run then
stops and rolls back: it's safe, but nothing is restored. The verifier checks its own tools and refuses older ones.

## 1. What a backup holds, and what it doesn't

**It holds:**
- The application's schemas `public`, `private` and `supabase_migrations`, whole: tables and rows, functions,
  triggers, row-security policies, indexes, constraints, sequences, privileges, row security, and which tables Realtime
  publishes.
- In Supabase's `auth` and `storage` schemas: their definitions and rows (sign-in accounts, identities, file records),
  and the application's own objects there:
  - the `hangtag_on_auth_user_created` trigger on `auth.users`;
  - the three "hangtag bills" policies on `storage.objects`.
- Times written in UTC.

**It doesn't hold:**
- **Supabase's platform**, which every Supabase project provides and plain PostgreSQL can't:
  - its `extensions` schema functions, and the event triggers that call them (PostgREST's schema-cache watchers and
    the pg_cron, pg_graphql and pg_net access hooks);
  - Vault (`supabase_vault`) and its secrets (Hangtag stores none there);
  - Realtime's own schema and publication;
  - GraphQL and pg_net.
- **The files in Storage** (bucket `hangtag-bills`, the supplier-bill originals). Only their records are in the
  database: copy the files separately (§5 step 10).
- **The project's configuration:** Auth settings (Site URL, redirect URLs, Google sign-in, email), the JWT secret, the
  API keys, Edge Functions and their secrets, webhooks, and Vercel's settings.
- **Anything written after the dump.**

## 2. Why plain PostgreSQL is a proof, not a recovery
A restore into plain PostgreSQL proves the archive is complete and consistent: every object, right, row and sequence
comes back the same. It can't run Hangtag, which needs Supabase's sign-in, its Data API, Storage, Realtime and Edge
Functions. **A real recovery goes into a new Supabase project (§5).**

The check leaves out exactly the platform's entries, 66 in this archive. Each is matched by its identity and listed in
the report with its reason, never by its error message:

| Entries left out | Why |
|---|---|
| 6 event triggers (`issue_graphql_placeholder`, `issue_pg_cron_access`, `issue_pg_graphql_access`, `issue_pg_net_access`, `pgrst_ddl_watch`, `pgrst_drop_watch`) | Owned by Supabase's roles; they call functions in Supabase's own `extensions` schema, which no backup takes. Every Supabase project has its own |
| `EXTENSION supabase_vault` and its comment | A Supabase-only extension. No application object uses it (checked) |
| 5 grants inside `vault` (secrets, decrypted_secrets, create_secret, update_secret, _crypto_aead_det_decrypt) | Supabase's privileges inside the schema of its own extension |
| 51 grants on `extensions.*` functions and views (pgcrypto, pg_stat_statements …) | Supabase's privileges on its extensions' functions |
| `supabase_realtime_messages_publication` and its table `realtime.messages`, by name | Realtime's own publication of its own table. The application's `supabase_realtime` publication of its 39 tables **is** restored |

The check also fails the plan if:
- an application object uses a Supabase schema that no backup takes;
- the recovery would give an object to a role other than `postgres`;
- it would have to write rows where `postgres` can't;
- the repository's own SQL (schema, migrations, operations) makes an object in `auth` or `storage` that the plan would
  leave out, or changes one of Supabase's objects there;
- an entry the recovery leaves out holds a grant made by a role other than Supabase's.

A trigger on Supabase's tables counts as the application's whenever its function lives outside Supabase's own schemas.

The repository makes four such objects, and all four are restored: the trigger and the three policies.

Two kinds of difference are accepted as equivalent, each listed by name in the report:
- **The same condition, written flat.** PostgreSQL 18 writes three CHECK constraints and one trigger's WHEN clause as
  `(a AND b AND c)` where the archive (PostgreSQL 17) has `((a AND b) AND c)`. Operand order and quoted text must be
  unchanged.
- **The same rows in another order.** A table compares as a set of rows, each row hashed. After the rollback drill,
  `auth.users` holds the same 30 rows in a different physical order: the real load reuses space the rolled-back one left.

Anything else that differs fails the check.

## 3. Which recovery for which failure

| What happened | What to do |
|---|---|
| The repair or a migration misbehaves, and no data is damaged | Its own undo (`supabase/REPAIR-RUNBOOK.md` §8). No restore |
| Data is damaged, or the project is lost | Recover into a **new** Supabase project (§5), check it (§5 step 8), then the owner decides: move the app to it, or copy named rows back by hand. What was written after the dump is lost either way |
| Never | Restore over the live project in place, or re-run old section files |

## 4. Prove a backup before relying on it
On the computer that holds the archive (nothing leaves the computer), in the repository's folder:
```
node scripts/backup/verify-restore.mjs <archive.dump>                            # plain PostgreSQL
node scripts/backup/verify-restore.mjs <archive.dump> --target supabase-sim      # §5 rehearsed in a simulated new project
node scripts/backup/verify-restore.mjs <archive.dump> --demo-without-pre-step    # optional: what before-recovery.sql prevents
```
The first two must each end with **`RESULT: restorable …`** and exit 0. The demo must end with
`DEMO RESULT (not a recovery): … over-grants`.

Beside the archive, the runs write:
- the reports;
- `<archive>.restore-vanilla.list` and `<archive>.restore-into-supabase.list`, the restore lists;
- `<archive>.preflight-new-project.sql`, the preflight.

These hold object names, counts and hashes, never a row. `--diff` prints the definitions that differ (never data).
If you stop a run midway (Ctrl+C), delete the `restore-<time>` folder it leaves beside the archive: it holds a
throwaway copy of the data. The §5 script does this itself.

The simulation gives `postgres` what Supabase gives it, and no more:
- it is not a superuser (CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS);
- it owns the database;
- it may read every table (the live backup, made as `postgres`, read them all);
- it may set `session_replication_role`.

It then runs §5 steps 6–7 as `postgres`:
1. the preflight;
2. a check that the recovery command's quiet flags still show a WARNING;
3. a rollback drill: the recovery with a failure injected before COMMIT, after which nothing may remain but one
   sequence's position (§7);
4. the recovery command exactly as written, where any error or warning fails;
5. the same command again, which must refuse;
6. the preflight again, which must refuse.

## 5. Recover into a new Supabase project (owner, on approval)
Steps 1–11 work on the NEW project only: nothing in them connects to, or changes, the live project or what it uses.
Step 12, the cut-over, is the one that moves the app and its integrations.

**Steps 2 and 4–9 in one command.** After steps 1 and 3, `scripts/backup/recover-into-new-project.ps1` runs them with
the commands below, in order, and stops at the first problem. In PowerShell, in the repository's folder:
```
powershell -ExecutionPolicy Bypass -File scripts\backup\recover-into-new-project.ps1 -Archive "$env:USERPROFILE\hangtag-backups\hangtag-wcorlmgkwcahyfastjoz-<stamp>.dump" -NewRef <NEW_REF> -PoolerHost <host from the Connect panel>
```
- **Before anything connects,** it refuses the live ref, anything that isn't a project ref, and any host that isn't a
  Supabase pooler. A refused value is never shown or logged, in case it holds a password.
- **Step 4 runs first,** on this computer only, before the password is asked for.
- **Then it reads, without writing:** the server's system identifier (it stops on live's), its version, what it holds,
  and when its storage was set up. You type the ref again to go on.
- **The password** is asked once and not shown. It stays in the script's process and the tools it starts for steps
  5–8. The connection requires SCRAM authentication (`require_auth=scram-sha-256`), which never sends the password
  itself.
- **psql reads no psqlrc file,** and no inherited `PG…` setting is kept.
- **It ends after step 9.** The section files go into a new folder, `recovery-<time>`, and it deletes them and the folder
  whatever happens. It also removes a throwaway copy that an interrupted step 4 left behind.
- **Its log** (`<archive>.recovery-<time>.log`, beside the archive) holds the target, each step's commands and exit
  codes, and the preflight's, the recovery's and the check's messages. It never holds a row or the password. Step 4's
  details are in `<archive>.verify-supabase-sim.txt`.
- **Exit codes:** 0, recovered and identical. 3, recovered, to review before traffic moves. 5, recovered, but the check
  couldn't read the new project to the end: run the check again by adding `-CheckOnly` to the same command, which does
  step 2's checks and step 8 only. 1, stopped, or recovered but not shown identical. 2, refused before connecting. The
  last `RESULT` line always says which, and §7 says what is left.

1. **A new project.**
   - Region ap-south-1, Postgres 17.
   - The Free plan allows two active projects, and the organisation has two (hangtag, ecommerce). **Pause ecommerce,
     never hangtag**, or use a paid plan. Live stays up, and its Storage holds the only copy of the bill files
     (step 10).
   - Set its database password and keep it in your password manager. Note its project ref: `<NEW_REF>`.
2. **Its connection string**, from the NEW project's **Connect** panel (Session pooler, port 5432). Never type the
   live ref. In PowerShell, in the repository's folder:
   ```
   $PG  = "C:\Program Files\PostgreSQL\18\bin"
   $A   = "$env:USERPROFILE\hangtag-backups\hangtag-wcorlmgkwcahyfastjoz-<stamp>.dump"
   $R   = "$env:USERPROFILE\hangtag-backups\recovery-$(Get-Date -Format yyyyMMdd-HHmmss)"   # a new folder of its own
   $NEW = "host=<host from the Connect panel> port=5432 dbname=postgres user=postgres.<NEW_REF> sslmode=require require_auth=scram-sha-256"
   if ($NEW -match 'wcorlmgkwcahyfastjoz') { throw 'That is the LIVE project. Stop.' }
   $s = Read-Host 'The NEW project database password' -AsSecureString
   $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   $env:PGCLIENTENCODING = 'UTF8'
   $env:PSQLRC = "$env:TEMP\hangtag-no-psqlrc\psqlrc"; $env:PGSYSCONFDIR = "$env:TEMP\hangtag-no-psqlrc"
   ```
   The password lives in this window only; step 9 removes it. `require_auth` lets the password be used only in a SCRAM
   exchange, which never sends it. The last line keeps psql from reading a psqlrc file, which could undo step 7's
   `VERBOSITY=terse` (that folder must not exist).
3. **Extensions.** Database → Extensions: `pgcrypto`, `uuid-ossp` and `pg_stat_statements` must be on. They are by
   default. The preflight checks them.
4. **Rehearse this exact archive** (§4, `--target supabase-sim`). It must pass. It writes the recovery list and the
   preflight beside the archive.
5. **Write the recovery's three files** into your private folder. They hold personal data.
   ```
   if (Test-Path $R) { throw "$R exists already" }; New-Item -ItemType Directory $R | Out-Null
   & "$PG\pg_restore.exe" -L "$A.restore-into-supabase.list" --section=pre-data  -f "$R\1-pre-data.sql"  $A; if ($LASTEXITCODE) { throw 'pre-data failed' }
   & "$PG\pg_restore.exe" -L "$A.restore-into-supabase.list" --section=data      -f "$R\2-data.sql"      $A; if ($LASTEXITCODE) { throw 'data failed' }
   & "$PG\pg_restore.exe" -L "$A.restore-into-supabase.list" --section=post-data -f "$R\3-post-data.sql" $A; if ($LASTEXITCODE) { throw 'post-data failed' }
   foreach ($f in '1-pre-data', '2-data', '3-post-data') { if (-not (Get-Content "$R\$f.sql" -Tail 3 | Select-String -Quiet '^\\unrestrict ')) { throw "$f.sql is incomplete" } }
   ```
   No error means each file was written whole: a complete file ends with its `\unrestrict` line.
6. **The preflight** on the NEW project. It changes nothing.
   ```
   & "$PG\psql.exe" -d $NEW -v ON_ERROR_STOP=1 -f "$A.preflight-new-project.sql"
   ```
   It must end with `preflight: every check passed. Nothing was changed.` It checks that:
   - this is a new, empty project: no tables in `public`, no `private` schema, no sign-in accounts;
   - it runs PostgreSQL 17 or newer, in UTF8;
   - the roles and extensions the recovery names exist;
   - `postgres` bypasses row security, may create schemas, owns schema `public` (as the database's owner), and may add
     tables to `supabase_realtime`;
   - `anon` and `authenticated` have no superuser-like attribute and belong to no other role;
   - `postgres` may read and write every Supabase table the rows go into; those tables take the archive's columns, and
     they are still empty;
   - `postgres` may set the `auth` sequence, make the trigger on `auth.users`, and make the foreign keys to it;
   - the app's trigger and policies don't exist there yet;
   - the Supabase functions the app calls exist;
   - no default privilege would over-grant that `before-recovery.sql` doesn't take away;
   - `postgres` may pause triggers;
   - `postgres` may create the policies on `storage.objects` and the trigger on `auth.users` (a probe of each, always
     rolled back).

   Any problem stops it with a list. Fix the cause or ask; don't go on.
7. **The recovery**: one command, one transaction.
   ```
   & "$PG\psql.exe" -d $NEW --single-transaction -v ON_ERROR_STOP=1 -v VERBOSITY=terse -q -o NUL -f scripts\backup\before-recovery.sql -f "$R\1-pre-data.sql" -c "SET session_replication_role = replica" -f "$R\2-data.sql" -c "SET session_replication_role = origin" -f "$R\3-post-data.sql" -c "NOTIFY pgrst, 'reload schema'"
   $LASTEXITCODE
   ```
   Success is no output at all, then `0`. `-q` and `-o NUL` keep normal output off the screen. `VERBOSITY=terse` keeps
   an error to one line, so a failing row of personal data is never printed.

   What each part does:
   - **`before-recovery.sql`** first refuses anything but a new, empty project. Then it takes away Supabase's default
     grants to `anon`, `authenticated` and `service_role` in `public`, so restored objects get exactly live's
     privileges. The archive's last entries put those defaults back for objects made later.
   - **`1-pre-data.sql`**: schemas, types, functions, tables, views and grants.
   - **`2-data.sql`**: the rows and the sequence positions. Triggers are paused only while these load (`replica`), so
     Supabase's own triggers on the `auth` and `storage` tables don't fire on restored rows. This is the shape of
     Supabase's documented restore: the schema, then `SET session_replication_role = replica`, then the data, in one
     `--single-transaction` run.
   - **`3-post-data.sql`**: indexes, constraints, foreign keys, triggers, policies, row security, the Realtime tables, and
     the default privileges.
   - **`NOTIFY pgrst`**: the Data API reloads its schema cache when the transaction commits.

   An `ERROR` line, or anything but `0`, means everything was rolled back (§7). A `WARNING` line: don't move traffic;
   run step 8 and report.
8. **Check it**, read-only, right away, before anyone signs in (signing in changes auth rows):
   ```
   node scripts\backup\verify-restore.mjs $A --compare-to $NEW
   ```
   What it requires:
   - every application definition, every row and every sequence is identical;
   - the rights of `anon` and `authenticated` are the archive's, everywhere outside Supabase's own schemas;
   - both roles are plain, with no superuser-like attribute and no membership;
   - the app's extensions are present;
   - row security and grants on `auth.users` and `storage.objects`, which carry the app's trigger and policies, match;
   - anything only the new project has is Supabase's: in its own schemas, owned and made by its roles;
   - a Supabase table with newer columns holds exactly the archive's rows on the archive's columns.

   It never rewrites the rehearsed lists. Four outcomes:
   - `RESULT: the compared database holds the archive` (exit 0): go on.
   - `RESULT (review needed, exit 3)`: the application is identical, but some of Supabase's own definitions in the
     archive are missing or different in the new project. Each is listed. Either Supabase's version differs, or it is
     an application object the plan left out, such as one made by hand in Supabase's schemas. Don't move traffic until
     each is explained.
   - `RESULT: … does NOT hold the archive` (exit 1): don't move traffic (§7).
   - `RESULT (not judged, exit 5)`: a read of the new project failed partway, such as a dropped connection or a
     refused query. Its first line names the cause. Nothing is known about the copy yet. The check only reads: run it
     again.
9. **Clean up:** only the three files, then their folder.
   ```
   Remove-Item "$R\1-pre-data.sql", "$R\2-data.sql", "$R\3-post-data.sql"; [IO.Directory]::Delete($R, $false)
   Remove-Item Env:PGPASSWORD
   ```
10. **The files.** The restored `storage.objects` records already hold the bill files' names. Upload each original from
    the old project into the new project's `hangtag-bills` bucket, at the same path, **with overwrite**: the Storage
    API with `x-upsert: true` and the new project's service-role key, or an S3-protocol PUT. A plain upload is refused
    as "already exists". Then open one bill in the app.
11. **Prepare the new project**, each a separate change the owner approves. None of these changes the live project or
    what it uses.
    - **Auth** in the new project: Site URL, redirect URLs, email, and the Google provider (client ID and secret).
    - **Google Cloud Console:** add `https://<NEW_REF>.supabase.co/auth/v1/callback` to the OAuth client's authorized
      redirect URIs, beside live's. Adding one leaves live's sign-in as it is.
    - **Edge Functions**: deploy each to the new project, using RELEASE §4 and §5 for the list and the
      `--no-verify-jwt` set. **RELEASE's commands name the live project:** run each with `--project-ref <NEW_REF>`,
      never as written:
      - `npx supabase functions deploy <name> --project-ref <NEW_REF>`
      - `npx supabase secrets set --env-file <file> --project-ref <NEW_REF>`
12. **Cut over, in one window.** This is the owner's decision, and the one step that changes what live uses.
    - **The app:** its Supabase URL and publishable key (a commit and a deploy), and Vercel's settings.
    - **Webhooks and scheduler:** right after the app deploy, re-register every provider webhook (payments,
      subscriptions, delivery status) and the external scheduler that calls `webhook-dispatch`, at
      `https://<NEW_REF>.supabase.co/functions/v1/<name>`. Not before: until the app moves, live still takes payments,
      and their confirmations must reach live.
    - **Users sign in again:** the new project has its own JWT secret. Passwords still work; Google works once its
      provider is set.
    - Keep the old project as it is until the owner decides otherwise.

## 6. The limits of the rehearsal
- **Engine:** PostgreSQL 18.6 on Windows. A Supabase project runs PostgreSQL 17. The section files set
  `transaction_timeout`, which needs 17 or newer; the preflight checks the version.
- **Supabase's parts are modelled, not real:**
  - The simulated project's auth and storage definitions come from the archive itself, so they are live's Supabase
    version. A new project may be newer. The preflight checks the columns and privileges the recovery needs. The
    compare accepts newer columns only when the archive's rows match exactly.
  - Supabase's supautils extension lets `postgres` pause triggers and create policies on `storage.objects`. The
    simulation models both: a parameter grant, and, for the probe and the recovery only, membership in
    `supabase_storage_admin`. On the real project the preflight proves both before anything is written. The live
    policies were made as `postgres`.
  - The simulation assumes `postgres` owns the database and `supabase_realtime`, as on live. The preflight checks
    both.
- **What the simulation can't see:** an application object wrongly left out of the recovery list. Its platform part
  comes from the same archive. Worse, pg_dump labels a trigger, policy, index or grant on one of Supabase's tables with
  the table's owner, whoever made it, so an owner check can't tell the application's from Supabase's. The plan guards
  against it:
  - left-out entries are matched by identity;
  - every left-out entry owned outright (a table, function or type) must be owned by Supabase's roles;
  - a trigger whose function lives outside Supabase's schemas is restored;
  - a grant made by another role inside a left-out entry fails the plan;
  - the plan is cross-checked against the repository's SQL.

  What none of these catches, such as an index made by hand on `storage.objects`, shows at §5 step 8: the new project
  lacks it, so the compare ends "review needed" instead of passing.
- **Generated columns** are recomputed by the server, never compared: `auth.identities.email`, `auth.scim_users`,
  `auth.users.confirmed_at`, `public.bill_items.line_total`, `storage.objects.path_tokens`. The archive doesn't record
  live's locale; the throwaway uses the builtin `C.UTF-8`, and the preflight prints the new project's.
- **What only a real drill proves:** §5 steps 1–8 on a real new project. It's the owner's decision.

## 7. Rollback, idempotency and stopping safely
- **All or nothing.** Step 7 is one transaction. On any error, `psql` sends ROLLBACK instead of COMMIT, and the new
  project is as before. That includes `before-recovery.sql`'s change to the default privileges.
  - This behaviour of `--single-transaction` across several `-c` and `-f` needs psql 15 or newer; this runbook
    requires 17.6.
  - One exception: the position of `auth.refresh_tokens_id_seq`, a sequence the project already has. The recovery sets
    it, and a sequence's position is never rolled back. That is harmless, because a retry sets the same value.
  - The rehearsal proves both: a failure injected after the last step left nothing behind but that position.
- **A dropped connection** is the same: the server rolls back the open transaction.
- **Not repeatable, by design.** A second run, or a run against any database with Hangtag's tables or with sign-in
  accounts (live among them), stops at `before-recovery.sql`'s first statement and changes nothing. The preflight
  refuses the same databases. Both are proven.
- **To retry after a failure:** fix the cause the error names, run step 6 again, then step 7. Never re-run the files
  in pieces. With the script, run it again: it repeats steps 4–9, and its preflight refuses a project where anything
  was kept.
- **If step 8 can't read the new project to the end (exit 5):** the copy hasn't been judged yet. Run step 8 again (with
  the script, the same command with `-CheckOnly`); it only reads. Never run the whole recovery again on that project:
  its preflight refuses it.
- **If step 8 fails, or ends "review needed", after a successful step 7:** the new project holds a copy that doesn't
  match, or that someone must explain first. Don't move traffic.
  Keep the report, and either start again with a fresh project from step 1 or ask. There is no partial undo inside the
  project.
- **Stopping points:** you can stop after any step up to 11. None of them touches the live project or what it uses.
  Until the cut-over (step 12), the app keeps using live. Step 12 changes live's integrations (the app's settings,
  webhooks, the scheduler), so it is done in one window.
- **After traffic moves**, going back means pointing the app at the old project again. What was written in the new
  project meanwhile stays only there: the owner decides before moving.
