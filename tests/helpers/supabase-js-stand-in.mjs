// A stand-in for "npm:@supabase/supabase-js" when an Edge Function's own index.ts is run in Node (supabase/tests/
// edge-entrypoints.test.mjs): createClient(url, key, options) is recorded in globalThis.__sbClients and answers rpc(),
// from().select().eq().maybeSingle() and auth.getUser() from the PGlite database in globalThis.__sbDb — as the service
// role for globalThis.__sbKeys.service, as `authenticated` for the anon key (the user named by the Authorization bearer,
// through globalThis.__sbTokens: token → { id, email }), with row security applying as in PostgREST. Not supabase-js
// itself: what it shows is what the entry files hand the library, and what the database does with it.
const clients = (globalThis.__sbClients = globalThis.__sbClients || []);

export function createClient(url, key, options = {}) {
  const db = globalThis.__sbDb, keys = globalThis.__sbKeys || {}, tokens = globalThis.__sbTokens || {};
  const headers = (options.global && options.global.headers) || {};
  const bearer = String(headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const user = key === keys.service ? null : tokens[bearer] || null;
  const role = key === keys.service ? 'service_role' : user ? 'authenticated' : 'anon';
  clients.push({ url, key: key === keys.service ? 'service' : key === keys.anon ? 'anon' : 'other', role, headers: Object.keys(headers), device: headers['x-hangtag-device'] || null, options });
  const run = async (q, p) => {
    await db.exec(`SET ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
      [user ? user.id : '', JSON.stringify(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])))]);
    try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
  };
  return {
    auth: { getUser: async () => ({ data: { user }, error: user ? null : { message: 'invalid token' } }) },
    rpc: async (name, args = {}) => {
      try {
        const sig = (await db.query(`SELECT p.proargnames AS n, oidvectortypes(p.proargtypes) AS t FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [name])).rows[0];
        if (!sig) return { data: null, error: { code: 'PGRST202', message: 'no such function' } };
        const names = sig.n || [], types = sig.t ? sig.t.split(', ') : [], ks = Object.keys(args).filter((k) => names.includes(k));
        const r = await run(`SELECT public.${name}(${ks.map((k, i) => `${k} => $${i + 1}::${types[names.indexOf(k)]}`).join(', ')}) AS r`,
          ks.map((k) => (args[k] != null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
    from: (t) => {
      const f = []; let cols = '*';
      const q = { select: (c) => { cols = c; return q; }, eq: (k, v) => { f.push([k, v]); return q; }, limit: () => q,
        maybeSingle: async () => {
          try { const r = await run(`SELECT ${cols} FROM public.${t} WHERE ${f.map(([k], i) => `${k} = $${i + 1}`).join(' AND ') || 'TRUE'} LIMIT 2`, f.map(([, v]) => v)); return { data: r.rows[0] || null, error: null }; }
          catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
        } };
      return q;
    },
  };
}
