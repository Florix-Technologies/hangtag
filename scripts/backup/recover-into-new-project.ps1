# Recovers a Hangtag backup into a NEW Supabase project and checks it: supabase/RESTORE-RUNBOOK.md section 5, steps 2
# and 4-9, with the commands written there, stopping at the first problem. Run it yourself, in your own PowerShell
# window, after steps 1 and 3 (the new project and its extensions, in the dashboard):
#   powershell -ExecutionPolicy Bypass -File scripts\backup\recover-into-new-project.ps1 -Archive <the .dump> -NewRef <NEW_REF> -PoolerHost <host>
# - Never the live project (wcorlmgkwcahyfastjoz). Before anything connects: the ref and the host (a rejected value is
#   never shown or logged: it might hold a password). Then, read-only: the server's system identifier (live's is
#   7678071634733212629), its version and what it holds; you type the ref again before anything is written. The
#   preflight and before-recovery.sql then refuse any database that isn't new and empty.
# - The order: step 4 (on this computer only), then the password, the read-only look at the target, and steps 5-9
#   (with -CheckOnly: the password, the read-only look, and step 8 only).
# - The password: asked once, not shown. It is in this PowerShell process and the tools it starts for steps 5-8, never
#   in the step-4 rehearsal, and it goes when the script ends. The connection requires SCRAM (require_auth), which never
#   sends the password itself.
# - psql reads no psqlrc file (PSQLRC and PGSYSCONFDIR point to a folder that does not exist), and no inherited PG*
#   setting is kept.
# - It ends after step 9. No Storage file is copied; nothing in Auth, Edge Functions, webhooks, the scheduler or the app
#   changes (steps 10-12 are separate decisions).
# - It writes beside the archive: the three section files, in a new folder recovery-<time> (personal data: they and the
#   folder are deleted at the end, whatever happens); the check's report (<archive>.verify-compare.txt); and a log
#   (<archive>.recovery-<time>.log: the target, each step's commands and exit codes, and the preflight's, the recovery's
#   and the check's messages, never a row or the password; step 4's details are in <archive>.verify-supabase-sim.txt).
# - Exit 0: recovered and identical. 3: recovered, to review before any traffic moves (the recovery printed something,
#   or the check says "review needed"). 5: recovered, but the check could not read the new project to the end: run the
#   check again, with -CheckOnly. 1: stopped, or recovered but not shown identical. 2: refused before connecting. The
#   last RESULT line says which.
# -CheckOnly: after a recovery, only step 8 again (read-only), with step 2's checks and the read-only look first.
# -LocalTestPort: only for rehearsing this script on this computer, against a throwaway server on 127.0.0.1 (trust
#   authentication: no password, no prompt).
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$NewRef,
  [Parameter(Mandatory = $true)][string]$PoolerHost,
  [string]$PgBin = 'C:\Program Files\PostgreSQL\18\bin',
  [switch]$CheckOnly,
  [int]$LocalTestPort = 0
)
$ErrorActionPreference = 'Stop'
$Live = 'wcorlmgkwcahyfastjoz'               # the live project "hangtag": never a target
$LiveSystemId = '7678071634733212629'        # its server's system identifier (supabase/REPAIR-RUNBOOK.md section 0)
$LiveStorageSetUp = '2026-09-23 09:50:13'    # when its storage was set up (the archive's storage.migrations)
$Test = $LocalTestPort -gt 0
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$script:LogFile = $null
$script:Code = 1

