// Checks a Hangtag backup (a pg_dump custom-format archive, from scripts/backup/hangtag-backup.ps1) and proves whether it
// restores — on THIS computer only. It connects nowhere but 127.0.0.1, except --compare-to (read-only). No row is printed,
// and rows are written nowhere but the throwaway database.
//
// 1. The archive: readable (pg_restore --list), its size and SHA-256, what it holds; its rows read once (hashes and counts).
// 2. A plan, entry by entry, each decision by the entry's identity and with its reason (never by an error message):
//    - left out of every restore, Supabase's platform: event triggers owned by its roles that call functions in its own
//      `extensions` schema; Supabase-only extensions (supabase_vault …) and every grant inside their schemas; the grants on
//      extension functions in `extensions`; Realtime's own publication of its own table (by name);
//    - left out of a recovery into a new Supabase project, which has them already: the extensions, the supabase_realtime
//      publication, Supabase's default privileges and its grant on pg_reload_conf, the platform's migration history, and the
//      auth / storage definitions owned by Supabase's roles (checked: none is made by the repository's own SQL);
//    - left out as nothing to restore: Supabase's tables that postgres can't write, when the archive holds no row for them;
//    - restored by a recovery: the application's schemas whole, the auth / storage rows, and the application's own objects
//      in Supabase's schemas (the trigger on auth.users, the policies on storage.objects). postgres's default privileges in
//      public and the public schema's grants are in a new project already, and restored as well.
//    The plan fails if an application object uses a Supabase schema no backup takes, if the recovery would give an object
//    to a role other than postgres, if it must write rows where postgres can't, or if the repository's SQL makes an object
//    in Supabase's schemas that the plan would leave out.
// 3. --target vanilla (the default): a throwaway PostgreSQL in a folder beside the archive (initdb with supabase_admin as
//    its superuser, as on Supabase; locale builtin C.UTF-8; trust only from 127.0.0.1; its own port; time zone UTC). The
//    archive is restored by the superuser, owners and privileges as in the archive.
//    --target supabase-sim rehearses supabase/RESTORE-RUNBOOK.md §5. The throwaway database first gets what a new project
//    has (the platform part, by the superuser, Supabase's default privileges for postgres in public included). postgres is
//    a LOGIN role that is NOT a superuser, as on Supabase: CREATEDB CREATEROLE REPLICATION BYPASSRLS, read access to every
//    table (the live backup, made as postgres, read them all), allowed to SET session_replication_role. Then, as postgres:
//    the preflight (<archive>.preflight-new-project.sql); a rollback drill (the recovery with a failure injected before
//    COMMIT: nothing may remain); the runbook's recovery command exactly as written (before-recovery.sql and the three
//    section files in one transaction, triggers paused only while rows load; any error or WARNING fails); a second run,
//    which must refuse; the preflight again, which must refuse. One allowance models Supabase's supautils extension, which
//    plain PostgreSQL lacks: postgres may create the policies on storage.objects. It is made a member of
//    supabase_storage_admin for the preflight's probe and the recovery only, after the preflight's privilege checks.
//    --demo-without-pre-step: the same recovery without before-recovery.sql, to show what that file prevents (it must fail).
// 4. The proof: every restored entry's definition, re-dumped, is the archive's (functions, triggers, policies, indexes,
//    constraints, privileges, publications … text for text; two named kinds of equivalence); anon's and authenticated's
//    rights on every function and table of the application's schemas are the ones the archive's grants give; every table
//    has the archive's columns and rows (a SHA-256 per table; both sides in UTC) and every sequence its position; the
//    application schemas' objects are counted in the catalog.
// 5. The throwaway cluster is stopped and deleted (it holds personal data) unless --keep; the archive is hashed again. The
//    report, the restore lists and the preflight are written beside the archive (names, counts and hashes only).
// --prereq <file.sql> (repeatable, vanilla only) runs SQL first, for objects an archive is known to lack: a diagnosis, never
//    a pass.
// --compare-to "<connection>" restores nothing: it compares an EXISTING database (the new Supabase project right after a
//    real recovery — never production) with the archive, read-only. The application's definitions, rights, rows and
//    sequences must match; so must the extensions it uses, row security and grants on auth.users and storage.objects
//    (which carry its trigger and policies), and the API roles' attributes. Anything only the project has must be
//    Supabase's (in its schemas, owned and made by its roles) and give anon and authenticated nothing outside them. An
//    auth / storage table with Supabase's newer columns must hold the archive's rows on the archive's columns. Exit 3
//    (review needed): one of Supabase's own definitions in the archive is missing or different in the project — its
//    version, or an application object the plan left out. Exit 5 (not judged): a read of the project failed (a dropped
//    connection, a refused query), so nothing is known about the copy; it only reads, so run it again. The password comes
//    from your own pgpass file or PGPASSWORD in your own shell, never this script.
// Run: node scripts/backup/verify-restore.mjs <archive.dump> [--target vanilla|supabase-sim] [--demo-without-pre-step] [--keep] [--port 55432] [--diff]
//      node scripts/backup/verify-restore.mjs <archive.dump> --compare-to "host=… port=5432 dbname=postgres user=postgres.<ref> sslmode=require require_auth=scram-sha-256"
//      (PG_BIN: the bin folder of PostgreSQL client tools 17.6 or newer; default C:\Program Files\PostgreSQL\18\bin)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2), keep = argv.includes('--keep'), demo = argv.includes('--demo-without-pre-step');
const valueOf = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const PORT = +(valueOf('--port')[0] || 55432), prereqs = valueOf('--prereq'), compareTo = valueOf('--compare-to')[0] || null;
const TARGET = demo ? 'supabase-sim' : valueOf('--target')[0] || 'vanilla';
const archive = argv.find((a, i) => !a.startsWith('--') && !['--port', '--prereq', '--target', '--compare-to'].includes(argv[i - 1]));
const BIN = process.env.PG_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const exe = (n) => path.join(BIN, process.platform === 'win32' ? n + '.exe' : n);
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..', '..');
const PRE_STEP = path.join(HERE, 'before-recovery.sql');
const usage = 'Usage: node scripts/backup/verify-restore.mjs <archive.dump> [--target vanilla|supabase-sim] [--demo-without-pre-step] [--keep] [--port N] [--prereq file.sql] [--diff]\n'
  + '       node scripts/backup/verify-restore.mjs <archive.dump> --compare-to "<connection>"';
if (!archive || !fs.existsSync(archive) || !['vanilla', 'supabase-sim'].includes(TARGET) || (compareTo && (demo || prereqs.length)) || (prereqs.length && TARGET !== 'vanilla')) { console.error(usage); process.exit(2); }
for (const p of prereqs) if (!fs.existsSync(p)) { console.error('No such prerequisite file: ' + p); process.exit(2); }
if (TARGET === 'supabase-sim' && !fs.existsSync(PRE_STEP)) { console.error('Missing ' + PRE_STEP); process.exit(2); }

// Supabase's own schemas (the backup script leaves the same ones out), the application's, and the platform's roles
const MANAGED_SCHEMAS = ['extensions', 'graphql', 'graphql_public', 'realtime', 'supabase_functions', 'pgsodium', 'pgsodium_masks', 'vault', 'net', 'pgbouncer', 'cron', 'pgtle'];
const APP_SCHEMAS = ['public', 'private', 'supabase_migrations'], SUPABASE_SCHEMAS = ['auth', 'storage'];
const PLATFORM_ROLES = new Set(['supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin']);
// extensions only Supabase has (or plain PostgreSQL doesn't ship): left out of every restore, whatever the target has
const SUPABASE_EXTENSIONS = new Set(['supabase_vault', 'pg_graphql', 'pgsodium', 'pg_net', 'pg_cron', 'pgjwt', 'wrappers', 'pg_jsonschema', 'pg_hashids', 'supautils', 'index_advisor', 'pg_tle']);
// tables whose rows are the platform's own migration history: a new Supabase project has its own
const PLATFORM_HISTORY = new Set(['auth.schema_migrations', 'storage.migrations']);

// every client tool talks in UTC (the archive's times are compared as text)
const ENV = { ...process.env, PGTZ: 'UTC', PGCLIENTENCODING: 'UTF8', PGOPTIONS: '' };
const report = [], say = (s) => { report.push(s); console.log(s); };
const run = (cmd, a, opts = {}) => spawnSync(exe(cmd), a, { encoding: 'utf8', maxBuffer: 1 << 30, env: ENV, ...opts });
const base = path.resolve(archive);
const reportFile = base + (compareTo ? '.verify-compare.txt' : prereqs.length ? '.verify-with-prereq.txt' : demo ? '.verify-demo-without-pre-step.txt'
  : TARGET === 'vanilla' ? '.verify.txt' : '.verify-supabase-sim.txt');
