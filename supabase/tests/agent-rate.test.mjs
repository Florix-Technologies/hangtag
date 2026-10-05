// The Agent's server-side rate limit (schema.sql section 3t: hangtag_agent_usage + hangtag_agent_take, called only by
// the agent Edge Function with the service role). Per user and per shop, per minute and per UTC day; a refusal says when
// to retry, is never counted (so it never extends the wait), and never touches another user or shop; the app cannot call
// it, read the counters or reset them.
// Run: node supabase/tests/agent-rate.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222', U3 = '33333333-3333-3333-3333-333333333333';
const S1 = U1, S2 = U3;   // shop 1 (U1 owner, U2 a member), shop 2 (U3)
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider text, email text);
CREATE TABLE auth.sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`;
async function run(db, role, who, sql, params) {
  await db.exec(`SET ROLE ${role}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [who || '']);
  try { return { r: await db.query(sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } finally { await db.exec('RESET ROLE'); }
}
// limits: 3 per user per minute, 5 per user per day, 4 per shop per minute, 8 per shop per day
const take = async (db, user, shop, lim = [3, 5, 4, 8]) => {
  const x = await run(db, 'service_role', '', `SELECT public.hangtag_agent_take($1, $2, $3, $4, $5, $6) AS t`, [user, shop, ...lim]);
  if (x.err) throw new Error(x.err);
  return x.r.rows[0].t;
};
const hits = async (db, subject) => (await db.query(`SELECT COALESCE(sum(hits), 0)::int n FROM public.hangtag_agent_usage WHERE subject = $1`, [subject])).rows[0].n;
const rollMinute = (db) => db.query(`UPDATE public.hangtag_agent_usage SET bucket = bucket - interval '1 minute' WHERE subject LIKE 'um:%' OR subject LIKE 'sm:%'`);
const rollDay = (db) => db.query(`UPDATE public.hangtag_agent_usage SET bucket = bucket - interval '1 day'`);

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@x.in'), ($2, 'b@x.in'), ($3, 'c@x.in')`, [U1, U2, U3]);
await db.exec(NEW);

console.log('=== only the trusted Edge Function may count ===');
{
  const a = await run(db, 'authenticated', U1, `SELECT public.hangtag_agent_take($1, $2, 0, 0, 0, 0)`, [U1, S1]);
  const n = await run(db, 'anon', '', `SELECT public.hangtag_agent_take($1, $2, 0, 0, 0, 0)`, [U1, S1]);
  check('a signed-in user (the app) cannot call it — so it cannot skip or reset its own limit', /permission denied/.test(a.err || ''), a);
  check('a signed-out visitor cannot either', /permission denied/.test(n.err || ''), n);
  const rd = await run(db, 'authenticated', U1, `SELECT * FROM public.hangtag_agent_usage`), wr = await run(db, 'authenticated', U1, `DELETE FROM public.hangtag_agent_usage`);
  check('the counters cannot be read or cleared by the app', /permission denied/.test(rd.err || '') && /permission denied/.test(wr.err || ''), { rd, wr });
  const bad = await run(db, 'service_role', '', `SELECT public.hangtag_agent_take(NULL, $1, 1, 1, 1, 1)`, [S1]);
  check('a user and a shop are required', !!bad.err, bad);
}

console.log('=== per user per minute ===');
{
  const r = [];
  for (let i = 0; i < 3; i++) r.push(await take(db, U1, S1));
  check('normal use is allowed (3 of 3 this minute)', r.every((x) => x.allowed && x.retry_after === 0) && r[2].user_minute === 3, r);
  const burst = await take(db, U1, S1);
  check('the 4th request in the minute is refused, naming the window', burst.allowed === false && burst.limit === 'user_minute', burst);
  check('…with a retry time within the minute (1–60 s)', burst.retry_after >= 1 && burst.retry_after <= 60, burst);
  const before = await hits(db, 'um:' + U1);
  await take(db, U1, S1); await take(db, U1, S1);
  check('refused requests are not counted (hammering does not extend the wait)', await hits(db, 'um:' + U1) === before, { before, after: await hits(db, 'um:' + U1) });
  const other = await take(db, U2, S1);
  check('another user of the same shop is not affected by this user\'s limit', other.allowed === true && other.user_minute === 1, other);
  const shop2 = await take(db, U3, S2);
  check('another shop is not affected', shop2.allowed === true && shop2.shop_minute === 1 && shop2.shop_day === 1, shop2);
  await rollMinute(db);
  const next = await take(db, U1, S1);
  check('when the minute rolls over the same user is allowed again (no lasting lock)', next.allowed === true && next.user_minute === 1, next);
}

console.log('=== per shop per minute ===');
{
  // shop 1 has made 1 request this minute (U1 after the roll-over); U2's earlier one was before the roll-over
  const a = await take(db, U2, S1), b = await take(db, U2, S1), c = await take(db, U1, S1);
  check('the shop\'s 4 requests this minute are allowed (two users)', a.allowed && b.allowed && c.allowed && c.shop_minute === 4, { a, b, c });
  const d = await take(db, U1, S1);
  check('the shop\'s 5th request this minute is refused for any of its users (shop_minute)', d.allowed === false && d.limit === 'shop_minute' && d.retry_after >= 1, d);
  const e = await take(db, U3, S2);
  check('…while the other shop carries on', e.allowed === true, e);
}

console.log('=== per day ===');
{
  await rollMinute(db);
  // allowed so far today: U1 3 + 1 + 1 = 5 (its limit), U2 1 + 2 = 3, so shop 1 = 8 (its limit)
  const day = await hits(db, 'ud:' + U1), shopDay = await hits(db, 'sd:' + S1);
  const refused = await take(db, U1, S1);
  check('a user\'s requests add up over the day; the 6th is refused (user_day) with a retry time until the next UTC day',
    day === 5 && refused.allowed === false && refused.limit === 'user_day' && refused.retry_after > 60 && refused.retry_after <= 86400, { day, refused });
  const s = await take(db, U2, S1);
  check('the shop has used its 8 for the day: its other user is refused too (shop_day)', shopDay === 8 && s.allowed === false && s.limit === 'shop_day', { shopDay, s });
  check('…and those refusals were not counted', await hits(db, 'ud:' + U1) === 5 && await hits(db, 'sd:' + S1) === 8);
  await rollDay(db);
  const fresh = await take(db, U1, S1);
  check('a new day starts again', fresh.allowed === true && fresh.user_day === 1 && fresh.shop_day === 1, fresh);
  const old = (await db.query(`SELECT count(*)::int n FROM public.hangtag_agent_usage WHERE bucket < now() - interval '2 days'`)).rows[0].n;
  check('old counters are cleared as new days start (nothing older than two days)', old === 0, old);
  const unlimited = await take(db, U3, S2, [0, 0, 0, 0]);
  check('a limit of 0 means no limit', unlimited.allowed === true, unlimited);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
