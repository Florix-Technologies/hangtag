# Two returns of one bill line at the same moment (AUDIT 114, 141)

The test suites use PGlite, which has one connection, so this race can't run there. This folder runs it on a real,
disposable PostgreSQL 17 with two `psql` sessions. **Never point it at the live project** (or any project the app uses).

**Prerequisite:** a PostgreSQL 17 server you can throw away and its `psql` — Docker's `postgres:17`, or PostgreSQL's own
binaries unzipped (no installer, no service). None of them is on the machine this was written on (checked again
2026-10-20: no Docker, `psql`, `pg_ctl`, PostgreSQL server or service; `wsl.exe` is only Windows' stub — WSL isn't
installed), so it has not been run; the statements were checked one after the other on PGlite.

## Run it (Docker)
```sh
docker run --rm -d --name ht-race -e POSTGRES_PASSWORD=race -p 55432:5432 postgres:17
export PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=race PGDATABASE=postgres
cd supabase/tests/concurrency
psql -v ON_ERROR_STOP=1 -f setup.sql                       # Supabase's roles, schema.sql, a shop with one bill (2 pieces)
psql -v ON_ERROR_STOP=1 -f ../../migrations/20261019120000_hangtag_post_repair_integrity.sql   # leave out to see the race
psql -f session-1.sql &                                    # returns 2 pieces, holds its transaction 5 s
sleep 1; psql -f session-2.sql                             # returns 2 pieces of the same line meanwhile
wait; psql -f result.sql
docker rm -f ht-race
```

## Run it (Windows, no Docker)
PostgreSQL 17's Windows binaries as a zip archive (EDB's "PostgreSQL binaries" download, the 17.x zip), unzipped to
`C:\pg17` (giving `C:\pg17\pgsql\bin`). In PowerShell, from the repository's root; the server listens on this computer
only and is deleted at the end:
```powershell
$PG = 'C:\pg17\pgsql\bin'
& "$PG\initdb.exe" -D C:\pg17\race -U postgres --auth=trust -E UTF8
& "$PG\pg_ctl.exe" -D C:\pg17\race -o "-p 55432 -c listen_addresses=localhost" -l C:\pg17\race.log start
$env:PGHOST = 'localhost'; $env:PGPORT = '55432'; $env:PGUSER = 'postgres'; $env:PGDATABASE = 'postgres'
Set-Location supabase\tests\concurrency
& "$PG\psql.exe" -v ON_ERROR_STOP=1 -f setup.sql
& "$PG\psql.exe" -v ON_ERROR_STOP=1 -f ..\..\migrations\20261019120000_hangtag_post_repair_integrity.sql   # leave out to see the race
$s1 = Start-Process "$PG\psql.exe" -ArgumentList '-f', 'session-1.sql' -WorkingDirectory (Get-Location).Path -NoNewWindow -PassThru
Start-Sleep -Seconds 1; & "$PG\psql.exe" -f session-2.sql
$s1.WaitForExit(); & "$PG\psql.exe" -f result.sql
Set-Location ..\..\..
& "$PG\pg_ctl.exe" -D C:\pg17\race stop; Remove-Item -Recurse -Force C:\pg17\race
```

## Expected
- **With the post-repair migration:** it ends with its report and commits only when every row is ok (an error "The
  post-repair report is not all ok (…)" would mean nothing of it was kept). Session 2 waits until session 1 commits,
  then is refused ("Can't return 2 piece(s): 2 bought, 2 already returned"). `result.sql`: returned **2**, ok **true**.
- **Without it (schema.sql alone, as the live project would be after the repair):** both sessions succeed. `result.sql`:
  returned **4**, ok **false**: the race this fixes.

`setup.sql` reads `../../schema.sql` with `\i`, so run it from this folder.