const work = path.join(path.dirname(base), 'restore-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
const pgdata = path.join(work, 'data'), pglog = path.join(work, 'server.log');
function hashFile(p) {
  const h = createHash('sha256'), fd = fs.openSync(p, 'r'), b = Buffer.alloc(1 << 20);
  for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
let started = false, keepLog = false, fileHash = null;
function finish(code) {
  if (started) run('pg_ctl', ['-D', pgdata, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  if (keepLog && fs.existsSync(pglog)) fs.copyFileSync(pglog, base + '.server.log');
  if (!keep && fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  else if (fs.existsSync(work)) say(`kept the restored copy: ${work} (it holds personal data: delete it when done)`);
  if (fileHash) {
    const now = hashFile(archive);
    say(now === fileHash ? `archive unchanged: sha256 ${now}` : `THE ARCHIVE CHANGED during the run: sha256 ${now}`);
    if (now !== fileHash) code = 1;
  }
  fs.writeFileSync(reportFile, report.join('\n') + '\n');
  process.exit(code);
}
/* "a"."b" → a.b (quoted identifiers as plain names) */
const unq = (s) => s.replace(/"((?:[^"]|"")*)"/g, (_, x) => x.replace(/""/g, '"'));
/* an error line without the values it may quote (invalid input …: "<value>") — never a row's content */
const mask = (l) => l.replace(/(invalid input (?:syntax|value) for [^:]*: )"[^"]*"/g, '$1"…"');
const problemLines = (s) => String(s).split(/\r?\n/).filter((l) => /\b(ERROR|WARNING|FATAL|PANIC):/.test(l)).map((l) => mask(l.replace(/^psql:.*?:\d+: /, '')).slice(0, 220));

// the client tools: the recovery's section files carry \restrict lines (pg_dump 17.6 and later), which older psql rejects
const version = (cmd) => { const m = /(\d+)\.(\d+)/.exec(run(cmd, ['--version']).stdout || ''); return m ? [+m[1], +m[2]] : null; };
const tools = ['psql', 'pg_restore', 'pg_dump'].map((c) => [c, version(c)]);
say(`client tools: ${tools.map(([c, v]) => `${c} ${v ? v.join('.') : 'missing'}`).join(', ')} (17.6 or newer required)`);
if (tools.some(([, v]) => !v || v[0] < 17 || (v[0] === 17 && v[1] < 6))) { say('client tools older than 17.6: install PostgreSQL 17.6 or newer (or set PG_BIN)'); finish(2); }

// ---------- 1. the archive ----------
const size = fs.statSync(archive).size;
fileHash = hashFile(archive);
say(`archive ${base}`);
say(`size ${size} bytes; sha256 ${fileHash}`);
const list = run('pg_restore', ['--list', archive]);
if (list.status !== 0) { say(`pg_restore --list: exit ${list.status} — NOT readable: ${String(list.stderr).trim().split('\n')[0]}`); finish(1); }
list.stdout.split(/\r?\n/).filter((l) => /^;\s+(Archive created at|dbname|TOC Entries|Dumped from database version|Dumped by pg_dump version|Format)/.test(l))
  .forEach((l) => say('  ' + l.replace(/^;\s+/, '')));
/* the table of contents: "<id>; <oid> <oid> <TYPE> <schema|-> <name …> <owner>", the TYPE one to three words, the owner
   empty for some entries (the line then ends with a space) */
const TWO = new Set(['TABLE DATA', 'SEQUENCE SET', 'FK CONSTRAINT', 'ROW SECURITY', 'DEFAULT ACL', 'MATERIALIZED VIEW', 'EVENT TRIGGER',
  'FOREIGN TABLE', 'LARGE OBJECT', 'PUBLICATION TABLE', 'CHECK CONSTRAINT', 'SHELL TYPE']);
const entries = [];
for (const raw of list.stdout.split(/\r?\n/)) {
  const m = /^(\d+); \d+ \d+ (.*)$/.exec(raw);
  if (!m) continue;
  const t = m[2].split(' ');
  const w = t.slice(0, 3).join(' ') === 'SEQUENCE OWNED BY' ? 3 : TWO.has(t[0] + ' ' + t[1]) ? 2 : 1;
  const tail = t.slice(w + 1), owner = tail.length > 1 ? tail[tail.length - 1] : '';
  entries.push({ id: m[1], raw, type: t.slice(0, w).join(' '), schema: t[w], name: (tail.length > 1 ? tail.slice(0, -1) : tail).join(' '), owner });
}
const tables = entries.filter((e) => e.type === 'TABLE').map((e) => e.schema + '.' + e.name);
const schemasIn = [...new Set(entries.filter((e) => e.schema !== '-').map((e) => e.schema).concat(entries.filter((e) => e.type === 'SCHEMA').map((e) => e.name)))].sort();
say(`pg_restore --list: exit 0, ${entries.length} entries, ${tables.length} tables; schemas: ${schemasIn.join(', ')}`);

/* the COPY blocks and sequence positions of a data-only plain dump (a stream) →
   { tables: { "schema.table": { cols, rows, hash, sorted, utc, zoned } }, seqs: { "schema.seq": "value is_called" } }
   (hash: the rows in order; sorted: the same rows in any order) */
function copyBlocks(cmd, a) {
  return new Promise((done, bad) => {
    const p = spawn(exe(cmd), a, { env: ENV }), out = {}, seqs = {};
    let buf = '', cur = null, h = null, n = 0, cols = '', utc = 0, zoned = 0, digests = [], err = '';
    const line = (l) => {
      if (cur) {
        if (l === '\\.') { out[cur] = { cols, rows: n, hash: h.digest('hex'), sorted: createHash('sha256').update(digests.sort().join('\n')).digest('hex'), utc, zoned }; cur = null; return; }
        h.update(l + '\n'); n++; digests.push(createHash('sha256').update(l).digest('hex'));
        utc += (l.match(/\d\d:\d\d:\d\d(\.\d+)?\+00(?=[\t\\]|$)/g) || []).length;
        zoned += (l.match(/\d\d:\d\d:\d\d(\.\d+)?[+-](0[1-9]|1\d)(:\d\d)?(?=[\t\\]|$)/g) || []).length;
        return;
      }
      // (a table whose columns are all generated has no column list; a quoted name may hold spaces)
      let m = /^COPY (.+?) (?:\((.*)\) )?FROM stdin;$/.exec(l);
      if (m) { cur = unq(m[1]); cols = m[2] || ''; h = createHash('sha256'); n = 0; utc = 0; zoned = 0; digests = []; return; }
      m = /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?\d+), (true|false)\);$/.exec(l);
      if (m) seqs[unq(m[1].replace(/''/g, "'"))] = m[2] + ' ' + m[3];
    };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? done({ tables: out, seqs }) : bad(new Error(`${cmd} exit ${code}: ${err.trim().split('\n')[0]}`))));
  });
}
const planErrors = [];
let original;
try { original = await copyBlocks('pg_restore', ['--data-only', '-f', '-', archive]); } catch (e) { say('reading the archive\'s rows failed: ' + e.message); finish(1); }
{
  // every TABLE DATA entry must come back as a COPY block, and nothing else
  const dataEntries = entries.filter((e) => e.type === 'TABLE DATA').map((e) => e.schema + '.' + e.name);
  const unread = dataEntries.filter((t) => !original.tables[t]), stray = Object.keys(original.tables).filter((t) => !dataEntries.includes(t));
  say(`  its rows: ${Object.keys(original.tables).length} tables read for ${dataEntries.length} TABLE DATA entries, ${Object.values(original.tables).reduce((a, x) => a + x.rows, 0)} rows; ${Object.keys(original.seqs).length} sequence positions`);
  if (unread.length || stray.length) planErrors.push(`the archive's rows don't match its TABLE DATA entries: ${[...unread, ...stray].slice(0, 10).join(', ')}`);
  const seqEntries = entries.filter((e) => e.type === 'SEQUENCE SET').length;
  if (Object.keys(original.seqs).length !== seqEntries) planErrors.push(`the archive's sequence positions (${Object.keys(original.seqs).length} read) don't match its ${seqEntries} SEQUENCE SET entries`);
}

// ---------- 2. the plan ----------
// the archive's definitions, entry by entry ("-- Name: …; Type: …; Schema: …; Owner: …" headers of a schema-only listing)
function ddlEntries(text) {
  const out = new Map(); let key = null, body = [];
  const flush = () => { if (key) out.set(key, (out.get(key) ? out.get(key) + '\n' : '') + norm(body)); };
  const norm = (lines) => lines.filter((l) => !/^SET default_tablespace|^SET default_table_access_method|^\\(un)?restrict |^-- (Dumped|PostgreSQL database dump)|^--$/.test(l))
    .map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{2,}/g, '\n').trim();
  for (const l of text.split(/\r?\n/)) {
    const m = /^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*)$/.exec(l);
    // (an entry without an owner is "Owner: -" here and an empty owner in the table of contents)
    if (m) { flush(); key = `${m[2]}|${m[3]}|${m[1]}|${m[4] === '-' ? '' : m[4]}`; body = []; continue; }
    if (key) body.push(l);
  }
  flush();
  return out;
}
const archDdl = ddlEntries(run('pg_restore', ['-s', '-f', '-', archive]).stdout);
const keyOf = (e) => `${e.type}|${e.schema}|${e.name}|${e.owner}`;
const ddlOf = (e) => archDdl.get(keyOf(e)) || '';
const aclBy = new Map(entries.filter((e) => e.type === 'ACL').map((e) => [`${e.schema}|${e.name}`, ddlOf(e)]));
const extName = (e) => unq(e.type === 'EXTENSION' ? e.name : e.type === 'COMMENT' && e.name.startsWith('EXTENSION ') ? e.name.slice(10) : '') || null;
const extSchema = new Map(entries.filter((e) => e.type === 'EXTENSION').map((e) => [unq(e.name), unq((/WITH SCHEMA (\S+?);/.exec(ddlOf(e)) || [])[1] || '')]));
// the schemas Supabase-only extensions keep their objects in (supabase_vault → vault)
// (never an application or system schema: pg_cron lives in pg_catalog, and some extensions can be put in public)
const supaExtSchemas = new Set([...extSchema].filter(([x, s]) => SUPABASE_EXTENSIONS.has(x) && s && ![...APP_SCHEMAS, ...SUPABASE_SCHEMAS, 'pg_catalog'].includes(s)).map(([, s]) => s));
const inSupabaseSchemas = (e) => SUPABASE_SCHEMAS.includes(e.schema) || (e.schema === '-' && /^(SCHEMA )?(auth|storage)$/.test(e.name));
// what the archive defines (an extension's members have no entry of their own, only their grants)
const defined = new Set(entries.filter((e) => !['ACL', 'COMMENT', 'SECURITY LABEL', 'TABLE DATA', 'SEQUENCE SET'].includes(e.type)).map((e) => `${e.schema}|${e.name.replace(/\(.*$/, '')}`));
const aclObject = (e) => `${e.schema}|${e.name.replace(/^[A-Z]+(?: [A-Z]+)? /, '').replace(/\(.*$/, '').split('.')[0]}`;
/* a trigger is the application's when its function lives outside Supabase's own schemas (any schema the backup takes) */
const SUPABASE_OWN = new Set([...SUPABASE_SCHEMAS, ...MANAGED_SCHEMAS]);
const appTriggerDdl = (ddl) => { const s = unq((/EXECUTE FUNCTION ("?[\w$]+"?)\./.exec(ddl) || [])[1] || ''); return !!s && !SUPABASE_OWN.has(s); };

/* what the repository's own SQL (supabase/schema.sql, supabase/migrations, supabase/operations) makes or changes in
   Supabase's auth and storage schemas, dynamic SQL in strings included: the plan must restore what it makes, and it
   can't carry what it changes */
