// The repair rehearsal (supabase/REPAIR-RUNBOOK.md §4) on a restored copy of the REAL backup, on THIS computer only:
// nothing connects anywhere but 127.0.0.1, no row is printed or written anywhere but the throwaway database, and the
// archive is only read (hashed before and after).
// 1. node scripts/backup/verify-restore.mjs <archive> --target supabase-sim --keep: the archive restored into a throwaway
//    cluster that is a simulated new Supabase project (postgres a LOGIN role, not a superuser) and proven against the
//    archive, entry by entry and row by row; the cluster is kept for step 2.
// 2. That cluster started again on 127.0.0.1; as postgres, exactly what the runbook's step 6 and 7 run, each followed by
//    the runbook's own check files (supabase/checks):
//    before: the dry run (all 0), the function versions (the older ones, as on live), open policies (none: the
//      containment), the data fingerprint, the two-shop isolation probes, and every account's read of every shop table;
//    the repair (BEGIN; SET LOCAL lock_timeout = '10s'; the whole schema.sql; COMMIT): its report all ok, the versions all
//      ok, no open policy, the dry run 0, the fingerprint unchanged, the isolation probes clean, every account reading
//      only its own shop;
//    the post-repair migration the same way: its report all ok, the fingerprint unchanged but for its one new, empty table;
//    the Cashfree migration (20261027120000) twice: the post-repair report still all ok, its two functions still the
//      service role's only;
//    the undos, newest first: cashfree-readiness-undo (both functions exactly as the post-repair migration made them),
//      post-repair-integrity-undo (it says it took), then the repair's own undo (2026-10-13-repair-undo.sql): every
//      hangtag function exactly as before the repair, and the fingerprint as before it.
// 3. The cluster stopped and deleted (it holds personal data); the archive hashed again. The results (names, counts,
//    hashes) are written beside the archive: <archive>.rehearse-repair.txt. Exit 0 only when every check passed.
// Run: node scripts/backup/rehearse-repair.mjs <archive.dump> [--sha256 <expected>] [--port 55433]
//   PG_BIN: the bin folder of PostgreSQL 17.6 or newer (default C:\Program Files\PostgreSQL\18\bin).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const valueOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const flagValues = new Set(['--sha256', '--port'].map(valueOf).filter(Boolean));
const archive = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));
if (!archive || !fs.existsSync(archive)) { console.error('Usage: node scripts/backup/rehearse-repair.mjs <archive.dump> [--sha256 <expected>] [--port 55433]'); process.exit(2); }
const PORT = +(valueOf('--port') || 55433), WANT = valueOf('--sha256');
const BIN = process.env.PG_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const base = path.resolve(archive), reportFile = base + '.rehearse-repair.txt';
const lines = [];
let fails = 0, work = null, started = false;
const say = (s) => { lines.push(s); console.log(s); };
const check = (name, ok, info) => { if (!ok) fails++; say((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const run = (exe, args, opts = {}) => spawnSync(path.join(BIN, exe), args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
function hashFile(p) {
  const h = createHash('sha256'), fd = fs.openSync(p, 'r'), b = Buffer.alloc(1 << 20);
  for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
function finish(code) {
  if (started) run('pg_ctl.exe', ['-D', path.join(work, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  if (work && fs.existsSync(work)) { fs.rmSync(work, { recursive: true, force: true }); say(`the restored copy deleted: ${path.basename(work)}`); }
  const now = hashFile(archive);
  say(now === sha ? `archive unchanged: sha256 ${now}` : `THE ARCHIVE CHANGED during the run: sha256 ${now}`);
  if (now !== sha) code = 1;
  say(code === 0 && fails === 0 ? 'REHEARSAL PASSED: every check above passed' : `REHEARSAL FAILED: ${fails} check(s) failed${code ? ' (stopped early)' : ''}`);
  fs.writeFileSync(reportFile, lines.join('\n') + '\n');
  process.exit(code || (fails ? 1 : 0));
}

/* SQL text → its statements (quotes, quoted names, dollar quotes and comments respected) */
function statements(sql) {
  const out = []; let i = 0, start = 0;
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === '--') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e + 1; continue; }
    if (two === '/*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'") { i++; while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1; i++; continue; }
    if (c === '"') { const e = sql.indexOf('"', i + 1); i = e < 0 ? sql.length : e + 1; continue; }
    if (c === '$') { const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64)); if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? sql.length : e + m[0].length; continue; } }
    if (c === ';') { out.push(sql.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  out.push(sql.slice(start));
  return out.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}
const discard = () => path.join(work, 'discard.out').replace(/\\/g, '/');
function psql(script, as = 'postgres') {
  const f = path.join(work, 'step.sql');
  fs.writeFileSync(f, script);
  return run('psql.exe', ['-X', '-h', '127.0.0.1', '-p', String(PORT), '-U', as, '-d', 'restored', '-v', 'ON_ERROR_STOP=1', '-At', '-f', f]);
}
/* Run SQL (its output discarded); { ok, error } — the error's first line only (never row data) */
function exec(sql) {
  const r = psql(`\\o ${discard()}\n${sql}\n`);
  return { ok: r.status === 0, error: r.status === 0 ? null : String(r.stderr || '').split('\n').find((l) => /ERROR/.test(l)) || `psql exit ${r.status}` };
}
/* Run SQL; the rows of its last statement as JSON (earlier statements' output discarded) */
function rows(sql) {
  const st = statements(sql), last = st.pop().trim().replace(/;\s*$/, '');
  const r = psql(`\\o ${discard()}\n${st.join('\n')}\n\\o\nSELECT coalesce(jsonb_agg(q), '[]'::jsonb) FROM (\n${last}\n) q;\n`);
  if (r.status !== 0) throw new Error(String(r.stderr || '').split('\n').find((l) => /ERROR/.test(l)) || `psql exit ${r.status}`);
  return JSON.parse(r.stdout.trim());
}
const checkFile = (f) => rows(read('supabase/checks/' + f));
const tx = (sql) => `BEGIN;\nSET LOCAL lock_timeout = '10s';\n${sql}\nCOMMIT;`;
const FNS = `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, md5(replace(p.prosrc, chr(13), '')) AS v
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%' ORDER BY 1;`;
const fns = () => Object.fromEntries(rows(FNS).map((r) => [r.k, r.v]));
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
// every account (auth.users) reading every shop table (public hangtag_* with owner_id) as itself, in a sub-transaction
// always rolled back: rows visible, and rows of a shop other than its own (public.hangtag_shop_id(): an owner's own id,
// a staff member's shop). Counts only.
const EVERYONE = `CREATE TEMP TABLE IF NOT EXISTS zz_all_probe (who uuid, tbl text, visible bigint, other bigint, err text);
TRUNCATE zz_all_probe;
DO $p$
DECLARE u uuid; t text; n bigint; o bigint; e text;
BEGIN
  FOR u IN SELECT id FROM auth.users ORDER BY id LOOP
    FOR t IN SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p')
              WHERE c.table_schema = 'public' AND c.column_name = 'owner_id' AND c.table_name LIKE 'hangtag%' ORDER BY 1 LOOP
      n := NULL; o := NULL; e := NULL;
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('SELECT count(*), count(*) FILTER (WHERE owner_id IS DISTINCT FROM public.hangtag_shop_id()) FROM public.%I', t) INTO n, o;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN e := SQLSTATE;
      END;
      INSERT INTO zz_all_probe VALUES (u, t, n, o, e);
    END LOOP;
  END LOOP;
END $p$;
SELECT count(DISTINCT who) AS accounts, count(DISTINCT tbl) AS tables, COALESCE(sum(visible), 0) AS rows_visible, COALESCE(sum(other), 0) AS rows_of_other_shops,
       COALESCE(string_agg(DISTINCT tbl || ':' || err, ', ') FILTER (WHERE err IS NOT NULL), '') AS errors
  FROM zz_all_probe;`;
// every account (auth.users), as itself, trying to change and to delete one row of another shop in each of the six tables
// the 2026-10-13 policies opened (the row found by the database owner; each try in a sub-transaction always rolled back)
const EVERYONE_WRITES = `CREATE TEMP TABLE IF NOT EXISTS zz_all_writes (who uuid, tbl text, op text, n bigint, err text);
TRUNCATE zz_all_writes;
DO $p$
DECLARE u uuid; shop uuid; t text; c tid; n bigint; e text; op text;
BEGIN
  FOR u IN SELECT id FROM auth.users ORDER BY id LOOP
    shop := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.headers', '{}', true);
      SET LOCAL ROLE authenticated;
      shop := public.hangtag_shop_id();
      RAISE EXCEPTION USING ERRCODE = 'ZZ001';
    EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN shop := NULL;
    END;
    FOR t IN SELECT unnest(ARRAY['hangtag_meta', 'hangtag_sales', 'hangtag_sale_items', 'hangtag_products', 'hangtag_images', 'hangtag_sizes']) LOOP
      c := NULL;
      EXECUTE format('SELECT ctid FROM public.%I WHERE owner_id IS DISTINCT FROM $1 LIMIT 1', t) INTO c USING shop;
      CONTINUE WHEN c IS NULL;
      FOREACH op IN ARRAY ARRAY['update', 'delete'] LOOP
        n := NULL; e := NULL;
        BEGIN
          PERFORM set_config('request.jwt.claim.sub', u::text, true);
          PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
          PERFORM set_config('request.headers', '{}', true);
          SET LOCAL ROLE authenticated;
          IF op = 'update' THEN EXECUTE format('UPDATE public.%I SET owner_id = owner_id WHERE ctid = $1', t) USING c;
          ELSE EXECUTE format('DELETE FROM public.%I WHERE ctid = $1', t) USING c; END IF;
          GET DIAGNOSTICS n = ROW_COUNT;
          RAISE EXCEPTION USING ERRCODE = 'ZZ001';
        EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN e := SQLSTATE;
        END;
        INSERT INTO zz_all_writes VALUES (u, t, op, n, e);
      END LOOP;
    END LOOP;
  END LOOP;
END $p$;
SELECT count(DISTINCT who) AS accounts, count(*) AS attempts, count(*) FILTER (WHERE n > 0) AS changed_other_shop,
       COALESCE(string_agg(DISTINCT tbl || ':' || op || ':' || err, ', ') FILTER (WHERE err IS NOT NULL), '') AS errors
  FROM zz_all_writes;`;
// every account, as itself, adding a row that names another shop (a copy of one of its rows under a new key, as the
// runbook's probe makes it) in each of the six tables — that shop's plan first made current inside the same rolled-back
// sub-transaction, so the plan guard (HT402, a BEFORE trigger, which a lapsed shop meets first) lets it through and row
// security's own check is what must refuse it (42501)
const EVERYONE_INSERTS = `CREATE TEMP TABLE IF NOT EXISTS zz_all_inserts (who uuid, tbl text, access boolean, result text);
TRUNCATE zz_all_inserts;
DO $p$
DECLARE u uuid; shop uuid; other uuid; t text; j jsonb; pk text[]; col text; res text; acc boolean;
BEGIN
  FOR u IN SELECT id FROM auth.users ORDER BY id LOOP
    shop := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.headers', '{}', true);
      SET LOCAL ROLE authenticated;
      shop := public.hangtag_shop_id();
      RAISE EXCEPTION USING ERRCODE = 'ZZ001';
    EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN shop := NULL;
    END;
    FOR t IN SELECT unnest(ARRAY['hangtag_meta', 'hangtag_sales', 'hangtag_sale_items', 'hangtag_products', 'hangtag_images', 'hangtag_sizes']) LOOP
      j := NULL; other := NULL;
      EXECUTE format('SELECT to_jsonb(x), x.owner_id FROM public.%I x WHERE x.owner_id IS DISTINCT FROM $1 AND x.owner_id IS NOT NULL LIMIT 1', t) INTO j, other USING shop;
      CONTINUE WHEN j IS NULL;
      SELECT array_agg(a.attname::text) INTO pk FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = ('public.' || t)::regclass AND i.indisprimary;
      FOREACH col IN ARRAY COALESCE(pk, ARRAY[]::text[]) LOOP
        CONTINUE WHEN col = 'owner_id';
        j := jsonb_set(j, ARRAY[col], CASE jsonb_typeof(j -> col) WHEN 'number' THEN to_jsonb((j ->> col)::numeric + 1000000000)
          ELSE CASE WHEN (j ->> col) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN to_jsonb(gen_random_uuid()::text) ELSE to_jsonb((j ->> col) || '-zzprobe') END END);
      END LOOP;
      res := NULL; acc := NULL;
      BEGIN
        UPDATE public.hangtag_subscriptions SET suspended = FALSE WHERE owner_id = other AND suspended;
        PERFORM public.hangtag_subscription_extend(other, 'm1');
        acc := public.hangtag_access_ok(other);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I, $1)', t, t) USING j;
        res := 'ALLOWED (row added)';
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL;
        WHEN insufficient_privilege THEN res := 'blocked by row security (' || SQLSTATE || ')';
        WHEN OTHERS THEN res := 'refused ' || SQLSTATE;
      END;
      INSERT INTO zz_all_inserts VALUES (u, t, acc, res);
    END LOOP;
  END LOOP;
END $p$;
SELECT count(DISTINCT who) AS accounts, count(*) AS attempts, count(*) FILTER (WHERE result LIKE 'ALLOWED%') AS allowed,
       count(*) FILTER (WHERE result LIKE 'blocked by row security%') AS rls_blocked, count(*) FILTER (WHERE NOT COALESCE(access, FALSE)) AS access_not_made,
       COALESCE(string_agg(DISTINCT result, ', ') FILTER (WHERE result NOT LIKE 'blocked by row security%'), '') AS other_results
  FROM zz_all_inserts;`;
// every shop owner, as itself, changing one of its own rows (a no-op change) in each of the six tables — its plan made
// current in the same rolled-back sub-transaction (a lapsed shop's own writes are refused by the plan lock, by design):
// the shop's own writes still work. Owners only: a team member's rights depend on their role.
const OWNERS_OWN = `CREATE TEMP TABLE IF NOT EXISTS zz_own_writes (who uuid, tbl text, n bigint, err text);
TRUNCATE zz_own_writes;
DO $p$
DECLARE u uuid; shop uuid; t text; c tid; n bigint; e text;
BEGIN
  FOR u IN SELECT id FROM auth.users ORDER BY id LOOP
    shop := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.headers', '{}', true);
      SET LOCAL ROLE authenticated;
      shop := public.hangtag_shop_id();
      RAISE EXCEPTION USING ERRCODE = 'ZZ001';
    EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN shop := NULL;
    END;
    CONTINUE WHEN shop IS DISTINCT FROM u;
    FOR t IN SELECT unnest(ARRAY['hangtag_meta', 'hangtag_sales', 'hangtag_sale_items', 'hangtag_products', 'hangtag_images', 'hangtag_sizes']) LOOP
      c := NULL;
      EXECUTE format('SELECT ctid FROM public.%I WHERE owner_id = $1 LIMIT 1', t) INTO c USING u;
      CONTINUE WHEN c IS NULL;
      n := NULL; e := NULL;
      BEGIN
        UPDATE public.hangtag_subscriptions SET suspended = FALSE WHERE owner_id = u AND suspended;
        PERFORM public.hangtag_subscription_extend(u, 'm1');
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('UPDATE public.%I SET owner_id = owner_id WHERE ctid = $1', t) USING c;
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN e := SQLSTATE;
      END;
      INSERT INTO zz_own_writes VALUES (u, t, n, e);
    END LOOP;
  END LOOP;
END $p$;
SELECT count(DISTINCT who) AS owners, count(*) AS attempts, count(*) FILTER (WHERE n = 1) AS worked,
       COALESCE(string_agg(DISTINCT tbl || ':' || COALESCE(err, 'rows=' || n), ', ') FILTER (WHERE n IS DISTINCT FROM 1), '') AS other
  FROM zz_own_writes;`;
const RESTRICTED = /^hangtag_(backup_v\d+_\w+|subscriptions|trial_claims|promo_redemptions|webhook_secrets|billing_\w+|autopay_\w+):42501$/;
function isolation(label) {
  const probe = checkFile('shop-isolation-probe.sql'), sync = checkFile('sync-read-isolation.sql'), all = rows(EVERYONE)[0];
  // (with real data a shop may have no row in a table: its own count is then 0, and a probe that needs one of its rows
  // or the other's can't be tried — not applicable)
  const want = { '1 read': /other shops' rows visible: 0;/, '2 change other shop': /^blocked \(0 rows\)$/, '3 delete other shop': /^blocked \(0 rows\)$/,
    // refused by the plan guard (HT402) first when the other shop's plan has lapsed — the row isn't added either way; row
    // security's own refusal is then shown by the every-account probe below, with that shop's plan made current
    // a lapsed shop's own change is refused by the plan lock (HT402), by design: the owners' probe below shows own changes
    // work once the plan is current
    '4 add as other shop': /^(blocked by row security \(42501\)|refused HT402)$/, '5 change own row': /^(works \(1 row\)|refused HT402)$/ };
  // a probe that needs a row of the other shop in a table where that shop has none can't be tried: not applicable
  const na = probe.filter((r) => /(the other shop|this shop) has no row here/.test(r.result));
  const badProbe = probe.filter((r) => !na.includes(r) && !(want[r.probe] && want[r.probe].test(r.result)));
  check(`${label}: the two-shop probes (${probe.length} rows, ${na.length} not applicable: a shop with no row there) — no shop reads, changes, deletes or adds the other's rows on the six reopened tables; each changes its own`,
    probe.length >= 50 && badProbe.length === 0 && probe.filter((r) => r.probe === '1 read').every((r) => want['1 read'].test(r.result)),
    badProbe.length ? badProbe.map((r) => `${r.who} ${r.tbl} ${r.probe}: ${r.result}`) : { tried: probe.length - na.length });
  const guard = probe.filter((r) => r.probe === '4 add as other shop' && r.result === 'refused HT402').length;
  if (guard) say(`  (${guard} of the two-shop "add as other shop" probes were refused by the plan guard, HT402, before row security: that shop's plan has lapsed)`);
  const ins = rows(EVERYONE_INSERTS)[0];
  check(`${label}: every account (${ins.accounts}) adding a row that names another shop on the six reopened tables (${ins.attempts} attempts, that shop's plan made current, always rolled back): every one refused by row security itself (42501)`,
    +ins.attempts > 0 && +ins.allowed === 0 && +ins.rls_blocked === +ins.attempts && +ins.access_not_made === 0,
    { allowed: ins.allowed, rls_blocked: ins.rls_blocked, access_not_made: ins.access_not_made, other: ins.other_results });
  const own = rows(OWNERS_OWN)[0];
  check(`${label}: every shop owner (${own.owners}) changing one of its own rows on the six tables (${own.attempts} attempts, its plan made current, always rolled back): every one works`,
    +own.attempts > 0 && +own.worked === +own.attempts, { worked: own.worked, other: own.other });
  const w = rows(EVERYONE_WRITES)[0], wErrs = String(w.errors || '').split(', ').filter(Boolean);
  check(`${label}: every account (${w.accounts}) trying to change or delete a row of another shop on the six reopened tables (${w.attempts} attempts, always rolled back): none changed`,
    +w.attempts > 0 && +w.changed_other_shop === 0 && wErrs.every((e) => /:42501$/.test(e)), { changed: w.changed_other_shop, errors: wErrs });
  check(`${label}: a full sync as each of the two shops reads none of the other's rows`,
    sync.length === 2 && sync.every((r) => +r.rows_of_other_shops === 0 && +r.rows_visible > 0 && String(r.errors || '').split(', ').filter(Boolean).every((e) => RESTRICTED.test(e))),
    sync.map((r) => ({ who: r.who, tables: r.tables, visible: r.rows_visible, other: r.rows_of_other_shops, errors: r.errors })));
  const errs = String(all.errors || '').split(', ').filter(Boolean);
  check(`${label}: every account (${all.accounts}) reading every shop table (${all.tables}) as itself sees no row of another shop`,
    +all.accounts > 0 && +all.rows_of_other_shops === 0 && errs.every((e) => RESTRICTED.test(e)), { visible: all.rows_visible, other: all.rows_of_other_shops, errors: errs });
}

say(`Repair rehearsal on a restored copy of ${path.basename(archive)} — ${new Date().toISOString()}`);
const sha = hashFile(archive);
say(`archive sha256 ${sha}`);
// whatever stops the run, the copy (personal data) is stopped and deleted and the archive hashed again
process.on('uncaughtException', (e) => { say('STOPPED: ' + String((e && e.message) || e).split('\n')[0]); finish(1); });
if (WANT && WANT !== sha) { say(`STOP: the archive is not the one expected (${WANT})`); fs.writeFileSync(reportFile, lines.join('\n') + '\n'); process.exit(1); }

// 1. restore (and prove) into a simulated new Supabase project, kept
const vr = spawnSync(process.execPath, [path.join(repo, 'scripts', 'backup', 'verify-restore.mjs'), archive, '--target', 'supabase-sim', '--keep', '--port', String(PORT)],
  { encoding: 'utf8', maxBuffer: 1 << 28, cwd: repo });
const vOut = String(vr.stdout || '') + String(vr.stderr || '');
const kept = /kept the restored copy: (.+?) \(it holds/.exec(vOut);
work = kept ? kept[1].trim() : null;
check('the archive restored into a simulated new Supabase project and proven against it (verify-restore.mjs --target supabase-sim, exit 0)', vr.status === 0 && !!work,
  { exit: vr.status, last: vOut.trim().split('\n').slice(-3) });
if (vr.status !== 0 || !work) finish(1);

// 2. the kept cluster, again
const pgd = path.join(work, 'data');
const st = run('pg_ctl.exe', ['-D', pgd, '-l', path.join(work, 'server.log'), '-w', '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -c timezone=UTC`, 'start'], { stdio: 'ignore' });
started = st.status === 0;
check('the restored copy started again (127.0.0.1 only)', started);
if (!started) finish(1);
const who = rows(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, current_setting('server_version') AS v;`)[0];
check('connected as postgres, not a superuser (as on Supabase)', who.u === 'postgres' && who.su === false, who);
// Two allowances model what Supabase gives postgres and plain PostgreSQL doesn't (as verify-restore.mjs models supautils
// for storage): membership of anon, authenticated and service_role (the SQL Editor's "set role authenticated", which the
// runbook's isolation probes use); and supabase_auth_admin, while the repair runs only, for its one statement on a table
// of Supabase's auth schema (the trigger on auth.users) — which live accepted from postgres when schema.sql ran there on
// 2026-10-13.
const asAdmin = (sql) => run('psql.exe', ['-X', '-h', '127.0.0.1', '-p', String(PORT), '-U', 'supabase_admin', '-d', 'restored', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql]);
check('model: postgres may act as anon, authenticated and service_role (as on Supabase)', asAdmin('GRANT anon, authenticated, service_role TO postgres').status === 0);

say('=== before the repair: the live state as backed up ===');
const versions = (rs) => rs.reduce((a, r) => ((a[r.state] = (a[r.state] || 0) + 1), a), {});
const v0 = checkFile('2026-10-13-function-versions.sql');
const notOk0 = v0.filter((r) => r.state !== 'ok');
say(`function versions: ${JSON.stringify(versions(v0))}; not ok: ${notOk0.length}`);
check('the older functions (and the 3 indexes) the 2026-10-13 incident left are there, as on live', notOk0.length > 0, { not_ok: notOk0.length });
const open0 = checkFile('open-policies.sql');
check('no open ("Public access", always-true) policy: the containment of 2026-10-13 holds in the backup', open0.length === 0, { open: open0.length });
const dry0 = checkFile('schema-dry-run.sql')[0].dryrun;
check('the dry run: every number 0 (nothing the repair would refuse or change in the data)', Object.values(dry0).every((n) => +n === 0), dry0);
const fp0 = checkFile('data-fingerprint.sql');
say(`data fingerprint: ${fp0.length} shop tables, ${fp0.reduce((s, r) => s + +r.row_count, 0)} rows`);
isolation('before the repair (contained, not repaired)');
const fns0 = fns();

say('=== the repair: the whole schema.sql in one transaction (runbook step 6) ===');
const schema = read('supabase/schema.sql');
say(`schema.sql: ${Buffer.byteLength(schema)} bytes, sha256 ${createHash('sha256').update(schema).digest('hex')}`);
check('model: supabase_auth_admin and supabase_storage_admin given to postgres for the repair only (its trigger on auth.users, its policies on storage.objects)',
  asAdmin('GRANT supabase_auth_admin, supabase_storage_admin TO postgres').status === 0);
const rep = exec(tx(schema));
check('…and taken back after it', asAdmin('REVOKE supabase_auth_admin, supabase_storage_admin FROM postgres').status === 0);
check('the repair ran and committed', rep.ok, rep.error);
if (!rep.ok) finish(1);
const report = rows(`SELECT check_name, value, expected, ok FROM (${schema.slice(schema.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q;`);
const row96 = report.find((r) => /^96\b/.test(String(r.check_name)));
check(`the report: all ${report.length} rows ok (83 expected), row 96 = 0`, report.length === 83 && report.every((r) => r.ok) && (!row96 || +row96.value === 0),
  { not_ok: report.filter((r) => !r.ok).map((r) => r.check_name), row96: row96 && row96.value });
const v1 = checkFile('2026-10-13-function-versions.sql');
check('the function versions: all ok (the older functions replaced, the 3 indexes gone)', v1.every((r) => r.state === 'ok'), versions(v1));
check('still no open policy; the dry run still all 0', checkFile('open-policies.sql').length === 0 && Object.values(checkFile('schema-dry-run.sql')[0].dryrun).every((n) => +n === 0));
check('the data fingerprint: identical to before the repair (no row changed)', JSON.stringify(checkFile('data-fingerprint.sql')) === JSON.stringify(fp0));
isolation('after the repair');
const fns1 = fns();
say(`hangtag functions changed by the repair: ${diffKeys(fns0, fns1).length}`);

say('=== the post-repair migration (runbook step 7) ===');
const mandatesBefore = rows(`SELECT count(*)::int AS n FROM public.hangtag_subscriptions WHERE autopay_subscription_id IS NOT NULL;`)[0].n;
const pm = exec(tx(read('supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql')));
check('the post-repair migration ran and committed (it refuses to commit unless its own report is all ok)', pm.ok, pm.error);
if (!pm.ok) finish(1);
const post = checkFile('post-repair-report.sql');
check(`its report: all ${post.length} rows ok (13 expected)`, post.length === 13 && post.every((r) => r.ok === true), post.filter((r) => r.ok !== true).map((r) => r.check_name || r.check));
const fp2 = checkFile('data-fingerprint.sql'), had = new Set(fp0.map((r) => r.tbl)), added = fp2.filter((r) => !had.has(r.tbl));
check('the data fingerprint: every table as before, plus its one new shop table (hangtag_deleted_products) empty',
  JSON.stringify(fp2.filter((r) => had.has(r.tbl))) === JSON.stringify(fp0) && JSON.stringify(added.map((r) => r.tbl)) === '["hangtag_deleted_products"]' && added.every((r) => +r.row_count === 0),
  { added: added.map((r) => [r.tbl, r.row_count]) });
const pmx = rows(`SELECT (SELECT count(*) FROM public.hangtag_autopay_mandates)::int AS mandates, (SELECT billing_mode FROM public.hangtag_billing_settings) AS mode;`)[0];
check('AutoPay set-ups registered = those before (none on live); the billing mode is live', pmx.mandates === mandatesBefore && pmx.mode === 'live', { ...pmx, before: mandatesBefore });
isolation('after the post-repair migration');
const fns2 = fns();

say('=== the Cashfree migration (20261027120000), twice ===');
const cf1 = exec(tx(read('supabase/migrations/20261027120000_hangtag_cashfree_readiness.sql'))), cf2 = exec(tx(read('supabase/migrations/20261027120000_hangtag_cashfree_readiness.sql')));
check('ran and committed, and again (safe to run twice)', cf1.ok && cf2.ok, { first: cf1.error, second: cf2.error });
const cfReport = checkFile('cashfree-readiness-report.sql');
check(`its own report (cashfree-readiness-report.sql): all ${cfReport.length} rows ok (4 expected)`, cfReport.length === 4 && cfReport.every((r) => r.ok === true),
  cfReport.filter((r) => r.ok !== true).map((r) => r.check_name));
const post3 = checkFile('post-repair-report.sql');
check('the post-repair report still all ok after it', post3.length === 13 && post3.every((r) => r.ok === true), post3.filter((r) => r.ok !== true).map((r) => r.check_name || r.check));
const priv = rows(`SELECT f, has_function_privilege('anon', f, 'EXECUTE') AS anon, has_function_privilege('authenticated', f, 'EXECUTE') AS auth, has_function_privilege('service_role', f, 'EXECUTE') AS svc
  FROM unnest(ARRAY['public.hangtag_billing_readiness()', 'public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)']::regprocedure[]) f;`);
check('its two functions: the service role only (no signed-out or signed-in caller)', priv.length === 2 && priv.every((p) => !p.anon && !p.auth && p.svc), priv);
const ready = rows(`SELECT public.hangtag_billing_readiness() AS r;`)[0].r;
check('readiness answers (not ready on a copy of live: no proven notification, no reconciliation run)', ready && ready.ready === false && ready.mode === 'live', ready);
const fns3 = fns();
say(`hangtag functions changed by the Cashfree migration: ${JSON.stringify(diffKeys(fns2, fns3))}`);
isolation('after the Cashfree migration');

say('=== the undos, newest first ===');
const u1 = exec(read('supabase/operations/cashfree-readiness-undo.sql'));
const fns4 = fns();
check('cashfree-readiness-undo: every hangtag function exactly as the post-repair migration left it', u1.ok && diffKeys(fns2, fns4).length === 0, { error: u1.error, diff: diffKeys(fns2, fns4) });
let undone = null;
try { undone = rows(read('supabase/operations/post-repair-integrity-undo.sql')); } catch (e) { undone = { error: e.message }; }
check('post-repair-integrity-undo: it says it took', Array.isArray(undone) && undone[0] && undone[0].undone === true, undone);
const fns5 = fns();
check('…every hangtag function exactly as the repair left it', diffKeys(fns1, fns5).length === 0, diffKeys(fns1, fns5));
const ru = exec(read('supabase/checks/2026-10-13-repair-undo.sql'));
const fns6 = fns();
check('the repair\'s own undo (2026-10-13-repair-undo.sql): every hangtag function exactly as before the repair (byte for byte, md5 of each body)',
  ru.ok && diffKeys(fns0, fns6).length === 0, { error: ru.error, diff: diffKeys(fns0, fns6) });
check('…and the data fingerprint as before the repair', JSON.stringify(checkFile('data-fingerprint.sql').filter((r) => had.has(r.tbl))) === JSON.stringify(fp0));
finish(0);
