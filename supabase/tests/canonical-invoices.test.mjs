// The canonical invoices migration (supabase/migrations/20261026150000_hangtag_canonical_invoices.sql) on schema.sql, in
// PGlite (on this computer; never the live project):
// - it applies, and again (nothing changes); with a storage schema the bucket is private, PDF only, 2 MB at most;
// - one invoice per bill: a second one for the same bill is refused (the database decides the bill's one invoice, however
//   many phones or channels register at once); an invoice of a bill that doesn't exist, or with a path that isn't
//   <shop>/<sha256>.pdf, is refused;
// - a shop reads its own invoices, never another shop's; the signed-out read nothing; no app account adds, changes or
//   removes one (only the send-receipt function, as the service role, writes them);
// - a delivery record names an invoice of its own shop only; the undo removes the table and the column and keeps every
//   delivery record.
// Run: node supabase/tests/canonical-invoices.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const STORAGE = `CREATE SCHEMA storage; GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`;
const MIG = read('../migrations/20261026150000_hangtag_canonical_invoices.sql'), UNDO = read('../operations/canonical-invoices-undo.sql');
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(STORAGE);
await db.exec(read('../schema.sql'));
const sql = async (q, p) => (await db.query(q, p)).rows;
const tryq = async (q, p) => { try { return { rows: (await db.query(q, p)).rows }; } catch (e) { return { err: e.message }; } };
/* a whole script (several statements) */
const run = async (s) => { try { await db.exec(s); return {}; } catch (e) { return { err: e.message }; } };
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return (await db.query(q, p)).rows; } catch (e) { return { err: e.message }; } finally { await db.exec('RESET ROLE'); }
}
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await sql(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.test'),($2,'b@x.test')`, [A, B]);
await as(A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method, bill_no) VALUES ('s1', 1790000000000, 1250, 1250, 'cash', 'INV-1'), ('s2', 1790000001000, 700, 700, 'upi', 'INV-2')`);
await as(B, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method, bill_no) VALUES ('t1', 1790000002000, 900, 900, 'cash', 'B-1')`);
check('two shops with their bills', (await sql(`SELECT count(*)::int AS n FROM public.hangtag_sales`))[0].n === 3);

const first = await run(MIG), again = await run(MIG);
check('the migration applies on schema.sql, and again changes nothing', !first.err && !again.err, { first: first.err, again: again.err });
const bucket = (await sql(`SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'hangtag-invoices'`))[0];
check('the bucket is private, PDF only, 2 MB at most', bucket && bucket.public === false && Number(bucket.file_size_limit) === 2097152 && JSON.stringify(bucket.allowed_mime_types) === '["application/pdf"]', bucket);

// written by the function (the service role; here the superuser)
const sha = (c) => c.repeat(64), path = (o, c) => `${o}/${sha(c)}.pdf`;
const add = (o, s, c) => tryq(`INSERT INTO public.hangtag_invoices (owner_id, sale_id, number, total, sha256, size_bytes, storage_path) VALUES ($1,$2,'INV-1',1250,$3,4096,$4) RETURNING id`, [o, s, sha(c), path(o, c)]);
const a1 = await add(A, 's1', 'a');
check('the function records a bill\'s invoice', !a1.err && a1.rows.length === 1, a1.err);
const a1b = await add(A, 's1', 'b');
check('a second invoice for the same bill is refused: the bill has one invoice', !!a1b.err && /unique|duplicate/i.test(a1b.err), a1b);
const ghost = await add(A, 'nope', 'c');
check('an invoice of a bill that doesn\'t exist is refused', !!ghost.err, ghost);
const badPath = await tryq(`INSERT INTO public.hangtag_invoices (owner_id, sale_id, number, total, sha256, size_bytes, storage_path) VALUES ($1,'s2','INV-2',700,$2,4096,'../other/x.pdf')`, [A, sha('d')]);
check('…and one whose file isn\'t <shop>/<sha256>.pdf', !!badPath.err && /check/i.test(badPath.err), badPath);
const b1 = await add(B, 't1', 'e');
check('the other shop\'s bill gets its own invoice', !b1.err, b1.err);

// read: the shop's own, nothing else
const seenA = await as(A, `SELECT sale_id FROM public.hangtag_invoices ORDER BY sale_id`), seenB = await as(B, `SELECT sale_id FROM public.hangtag_invoices ORDER BY sale_id`);
check('a shop reads its own invoices only', JSON.stringify(seenA) === '[{"sale_id":"s1"}]' && JSON.stringify(seenB) === '[{"sale_id":"t1"}]', { seenA, seenB });
const byId = await as(A, `SELECT id FROM public.hangtag_invoices WHERE id = $1`, [b1.rows[0].id]);
check('…even when it asks for another shop\'s invoice by its id', Array.isArray(byId) && byId.length === 0, byId);
const anon = await as(null, `SELECT id FROM public.hangtag_invoices`);
check('the signed-out read nothing (refused)', !!anon.err || (Array.isArray(anon) && anon.length === 0), anon);
// write: never an app account
const ins = await as(A, `INSERT INTO public.hangtag_invoices (owner_id, sale_id, number, total, sha256, size_bytes, storage_path) VALUES ($1,'s2','INV-2',700,$2,4096,$3)`, [A, sha('f'), path(A, 'f')]);
const upd = await as(A, `UPDATE public.hangtag_invoices SET number = 'X' WHERE sale_id = 's1' RETURNING id`);
const del = await as(A, `DELETE FROM public.hangtag_invoices WHERE sale_id = 's1' RETURNING id`);
check('an app account can\'t add, change or remove an invoice (only the function writes them)', !!ins.err && !!upd.err && !!del.err, { ins, upd, del });
check('…so the shop\'s invoice is as the function recorded it', (await sql(`SELECT number FROM public.hangtag_invoices WHERE owner_id = $1 AND sale_id = 's1'`, [A]))[0].number === 'INV-1');

// delivery records name the invoice they carried — of their own shop only
const okDel = await tryq(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, invoice_id) VALUES ($1,'s1','email','a@b.in','sent','resend','re_1',$2) RETURNING id`, [A, a1.rows[0].id]);
check('a delivery record names the bill\'s invoice', !okDel.err, okDel.err);
const crossDel = await tryq(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, invoice_id) VALUES ($1,'s1','sms','+919876543210','sent','twilio','SM1',$2)`, [A, b1.rows[0].id]);
check('…never another shop\'s invoice', !!crossDel.err && /foreign key/i.test(crossDel.err), crossDel);
const readDel = await as(A, `SELECT invoice_id FROM public.hangtag_deliveries WHERE sale_id = 's1'`);
check('the shop reads which invoice each message carried', Array.isArray(readDel) && readDel.length === 1 && readDel[0].invoice_id === a1.rows[0].id, readDel);

// the undo: the table and the column go, every delivery record stays
const before = (await sql(`SELECT count(*)::int AS n FROM public.hangtag_deliveries`))[0].n;
const undo = await run(UNDO);
const gone = (await sql(`SELECT to_regclass('public.hangtag_invoices') AS t, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'hangtag_deliveries' AND column_name = 'invoice_id') AS c`))[0];
check('the undo removes the invoices table and the column, and keeps every delivery record', !undo.err && gone.t === null && gone.c === 0 && (await sql(`SELECT count(*)::int AS n FROM public.hangtag_deliveries`))[0].n === before, { undo: undo.err, gone });
const redo = await run(MIG);
check('…and the migration applies again after it', !redo.err, redo.err);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