function repoObjects() {
  const dir = path.join(REPO, 'supabase');
  const sqlIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(d, f)) : []);
  const files = [path.join(dir, 'schema.sql'), ...sqlIn(path.join(dir, 'migrations')), ...sqlIn(path.join(dir, 'operations'))].filter((f) => fs.existsSync(f));
  if (!files.length) return null;
  // (a comment runs to the line's end, except inside a quoted string; an unquoted name folds to lower case)
  const uncomment = (t) => t.split('\n').map((l) => { let q = false; for (let i = 0; i < l.length; i++) { if (l[i] === "'") q = !q; else if (!q && l[i] === '-' && l[i + 1] === '-') return l.slice(0, i); } return l; }).join('\n');
  const id = (s) => (s.startsWith('"') ? unq(s) : s.toLowerCase());
  const made = new Map(), changes = [], S = '"?(auth|storage)"?', ID = '("(?:[^"]|"")+"|[\\w$]+)';
  for (const f of files) {
    const text = uncomment(fs.readFileSync(f, 'utf8')), at = path.relative(REPO, f).replace(/\\/g, '/');
    const add = (key) => made.set(key, (made.get(key) || []).concat(at));
    for (const m of text.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${ID}[^;]*?\\sON\\s+(?:ONLY\\s+)?${S}\\.${ID}`, 'gi'))) add(`TRIGGER|${m[2].toLowerCase()}|${id(m[3])} ${id(m[1])}`);
    for (const m of text.matchAll(new RegExp(`CREATE\\s+POLICY\\s+${ID}\\s+ON\\s+(?:ONLY\\s+)?${S}\\.${ID}`, 'gi'))) add(`POLICY|${m[2].toLowerCase()}|${id(m[3])} ${id(m[1])}`);
    for (const m of text.matchAll(new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}\\s+ON\\s+(?:ONLY\\s+)?${S}\\.`, 'gi'))) add(`INDEX|${m[2].toLowerCase()}|${id(m[1])}`);
    for (const m of text.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(FUNCTION|PROCEDURE|VIEW|TABLE|TYPE|SEQUENCE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${S}\\.${ID}`, 'gi'))) add(`${m[1].toUpperCase()}|${m[2].toLowerCase()}|${id(m[3])}`);
    for (const re of [`\\b(?:GRANT|REVOKE)\\b[^;]*?\\sON\\s[^;]*?[\\s,]${S}(?:\\.|\\s+TO\\b|\\s+FROM\\b|\\s*,)`, `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${S}\\.`,
      `\\bCOMMENT\\s+ON\\s+\\w+(?:\\s+\\w+)?\\s+${S}\\.`, `\\bALTER\\s+DEFAULT\\s+PRIVILEGES[^;]*?\\sIN\\s+SCHEMA\\s+${S}\\b`])
      for (const m of text.matchAll(new RegExp(re, 'gi'))) changes.push(`${at}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  return { files: files.length, made, changes };
}
const repo = repoObjects();
const repoMade = (e) => !!repo && (repo.made.has(`${e.type}|${e.schema}|${e.name}`) || (['FUNCTION', 'PROCEDURE'].includes(e.type) && repo.made.has(`${e.type}|${e.schema}|${e.name.replace(/\(.*$/, '')}`)));

/* the reason an entry belongs to Supabase's platform and is left out of every restore, or null */
function platformOnly(e) {
  if (e.type === 'EVENT TRIGGER' && PLATFORM_ROLES.has(e.owner) && /EXECUTE FUNCTION extensions\./.test(ddlOf(e))) return 'Supabase platform hook (an event trigger on DDL; its function is in Supabase\'s own `extensions` schema, which no backup takes; every Supabase project has its own)';
  const x = extName(e);
  if (x && SUPABASE_EXTENSIONS.has(x)) return `Supabase-only extension ${x} (not in plain PostgreSQL; every Supabase project has it)`;
  if (e.type === 'PUBLICATION' && e.name === 'supabase_realtime_messages_publication') return 'Supabase Realtime\'s own publication of its own table (by name)';
  if (e.type === 'PUBLICATION TABLE' && MANAGED_SCHEMAS.includes(e.schema)) return 'a table of Supabase\'s own schema in Realtime\'s own publication';
  if (e.type === 'ACL' && e.schema === 'extensions') return 'Supabase\'s privileges on its extensions\' functions in its own `extensions` schema';
  if (e.type === 'ACL' && supaExtSchemas.has(e.schema) && !defined.has(aclObject(e))) return `Supabase's privileges inside schema ${e.schema}, which belongs to a Supabase-only extension`;
  return null;
}
/* what a new Supabase project already has, so a recovery into one leaves it out (the platform part), or null */
function providedBySupabase(e) {
  if (platformOnly(e)) return platformOnly(e);
  if (extName(e)) return 'an extension every Supabase project has (the preflight checks it is enabled)';
  if (e.type === 'PUBLICATION' && e.name === 'supabase_realtime') return 'the supabase_realtime publication exists in every Supabase project (the application\'s tables in it are restored)';
  if (e.type === 'DEFAULT ACL' && (PLATFORM_ROLES.has(e.owner) || SUPABASE_SCHEMAS.includes(e.schema))) return 'Supabase\'s default privileges';
  if (e.type === 'ACL' && e.schema === 'pg_catalog' && PLATFORM_ROLES.has(e.owner)) return 'Supabase\'s grant on a PostgreSQL system function to its own role';
  if (e.type === 'TABLE DATA' && PLATFORM_HISTORY.has(e.schema + '.' + e.name)) return 'the platform\'s own migration history (a new project has its own)';
  if (!inSupabaseSchemas(e)) return null;
  if (e.type === 'TABLE DATA' || e.type === 'SEQUENCE SET') return null;                       // the accounts, the files' records
  if (e.type === 'POLICY' || repoMade(e)) return null;                                           // Supabase ships no policy: the application's
  if (e.type === 'TRIGGER' && appTriggerDdl(ddlOf(e))) return null;                             // calls the application's function
  return 'Supabase\'s own auth / storage definitions (a new project has them, in its own version)';
}
/* in a new project already AND restored: postgres's default privileges in public (put back at the end of the recovery,
   after before-recovery.sql took them away), and the public schema's grants */
const both = (e) => (e.type === 'DEFAULT ACL' && e.schema === 'public' && e.owner === 'postgres') || (e.type === 'ACL' && e.schema === '-' && e.name === 'SCHEMA public');
/* may postgres write this table's rows (INSERT) or set this sequence (UPDATE), by the archive's grants? */
function mayWrite(e) {
  if (e.owner === 'postgres') return true;
  const kind = e.type === 'TABLE DATA' ? 'TABLE' : 'SEQUENCE', need = kind === 'TABLE' ? 'INSERT' : 'UPDATE';
  return (aclBy.get(`${e.schema}|${kind} ${e.name}`) || '').split('\n').some((l) => {
    const m = /^GRANT (.+?) ON (?:TABLE|SEQUENCE) \S+ TO ("?[\w$]+"?)(?: WITH GRANT OPTION)?;$/.exec(l);
    return m && /^(postgres|PUBLIC)$/.test(unq(m[2])) && (m[1] === 'ALL' || m[1].split(',').includes(need));
  });
}
const plan = entries.map((e) => ({ e, skip: platformOnly(e), supa: providedBySupabase(e), both: both(e) }));
for (const p of plan) {
  const { e } = p;
  if (p.supa || !SUPABASE_SCHEMAS.includes(e.schema) || !['TABLE DATA', 'SEQUENCE SET'].includes(e.type) || mayWrite(e)) continue;
  const rows = e.type === 'TABLE DATA' ? (original.tables[`${e.schema}.${e.name}`] || {}).rows : null;
  if (rows === 0) p.empty = `Supabase's own table ${e.schema}.${e.name}: postgres has no INSERT on it and the archive holds no row (nothing to restore)`;
  else planErrors.push(`postgres can't write ${e.schema}.${e.name} (no ${e.type === 'TABLE DATA' ? 'INSERT' : 'UPDATE'} in the archive's grants), yet the archive holds ${rows === null ? 'its position' : rows + ' rows'}: decide how before any recovery`);
}
const inVanilla = (p) => !p.skip, inRecovery = (p) => (!p.supa || p.both) && !p.empty, inPlatform = (p) => (!!p.supa && !p.skip) || p.both;
const planById = new Map(plan.map((p) => [p.e.id, p])), planByKey = new Map(plan.map((p) => [keyOf(p.e), p]));
const label = (e) => `${e.type} ${e.schema === '-' ? '' : e.schema + '.'}${e.name}`;
const groupSay = (ps, why) => { const g = {}; for (const p of ps) (g[why(p)] = g[why(p)] || []).push(label(p.e)); for (const [w, items] of Object.entries(g)) say(`  ${items.length} × ${w}: ${items.slice(0, 8).join('; ')}${items.length > 8 ? '; …' : ''}`); };
const skipped = plan.filter((p) => p.skip);
say(`plan: ${entries.length} entries; ${skipped.length} left out of every restore as Supabase's platform (each by its identity, never by an error):`);
groupSay(skipped, (p) => p.skip);
const provided = plan.filter((p) => p.supa && !p.skip), kept = plan.filter(inRecovery);
say(`  a recovery into a new Supabase project restores ${kept.length} entries; ${provided.length} are what the project already has (the platform part: ${[...new Set(provided.map((p) => p.e.type))].join(', ')});`
  + ` ${plan.filter((p) => p.both).length} are both (${plan.filter((p) => p.both).map((p) => label(p.e)).join('; ')})`);
const empties = plan.filter((p) => p.empty);
if (empties.length) say(`  ${empties.length} left out as nothing to restore — Supabase's own tables that postgres can't write, empty in the archive: ${empties.map((p) => p.e.schema + '.' + p.e.name).join(', ')}`);
// the application's objects inside Supabase's schemas, and the repository's own SQL
const appInSupabase = kept.filter((p) => inSupabaseSchemas(p.e) && !['TABLE DATA', 'SEQUENCE SET'].includes(p.e.type));
say(`  the application's objects in Supabase's schemas, restored: ${appInSupabase.map((p) => label(p.e)).join('; ') || 'none'}`);
if (!repo) say('  the repository\'s SQL (supabase/schema.sql, supabase/migrations) was not found beside this script: its cross-check is skipped');
else {
  const made = [...repo.made.keys()].map((k) => {
    const [type, schema, name] = k.split('|');
    const p = plan.find((x) => x.e.type === type && x.e.schema === schema && (x.e.name === name || (['FUNCTION', 'PROCEDURE'].includes(type) && x.e.name.replace(/\(.*$/, '') === name)));
    if (p && !inRecovery(p)) planErrors.push(`the repository's SQL makes ${type} ${schema}.${name}, but the plan leaves it out`);
    return `${type} ${schema}.${name} (${p ? (inRecovery(p) ? 'restored' : 'LEFT OUT') : 'not in the archive'})`;
  });
  say(`  the repository's SQL (${repo.files} files) makes in Supabase's schemas: ${made.join('; ') || 'nothing'}`);
  if (repo.changes.length) planErrors.push(`the repository's SQL changes Supabase's own objects, which a recovery doesn't carry: ${repo.changes.slice(0, 6).join(' | ')}`);
}
// what is left out as Supabase's in auth / storage is owned by Supabase's roles (default privileges name the role they're for)
const foreign = provided.filter((p) => inSupabaseSchemas(p.e) && p.e.type !== 'DEFAULT ACL' && !PLATFORM_ROLES.has(p.e.owner));
say(`  auth / storage entries left out as Supabase's: ${provided.filter((p) => inSupabaseSchemas(p.e)).length}, ${foreign.length ? 'NOT all owned by Supabase\'s roles: ' + foreign.slice(0, 8).map((p) => label(p.e) + ' (' + p.e.owner + ')').join('; ') : 'every one owned by Supabase\'s roles (or its default privileges)'}`);
if (foreign.length) planErrors.push(`auth / storage entries left out as Supabase's, but owned by another role: ${foreign.slice(0, 8).map((p) => label(p.e)).join('; ')}`);
// (a trigger, policy or grant carries its table's owner in the archive, whoever made it. A grant made by another role
//  inside an entry the recovery leaves out is wrapped in SET SESSION AUTHORIZATION: the application's, lost with the entry)
const othersGrants = plan.filter((p) => p.e.type === 'ACL' && !inRecovery(p)).flatMap((p) => [...ddlOf(p.e).matchAll(/^SET SESSION AUTHORIZATION ("?[\w$]+"?);$/gm)]
  .map((m) => unq(m[1])).filter((r) => !PLATFORM_ROLES.has(r)).map((r) => `${label(p.e)} (granted by ${r})`));
say(`  grants by other roles inside entries the recovery leaves out: ${othersGrants.join('; ') || 'none'}`);
if (othersGrants.length) planErrors.push(`grants the application made inside entries the recovery leaves out: ${othersGrants.slice(0, 6).join('; ')} — re-grant them by hand after the recovery, or decide otherwise first`);
// the recovery gives every object to postgres (a non-superuser can give objects only to roles it belongs to)
const owners = [...new Set(kept.flatMap((p) => [...ddlOf(p.e).matchAll(/^ALTER .* OWNER TO ("?[\w$]+"?);$/gm)].map((m) => unq(m[1]))))];
say(`  owners the recovery sets: ${owners.join(', ') || 'none'}`);
if (owners.some((o) => o !== 'postgres')) planErrors.push(`the recovery would give objects to ${owners.filter((o) => o !== 'postgres').join(', ')}: postgres can't`);
// no restored object may use a Supabase schema no backup takes (a function body isn't checked when it is created)
const outside = [...new Set([...MANAGED_SCHEMAS, ...supaExtSchemas])];
const refRe = new RegExp(`(^|[^\\w$"])"?(${outside.join('|')})"?\\.`, 'gi'), deps = new Map();
for (const p of kept.filter((x) => !/^(PUBLICATION|PUBLICATION TABLE|TABLE DATA|SEQUENCE SET)$/.test(x.e.type)))
  for (const m of ddlOf(p.e).matchAll(refRe)) deps.set(m[2].toLowerCase(), (deps.get(m[2].toLowerCase()) || new Set()).add(label(p.e)));
const fatalDeps = [...deps].filter(([s]) => s !== 'extensions');
say(`  restored objects using Supabase's schemas that no backup takes (checked: ${outside.join(', ')}): ${deps.size ? [...deps].map(([s, o]) => `${s}: ${[...o].slice(0, 4).join('; ')}`).join(' | ') : 'none'}`);
if (deps.has('extensions')) say('  (functions in schema extensions come from the extensions the archive names; the preflight checks they are enabled)');
if (fatalDeps.length) planErrors.push(`restored objects use ${fatalDeps.map(([s]) => s).join(', ')}: the new project must enable their extensions, and no plain PostgreSQL proof covers them`);
planErrors.forEach((x) => say(`  PLAN ERROR: ${x}`));

// the lists — beside the archive, except with --compare-to (it must never rewrite the rehearsed ones)
fs.mkdirSync(work, { recursive: true });
const writeList = (file, keepEntry) => {
  fs.writeFileSync(file, list.stdout.split(/\r?\n/).map((l) => { const m = /^(\d+);/.exec(l); if (!m) return l; const p = planById.get(m[1]); return p && keepEntry(p) ? l : ';' + l; }).join('\n'));
  return file;
};
const vanillaList = writeList(compareTo ? path.join(work, 'restore-vanilla.list') : base + '.restore-vanilla.list', inVanilla);
const recoveryList = writeList(compareTo ? path.join(work, 'restore-into-supabase.list') : base + '.restore-into-supabase.list', inRecovery);
const platformList = writeList(path.join(work, 'platform-part.list'), inPlatform);

// the preflight: checks on the NEW project before the recovery, as postgres, changing nothing
const splitCols = (s) => (s.match(/"(?:[^"]|"")*"|[^,\s][^,]*/g) || []).map((x) => unq(x.trim()));
function preflightSql() {
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`, arr = (xs) => (xs.length ? `ARRAY[${xs.map(lit).join(', ')}]::text[]` : 'ARRAY[]::text[]');
  const bodies = kept.map((p) => ddlOf(p.e)).join('\n');
  const supaRefs = (re, types) => {
    const known = new Set(entries.filter((e) => types.includes(e.type) && SUPABASE_SCHEMAS.includes(e.schema)).map((e) => `${e.schema}.${e.name.replace(/\(.*$/, '')}`));
    return [...new Set([...bodies.matchAll(re)].map((m) => `${m[1].toLowerCase()}.${unq(m[2])}`))].filter((x) => known.has(x)).sort();
  };
  const roles = roleRefs(kept), exts = plan.filter((p) => p.e.type === 'EXTENSION' && !p.skip).map((p) => unq(p.e.name));
  const data = kept.filter((p) => p.e.type === 'TABLE DATA' && SUPABASE_SCHEMAS.includes(p.e.schema)).map((p) => [`${p.e.schema}.${p.e.name}`, splitCols((original.tables[`${p.e.schema}.${p.e.name}`] || {}).cols || '')]);
  const seqs = kept.filter((p) => p.e.type === 'SEQUENCE SET' && SUPABASE_SCHEMAS.includes(p.e.schema)).map((p) => `${p.e.schema}.${p.e.name}`);
  const onTables = (type) => [...new Set(kept.filter((p) => p.e.type === type && SUPABASE_SCHEMAS.includes(p.e.schema)).map((p) => `${p.e.schema}.${p.e.name.split(' ')[0]}`))];
  const fns = supaRefs(/\b(auth|storage)\.("?[\w$]+"?)\s*\(/gi, ['FUNCTION']);
  const rels = supaRefs(/\b(auth|storage)\.("?[\w$]+"?)/gi, ['TABLE', 'VIEW']);
  const refs = supaRefs(/\bREFERENCES\s+(auth|storage)\.("?[\w$]+"?)/gi, ['TABLE']);
  const appObjs = kept.filter((p) => ['POLICY', 'TRIGGER'].includes(p.e.type) && SUPABASE_SCHEMAS.includes(p.e.schema))
    .map((p) => `(${lit(p.e.schema + '.' + p.e.name.split(' ')[0])}, ${lit(p.e.name.split(' ').slice(1).join(' '))})`);
  const policyTables = onTables('POLICY'), triggerTables = onTables('TRIGGER');
  const part1 = `-- Preflight for recovering ${path.basename(base)}
-- (sha256 ${fileHash}) into a NEW Supabase project: supabase/RESTORE-RUNBOOK.md section 5.
-- Written by scripts/backup/verify-restore.mjs. Run it as postgres on the NEW project (never the live one) before the
-- recovery:   psql -d "<the new project's connection string>" -v ON_ERROR_STOP=1 -f <this file>
-- It changes nothing. Part 1 only reads, in a read-only transaction that it rolls back. Part 2 creates a probe policy and a
-- probe trigger inside a transaction that is always rolled back. It stops at the first part that fails, listing every problem.
\\set ON_ERROR_STOP on

-- Part 1: a new, empty project, with what the recovery needs: roles, extensions, privileges, Supabase's tables and functions.
BEGIN READ ONLY;
DO $preflight$
DECLARE
  problems text[] := '{}';
  x text;
  y text;
  t text;
  cols text[];
  missing text[];
  filled boolean;
BEGIN
  IF current_user <> 'postgres' THEN problems := problems || format('connected as %s: run it as postgres', current_user); END IF;
  IF current_setting('server_version_num')::int < 170000 THEN
    problems := problems || format('PostgreSQL %s: the recovery needs 17 or newer', current_setting('server_version'));
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN problems := problems || 'the database is not UTF8'::text; END IF;
  -- never an existing database
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) THEN
    problems := problems || 'schema public already has tables: not a new, empty project (never restore over an existing database)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('private', 'supabase_migrations')) THEN
    problems := problems || 'schema private or supabase_migrations exists already: not a new, empty project'::text;
  END IF;
  IF to_regclass('auth.users') IS NULL THEN problems := problems || 'auth.users is missing: not a Supabase project'::text;
  ELSIF EXISTS (SELECT 1 FROM auth.users) THEN problems := problems || 'auth.users has accounts: not a new, empty project'::text;
  END IF;
  -- the roles the recovery names, the extensions the application's objects were made with
  FOREACH x IN ARRAY ${arr(roles)} LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = x) THEN problems := problems || format('role %s is missing', x); END IF;
  END LOOP;
  FOREACH x IN ARRAY ${arr(exts)} LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = x) THEN
      problems := problems || format('extension %s is not enabled (Database > Extensions)', x);
    END IF;
  END LOOP;
  -- what postgres must be: not a superuser on Supabase, but it bypasses row security, may create schemas, and owns schema
  -- public as the database's owner (its grants there would otherwise only warn)
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'postgres') THEN
    problems := problems || 'postgres does not bypass row security: rows of Supabase''s tables with row security would not load'::text;
  END IF;
  IF NOT has_database_privilege('postgres', current_database(), 'CREATE') THEN
    problems := problems || 'postgres may not create schemas in this database'::text;
  END IF;
  IF NOT pg_has_role('postgres', (SELECT nspowner FROM pg_namespace WHERE nspname = 'public'), 'USAGE') OR NOT has_schema_privilege('postgres', 'public', 'CREATE') THEN
    problems := problems || 'postgres does not own schema public (as the database''s owner): the recovery''s objects and grants there would fail or only warn'::text;
  END IF;
  -- the API's roles: no attribute or membership that would make row security void
  FOR x IN SELECT r.rolname FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
           AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)) LOOP
    problems := problems || format('role %s has a superuser-like attribute or belongs to another role', x);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND pg_has_role('postgres', pubowner, 'USAGE')) THEN
    problems := problems || 'publication supabase_realtime is missing, or postgres may not add tables to it'::text;
  END IF;
  -- Supabase's tables the recovery loads rows into: postgres may write them, they take the archive's columns, and they are
  -- still empty (rows already there would end up beside the archive's, or stop the recovery halfway)
  FOR t, cols IN SELECT * FROM (VALUES
${data.map(([tn, cs]) => `      (${lit(tn)}, ${arr(cs)})`).join(',\n') || '      (NULL::text, NULL::text[])'}
    ) v(tn, cs) WHERE tn IS NOT NULL LOOP
    IF to_regclass(t) IS NULL THEN problems := problems || format('table %s is missing', t); CONTINUE; END IF;
    IF NOT has_table_privilege('postgres', t, 'INSERT') THEN problems := problems || format('postgres may not insert into %s', t); END IF;
    missing := ARRAY(SELECT c FROM unnest(cols) c WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(t)
                     AND a.attname::text = c AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''));
    IF cardinality(missing) > 0 THEN
      problems := problems || format('%s lacks the archive''s columns (or generates them): %s', t, array_to_string(missing, ', '));
    END IF;
    missing := ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = to_regclass(t) AND a.attnum > 0 AND NOT a.attisdropped
                     AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = '' AND a.attname::text <> ALL (cols));
    IF cardinality(missing) > 0 THEN
      problems := problems || format('%s has required columns the archive lacks: %s', t, array_to_string(missing, ', '));
    END IF;
    IF NOT has_table_privilege('postgres', t, 'SELECT') THEN problems := problems || format('postgres may not read %s', t);
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', to_regclass(t)) INTO filled;
      IF filled THEN problems := problems || format('%s has rows already: not a new, empty project', t); END IF;
    END IF;
  END LOOP;
  FOREACH x IN ARRAY ${arr(seqs)} LOOP
    IF to_regclass(x) IS NULL THEN problems := problems || format('sequence %s is missing', x);
    ELSIF NOT has_sequence_privilege('postgres', x, 'UPDATE') THEN problems := problems || format('postgres may not set sequence %s', x);
    END IF;
  END LOOP;
  FOREACH x IN ARRAY ${arr(onTables('TRIGGER'))} LOOP
    IF to_regclass(x) IS NULL OR NOT has_table_privilege('postgres', x, 'TRIGGER') THEN
      problems := problems || format('postgres may not create the application''s trigger on %s', x);
    END IF;
  END LOOP;
  FOREACH x IN ARRAY ${arr(refs)} LOOP
    IF to_regclass(x) IS NULL OR NOT has_any_column_privilege('postgres', x, 'REFERENCES') THEN
      problems := problems || format('postgres may not make foreign keys to %s', x);
    END IF;
  END LOOP;
  -- the application's own objects in Supabase's schemas must not exist yet (the recovery creates them)
  FOR t, y IN SELECT * FROM (VALUES ${appObjs.join(', ') || '(NULL::text, NULL::text)'}) v(tb, nm) WHERE tb IS NOT NULL LOOP
    IF to_regclass(t) IS NOT NULL AND (EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(t) AND polname = y)
                                       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(t) AND tgname = y)) THEN
      problems := problems || format('%s already has %s: the recovery would fail on it', t, y);
    END IF;
  END LOOP;
  -- Supabase's tables and functions the application's objects use
  FOREACH x IN ARRAY ${arr(rels)} LOOP
    IF to_regclass(x) IS NULL THEN problems := problems || format('%s is missing (the application uses it)', x); END IF;
  END LOOP;
  FOREACH x IN ARRAY ${arr(fns)} LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = split_part(x, '.', 1) AND p.proname = split_part(x, '.', 2)) THEN
      problems := problems || format('function %s is missing (the application calls it)', x);
    END IF;
  END LOOP;
  -- default privileges before-recovery.sql doesn't take away would give restored objects grants live never had
  IF EXISTS (SELECT 1 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
             WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
               AND (d.defaclnamespace = 0 OR n.nspname IN ('private', 'supabase_migrations'))) THEN
    problems := problems || 'postgres has default privileges outside schema public, which before-recovery.sql does not take away'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a
             WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres') AND n.nspname = 'public'
               AND a.grantee NOT IN (SELECT oid FROM pg_roles WHERE rolname IN ('postgres', 'anon', 'authenticated', 'service_role'))) THEN
    problems := problems || 'postgres''s default privileges in public grant to other roles than anon, authenticated and service_role'::text;
  END IF;
  RAISE NOTICE 'preflight: database % on PostgreSQL %, collation %, ctype %', current_database(), current_setting('server_version'),
    (SELECT datcollate FROM pg_database WHERE datname = current_database()), (SELECT datctype FROM pg_database WHERE datname = current_database());
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'preflight: % problem(s), the recovery must not run:%', cardinality(problems), E'\\n  - ' || array_to_string(problems, E'\\n  - ');
  END IF;
  RAISE NOTICE 'preflight part 1 passed: a new, empty project with the roles, extensions, tables, functions and privileges the recovery needs';
