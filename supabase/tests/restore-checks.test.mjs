// The two restore checks of RELEASE.md §2a item 3 (supabase/checks/restore-fk-orphans.sql, restore-row-counts.sql), run as
// written on schema.sql: no orphan on a clean database; a bill line loaded the way a restore loads data (triggers off)
// whose bill doesn't exist is found, by its foreign key; every table in public and auth is counted, and only counted.
// Run: node supabase/tests/restore-checks.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
const run = async (f) => (await db.exec(read(`../checks/${f}`))).at(-1).rows;
const sql = async (q) => (await db.query(q)).rows;

const fks = (await sql(`SELECT count(*)::int n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`))[0].n;
check(`a clean database: no orphan across its ${fks} foreign keys`, fks > 50 && (await run('restore-fk-orphans.sql')).length === 0);
const tables = (await sql(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'auth') ORDER BY 1`)).map((r) => r.t);
const counts = await run('restore-row-counts.sql');
check(`row counts: every table in public and auth, once (${tables.length}), with its count and nothing else`,
  JSON.stringify(counts.map((r) => r.tbl)) === JSON.stringify(tables) && counts.every((r) => Object.keys(r).join() === 'tbl,row_count'), counts.slice(0, 3));
await db.exec(`SET session_replication_role = replica;
  INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111');
  INSERT INTO public.hangtag_sale_items (owner_id, sale_id, line_no, product_id, product_name, size, quantity, unit_price)
    VALUES ('11111111-1111-1111-1111-111111111111', 'no-such-bill', 0, 'p', 'x', '', 1, 1);
  SET session_replication_role = origin;`);
const orphans = await run('restore-fk-orphans.sql');
check('a bill line loaded without its bill (triggers off, as a restore loads): found, by the bill line\'s foreign key to its bill',
  orphans.length >= 1 && orphans.some((o) => /hangtag_sale_items/.test(o.child) && +o.orphans === 1), orphans);
const after = await run('restore-row-counts.sql');
check('…and the counts show the two rows it added (one account, one bill line)', +after.find((r) => r.tbl === 'auth.users').row_count === 1
  && +after.find((r) => r.tbl === 'public.hangtag_sale_items').row_count === 1);
check('the checks change no stored data (only a temporary table)', (await sql(`SELECT count(*)::int n FROM pg_class WHERE relname IN ('zz_fk_orphans', 'zz_row_counts') AND relpersistence <> 't'`))[0].n === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
