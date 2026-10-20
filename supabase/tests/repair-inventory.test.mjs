// The repair's exact change set (RELEASE.md §3, supabase/REPAIR-RUNBOOK.md), on the live project as reconstructed:
// schema.sql of 2026-10-13, the section files 3za … 3r newest-first, the first migration as it was, then the containment
// of 23:45 IST (the six "Public access" policies dropped). The catalog and every table's rows are compared before and after
// the whole schema.sql: it changes exactly the 18 older functions, re-adds one constraint as it was (NOT VALID), removes
// the 3 indexes the first migration put back — and no policy, table, column, trigger, row security, grant or row.
// If schema.sql changes, this test says how the repair's scope changed (and the runbook and approval must say so too).
// Run: node supabase/tests/repair-inventory.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const R = new URL('../../', import.meta.url), MIGS = new URL('supabase/migrations/', R);
const lr = fs.readFileSync(new URL('supabase/tests/live-recovery.test.mjs', R), 'utf8');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const NEW = fs.readFileSync(new URL('supabase/schema.sql', R), 'utf8');
const INITIAL = fs.readFileSync(new URL('20260923102731_hangtag_initial_schema.sql', MIGS), 'utf8');
const INITIAL_AS_IT_WAS = INITIAL.replace(/    IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE table_schema = 'public' AND table_name = 'hangtag_meta' AND column_name = 'owner_id'\) THEN\r?\n        RETURN;\r?\n    END IF;\r?\n/, '');
if (INITIAL_AS_IT_WAS === INITIAL) throw new Error('guard not found');
const SECTIONS = fs.readdirSync(MIGS).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
const db = new PGlite();
await db.exec(STUB); await db.exec(NEW);
// two shops with a few rows, so the data diff has something to compare
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.test'),($2,'b@x.test')`, [A, B]);
for (const o of [A, B]) await db.query(`UPDATE public.hangtag_profiles SET shop_name='S', full_name='X', business_type='retail', onboarded_at=NOW() WHERE id=$1`, [o]);
for (const f of SECTIONS) await db.exec(fs.readFileSync(new URL(f, MIGS), 'utf8'));
await db.exec(INITIAL_AS_IT_WAS);
const open = (await db.query(`SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'Public access to %'`)).rows;
for (const p of open) await db.exec(`DROP POLICY "${p.policyname}" ON public.${p.tablename}`);   // the containment of 2026-10-13 23:45 IST
const snap = async () => {
  const q = async (s) => (await db.query(s)).rows;
  const out = {};
  for (const r of await q(`SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, md5(replace(p.prosrc, chr(13), '')) || ' ' || p.prosecdef::text || ' ' || p.provolatile::text AS v FROM pg_proc p WHERE p.pronamespace='public'::regnamespace`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'policy ' || tablename || ': ' || policyname AS k, cmd || ' ' || array_to_string(roles, ',') || ' ' || COALESCE(qual,'') || ' ' || COALESCE(with_check,'') AS v FROM pg_policies WHERE schemaname IN ('public','storage')`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'index ' || indexname AS k, indexdef AS v FROM pg_indexes WHERE schemaname='public'`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'column ' || table_name || '.' || column_name AS k, data_type || ' ' || COALESCE(column_default,'') || ' ' || is_nullable AS v FROM information_schema.columns WHERE table_schema='public'`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'trigger ' || c.relname || ': ' || t.tgname AS k, pg_get_triggerdef(t.oid) AS v FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'constraint ' || conrelid::regclass::text || ': ' || conname AS k, pg_get_constraintdef(oid) AS v FROM pg_constraint WHERE connamespace='public'::regnamespace`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'rls ' || relname AS k, relrowsecurity::text AS v FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'grant ' || table_name || ' ' || grantee AS k, string_agg(privilege_type, ',' ORDER BY privilege_type) AS v FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role') GROUP BY 1`)) out[r.k] = r.v;
  for (const r of await q(`SELECT 'fgrant ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text AS v FROM pg_proc p WHERE p.pronamespace='public'::regnamespace`)) out[r.k] = r.v;
  for (const r of await q(`SELECT relname AS t FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`)) {
    const d = (await db.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(md5(x::text), ',' ORDER BY md5(x::text))), '') AS h FROM public.${r.t} x`)).rows[0];
    out['rows ' + r.t] = d.n + ' ' + d.h;
  }
  return out;
};
const before = await snap();
await db.exec(`BEGIN;\nSET LOCAL lock_timeout = '10s';\n${NEW}\nCOMMIT;`);
const after = await snap();
const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const changes = { added: [], removed: [], changed: [] };
for (const k of keys) {
  if (!(k in before)) changes.added.push(k); else if (!(k in after)) changes.removed.push(k); else if (before[k] !== after[k]) changes.changed.push(k);
}
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
const LIVE_OLDER = JSON.parse(lr.slice(lr.indexOf('const LIVE_OLDER = ') + 19, lr.indexOf('].sort();', lr.indexOf('const LIVE_OLDER = ')) + 1).replace(/'/g, '"')).sort();
check('the containment had dropped the six "Public access" policies', open.length === 6, open);
check('the repair adds nothing (no table, column, function, policy, index, trigger or grant)', changes.added.length === 0, changes.added);
check('…removes exactly the 3 indexes the first migration put back', JSON.stringify(changes.removed) === JSON.stringify(['index idx_hangtag_sale_items_sale', 'index idx_hangtag_sales_time', 'index idx_hangtag_sizes_prod']), changes.removed);
const fnChanged = changes.changed.filter((k) => k.startsWith('function ')).map((k) => k.slice(9)).sort(), other = changes.changed.filter((k) => !k.startsWith('function '));
check('…changes exactly the 18 older functions (the live project ones, read from its catalog on 2026-10-13)', JSON.stringify(fnChanged) === JSON.stringify(LIVE_OLDER), fnChanged);
check('…and re-adds one constraint as schema.sql has it (hangtag_sales_money_check, NOT VALID); nothing else: no policy, column, trigger, row security, grant',
  JSON.stringify(other) === JSON.stringify(['constraint hangtag_sales: hangtag_sales_money_check']) && /NOT VALID/.test(after['constraint hangtag_sales: hangtag_sales_money_check']), { other, before: before['constraint hangtag_sales: hangtag_sales_money_check'], after: after['constraint hangtag_sales: hangtag_sales_money_check'] });
check('no row of any table changes (the shops rows, plans, settings, everything in public)', !changes.changed.some((k) => k.startsWith('rows ')) && Object.keys(before).filter((k) => k.startsWith('rows ')).length > 60);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