END
$preflight$;
-- postgres may pause triggers while the rows load (on Supabase, its supautils extension allows it)
SET LOCAL session_replication_role = replica;
ROLLBACK;
`;
  const part2 = `
-- Part 2: postgres may create the application's policies on ${policyTables.join(', ') || '(none)'} (on Supabase, its supautils
-- extension allows it) and its trigger on ${triggerTables.join(', ') || '(none)'}. One probe of each, in a transaction that is always
-- rolled back.
BEGIN;
${[...policyTables.map((t) => `CREATE POLICY hangtag_preflight_probe ON ${t} FOR SELECT TO authenticated USING (false);`),
    ...triggerTables.map((t) => `CREATE TRIGGER hangtag_preflight_probe BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger();`)].join('\n')}
ROLLBACK;
\\echo preflight: every check passed. Nothing was changed.
`;
  return { part1, part2 };
}
/* the roles some entries name: owners, grantees, policy roles, default privileges' roles (never words in a function body) */
function roleRefs(ps) {
  const refs = new Set();
  for (const p of ps) for (const l of ddlOf(p.e).split('\n')) {
    let m;
    if ((m = /^ALTER .* OWNER TO ("?[\w$]+"?);$/.exec(l))) refs.add(m[1]);
    if (/^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) /.test(l) && (m = /\b(?:TO|FROM) ([\w", ]+?)( WITH GRANT OPTION| GRANTED BY .*)?;$/.exec(l))) m[1].split(',').forEach((x) => refs.add(x.trim()));
    if ((m = /^ALTER DEFAULT PRIVILEGES FOR ROLE ("?[\w$]+"?)/.exec(l))) refs.add(m[1]);
    if (/^CREATE POLICY /.test(l)) { const t = /\bTO ([\w", ]+?)(\s+USING|\s+WITH CHECK|;|$)/.exec(l); if (t) t[1].split(',').forEach((x) => refs.add(x.trim())); }
  }
  return [...refs].map(unq).filter((x) => x && !/^(public|current_user|session_user|current_role|pg_database_owner)$/i.test(x)).sort();
}
const preflight = preflightSql();
const preflightFile = base + '.preflight-new-project.sql';
if (!compareTo) fs.writeFileSync(preflightFile, preflight.part1 + preflight.part2);
say(`restore lists${compareTo ? ' (in the work folder; the rehearsed ones beside the archive are left as they are)' : ` and the preflight written: ${path.basename(vanillaList)} (plain PostgreSQL); ${path.basename(recoveryList)} (the recovery); ${path.basename(preflightFile)}`}`);

// ---------- 3. the restore (or, with --compare-to, the existing database: read-only, never written) ----------
const SU = ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'supabase_admin'];
const TGT = compareTo ? ['-w', '-d', compareTo] : [...SU, '-d', 'restored'];     // (-w: never ask for a password)
const su = (db, ...sql) => run('psql', [...SU, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAt', ...sql.flatMap((s) => ['-c', s])]);
// (read-only for this transaction only: a session setting could outlive it on a pooled connection)
const tq = (sqlText) => run('psql', [...TGT, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', 'BEGIN READ ONLY', '-c', sqlText, '-c', 'COMMIT']);
// (with --compare-to, a read of the compared database that fails ends the check with exit 5: the copy was not judged, so
//  it is never reported as different for that. The check only reads: run it again.)
const readOrStop = (what, x) => {
  if (compareTo && x.status !== 0) {
    say(`could not read the compared database (${what}): ${String(x.stderr).trim().split('\n')[0] || 'exit ' + x.status}`);
    say('RESULT (not judged, exit 5): the compared database could not be read to the end, so nothing is known about the copy yet. The check only reads: run it again.');
    finish(5);
  }
  return x;
};
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
let r, restoreOk = true, simOk = true;
const restore = (listFile, what) => {
  const x = run('pg_restore', [...SU, '-d', 'restored', '-L', listFile, archive]);
  const errs = String(x.stderr).split(/\r?\n/).filter((l) => /pg_restore: error:/.test(l));
  say(`pg_restore (${what}): exit ${x.status}, ${errs.length} errors`);
  [...new Set(errs.map((e) => mask(e.replace(/pg_restore: error: /, '')).slice(0, 220)))].slice(0, 15).forEach((e) => say('  error: ' + e));
  return x.status === 0 && !errs.length;
};
if (!compareTo) {
  r = run('initdb', ['-D', pgdata, '-U', 'supabase_admin', '-A', 'trust', '-E', 'UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C', '--no-instructions']);
  if (r.status !== 0) { say(`initdb failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`); finish(1); }
  // only this computer may connect, only on this port
  fs.writeFileSync(path.join(pgdata, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
  // (its output only to its log: on Windows the server keeps any pipe it inherits open, and the start would never return)
  r = run('pg_ctl', ['-D', pgdata, '-l', pglog, '-w', '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -c timezone=UTC`, 'start'], { stdio: 'ignore' });
  if (r.status !== 0) { say(`the throwaway server didn't start (port ${PORT} in use? try --port; its log: ${pglog})`); keepLog = true; finish(1); }
  started = true;
  // postgres as on Supabase: not a superuser; it owns the database; it may read every table and pause triggers
  r = su('postgres', 'CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS', 'GRANT pg_read_all_data TO postgres',
    'GRANT SET ON PARAMETER session_replication_role TO postgres', 'CREATE DATABASE restored OWNER postgres');
  if (r.status !== 0) { say(`setting up the throwaway server failed: ${String(r.stderr).trim().split('\n')[0]}`); finish(1); }
  say(`throwaway PostgreSQL ${run('postgres', ['--version']).stdout.trim().replace(/^postgres \(PostgreSQL\) /, '')} on 127.0.0.1:${PORT}, superuser supabase_admin, locale builtin C.UTF-8, time zone UTC, in ${work};`
    + ' postgres: LOGIN, not a superuser, CREATEDB CREATEROLE REPLICATION BYPASSRLS, reads every table (pg_read_all_data), may SET session_replication_role, owns database restored');
  // the roles the archive names (owners, grantees, policy roles), and the empty schema its extensions are created in
  const roles = roleRefs(plan.filter((p) => !p.skip)).filter((x) => x !== 'postgres');
  r = su('restored', `DO $$ DECLARE r TEXT; BEGIN
    FOREACH r IN ARRAY ARRAY[${roles.map((x) => `'${x.replace(/'/g, "''")}'`).join(',') || "''"}] LOOP
      IF r <> '' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP; END $$`, 'CREATE SCHEMA IF NOT EXISTS extensions', `GRANT USAGE ON SCHEMA extensions TO ${['postgres', 'anon', 'authenticated', 'service_role'].filter((x) => x === 'postgres' || roles.includes(x)).join(', ')}`);
  if (r.status !== 0) { say(`provisioning failed: ${String(r.stderr).trim().split('\n')[0]}`); finish(1); }
  say(`provisioned (only what the archive needs): ${roles.length} roles it names (${roles.join(', ')}); the empty schema extensions (its extensions are created there)`);
  for (const p of prereqs) {
    r = run('psql', [...SU, '-d', 'restored', '-v', 'ON_ERROR_STOP=1', '-q', '-f', p]);
    say(`PREREQUISITE added before the restore (not from the archive): ${path.resolve(p)} — exit ${r.status}${r.status ? ': ' + String(r.stderr).trim().split('\n')[0] : ''}`);
    if (r.status !== 0) finish(1);
  }
  if (TARGET === 'vanilla') restoreOk = restore(vanillaList, 'into plain PostgreSQL, by the superuser, owners and privileges as in the archive');
  else simOk = restoreOk = simulate();
} else {
  // (SQL on the command line stays ASCII: Windows passes command lines through its ANSI code page)
  r = readOrStop('connecting, read-only', tq('SELECT current_setting(\'server_version\') || \' - \' || current_database() || \' as \' || current_user'));
  say(`comparing an existing database, read-only: PostgreSQL ${r.stdout.trim()} — nothing is restored or written there`);
}

/* supabase/RESTORE-RUNBOOK.md §5 in the throwaway: the platform part, the preflight, the drills and the recovery command */
function simulate() {
  const conninfo = `host=127.0.0.1 port=${PORT} dbname=restored user=postgres`;
  const asPostgres = (a) => run('psql', ['-d', conninfo, ...a]);
  if (!restore(platformList, 'what a new Supabase project already has, by the superuser: Supabase\'s auth / storage definitions, extensions, the supabase_realtime publication, its default privileges (postgres\'s in public among them), its migration history')) return false;
  // the recovery's three section files, as the runbook writes them (they hold personal data: the work folder only)
  const S = ['1-pre-data', '2-data', '3-post-data'].map((s) => path.join(work, s + '.sql'));
  const listed = fs.readFileSync(recoveryList, 'utf8').split(/\r?\n/).filter((l) => /^\d+;/.test(l)).length;
  let inFiles = 0;
  for (const [i, s] of ['pre-data', 'data', 'post-data'].entries()) {
    const x = run('pg_restore', ['-L', recoveryList, '--section=' + s, '-f', S[i], archive]);
    if (x.status !== 0) { say(`pg_restore --section=${s}: exit ${x.status}`); return false; }
    const text = fs.readFileSync(S[i], 'utf8');
    inFiles += (text.match(/^-- (?:Data for )?Name: /gm) || []).length;
    // (a complete file ends with its \unrestrict line, as the runbook checks)
    if (!/^\\unrestrict \S+$/.test(text.replace(/\r/g, '').trimEnd().split('\n').pop())) { say(`${path.basename(S[i])} doesn't end with its \\unrestrict line: incomplete`); return false; }
  }
  say(`the recovery's three section files (pg_restore -L <recovery list> --section=pre-data|data|post-data): ${inFiles} entries in them, ${listed} in the list${inFiles === listed ? '' : ' — NOT the same'}`);
  if (inFiles !== listed) return false;
  // (quiet: results to the null device, errors without their detail lines — a failing row is never printed)
  const command = (withPreStep, extra = []) => ['-d', conninfo, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-q', '-o', NULL_DEVICE, ...(withPreStep ? ['-f', PRE_STEP] : []),
    '-f', S[0], '-c', 'SET session_replication_role = replica', '-f', S[1], '-c', 'SET session_replication_role = origin', '-f', S[2], '-c', "NOTIFY pgrst, 'reload schema'", ...extra];
  say(`the runbook's recovery command, as postgres: psql ${command(!demo).map((a) => (a.startsWith(work) || a === PRE_STEP ? path.basename(a) : /\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  const SNAP = 'SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'public\') || \' relations in public, \' || '
    + '(SELECT count(*) FROM pg_namespace WHERE nspname IN (\'private\', \'supabase_migrations\')) || \' of schemas private and supabase_migrations, \' || '
    + '(SELECT count(*) FROM auth.users) || \' sign-in accounts, \' || (SELECT count(*) FROM pg_policy WHERE polrelid = \'storage.objects\'::regclass) || \' policies on storage.objects, \' || '
    + '(SELECT count(*) FROM pg_trigger WHERE tgrelid = \'auth.users\'::regclass AND NOT tgisinternal) || \' triggers on auth.users, \' || '
    + '(SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a WHERE n.nspname = \'public\' AND d.defaclrole = \'postgres\'::regrole AND a.grantee = \'anon\'::regrole) || \' default grants to anon in public\'';
  const snap = () => su('restored', SNAP).stdout.trim();
  const allow = () => su('postgres', 'GRANT supabase_storage_admin TO postgres'), disallow = () => su('postgres', 'REVOKE supabase_storage_admin FROM postgres');
  if (demo) {
    allow();
    const x = asPostgres(command(false)), probs = problemLines(x.stderr);
    disallow();
    say(`DEMO — the recovery WITHOUT before-recovery.sql, as postgres: exit ${x.status}, ${probs.length} errors or warnings${probs.length ? ': ' + probs.slice(0, 3).join(' | ') : ''}`);
    return x.status === 0;
  }
  const pf1 = path.join(work, 'preflight-part1.sql'), pf2 = path.join(work, 'preflight-part2.sql');
  fs.writeFileSync(pf1, preflight.part1); fs.writeFileSync(pf2, preflight.part2);
  const told = (s) => String(s).split(/\r?\n/).filter((l) => /NOTICE:|ERROR:|^\s+- /.test(l)).map((l) => mask(l.replace(/^psql:.*?:\d+: /, '')).trim().slice(0, 220));
  // the preflight's checks, before the supautils allowance: they see postgres's own privileges only
  let x = asPostgres(['-v', 'ON_ERROR_STOP=1', '-f', pf1]);
  say(`preflight part 1, as postgres (read-only, rolled back): exit ${x.status}`);
  told(x.stderr).forEach((l) => say('  ' + l));
  if (x.status !== 0) return false;
  allow();
  try {
    x = asPostgres(['-v', 'ON_ERROR_STOP=1', '-f', pf2]);
    say(`preflight part 2, as postgres (a probe policy and a probe trigger, rolled back): exit ${x.status}${x.status ? ': ' + problemLines(x.stderr).slice(0, 2).join(' | ') : ''}`);
    if (x.status !== 0) return false;
    // the command's quiet flags must still show a WARNING (the runbook makes any warning a stop)
    x = asPostgres(['-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-q', '-o', NULL_DEVICE, '-c', 'DO $$ BEGIN RAISE WARNING \'hangtag warning probe\'; END $$']);
    const warnShown = /WARNING:\s+hangtag warning probe/.test(x.stderr);
    say(`with the command's flags (-q, VERBOSITY=terse, -o ${NULL_DEVICE}) a WARNING still shows: ${warnShown ? 'yes' : 'NO'}`);
    if (!warnShown) return false;
    // the rollback drill: everything runs, then a failure before COMMIT — nothing may remain but the positions of the
    // sequences the project already has (a sequence's position is never rolled back)
    const ownSeqs = kept.filter((p) => p.e.type === 'SEQUENCE SET' && SUPABASE_SCHEMAS.includes(p.e.schema)).map((p) => `${p.e.schema}.${p.e.name}`);
    const seqPos = () => (ownSeqs.length ? su('restored', ownSeqs.map((s) => `SELECT '${s} ' || last_value || CASE WHEN is_called THEN ' (used)' ELSE ' (unused)' END FROM ${s}`).join(' UNION ALL ')).stdout.trim().split(/\r?\n/).join(', ') : 'none');
    const before = snap(), seqBefore = seqPos();
    x = asPostgres(command(true, ['-c', 'DO $$ BEGIN RAISE EXCEPTION \'safety drill: a failure injected after the last step, before COMMIT\'; END $$']));
    const afterDrill = snap(), seqAfter = seqPos();
    const drill1 = x.status !== 0 && /safety drill/.test(x.stderr) && afterDrill === before;
    say(`rollback drill (the recovery with a failure injected before COMMIT): exit ${x.status}; before: ${before}; after: ${afterDrill} — ${drill1 ? 'nothing remained' : 'NOT rolled back cleanly'}`);
    say(`  the project's own sequences, whose positions a rollback can't undo: before ${seqBefore}; after ${seqAfter}`);
    // the recovery, exactly as the runbook writes it
    x = asPostgres(command(true));
    const probs = problemLines(x.stderr), errs = probs.filter((l) => !/WARNING:/.test(l)), warns = probs.filter((l) => /WARNING:/.test(l));
    const afterRecovery = snap();
    say(`the recovery command, as postgres, one transaction: exit ${x.status}, ${errs.length} errors, ${warns.length} warnings; now: ${afterRecovery}`);
    probs.slice(0, 10).forEach((l) => say('  ' + l));
    const recovered = x.status === 0 && !probs.length;
    // a second run must refuse (before-recovery.sql's guard), and change nothing
    x = asPostgres(command(true));
    const drill2 = x.status !== 0 && /not a new, empty Supabase project/.test(x.stderr) && snap() === afterRecovery;
    say(`repeat drill (the same command again): exit ${x.status} — ${drill2 ? 'refused by before-recovery.sql\'s guard, nothing changed' : 'NOT refused cleanly: ' + problemLines(x.stderr).slice(0, 2).join(' | ')}`);
    // and so must the preflight
    x = asPostgres(['-v', 'ON_ERROR_STOP=1', '-f', pf1]);
    const pre2 = x.status !== 0 && /not a new, empty project/.test(x.stderr);
    say(`preflight on the recovered database: exit ${x.status} — ${pre2 ? 'refused (not a new, empty project)' : 'NOT refused'}`);
    return drill1 && recovered && drill2 && pre2;
  } finally { disallow(); }
}

