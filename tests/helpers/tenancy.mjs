// Tenant isolation, table by table on the real schema (PGlite): every table holding a shop's rows (an owner_id column),
// read and written by people who aren't that shop — another shop's owner or team member, an account in no shop, someone
// signed out. The suite says how a person acts (its own run(who, sql, params), which sets the role, the signed-in user
// and the request's headers); these helpers only ask the questions. Every write attempt runs inside a transaction that is
// rolled back, so finding a leak changes nothing.
import crypto from 'crypto';

/* The shop tables: public hangtag_* tables with an owner_id column (minus `exclude`) */
export async function shopTables(db, { exclude = [] } = {}){
  return (await db.query(`SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'owner_id' AND table_name LIKE 'hangtag_%' ORDER BY 1`)).rows
    .map((r) => r.t).filter((t) => !exclude.includes(t));
}
async function primaryKeys(db){
  const pk = {};
  (await db.query(`SELECT tc.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`)).rows
    .forEach((r) => { (pk[r.t] = pk[r.t] || []).push(r.c); });
  return pk;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Can anyone in `attackers` ([label, who]) see the victim shop's rows? → ['B sees 3 of the shop's hangtag_sales', …] */
export async function readLeaks({ run, tables, victim, attackers }){
  const leaks = [];
  for(const t of tables) for(const [label, who] of attackers){
    let n = 0; try{ n = (await run(who, `SELECT count(*)::int AS n FROM public.${t} WHERE owner_id = $1`, [victim])).rows[0].n; }catch{ n = 0; }
    if(n) leaks.push(`${label} sees ${n} of the shop's ${t}`);
  }
  return leaks;
}

/* Can anyone in `attackers` change, delete or add a row of the victim shop, in any table? →
   { leaks: [...], attempts, byRls (stopped by row security itself), byOther (stopped some other way: no privilege, a missing value) } */
export async function writeLeaks({ db, run, tables, victim, attackers }){
  const leaks = [], pks = await primaryKeys(db); let attempts = 0, byRls = 0, byOther = 0;
  const victimRows = async (t) => (await db.query(`SELECT count(*)::int AS n FROM public.${t} WHERE owner_id = $1`, [victim])).rows[0].n;
  // each statement runs through a tiny function (with the caller's own rights: row security applies) that catches the
  // database's answer itself — the error is never lost to the suite's role switching — and returns how many rows it touched
  await db.exec(`CREATE SCHEMA IF NOT EXISTS eval_tools; GRANT USAGE ON SCHEMA eval_tools TO PUBLIC;
    CREATE OR REPLACE FUNCTION eval_tools.try_sql(q text, a text) RETURNS text LANGUAGE plpgsql AS $f$
    DECLARE n int; BEGIN EXECUTE q USING a; GET DIAGNOSTICS n = ROW_COUNT; RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN RETURN 'err:' || SQLSTATE || ':' || SQLERRM; END $f$;
    GRANT EXECUTE ON FUNCTION eval_tools.try_sql(text, text) TO PUBLIC;`);
  /* one attempt as `who`, always rolled back → { rows } or { error } (and `after`: what after() saw before the rollback) */
  async function attempt(who, sql, param, after){
    attempts++;
    await db.exec('BEGIN');
    try{
      const r = String((await run(who, `SELECT eval_tools.try_sql($1, $2) AS r`, [sql, param])).rows[0].r);
      const out = r.startsWith('ok:') ? { rows: +r.slice(3) } : { error: r.slice(4) };
      if(out.error){ if(/row-level security/.test(out.error)) byRls++; else byOther++; }
      if(after) out.after = await after();
      return out;
    }finally{ await db.exec('ROLLBACK'); }
  }
  for(const t of tables){
    const sample = (await db.query(`SELECT to_jsonb(x) AS j FROM public.${t} x WHERE owner_id = $1 LIMIT 1`, [victim])).rows[0];
    const before = await victimRows(t);
    for(const [label, who] of attackers){
      const ch = await attempt(who, `UPDATE public.${t} SET owner_id = owner_id WHERE owner_id = $1::uuid`, victim);
      if(ch.rows) leaks.push(`${label} could change ${ch.rows} of the shop's ${t}`);
      const del = await attempt(who, `DELETE FROM public.${t} WHERE owner_id = $1::uuid`, victim);
      if(del.rows) leaks.push(`${label} could delete ${del.rows} of the shop's ${t}`);
      if(sample){
        // a copy of one of the shop's rows under a new key, still naming the shop: refused, or landed in the attacker's own shop
        const row = { ...sample.j };
        (pks[t] || []).filter((c) => c !== 'owner_id').forEach((c) => { const v = row[c]; row[c] = typeof v === 'string' ? (UUID.test(v) ? crypto.randomUUID() : v + '-x') : typeof v === 'number' ? v + 1e9 : v; });
        const ins = await attempt(who, `INSERT INTO public.${t} SELECT * FROM jsonb_populate_record(NULL::public.${t}, $1::jsonb)`, JSON.stringify(row), () => victimRows(t));
        if(!ins.error && ins.after > before) leaks.push(`${label} could add a row to the shop's ${t}`);
      }
    }
  }
  await db.exec('DROP SCHEMA eval_tools CASCADE');
  return { leaks, attempts, byRls, byOther };
}