# (PowerShell's variable names ignore case: no two names here differ only by it)
function Say([string]$s) {
  Write-Host $s
  if ($script:LogFile) {
    try { Add-Content -LiteralPath $script:LogFile -Value $s -Encoding utf8 }
    catch { Write-Host "(the log can't be written from here on: $($_.Exception.Message))"; $script:LogFile = $null }
  }
}
function Stop-Here([int]$c, [string]$why) { $script:Code = $c; throw $why }
# a message without the value it may quote (invalid input ...: "<value>"): never a row's content
function Hide-Values([string]$l) { $l -replace '(invalid input (?:syntax|value) for [^:]*: )"[^"]*"', '$1"..."' }
# the recovery's messages (step 7), where rows are in play: message lines only, with no quoted value in them (the names of
# relations, columns and constraints stay); any other line, such as a value running over several lines, is not shown
function Hide-RowValues([string]$l) {
  if ($l.Trim() -eq '') { return '' }
  if ($l -notmatch '^(psql:.*?: )?(ERROR|WARNING|NOTICE|FATAL|PANIC):') { return '(a line not shown: it may continue a value)' }
  $l -replace '(: )".*$', '$1"..."' -replace '\bvalue "[^"]*"', 'value "..."'
}
# runs a tool, keeps (and with -Show, shows and logs) its output and messages, and returns its exit code
function Invoke-Tool([string]$exe, [string[]]$argList, [switch]$Show, [switch]$Strict) {
  $lines = New-Object System.Collections.Generic.List[string]
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # a tool's message on stderr is output to keep, not a PowerShell error
  try {
    & $exe @argList 2>&1 | ForEach-Object {
      $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
      $l = if ($Strict) { Hide-RowValues $text } else { Hide-Values $text }
      $lines.Add($l)
      if ($Show) { Say "    $l" }
    }
    $c = $LASTEXITCODE
  } finally { $ErrorActionPreference = $saved }
  [pscustomobject]@{ Code = $c; Lines = $lines.ToArray() }
}
# a folder deleted whole (Remove-Item -Recurse in Windows PowerShell can stop halfway while Windows finishes deleting files)
function Remove-Tree([string]$p) {
  for ($n = 1; $n -le 5; $n++) {
    try { if (Test-Path -LiteralPath $p) { [IO.Directory]::Delete($p, $true) }; return }
    catch { if ($n -eq 5) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
# read-only, on the target: one query in a read-only transaction (never a session setting, which a pooled connection
# could hand on to the next step)
function Read-Target([string]$sql) {
  Invoke-Tool $psql @('-X', '-w', '-d', $NEW, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', 'BEGIN READ ONLY', '-c', $sql, '-c', 'COMMIT')
}
# what the target holds (shown before anything is written, and compared after a failed recovery)
$Snapshot = "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')) || ' relations in public, ' || " +
  "(SELECT count(*) FROM pg_namespace WHERE nspname IN ('private','supabase_migrations')) || ' of schemas private and supabase_migrations, ' || " +
  "(SELECT count(*) FROM auth.users) || ' sign-in accounts, ' || (SELECT count(*) FROM storage.buckets) || ' buckets, ' || (SELECT count(*) FROM storage.objects) || ' file records, ' || " +
  "(SELECT count(*) FROM pg_policy WHERE polrelid = 'storage.objects'::regclass) || ' policies on storage.objects, ' || " +
  "(SELECT count(*) FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal) || ' triggers on auth.users, ' || " +
  "(SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a WHERE n.nspname = 'public' AND d.defaclrole = 'postgres'::regrole AND a.grantee = 'anon'::regrole) || ' default grants to anon in public'"

$savedEncoding = [Console]::OutputEncoding
$A = $null; $SectionDir = $null; $sectionMade = $false; $hash = $null; $workBefore = $null
$identity = $null; $recovered = $false; $printedCount = 0; $cmp = $null; $written = 'nothing was done'
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8   # the tools write UTF-8

  # step 2: the target, checked before anything connects or is logged (a rejected value is never shown: it may hold a
  # password)
  if ($NewRef -cnotmatch '^[a-z]{20}$') { Stop-Here 2 "-NewRef is not a project ref (20 lowercase letters, in the NEW project's Connect panel). The value given is not shown. Nothing was done." }
  if ($NewRef -eq $Live) { Stop-Here 2 'That is the LIVE project, never a target. Nothing was done.' }
  if ($Test) {
    if ($PoolerHost -ne '127.0.0.1') { Stop-Here 2 'A local test connects to 127.0.0.1 only. Nothing was done.' }
    $NEW = "host=127.0.0.1 port=$LocalTestPort dbname=restored user=postgres sslmode=disable"
  } else {
    if ($PoolerHost -cnotmatch '^[a-z0-9-]+\.pooler\.supabase\.com$') {
      Stop-Here 2 "-PoolerHost is not a Supabase pooler host such as aws-0-ap-south-1.pooler.supabase.com. Give the host only, from the NEW project's Connect panel (Session pooler), never the connection string. The value given is not shown. Nothing was done."
    }
    $NEW = "host=$PoolerHost port=5432 dbname=postgres user=postgres.$NewRef sslmode=require require_auth=scram-sha-256"
  }
  if ($NEW -match $Live) { Stop-Here 2 'That is the LIVE project. Stop.' }
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Stop-Here 2 "No such archive: $Archive. Nothing was done." }
  $A = (Resolve-Path -LiteralPath $Archive).Path
  $script:LogFile = "$A.recovery-$stamp.log"
  if ($CheckOnly) { Say "The check only (step 8, read-only) of a Hangtag recovery in a NEW Supabase project: supabase/RESTORE-RUNBOOK.md section 5 ($((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC)" }
  else { Say "Recovery of a Hangtag backup into a NEW Supabase project: supabase/RESTORE-RUNBOOK.md section 5, steps 2 and 4-9 ($((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC)" }
  if ($Test) { Say 'LOCAL TEST of this script: the target is a throwaway server on 127.0.0.1 (trust authentication: no password, no prompt)' }
  Say "  target    $NEW"
  Say "  archive   $A"

  # the tools (17.6 or newer: the section files start and end with \restrict lines)
  $psql = Join-Path $PgBin 'psql.exe'
  $pgRestore = Join-Path $PgBin 'pg_restore.exe'
  foreach ($t in @($psql, $pgRestore)) {
    if (-not (Test-Path -LiteralPath $t)) { Stop-Here 2 "$t not found: PostgreSQL 17.6 or newer is needed (pass -PgBin). Nothing was done." }
    $v = (& $t --version) -join ' '
    if ($v -notmatch '(\d+)\.(\d+)' -or [int]$Matches[1] -lt 17 -or ([int]$Matches[1] -eq 17 -and [int]$Matches[2] -lt 6)) {
      Stop-Here 2 "$($v): 17.6 or newer is needed (the section files carry \restrict lines). Nothing was done."
    }
    Say "  tool      $v"
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Here 2 'node not found: steps 4 and 8 need Node.js. Nothing was done.' }
  # no inherited PG* or PSQL* setting may redirect a connection or change a session (PGHOSTADDR, PGSERVICE, PGOPTIONS ...),
  # and psql reads no psqlrc file, which could undo -v VERBOSITY=terse: both point to a folder that does not exist
  @(Get-ChildItem Env: | Where-Object { $_.Name -like 'PG*' -or $_.Name -like 'PSQL*' }) | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
  $none = Join-Path $env:TEMP "hangtag-no-psqlrc-$PID-$stamp"
  if (Test-Path -LiteralPath $none) { Stop-Here 2 "$none exists, and must not. Nothing was done." }
  $env:PSQLRC = Join-Path $none 'psqlrc'
  $env:PGSYSCONFDIR = $none
  $env:PG_BIN = $PgBin   # verify-restore.mjs uses the same tools
  $env:PGCLIENTENCODING = 'UTF8'
  Say '  psql      reads no psqlrc file; no inherited PG* setting is kept'

  # the archive: the one its backup recorded
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $A).Hash.ToLower()
  $backupLog = [IO.Path]::ChangeExtension($A, '.log')
  $recorded = $null
  if (Test-Path -LiteralPath $backupLog) {
    $m = Select-String -LiteralPath $backupLog -Pattern 'sha256 ([0-9a-f]{64})' | Select-Object -First 1
    if ($m) { $recorded = $m.Matches[0].Groups[1].Value }
  }
  if ($recorded -and $recorded -ne $hash) { Stop-Here 2 "the archive's SHA-256 is $hash, not the $recorded its backup recorded. Nothing was done." }
  Say "  archive   sha256 $hash$(if ($recorded) { ', as its backup log records' } else { ' (no backup log beside it to compare with)' })"
  $workBefore = @(Get-ChildItem -LiteralPath (Split-Path -Parent $A) -Directory -Filter 'restore-*' | ForEach-Object { $_.Name })

  # step 4, on this computer only, before the password exists here: the rehearsal of this exact archive. It writes the
  # recovery list and the preflight beside the archive.
  if (-not $CheckOnly) {
    Say ''
    Say 'step 4: rehearse this archive on this computer (node scripts\backup\verify-restore.mjs <archive> --target supabase-sim; about a minute)'
    $t4 = Get-Date
    $res = Invoke-Tool 'node' @((Join-Path $PSScriptRoot 'verify-restore.mjs'), $A, '--target', 'supabase-sim')
    $result = @($res.Lines | Where-Object { $_ -like 'RESULT*' }) -join ' '
    Say "  exit $($res.Code): $result"
    if ($res.Code -ne 0 -or $result -notlike 'RESULT: restorable*') {
      @($res.Lines | Select-Object -Last 15) | ForEach-Object { Say "    $_" }
      $rep = "$A.verify-supabase-sim.txt"
      $fresh = (Test-Path -LiteralPath $rep) -and ((Get-Item -LiteralPath $rep).LastWriteTime -ge $t4)
      Stop-Here 1 "the rehearsal did not pass$(if ($fresh) { " (its report: $rep)" } else { ' (it ended before writing its report)' }). Nothing connected to the new project."
    }
  }

  # step 2: the password, from here on in this process and the tools it starts
  if (-not $Test) {
    $s = Read-Host 'The NEW project database password (not shown)' -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    if (-not $env:PGPASSWORD) { Stop-Here 2 'No password given. Nothing was done.' }
  }

  # the target, read-only, before anything is written: not the live project's server, and what it holds
  Say ''
  Say 'The target, read-only, before anything is written:'
  $identity = 'failed'
  $written = 'nothing was written to the new project'
  $res = Read-Target ("SELECT current_user || '|' || current_database() || '|' || current_setting('server_version') || '|' || " +
    "has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE') || '|' || coalesce((SELECT min(executed_at)::text FROM storage.migrations), '-')")
  if ($res.Code -ne 0) { $res.Lines | ForEach-Object { Say "    $_" }; Stop-Here 1 'could not read the target (the lines above say why: host, ref or password?). Nothing was written.' }
  $f = "$(@($res.Lines)[-1])" -split '\|'
  $sysid = $null
  if ($f.Count -ge 5 -and $f[3] -eq 'true') {
    $r2 = Read-Target 'SELECT system_identifier FROM pg_control_system()'
    if ($r2.Code -eq 0) { $sysid = "$(@($r2.Lines)[-1])".Trim() }
  }
  $identity = if ($sysid -notmatch '^\d+$') { 'unreadable' } elseif ($sysid -eq $LiveSystemId) { 'same' } else { 'differs' }
  $r3 = Read-Target $Snapshot
  if ($r3.Code -ne 0) { $r3.Lines | ForEach-Object { Say "    $_" }; Stop-Here 1 'could not read what the target holds. Nothing was written.' }
  Say "  server    PostgreSQL $($f[2]), database $($f[1]), connected as $($f[0])"
  Say "  identity  system identifier $(if ($sysid) { $sysid } else { 'not readable' }) (the live project's: $LiveSystemId)"
  Say "  created   storage set up at $($f[4]) (its first migration, server time: UTC on Supabase; the live project's: $LiveStorageSetUp)"
  Say "  holds     $(@($r3.Lines)[-1])"
  if ($identity -eq 'same') {
    Stop-Here 1 "this server has the live project's system identifier: it is the live project, or a project made from the same Supabase image (compare the storage set-up times above). Nothing was written. Stop and ask before going on."
  }
  if ($identity -eq 'unreadable') { Stop-Here 1 "the server's system identifier could not be read, so it can't be shown not to be the live project. Nothing was written." }
  if ($f[0] -ne 'postgres') { Stop-Here 1 "connected as $($f[0]), not postgres. Nothing was written." }

  if (-not $CheckOnly) {
    if (-not $Test) {
      $typed = Read-Host "Type the NEW project's ref again to recover into it (anything else stops)"
      if ($typed -cne $NewRef) { Stop-Here 1 'Not confirmed. Nothing was written.' }
    }

    # step 5: the recovery's three files, each written whole, into a new folder of their own
    $list = "$A.restore-into-supabase.list"
    $sections = 'pre-data', 'data', 'post-data'
    $files = '1-pre-data', '2-data', '3-post-data'
    $SectionDir = Join-Path (Split-Path -Parent $A) "recovery-$stamp"
    Say ''
    Say "step 5: the recovery's three section files, into $SectionDir (a new folder; personal data: deleted at the end)"
    if (Test-Path -LiteralPath $SectionDir) { Stop-Here 1 "$SectionDir exists already. Nothing was written." }
    New-Item -ItemType Directory -Path $SectionDir | Out-Null
    $sectionMade = $true
    for ($i = 0; $i -lt 3; $i++) {
      $out = Join-Path $SectionDir "$($files[$i]).sql"
      $res = Invoke-Tool $pgRestore @('-L', $list, "--section=$($sections[$i])", '-f', $out, $A)
      Say "  pg_restore -L $list --section=$($sections[$i]) -f $out <archive>: exit $($res.Code)"
      $res.Lines | Where-Object { $_.Trim() } | ForEach-Object { Say "    $_" }
      if ($res.Code -ne 0) { Stop-Here 1 "pg_restore --section=$($sections[$i]) failed. Nothing was written to the new project." }
    }
    foreach ($f5 in $files) {
      if (-not (Get-Content -LiteralPath (Join-Path $SectionDir "$f5.sql") -Tail 3 | Select-String -Quiet '^\\unrestrict ')) { Stop-Here 1 "$f5.sql is incomplete. Nothing was written to the new project." }
    }
    $listed = @(Get-Content -LiteralPath $list | Where-Object { $_ -match '^\d+;' }).Count
    $inFiles = 0
    foreach ($f5 in $files) { $inFiles += @(Select-String -LiteralPath (Join-Path $SectionDir "$f5.sql") -Pattern '^-- (Data for )?Name: ' -CaseSensitive).Count }
    Say "  written whole (each ends with its \unrestrict line): $inFiles entries in them, $listed in the list"
    if ($inFiles -ne $listed) { Stop-Here 1 'the files do not hold the list exactly. Nothing was written to the new project.' }

    # step 6: the preflight
    Say ''
    Say "step 6: the preflight on the NEW project; it changes nothing (psql -d <target> -v ON_ERROR_STOP=1 -f $A.preflight-new-project.sql)"
    $res = Invoke-Tool $psql @('-d', $NEW, '-v', 'ON_ERROR_STOP=1', '-f', "$A.preflight-new-project.sql") -Show
    Say "  exit $($res.Code)"
    if ($res.Code -ne 0 -or $res.Lines -notcontains 'preflight: every check passed. Nothing was changed.') {
      Stop-Here 1 'the preflight did not pass: the lines above name each problem. Nothing was written. Fix the cause or ask, then run this again.'
    }

    # step 7: the recovery, exactly as the runbook writes it
    $b7 = Read-Target $Snapshot
    if ($b7.Code -ne 0) { $b7.Lines | ForEach-Object { Say "    $_" }; Stop-Here 1 'could not read the target before the recovery. Nothing was written.' }
    $before = "$(@($b7.Lines)[-1])"
    $cmd = @('-d', $NEW, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-q', '-o', 'NUL',
      '-f', (Join-Path $PSScriptRoot 'before-recovery.sql'), '-f', (Join-Path $SectionDir '1-pre-data.sql'), '-c', 'SET session_replication_role = replica',
      '-f', (Join-Path $SectionDir '2-data.sql'), '-c', 'SET session_replication_role = origin', '-f', (Join-Path $SectionDir '3-post-data.sql'), '-c', "NOTIFY pgrst, 'reload schema'")
    $shown = ($cmd | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    Say ''
    Say 'step 7: the recovery, one command, one transaction, as the runbook writes it:'
    Say "  psql $shown"
    Say "  before: $before"
    $written = 'the recovery started; its outcome is not known (read the lines above)'
    $res = Invoke-Tool $psql $cmd -Show -Strict
    $printedCount = @($res.Lines | Where-Object { $_.Trim() }).Count
    if ($res.Code -ne 0) {
      $a7 = Read-Target $Snapshot
      $after = "$(@($a7.Lines)[-1])"
      Say "  exit $($res.Code); after: $after"
      if ($a7.Code -eq 0 -and $after -eq $before) {
        $written = 'the recovery failed and was rolled back: the new project is as it was'
        Stop-Here 1 'the recovery failed and was rolled back: the new project is as it was (but for the position of auth.refresh_tokens_id_seq, RESTORE-RUNBOOK section 7). Fix the cause the error names, then run this again.'
      }
      $written = 'the recovery failed, and the new project is NOT shown to be as it was: do not use it'
      Stop-Here 1 'the recovery failed, and the new project is NOT shown to be as it was (before and after above). Do not use it: start again with a fresh project (RESTORE-RUNBOOK section 7).'
    }
    $recovered = $true
    $a7 = Read-Target $Snapshot
    Say "  exit 0; now: $(@($a7.Lines)[-1])"
    if ($printedCount) { Say "  committed, but it printed $printedCount line(s), listed above: each must be explained before any traffic moves" }
    else { Say '  committed, with no output at all: success as the runbook defines it' }
  }

  # step 8: the check, read-only, right away (before anyone signs in)
  Say ''
  Say 'step 8: the check, read-only (node scripts\backup\verify-restore.mjs <archive> --compare-to <target>):'
  $t8 = Get-Date
  $res = Invoke-Tool 'node' @((Join-Path $PSScriptRoot 'verify-restore.mjs'), $A, '--compare-to', $NEW) -Show
  $cmp = $res.Code
  $rep = "$A.verify-compare.txt"
  $fresh = (Test-Path -LiteralPath $rep) -and ((Get-Item -LiteralPath $rep).LastWriteTime -ge $t8)
  Say "  exit $cmp$(if ($fresh) { " (its report: $rep)" } else { ' (it ended before writing its report)' })"
  $script:Code = if ($cmp -eq 0 -and $printedCount -eq 0) { 0 } elseif ($cmp -eq 0 -or $cmp -eq 3) { 3 } elseif ($cmp -eq 5) { 5 } else { 1 }
} catch {
  Say ''
  Say "STOPPED: $($_.Exception.Message)"
} finally {
  [Console]::OutputEncoding = $savedEncoding
  if (Test-Path Env:PGPASSWORD) { Remove-Item Env:PGPASSWORD }
  # step 9: the three section files (personal data) and their folder; only what this run made
  if ($sectionMade) {
    try {
      foreach ($f9 in '1-pre-data', '2-data', '3-post-data') { $p9 = Join-Path $SectionDir "$f9.sql"; if (Test-Path -LiteralPath $p9) { Remove-Item -LiteralPath $p9 -Force } }
      [IO.Directory]::Delete($SectionDir, $false)   # (empty now: anything else in it makes this fail, and is reported)
      Say "step 9: deleted the three section files and $SectionDir"
    } catch { Say "step 9: could NOT delete everything in $SectionDir ($($_.Exception.Message)): delete it by hand, it holds personal data"; $script:Code = 1 }
  }
  # a throwaway copy that an interrupted step 4 (or step 8's work folder) left behind: its server stopped, the folder deleted
  if ($null -ne $workBefore) {
    foreach ($d in @(Get-ChildItem -LiteralPath (Split-Path -Parent $A) -Directory -Filter 'restore-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^restore-\d{14}$' -and $workBefore -notcontains $_.Name })) {
      try {
        if (Test-Path -LiteralPath (Join-Path $d.FullName 'data\postmaster.pid')) {
          $stop = Invoke-Tool (Join-Path $PgBin 'pg_ctl.exe') @('-D', (Join-Path $d.FullName 'data'), '-m', 'fast', '-w', 'stop')
          Say "the throwaway server in $($d.FullName): pg_ctl stop, exit $($stop.Code)"
          $stop.Lines | Where-Object { $_.Trim() } | ForEach-Object { Say "    $_" }
        }
        Remove-Tree $d.FullName
        Say "deleted $($d.FullName), which an interrupted step left behind (a throwaway copy may hold personal data)"
      } catch { Say "could NOT delete $($d.FullName) ($($_.Exception.Message)): delete it by hand, it may hold personal data"; $script:Code = 1 }
    }
  }
  if ($hash) {
    $now = try { (Get-FileHash -Algorithm SHA256 -LiteralPath $A).Hash.ToLower() } catch { "unreadable ($($_.Exception.Message))" }
    if ($now -eq $hash) { Say "archive unchanged: sha256 $now" } else { Say "THE ARCHIVE CHANGED during the run, or can't be read: sha256 $now"; $script:Code = 1 }
  }
}
# the last word: what was done, and what to do
$checked = if ($null -eq $cmp) { 'the check did not run' } elseif ($cmp -eq 0) { 'the check passed: every application definition, right, row and sequence identical' } elseif ($cmp -eq 3) { 'the check says review needed' } elseif ($cmp -eq 5) { 'the check could not read the new project to the end, so nothing is known about the copy yet' } else { "the check FAILED (its exit $cmp)" }
$todo = if ($script:Code -eq 0) { 'identical' } elseif ($script:Code -eq 3) { 'review each item above before any traffic moves' } elseif ($script:Code -eq 5) { 'run the check again: the same command with -CheckOnly (read-only)' } else { 'do not move traffic (RESTORE-RUNBOOK section 7)' }
if ($recovered) { Say "RESULT: recovered into the new project; $checked$(if ($printedCount) { "; the recovery printed $printedCount line(s), listed above" }). Exit $($script:Code): $todo." }
elseif ($CheckOnly -and $null -ne $cmp) { Say "RESULT: the check only, nothing written; $checked. Exit $($script:Code): $todo." }
else { Say "RESULT: stopped (the STOPPED line above says why); $written. Exit $($script:Code)." }
$contact = if ($null -eq $identity) { 'Nothing connected to any Supabase project.' }
  elseif ($identity -eq 'failed') { 'The target could not be read, and nothing was written there.' }
  elseif ($identity -eq 'differs') { "The live project was not contacted: the target's system identifier is not live's." }
  elseif ($identity -eq 'same') { "A server with the live project's system identifier was read, read-only; nothing was written there." }
  else { "The target was read, read-only, but its identity could not be shown; nothing was written there." }
Say "$contact Not done here (separate decisions): steps 10-12. No Storage file was copied; Auth, Edge Functions, webhooks, the scheduler and the app are unchanged."
Say "exit $($script:Code)"
exit $script:Code