// ---------- 4. the proof ----------
let ok = restoreOk && !planErrors.length, needsReview = false;
// (with --compare-to, Supabase's own definitions and migration history may differ by its version — except the extensions
//  the application's objects use, row security and grants on the auth / storage tables that carry the application's
//  trigger and policies, and triggers there that call the application's functions)
const strictTables = new Set(appInSupabase.filter((p) => ['TRIGGER', 'POLICY'].includes(p.e.type)).map((p) => p.e.schema + '|' + p.e.name.split(' ')[0]));
const strictKey = (k) => {
  const [type, schema, name] = k.split('|');
  if (type === 'EXTENSION') return expected.has(k);
  if (type === 'ROW SECURITY') return strictTables.has(schema + '|' + name);
  if (type === 'ACL' && /^(TABLE|COLUMN) /.test(name)) return strictTables.has(schema + '|' + name.replace(/^(TABLE|COLUMN) /, '').split('.')[0]);
  return type === 'TRIGGER' && SUPABASE_SCHEMAS.includes(schema) && appTriggerDdl(again.get(k) || expected.get(k) || '');
};
// (a) every restored entry's definition, re-dumped from the restored copy
const again = ddlEntries(readOrStop('its definitions, pg_dump -s', run('pg_dump', [...TGT, '-s', ...MANAGED_SCHEMAS.map((s) => '--exclude-schema=' + s)])).stdout);
const supabaseOwn = (k) => {
  if (!compareTo || strictKey(k)) return false;
  const p = planByKey.get(k);
  if (p) return !!p.supa && !p.both;
  // an entry only the project has is Supabase's only in Supabase's own schemas, owned by its roles and made by them, or a
  // database-wide kind every project has (extensions and their comments, its event triggers and publications)
  const [type, schema, name, owner] = k.split('|');
  const madeByOthers = [...(again.get(k) || '').matchAll(/^SET SESSION AUTHORIZATION ("?[\w$]+"?);$/gm)].some((m) => !PLATFORM_ROLES.has(unq(m[1])));
  if (MANAGED_SCHEMAS.includes(schema)) return true;
  if (SUPABASE_SCHEMAS.includes(schema) || schema === 'pg_catalog') return PLATFORM_ROLES.has(owner) && type !== 'POLICY' && !madeByOthers;
  if (schema === '-') return type === 'EXTENSION' || (type === 'COMMENT' && name.startsWith('EXTENSION ')) || (['EVENT TRIGGER', 'PUBLICATION', 'DEFAULT ACL'].includes(type) && PLATFORM_ROLES.has(owner));
  return false;
};
const expected = ddlEntries(run('pg_restore', ['-s', '-L', vanillaList, '-f', '-', archive]).stdout);
/* An expression with each AND / OR chain written flat: "((a AND b) AND c)" and "(a AND b AND c)" are the same condition
   (AND and OR are associative; the operands keep their order). PostgreSQL 18 writes a restored constraint, trigger WHEN
   or policy flat where the archive (PostgreSQL 17) wrote it nested. Quoted text is never touched. */
