# Backs up the live Hangtag database with pg_dump — run it yourself, in your own PowerShell window:
#   powershell -ExecutionPolicy Bypass -File scripts\backup\hangtag-backup.ps1
# - Read-only on the database: pg_dump reads and copies; nothing is changed there.
# - The password: pg_dump asks for it itself (-W). What you type isn't shown, stored, logged or kept in history. Nothing
#   here reads or writes a password.
# - Where: a private folder outside the repository (default %USERPROFILE%\hangtag-backups, readable only by you). The dump
#   holds customers' and staff's personal data: keep it there, encrypted at rest if you can; never commit, attach or
#   upload it.
# - What: every schema except the ones Supabase itself manages — so public (the shop's tables and functions), private
#   (the foundation tables' helper functions: their defaults, rules and triggers need it), auth (sign-in accounts),
#   storage (file metadata only; the files themselves are not in the database), supabase_migrations, and any schema
#   added later — as a custom-format archive, times written in UTC. (2026-10-25: the first version listed the schemas to
#   take and missed private, so 8 tables couldn't be restored from its archive.)
# - Then: node scripts\backup\verify-restore.mjs <the .dump file> checks it and restores it into a throwaway database
#   on this computer only.
param(
  [string]$Dir = (Join-Path $env:USERPROFILE 'hangtag-backups'),
  [string]$PgBin = 'C:\Program Files\PostgreSQL\18\bin'
)
$Ref = 'wcorlmgkwcahyfastjoz'                          # Supabase project "hangtag" (ap-south-1), as supabase/.temp says
$PoolerHost = 'aws-0-ap-south-1.pooler.supabase.com'   # session pooler (IPv4 and IPv6), port 5432
$User = "postgres.$Ref"
$PgDump = Join-Path $PgBin 'pg_dump.exe'
# Supabase's own schemas (its extensions, GraphQL, Realtime, Vault and keys, pg_net, the pooler, cron): left out; a
# restore elsewhere doesn't take them, and the database account can't read all of them
$Managed = @('extensions', 'graphql', 'graphql_public', 'realtime', 'supabase_functions', 'pgsodium', 'pgsodium_masks', 'vault', 'net', 'pgbouncer', 'cron', 'pgtle')
if (-not (Test-Path $PgDump)) { Write-Host "pg_dump not found at $PgDump (pass -PgBin)."; exit 2 }

# 1. The target, said before anything connects
Write-Host ''
Write-Host "Backup of the LIVE Hangtag database (read-only):"
Write-Host "  project  $Ref (hangtag)"
Write-Host "  server   ${PoolerHost}:5432, database postgres, user $User, TLS required"
Write-Host "  schemas  all but Supabase's own ($($Managed -join ', '))"
Write-Host "  to       $Dir"
$typed = Read-Host 'Type the project ref to go on (anything else stops)'
if ($typed -ne $Ref) { Write-Host 'Not confirmed: nothing was done.'; exit 1 }

# 2. The private folder: only you can read it
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir | Out-Null }
& icacls $Dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$file = Join-Path $Dir "hangtag-$Ref-$stamp.dump"
$log = Join-Path $Dir "hangtag-$Ref-$stamp.log"

# 3. The dump. pg_dump asks for the password ("Password:"): the database password of the project (Supabase → Project
#    Settings → Database). Custom format (-Fc), compressed; owners and grants kept in the archive (a restore may skip them).
$start = (Get-Date).ToUniversalTime()
$conn = "host=$PoolerHost port=5432 dbname=postgres user=$User sslmode=require connect_timeout=20 application_name=hangtag-backup"
$env:PGTZ = 'UTC'   # times written in UTC, as the restore check compares them
$exclude = $Managed | ForEach-Object { "--exclude-schema=$_" }
& $PgDump $conn -W -Fc -Z 6 @exclude -f $file
$code = $LASTEXITCODE
$end = (Get-Date).ToUniversalTime()
$size = if (Test-Path $file) { (Get-Item $file).Length } else { 0 }
$hash = if ($size -gt 0) { (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() } else { '' }
$lines = @(
  "project $Ref; server ${PoolerHost}:5432; user $User; schemas: all but $($Managed -join ', ')",
  "pg_dump $(& $PgDump --version)",
  "start $($start.ToString('yyyy-MM-dd HH:mm:ss')) UTC; end $($end.ToString('yyyy-MM-dd HH:mm:ss')) UTC",
  "exit $code; file $file; size $size bytes; sha256 $hash"
)
$lines | Set-Content -Path $log -Encoding utf8
Write-Host ''
$lines | ForEach-Object { Write-Host $_ }
if ($code -ne 0 -or $size -eq 0) {
  Write-Host 'The dump did NOT complete: not a backup. Read the error above (a wrong password says "password authentication failed").'
  if (Test-Path $file) { Remove-Item $file }
  exit 1
}

# 4. Readable? (the archive's table of contents)
$list = & (Join-Path $PgBin 'pg_restore.exe') --list $file
if ($LASTEXITCODE -ne 0) { Write-Host 'pg_restore --list could not read the archive: not a backup.'; exit 1 }
$entries = @($list | Where-Object { $_ -and -not $_.StartsWith(';') }).Count
$data = @($list | Where-Object { $_ -match ' TABLE DATA ' }).Count
# a schema is in the archive when it has tables or its own entry (a whole-database dump writes no entry for public)
$schemas = @(@($list | Where-Object { $_ -match '^\d+; \d+ \d+ SCHEMA - \S+ ' } | ForEach-Object { ($_ -split ' ')[5] }) +
  @($list | Where-Object { $_ -match '^\d+; \d+ \d+ TABLE (?!DATA )\S+ ' } | ForEach-Object { ($_ -split ' ')[4] })) | Sort-Object -Unique
"pg_restore --list: $entries entries, $data with table data; schemas: $($schemas -join ', ')" | Add-Content -Path $log -Encoding utf8
Write-Host "pg_restore --list: $entries entries, $data with table data; schemas: $($schemas -join ', ')"
$lacking = @('public', 'auth', 'private') | Where-Object { $schemas -notcontains $_ }
if ($lacking.Count) {
  "MISSING schemas: $($lacking -join ', ') - NOT a complete backup" | Add-Content -Path $log -Encoding utf8
  Write-Host "MISSING schemas: $($lacking -join ', ') - this is NOT a complete backup."; exit 1
}
Write-Host ''
Write-Host "Next: node scripts\backup\verify-restore.mjs `"$file`""