function flatBool(text) {
  let i = 0;
  const parse = (close) => {           // → an array of parts: plain text, quoted text, { group: parts }
    const out = []; let buf = '';
    const push = () => { if (buf) { out.push(buf); buf = ''; } };
    while (i < text.length) {
      const c = text[i];
      if (c === "'" || c === '"') { push(); let j = i + 1; while (j < text.length) { if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; } out.push({ q: text.slice(i, j + 1) }); i = j + 1; continue; }
      if (c === '(') { push(); i++; out.push({ group: parse(')') }); continue; }
      if (c === ')' && close) { push(); i++; return out; }
      buf += c; i++;
    }
    push(); return out;
  };
  const show = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.q !== undefined ? p.q : '(' + norm(p.group) + ')')).join('');
  /* a group's operands when its top level is one AND (or OR) chain, else null */
  const chain = (parts, op) => {
    const ops = [[]]; let other = false;
    for (const p of parts) {
      if (typeof p !== 'string') { ops[ops.length - 1].push(p); continue; }
      const bits = p.split(new RegExp(`( AND | OR )`));
      for (const b of bits) { if (b === ` ${op} `) ops.push([]); else if (b === ' AND ' || b === ' OR ') other = true; else if (b) ops[ops.length - 1].push(b); }
    }
    return !other && ops.length > 1 ? ops : null;
  };
  const norm = (parts) => {
    for (const op of ['AND', 'OR']) {
      const ops = chain(parts, op);
      if (!ops) continue;
      // an operand that is itself a parenthesised chain of the same operator gives its operands, however deep
      const expand = (o) => {
        const inner = o.length === 1 && typeof o[0] !== 'string' && o[0].group ? chain(o[0].group, op) : null;
        return inner ? inner.flatMap(expand) : [show(o)];
      };
      return ops.flatMap(expand).join(` ${op} `);
    }
    return show(parts);
  };
  return norm(parse(null));
}
const sameLines = (a, b) => a.split('\n').sort().join('\n') === b.split('\n').sort().join('\n');
const missingDdl = [...expected.keys()].filter((k) => !again.has(k)), extraDdl = [...again.keys()].filter((k) => !expected.has(k));
const changed = [...expected.keys()].filter((k) => again.has(k) && again.get(k) !== expected.get(k));
// equivalent, not identical: the same grants listed in another order, or the same conditions with AND / OR written flat
const reordered = changed.filter((k) => /^(ACL|DEFAULT ACL)\|/.test(k) && sameLines(expected.get(k), again.get(k)));
// (only definitions the server writes back from its own parse — constraints, triggers, policies, indexes, views, defaults;
//  a function's body is kept as written and must be identical)
const REWRITTEN = /^(TABLE|CHECK CONSTRAINT|CONSTRAINT|FK CONSTRAINT|TRIGGER|POLICY|INDEX|VIEW|MATERIALIZED VIEW|DEFAULT)\|/;
const flattened = changed.filter((k) => !reordered.includes(k) && REWRITTEN.test(k) && flatBool(expected.get(k)) === flatBool(again.get(k)));
const differAll = changed.filter((k) => !reordered.includes(k) && !flattened.includes(k));
const differDdl = differAll.filter((k) => !supabaseOwn(k));
const ownChanged = [...differAll, ...missingDdl].filter(supabaseOwn), ownExtra = extraDdl.filter(supabaseOwn);
if (compareTo) {
  // (one of Supabase's definitions in the archive that the project lacks is its version — or an application object the
  //  plan left out, which no rehearsal can see: each needs a look before traffic moves)
  needsReview = ownChanged.length > 0;
  say(`  Supabase's own definitions in the archive that the project lacks or defines differently: ${ownChanged.length}${ownChanged.length ? ' — Supabase\'s version, OR an application object the plan left out: check each' : ''}`);
  ownChanged.slice(0, 60).forEach((k) => say(`    ${again.has(k) ? 'different' : 'missing'}: ${k.split('|').join(' · ')}`));
  say(`  Supabase's own definitions only the project has (its version; accepted): ${ownExtra.length}`);
  ownExtra.slice(0, 60).forEach((k) => say(`    ${k.split('|').join(' · ')}`));
}
const byType = {};
for (const k of expected.keys()) { const t = k.split('|')[0]; byType[t] = byType[t] || { n: 0, same: 0 }; byType[t].n++; if (again.has(k) && !differDdl.includes(k)) byType[t].same++; }
say(`definitions: ${expected.size} restored entries compared; ${expected.size - missingDdl.length - changed.length} identical, ${reordered.length} the same grants in another order, ${flattened.length} the same conditions with AND / OR written flat, ${differDdl.length} different, ${missingDdl.length} missing; ${extraDdl.length} extra in the restored copy`);
reordered.forEach((k) => say(`  same grants, another order: ${k.split('|').join(' · ')}`));
flattened.forEach((k) => say(`  same conditions, AND / OR flat (PostgreSQL 18 writes them so): ${k.split('|').join(' · ')}`));
say('  by type (identical or equivalent / compared): ' + Object.entries(byType).sort().map(([t, v]) => `${t} ${v.same}/${v.n}`).join(', '));
for (const k of [...differDdl, ...missingDdl.filter((x) => !supabaseOwn(x))].slice(0, 20)) say(`  ${again.has(k) ? 'different' : 'missing'}: ${k.split('|').join(' · ')}`);
extraDdl.filter((x) => !supabaseOwn(x)).slice(0, 10).forEach((k) => say(`  extra: ${k.split('|').join(' · ')}`));
const appObjects = appInSupabase.map((p) => keyOf(p.e)), appSame = appObjects.filter((k) => again.has(k) && !differDdl.includes(k));
say(`  the application's objects in Supabase's schemas: ${appSame.length} of ${appObjects.length} restored identically${appSame.length < appObjects.length ? ' — NOT: ' + appObjects.filter((k) => !appSame.includes(k)).join('; ') : ''}`);
// --diff: the lines of each differing definition that only one side has (definitions only — never a row)
if (argv.includes('--diff')) for (const k of [...differDdl, ...reordered, ...flattened].slice(0, 24)) {
  const a = expected.get(k).split('\n'), b = again.get(k).split('\n');
  say(`  --- ${k.split('|').join(' · ')}`);
  const onlyA = a.filter((l) => !b.includes(l)), onlyB = b.filter((l) => !a.includes(l));
  if (!onlyA.length && !onlyB.length) { a.slice(0, 10).forEach((l) => say('    archive : ' + l.slice(0, 300))); b.slice(0, 10).forEach((l) => say('    restored: ' + l.slice(0, 300))); }
  onlyA.slice(0, 12).forEach((l) => say('    archive : ' + l.slice(0, 300)));
  onlyB.slice(0, 12).forEach((l) => say('    restored: ' + l.slice(0, 300)));
}
ok = ok && !missingDdl.filter((k) => !supabaseOwn(k)).length && !differDdl.length && !extraDdl.filter((k) => !supabaseOwn(k)).length && appSame.length === appObjects.length;
// (b) who may do what: anon's and authenticated's rights on every function and table outside Supabase's own schemas, worked
//     out from the archive's grants (PostgreSQL's built-in defaults, then each GRANT and REVOKE in order), against the
//     catalog; an object the archive doesn't have may give them nothing
const rightsFrom = (aclText, fn) => {
  const ALL = fn ? ['EXECUTE'] : ['DELETE', 'INSERT', 'SELECT', 'TRUNCATE', 'UPDATE'], r = new Map([['PUBLIC', new Set(fn ? ['EXECUTE'] : [])]]);
  for (const l of aclText.split('\n')) {
    const m = /^(GRANT|REVOKE) (.+?) ON (?:FUNCTION|PROCEDURE|TABLE) .+ (?:TO|FROM) ("?[\w$]+"?)(?: WITH GRANT OPTION)?;$/.exec(l);
    if (!m || m[2].includes('(')) continue;                       // (column privileges aren't table-wide)
    const who = unq(m[3]), set = r.get(who) || new Set();
    r.set(who, set);
    for (const x of m[2] === 'ALL' ? ALL : m[2].split(',').filter((y) => ALL.includes(y))) m[1] === 'GRANT' ? set.add(x) : set.delete(x);
  }
  return (role) => [...new Set([...(r.get(role) || []), ...r.get('PUBLIC')])].sort().join(',');
};
const privCols = (role) => ['DELETE', 'INSERT', 'SELECT', 'TRUNCATE', 'UPDATE'].map((x) => `CASE WHEN has_table_privilege('${role}', c.oid, '${x}') THEN '${x}' END`).join(', ');
const OUTSIDE_SUPABASE = `n.nspname NOT IN (${['pg_catalog', 'information_schema', ...SUPABASE_SCHEMAS, ...MANAGED_SCHEMAS].map((s) => `'${s}'`).join(', ')}) AND n.nspname !~ '^pg_'`;
const RIGHTS = 'SET search_path = \'\'; SELECT \'f|\' || n.nspname || \'|\' || p.proname || \'(\' || pg_catalog.oidvectortypes(p.proargtypes) || \')|\' || quote_ident(p.proname) || \'(\' || pg_catalog.pg_get_function_identity_arguments(p.oid) || \')|\' || '
  + 'CASE WHEN has_function_privilege(\'anon\', p.oid, \'EXECUTE\') THEN \'EXECUTE\' ELSE \'\' END || \'|\' || CASE WHEN has_function_privilege(\'authenticated\', p.oid, \'EXECUTE\') THEN \'EXECUTE\' ELSE \'\' END || \'|\' || CASE WHEN p.prosecdef THEN \'t\' ELSE \'f\' END '
  + `FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${OUTSIDE_SUPABASE} AND p.prokind IN ('f', 'p') `
  + `UNION ALL SELECT 't|' || n.nspname || '|' || c.relname || '|' || quote_ident(c.relname) || '|' || concat_ws(',', ${privCols('anon')}) || '|' || concat_ws(',', ${privCols('authenticated')}) || '|f' `
  + `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${OUTSIDE_SUPABASE} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;
let rightsDiffer = 0, anonDefiners = 0;
{
  const archFn = new Set(entries.filter((e) => ['FUNCTION', 'PROCEDURE'].includes(e.type)).map((e) => `${e.schema}|${e.name}`));
  const archRel = new Set(entries.filter((e) => ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE'].includes(e.type)).map((e) => `${e.schema}|${e.name}`));
  const rows = readOrStop('rights', tq(RIGHTS)), differ = [], extra = [], count = { f: 0, t: 0 }, definer = { have: 0, want: 0 };
  if (rows.status !== 0) { say(`  rights: the catalog query failed: ${String(rows.stderr).trim().split('\n')[0]}`); ok = false; }
  for (const row of rows.stdout.split(/\r?\n/).filter(Boolean)) {
    const [kind, schema, tocName, aclName, anon, authd, secdef] = row.split('|');
    if (!(kind === 'f' ? archFn : archRel).has(`${schema}|${tocName}`)) {              // (not in the archive: it may give them nothing)
      if (anon || authd) extra.push(`${kind === 'f' ? 'function' : 'table'} ${schema}.${tocName}: anon ${anon || 'nothing'}, authenticated ${authd || 'nothing'}`);
      continue;
    }
    const acl = aclBy.get(`${schema}|${kind === 'f' ? 'FUNCTION' : 'TABLE'} ${aclName}`) || (kind === 'f' ? aclBy.get(`${schema}|PROCEDURE ${aclName}`) : '') || '';
    const want = rightsFrom(acl, kind === 'f');
    count[kind]++;
    for (const [role, have] of [['anon', anon], ['authenticated', authd]]) if (want(role) !== have) differ.push(`${kind === 'f' ? 'function' : 'table'} ${schema}.${tocName}: ${role} ${have || 'nothing'} (the archive: ${want(role) || 'nothing'})`);
    if (kind === 'f' && secdef === 't') { if (anon) definer.have++; if (want('anon')) definer.want++; }
  }
  say(`rights: anon's and authenticated's on ${count.f} functions and ${count.t} tables and views outside Supabase's schemas — ${differ.length ? differ.length + ' NOT as the archive grants them' : 'every one as the archive grants it'}; SECURITY DEFINER functions anon may execute: ${definer.have} (the archive: ${definer.want}); objects the archive doesn't have that give them anything: ${extra.length}`);
  differ.slice(0, 12).forEach((d) => say('  ' + d));
  extra.slice(0, 12).forEach((d) => say('  not in the archive: ' + d));
  ok = ok && !differ.length && !extra.length && count.f + count.t > 0;
  rightsDiffer = differ.length + extra.length; anonDefiners = definer.have - definer.want;
}
// (c) the API's roles: no attribute or membership that would make row security void (rights above can't show those)
{
  const roles = readOrStop('the API roles', tq('SELECT r.rolname || \'|\' || (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) || \'|\' || (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE r.rolname IN (\'anon\', \'authenticated\') ORDER BY 1'))
    .stdout.split(/\r?\n/).filter(Boolean);
  const bad = roles.filter((x) => x.split('|')[1] !== 'false' || x.split('|')[2] !== '0').map((x) => x.split('|')[0]);
  say(`the API's roles: ${roles.length} of anon and authenticated found; ${bad.length ? 'NOT plain (a superuser-like attribute or a membership): ' + bad.join(', ') : 'neither has a superuser-like attribute or belongs to another role'}`);
  ok = ok && roles.length === 2 && !bad.length;
}
// (d) the application schemas in the restored catalog
const cat = readOrStop('catalog counts', tq(`SELECT n.nspname || '|' ||
  (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p')) || '|' ||
  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid AND p.prokind IN ('f','p')) || '|' ||
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = n.oid AND NOT t.tgisinternal) || '|' ||
  (SELECT count(*) FROM pg_policy po JOIN pg_class c ON c.oid = po.polrelid WHERE c.relnamespace = n.oid) || '|' ||
  (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p') AND c.relrowsecurity) || '|' ||
  (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = n.oid) || '|' ||
  (SELECT count(*) FROM pg_constraint co WHERE co.connamespace = n.oid AND co.contype IN ('p','u','f','c','x'))
  FROM pg_namespace n WHERE n.nspname IN (${[...APP_SCHEMAS, ...SUPABASE_SCHEMAS].map((s) => `'${s}'`).join(',')}) ORDER BY 1`)).stdout.split(/\r?\n/).filter(Boolean);
const tocCount = (s, ...types) => entries.filter((e) => e.schema === s && types.includes(e.type)).length;
for (const row of cat) {
  const [s, nt, nf, ntr, npo, nrls, nix, nco] = row.split('|').map((x, i) => (i ? +x : x));
  const want = { tables: tocCount(s, 'TABLE'), functions: tocCount(s, 'FUNCTION', 'PROCEDURE'), triggers: tocCount(s, 'TRIGGER'), policies: tocCount(s, 'POLICY'), rls: tocCount(s, 'ROW SECURITY') };
  const same = nt === want.tables && nf === want.functions && ntr === want.triggers && npo === want.policies && nrls === want.rls;
  say(`  catalog ${s}: ${nt} tables, ${nf} functions, ${ntr} triggers, ${npo} policies, ${nrls} with row security, ${nix} indexes, ${nco} constraints — ${same ? 'as in the archive' : `archive: ${want.tables} tables, ${want.functions} functions, ${want.triggers} triggers, ${want.policies} policies, ${want.rls} with row security`}`);
  if (APP_SCHEMAS.includes(s) && !same) ok = false;
}
const locq = tq('SELECT \'collation \' || datcollate::text || \', ctype \' || datctype::text || \', provider \' || datlocprovider::text || coalesce(\' \' || datlocale, \'\') FROM pg_database WHERE datname = current_database()');
const loc = locq.status === 0 ? locq.stdout.trim() : 'unknown (' + String(locq.stderr).trim().split('\n')[0] + ')';
const generated = [...archDdl].filter(([k, b]) => k.startsWith('TABLE|') && /GENERATED ALWAYS AS \(/.test(b))
  .map(([k, b]) => `${k.split('|')[1]}.${k.split('|')[2]} (${[...b.matchAll(/^\s+("(?:[^"]|"")+"|[\w$]+) [^\n]*GENERATED ALWAYS AS \(/gm)].map((m) => unq(m[1])).join(', ')})`);
say(`  locale ${loc}; generated columns are recomputed by the server, never compared (pg_dump doesn't write them): ${generated.join('; ') || 'none'}`);
// (e) every table, every row, every sequence
try {
  const present = new Set(readOrStop('its tables', tq(`SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p')`)).stdout.split(/\r?\n/).filter(Boolean));
  const absentAll = tables.filter((t) => !present.has(t));
  const restoredData = await copyBlocks('pg_dump', [...TGT, '--data-only', ...MANAGED_SCHEMAS.map((s) => '--exclude-schema=' + s)])
    .catch((e) => { readOrStop('its rows, pg_dump --data-only', { status: 1, stderr: e.message }); throw e; });
  const O = original.tables, R = restoredData.tables, names = Object.keys(O).sort();
  const zonedIn = names.reduce((a, t) => a + O[t].zoned, 0), utcIn = names.reduce((a, t) => a + O[t].utc, 0);
  say(`tables: ${tables.length} in the archive; ${tables.length - absentAll.length} exist in the ${compareTo ? 'compared database' : 'restored copy'}${absentAll.length ? '; not there: ' + absentAll.join(', ') : ''}`);
  say(`  the archive's times: ${utcIn} written in UTC, ${zonedIn} with another offset${zonedIn ? ' (NOT UTC: those compare as different text; dump again with PGTZ=UTC)' : ''}`);
  const noData = names.filter((t) => !R[t]), colsDiffer = names.filter((t) => R[t] && R[t].cols !== O[t].cols);
  const sameCols = names.filter((t) => R[t] && R[t].cols === O[t].cols);
  const otherOrder = sameCols.filter((t) => R[t].hash !== O[t].hash && R[t].sorted === O[t].sorted), rowsDiffer = sameCols.filter((t) => R[t].sorted !== O[t].sorted);
  const rows = names.reduce((a, t) => a + O[t].rows, 0);
  say(`data: ${names.length} tables, ${rows} rows in the archive; ${compareTo ? 'compared' : 'restored'}: ${sameCols.length - otherOrder.length - rowsDiffer.length} identical, ${otherOrder.length} the same rows in another order, ${colsDiffer.length} with other columns, ${rowsDiffer.length} with other rows, ${noData.length} without data`);
  otherOrder.forEach((t) => say(`  the same rows, another order: ${t}`));
  rowsDiffer.slice(0, 10).forEach((t) => say(`  other rows: ${t} (archive ${O[t].rows}, ${compareTo ? 'compared' : 'restored'} ${R[t].rows})`));
  noData.slice(0, 20).forEach((t) => say(`  no data: ${t} (${O[t].rows} rows in the archive)`));
  // (with --compare-to: an auth / storage table with Supabase's newer columns must hold the archive's rows on the archive's
  //  columns; the platform's migration history is the project's own; a Supabase table the archive held no row for may be
  //  missing in its version)
  const projected = (t) => {
    const x = run('psql', [...TGT, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-qAt', '-c', 'BEGIN READ ONLY', '-c', 'SET LOCAL datestyle = ISO', '-c', 'SET LOCAL intervalstyle = postgres',
      '-c', 'SET LOCAL extra_float_digits = 3', '-c', 'SET LOCAL row_security = off', '-c', `COPY (SELECT ${O[t].cols} FROM ONLY ${t.split('.').map((s) => '"' + s.replace(/"/g, '""') + '"').join('.')}) TO STDOUT`, '-c', 'COMMIT']);
    // (a column or table of the archive missing there is a difference; any other failure is a read that didn't happen)
    if (x.status !== 0) { if (!/ERROR:\s+(42703|42P01)\b/.test(x.stderr)) readOrStop(`${t} on the archive's columns`, x); return null; }
    const lines = x.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l, i, a) => i < a.length - 1 || l !== '');
    return createHash('sha256').update(lines.map((l) => createHash('sha256').update(l).digest('hex')).sort().join('\n')).digest('hex');
  };
  const sameOnArchiveCols = compareTo ? colsDiffer.filter((t) => SUPABASE_SCHEMAS.includes(t.split('.')[0]) && projected(t) === O[t].sorted) : [];
  colsDiffer.forEach((t) => say(`  other columns: ${t}${sameOnArchiveCols.includes(t) ? ' — Supabase\'s version; on the archive\'s columns, the archive\'s rows exactly' : ''}`));
  const tolerated = (t) => compareTo && (PLATFORM_HISTORY.has(t) || sameOnArchiveCols.includes(t)
    || (!present.has(t) && O[t].rows === 0 && (planByKey.get([...planByKey.keys()].find((k) => k.startsWith(`TABLE|${t.replace('.', '|')}|`)) || '') || {}).supa));
  const failing = [...noData, ...colsDiffer, ...rowsDiffer].filter((t) => !tolerated(t)), absent = absentAll.filter((t) => !tolerated(t));
  if (compareTo) say(`  Supabase's own tables accepted as they are: ${[...new Set([...noData, ...colsDiffer, ...rowsDiffer, ...absentAll])].filter(tolerated).join(', ') || 'none'}`);
  const count = (t) => (O[t] ? `${O[t].rows}${R[t] && (R[t].sorted === O[t].sorted || sameOnArchiveCols.includes(t)) ? '' : ' (NOT restored identically)'}` : '—');
  say('  critical tables (rows): ' + ['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects', 'public.hangtag_profiles', 'public.hangtag_products', 'public.hangtag_variants',
    'public.hangtag_sales', 'public.hangtag_payments', 'public.hangtag_customers', 'public.hangtag_subscriptions', 'public.shops'].map((t) => `${t} ${count(t)}`).join('; '));
  // every sequence at the archive's position (the next id a restored table hands out)
  const SA = original.seqs, SR = restoredData.seqs, seqBad = Object.keys(SA).filter((s) => SR[s] !== SA[s]);
  say(`sequences: ${Object.keys(SA).length} in the archive; ${Object.keys(SA).length - seqBad.length} at the archive's position${seqBad.length ? '; NOT: ' + seqBad.map((s) => `${s} (archive ${SA[s]}, ${compareTo ? 'compared' : 'restored'} ${SR[s] || 'missing'})`).join('; ') : ''}`);
  ok = ok && !absent.length && !failing.length && !seqBad.length && names.length > 0;
} catch (e) { say('the data comparison failed: ' + e.message); ok = false; }

const what = compareTo ? 'as the compared database holds it' : TARGET === 'vanilla' ? 'into plain PostgreSQL' : 'into a simulated new Supabase project';
if (demo) {
  const showed = !ok && simOk && rightsDiffer > 0;
  say(showed ? `DEMO RESULT (not a recovery): without before-recovery.sql the recovery runs without an error, yet over-grants — ${differDdl.length + extraDdl.length} privilege and other definitions differ from the archive; anon and authenticated hold rights the archive never gave on ${rightsDiffer} counts (anon may execute ${anonDefiners} SECURITY DEFINER functions it couldn't). The proof catches it; the runbook's command runs before-recovery.sql first.`
    : 'DEMO RESULT: UNEXPECTED — without before-recovery.sql the proof did not fail on rights: the simulation does not model Supabase\'s default privileges');
  finish(showed ? 1 : 4);
}
if (prereqs.length) say(ok ? `RESULT (diagnosis, NOT a pass): with the prerequisite(s) above, the archive restores ${what} — it is NOT self-contained.` : 'RESULT (diagnosis): not restorable even with the prerequisite(s) above.');
else if (compareTo) say(!ok ? 'RESULT: the compared database does NOT hold the archive — see the lines above.'
  : needsReview ? 'RESULT (review needed, exit 3): every application definition, right, row and sequence identical, but Supabase\'s own definitions listed above are missing or different in the project — Supabase\'s version, or an application object the plan left out. Check each before moving traffic.'
  : 'RESULT: the compared database holds the archive — every application definition, right, row and sequence identical; none of Supabase\'s own definitions in the archive is missing or different.');
else say(ok ? `RESULT: restorable ${what} — zero restore errors; every restored definition, right, row and sequence identical; ${skipped.length} entries of Supabase's platform left out, each named above with its reason`
  + (TARGET === 'supabase-sim' ? '; the runbook\'s command ran as postgres in one transaction with no error or warning, the preflight passed, the rollback drill left nothing, and a second run refused.' : '.')
  : 'RESULT: NOT proven restorable — see the lines above.');
finish(ok && !prereqs.length ? (needsReview ? 3 : 0) : 1);
